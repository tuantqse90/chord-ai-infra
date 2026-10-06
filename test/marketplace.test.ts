import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { addr, rawTx, USDC, useTempDb } from "../src/bots/_testkit";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("../src/bots");
const { emit } = await import("../src/bots/bus");
const { agents, _agentsTest: T } = await import("../src/agentsApi");
const M = await import("../src/marketplace");
const NN = await import("../src/nownodes");
const prevKey = process.env.NOWNODES_API_KEY;

const CREATOR = "owner-creator-1", BUYER = "sess-buyer-1", BUYER2 = "sess-buyer-2";
const W = addr(91), PAY = addr(77), OTHER = addr(78);
const PAYER_KP = Keypair.fromSeed(new Uint8Array(32).fill(9));
const PAYER = PAYER_KP.publicKey.toBase58();
const LATER = () => Date.now() + 2 * 3_600_000; // the marketplace clock: every agent made now is 2 h old
const nowS = () => Math.floor(LATER() / 1000);
const sig = () => bs58.encode(randomBytes(64));
const btCalls: any[] = [];
const fakeCopyBt = async (i: any) => { btCalls.push(i); return { days: 3, realizedUsd: 12.5, unrealizedUsd: -2.25, investedUsd: 90, trades: 7, winRate: 0.6 }; };
const keyOn = () => { process.env.NOWNODES_API_KEY = "test-key-123"; };
const keyOff = () => { delete process.env.NOWNODES_API_KEY; };

const post = (path: string, session: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  agents.request(path, { method: "POST", headers: { ...(session ? { "x-session": session } : {}), "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const LISTING = { title: "Whale mirror", pitch: "Mirrors one wallet that buys early.", priceUsdc: 5, profitSharePct: 10, payoutWallet: PAY };
/** a USDC payment of `units` to `to`, in a transaction `ageS` old */
const payTx = (s: string, o: { to?: string; units?: number; ageS?: number; err?: unknown; buyer?: string; memo?: string | null } = {}) => {
  const t: any = rawTx({
    sig: s, payer: PAYER, blockTime: nowS() - (o.ageS ?? 60), err: o.err,
    tokens: [{ owner: o.to ?? PAY, mint: USDC, pre: "0", post: String(o.units ?? 5_000_000), decimals: 6 }, { owner: PAYER, mint: USDC, pre: "9000000", post: String(9_000_000 - (o.units ?? 5_000_000)), decimals: 6 }],
  });
  // the x402 memo issued to the buyer (the 402 answer's extra.memo) ties the payment to them
  const memo = o.memo === undefined ? M.memoOf(M.nonceFor(A.id, o.buyer ?? BUYER)) : o.memo;
  if (memo) t.transaction.message.instructions.push({ program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: memo });
  return t;
};
// NOWNodes: a fake node answering getTransaction from a map, plus the wallet-path methods
const answers = new Map<string, unknown>();
const rpcCalls: any[] = [];
let walletUsdc = "9000000";
function fakeNode() {
  NN.setNowNodesFetch(async (_u, init) => {
    const b = JSON.parse(String(init?.body));
    rpcCalls.push(b);
    const result = b.method === "getTransaction" ? answers.get(b.params[0]) ?? null
      : b.method === "getMultipleAccounts" ? { value: [{ lamports: 1e9 }, { lamports: 2e6, data: { parsed: { info: { tokenAmount: { amount: walletUsdc } } } } }, null] }
      : b.method === "getLatestBlockhash" ? { value: { blockhash: Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58(), lastValidBlockHeight: 321 } }
      : b.method === "sendTransaction" ? "5".repeat(88) : null;
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  });
}

let A: any, AL: any, F: any, copy1: any;
beforeAll(() => {
  E._resetBots(); T.reset(); M._marketTest.reset(); NN._resetNowNodes();
  tmp = useTempDb("market");
  keyOff();
  A = E.createBot(CREATOR, { name: "Whale mirror", type: "copy", params: { wallets: [W], usdPerTrade: 15 } });
  AL = E.createBot(CREATOR, { name: "Watch", type: "alert", params: { wallets: [W], webhook: "https://example.com/hook" } });
  F = E.createBot(CREATOR, { name: "Free mirror", type: "copy", params: { wallets: [addr(92)], usdPerTrade: 10 } });
});
afterAll(() => {
  T.reset(); M._marketTest.reset(); E._resetBots(); NN._resetNowNodes(); tmp.restore();
  if (prevKey === undefined) delete process.env.NOWNODES_API_KEY; else process.env.NOWNODES_API_KEY = prevKey;
});

describe("publish", () => {
  it("owner only, 1 h of history, no alert agents, fields checked, payout wallet kept as typed", async () => {
    M._marketTest.setDeps({ copyBacktest: fakeCopyBt }); // the real clock: A is seconds old
    const young = await post(`/${A.id}/listing`, CREATOR, LISTING);
    expect(young.status).toBe(422);
    expect(await young.json()).toMatchObject({ error: "too_new", message: expect.stringMatching(/needs 1 hour of live history before it can be listed: \d+ min to go/) });

    M._marketTest.setDeps({ now: LATER, copyBacktest: fakeCopyBt });
    expect((await post(`/${A.id}/listing`, null, LISTING)).status).toBe(401);
    expect(await (await post(`/${A.id}/listing`, BUYER, LISTING)).json()).toMatchObject({ error: "not_owner" });
    expect((await post("/nope00000000/listing", CREATOR, LISTING)).status).toBe(404);
    const al = await post(`/${AL.id}/listing`, CREATOR, LISTING);
    expect(al.status).toBe(422);
    expect((await al.json()).error).toBe("not_listable");
    for (const bad of [{ title: "x".repeat(49) }, { title: "" }, { pitch: "p".repeat(281) }, { priceUsdc: 101 }, { priceUsdc: -1 }, { priceUsdc: 0.001 }, { profitSharePct: 31 }, { payoutWallet: "not-a-wallet" }, { payoutWallet: "" }]) {
      const r = await post(`/${A.id}/listing`, CREATOR, { ...LISTING, ...bad });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("bad_listing");
    }

    const r = await post(`/${A.id}/listing`, CREATOR, LISTING);
    expect(r.status).toBe(200);
    const { listing } = await r.json();
    expect(listing).toMatchObject({ id: A.id, title: "Whale mirror", priceUsdc: 5, profitSharePct: 10, payTo: PAY, creator: `${PAY.slice(0, 4)}…${PAY.slice(-4)}`, mine: true,
      headline: { days: 3, pnlUsd: 10.25, investedUsd: 90, trades: 7, winRate: 0.6 }, copies: 0, earnings: { paperUsd: 0, fromCopies: 0, paper: true } });
    expect(listing.payTo).toBe(PAY); // base58 is case-sensitive: kept exactly
    expect(btCalls[0]).toMatchObject({ days: 3, params: { wallets: [W], usdPerTrade: 15 } });
    expect(await (await post(`/${F.id}/listing`, CREATOR, { ...LISTING, title: "Free mirror", priceUsdc: 0, profitSharePct: 20 })).json()).toMatchObject({ listing: { priceUsdc: 0, profitSharePct: 20 } });
  });

  it("the backtest headline per agent type: strategy, copy, LP; a failing one is null and never blocks", async () => {
    const seen: any[] = [];
    M._marketTest.setDeps({
      now: LATER,
      strategyBacktest: async (s, d) => { seen.push(["custom", s, d]); return { days: 3, realizedUsd: 1, unrealizedUsd: 2, investedUsd: 40, trades: 2, winRate: 1 }; },
      lpBacktest: async (i) => { seen.push(["lp", i]); return { days: 3, pnlUsd: -4.567, amountUsd: 500, fills: [1, 2, 3] }; },
      copyBacktest: async () => { throw new Error("tape down"); },
    });
    expect(await M.headlineFor({ type: "custom", params: { strategy: { name: "S" } } as any })).toMatchObject({ days: 3, pnlUsd: 3, investedUsd: 40, trades: 2, winRate: 1 });
    const lp = { pool: addr(5), amountUsd: 500, preset: null, rangePct: 8, rebalance: { outOfRangeMinutes: 15, maxPerDay: 6 }, exits: { lpExodus: true, tokenDropPct: 25, dailyLossStopUsd: null }, safety: true };
    expect(await M.headlineFor({ type: "lp", params: lp as any })).toMatchObject({ pnlUsd: -4.57, investedUsd: 500, trades: 3, winRate: null });
    expect(seen[0]).toEqual(["custom", { name: "S" }, 3]);
    expect(seen[1]).toEqual(["lp", { pool: lp.pool, amountUsd: 500, preset: null, rangePct: 8, rebalance: lp.rebalance, exits: lp.exits, days: 3 }]);
    expect(await M.headlineFor({ type: "copy", params: { wallets: [W], usdPerTrade: 15 } as any })).toBeNull();
    M._marketTest.setDeps({ now: LATER, copyBacktest: fakeCopyBt });
  });
});

describe("market", () => {
  it("public listings: live stats, headline, terms; never an owner or a webhook; mine only for the owner", async () => {
    const j = await (await agents.request("/market?sort=new")).json();
    expect(j.sort).toBe("new");
    expect(j.listings.map((l: any) => l.id).sort()).toEqual([A.id, F.id].sort());
    expect(j.listings[0].listedAt).toBeGreaterThanOrEqual(j.listings[1].listedAt);
    const row = j.listings.find((l: any) => l.id === A.id);
    expect(row).toMatchObject({ title: "Whale mirror", pitch: LISTING.pitch, priceUsdc: 5, profitSharePct: 10, pnlUsd: 0, spark: [0, 0], sales: { count: 0, usdc: 0 },
      agent: { id: A.id, name: "Whale mirror", type: "copy", mode: "paper", status: "running", template: "Copy trader" } });
    expect(row).not.toHaveProperty("owner");
    expect(row).not.toHaveProperty("mine");
    expect(JSON.stringify(j)).not.toContain(CREATOR);
    expect(JSON.stringify(j)).not.toContain("webhook");
    const mine = await (await agents.request("/market", { headers: { "x-session": CREATOR } })).json();
    expect(mine.sort).toBe("pnl");
    expect(mine.listings.every((l: any) => l.mine === true)).toBe(true);
    expect((await (await agents.request(`/${AL.id}/listing`)).json()).listing).toBeNull();
    expect((await (await agents.request(`/${A.id}/listing`)).json()).listing).toMatchObject({ id: A.id, priceUsdc: 5 });
    const board = (await (await agents.request("/board?window=all")).json()).agents.find((a: any) => a.id === A.id);
    expect(board.listing).toEqual({ priceUsdc: 5, profitSharePct: 10 });
  });
});

describe("copy with x402", () => {
  it("a priced copy answers 402 with the x402 body; with a payment and no NOWNodes key: 503, nothing read", async () => {
    keyOff(); fakeNode(); rpcCalls.length = 0;
    const r = await post(`/${A.id}/copy`, BUYER, {});
    expect(r.status).toBe(402);
    const j = await r.json();
    expect(j).toMatchObject({ x402Version: 1, error: "payment_required", terms: { agent: A.id, priceUsdc: 5, profitSharePct: 10, payTo: PAY, profitShare: "paper" }, nownodes: { ready: false } });
    expect(j.accepts).toHaveLength(1);
    expect(j.accepts[0]).toMatchObject({ scheme: "exact", network: "solana", asset: USDC, payTo: PAY, maxAmountRequired: "5000000", resource: `http://localhost/v1/agents/${A.id}/copy`,
      mimeType: "application/json", maxTimeoutSeconds: 900, extra: { decimals: 6, verifiedBy: "NOWNodes" } });
    expect(j.accepts[0].description).toContain("10% of each profitable close");
    expect(j.message).not.toContain("—");
    const off = await post(`/${A.id}/copy`, BUYER, {}, { "x-payment": `solana:${sig()}` });
    expect(off.status).toBe(503);
    expect((await off.json()).error).toBe("nownodes_off");
    expect(rpcCalls.length).toBe(0);
    expect((await post(`/${A.id}/copy`, BUYER, {}, { "x-payment": "solana:nope" })).status).toBe(400);
    expect(E.listBots(BUYER)).toHaveLength(0);
  });

  it("a paid copy is read through NOWNodes getTransaction, created once; the same signature again is refused", async () => {
    keyOn(); fakeNode(); rpcCalls.length = 0;
    const s1 = sig();
    answers.set(s1, payTx(s1));
    const r = await post(`/${A.id}/copy`, BUYER, {}, { "x-payment": `solana:${s1}` });
    expect(r.status).toBe(201);
    copy1 = await r.json();
    expect(copy1).toMatchObject({ type: "copy", mode: "paper", name: "Copy of Whale mirror", payment: { signature: s1, paidUsdc: 5, payer: PAYER, payTo: PAY, verifiedBy: "NOWNodes" } });
    expect(JSON.parse(Buffer.from(r.headers.get("x-payment-response")!, "base64").toString())).toEqual({ success: true, transaction: s1, network: "solana", payer: PAYER });
    expect(rpcCalls).toEqual([{ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [s1, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }]);
    expect(E.listBots(BUYER).map((b) => b.id)).toEqual([copy1.id]);
    const again = await post(`/${A.id}/copy`, BUYER2, {}, { "x-payment": `solana:${s1}` });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("payment_used");
    expect(rpcCalls.length).toBe(1); // refused before reading the chain again
    expect(E.listBots(BUYER2)).toHaveLength(0);
    const row = (await (await agents.request("/market")).json()).listings.find((l: any) => l.id === A.id);
    expect(row).toMatchObject({ copies: 1, sales: { count: 1, usdc: 5 } });
  });

  it("a payment is tied to its buyer: another caller's memo, or no memo, is refused and the signature stays unused", async () => {
    keyOn(); fakeNode();
    const q = await post(`/${A.id}/copy`, BUYER2, {});
    expect(q.status).toBe(402);
    const memo2 = (await q.json()).accepts[0].extra.memo;
    expect(memo2).toBe(M.memoOf(M.nonceFor(A.id, BUYER2)));
    expect(memo2).not.toBe(M.memoOf(M.nonceFor(A.id, BUYER)));
    for (const [o, msg] of [[{ buyer: BUYER }, /issued to another buyer/], [{ memo: null }, /no x402 memo/]] as const) {
      const s = sig();
      answers.set(s, payTx(s, o as any)); // a transfer someone else made (or one without the memo), seen on chain
      const r = await post(`/${A.id}/copy`, BUYER2, {}, { "x-payment": `solana:${s}` });
      expect(r.status).toBe(402);
      expect((await r.json()).message).toMatch(msg);
      expect(M.paymentUsed(s)).toBe(false);
    }
  });

  it("wrong recipient, too small, failed, too old, not confirmed yet: 402 with the reason, the signature stays unused", async () => {
    keyOn(); fakeNode();
    const cases: [string, unknown, string, RegExp][] = [
      ["to", { to: OTHER }, "payment_rejected", /did not pay the listing's payout wallet in USDC/],
      ["small", { units: 4_000_000 }, "payment_rejected", /^paid 4 USDC, the price is 5 USDC$/],
      ["failed", { err: { InstructionError: [0, "Custom"] } }, "payment_rejected", /failed on chain/],
      ["old", { ageS: 16 * 60 }, "payment_expired", /16 min old/],
    ];
    for (const [, o, code, msg] of cases) {
      const s = sig();
      answers.set(s, payTx(s, { ...(o as any), buyer: BUYER2 }));
      const r = await post(`/${A.id}/copy`, BUYER2, {}, { "x-payment": `solana:${s}` });
      expect(r.status).toBe(402);
      const j = await r.json();
      expect(j.error).toBe(code);
      expect(j.message).toMatch(msg);
      expect(j.accepts[0].payTo).toBe(PAY);
      expect(M.paymentUsed(s)).toBe(false);
    }
    const pending = sig();
    const p = await post(`/${A.id}/copy`, BUYER2, {}, { "x-payment": `solana:${pending}` });
    expect(p.status).toBe(402);
    expect((await p.json()).error).toBe("payment_pending");
    answers.set(pending, payTx(pending, { buyer: BUYER2 })); // it lands: the same signature now buys the copy
    expect((await post(`/${A.id}/copy`, BUYER2, {}, { "x-payment": `solana:${pending}` })).status).toBe(201);
    expect(E.listBots(BUYER2)).toHaveLength(1);
  });

  it("no 402 for a copy the caller could not receive (5 agents already); free listings and unlisted agents copy at once", async () => {
    keyOff();
    const FULL = "sess-full-agents";
    for (let i = 0; i < E.MAX_BOTS_PER_OWNER; i++) E.createBot(FULL, { type: "copy", params: { wallets: [addr(200 + i)], usdPerTrade: 5 } });
    const r = await post(`/${A.id}/copy`, FULL, {});
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("too_many_bots");
    const free = await post(`/${F.id}/copy`, BUYER, { name: "Mine" });
    expect(free.status).toBe(201);
    expect((await free.json()).name).toBe("Mine");
    const own = await post(`/${A.id}/copy`, CREATOR, {}); // the creator copies their own agent for free
    expect(own.status).toBe(201);
    E.deleteBot(CREATOR, (await own.json()).id);
  });
});

describe("profit share (paper)", () => {
  const fill = (o: Partial<any>) => ({ id: `f-${Math.random()}`, botId: copy1.id, ts: Date.now(), side: "sell", mint: addr(5), symbol: "X", usd: 10, tokenAmount: 1, priceUsd: 1, status: "filled", reason: null, pnlUsd: null, quote: null, mode: "paper",
    source: { wallet: W, tx: "t", side: "sell", mint: addr(5), symbol: "X", usd: 1, priceUsd: 1, ts: 0, via: "websocket" }, ...o });
  it("only a filled close with positive PnL accrues the share, once per fill; a restart catches up", async () => {
    emit(copy1.id, { type: "fill", fill: fill({ side: "buy" }) as any });
    emit(copy1.id, { type: "fill", fill: fill({ pnlUsd: -3 }) as any });
    emit(copy1.id, { type: "fill", fill: fill({ pnlUsd: 0 }) as any });
    emit(copy1.id, { type: "fill", fill: fill({ status: "skipped", pnlUsd: 5 }) as any });
    expect(M.earningsOf(A.id)).toEqual({ paperUsd: 0, fromCopies: 0, closes: 0 });
    const win = fill({ id: "win-1", pnlUsd: 20 });
    emit(copy1.id, { type: "fill", fill: win as any });
    emit(copy1.id, { type: "fill", fill: win as any });
    expect(M.earningsOf(A.id)).toEqual({ paperUsd: 2, fromCopies: 1, closes: 1 });
    T.reset();
    const row = (await (await agents.request("/market")).json()).listings.find((l: any) => l.id === A.id);
    expect(row.earnings).toEqual({ paperUsd: 2, fromCopies: 1, closes: 1, paper: true });
    // a restart: subscriptions are gone, initMarketplace subscribes again for every live copy with a share
    for (const off of M._marketTest.shareSubs.values()) off();
    M._marketTest.shareSubs.clear();
    M.initMarketplace();
    expect(M._marketTest.shareSubs.has(copy1.id)).toBe(true);
    emit(copy1.id, { type: "fill", fill: fill({ id: "win-2", pnlUsd: 7.5 }) as any });
    expect(M.earningsOf(A.id)).toEqual({ paperUsd: 2.75, fromCopies: 1, closes: 2 });
  });
});

describe("the page's wallet path (NOWNodes)", () => {
  it("prepares the USDC transfer for the wallet, relays only a payment of this listing", async () => {
    keyOff();
    const off = await post(`/${A.id}/copy/pay-tx`, BUYER2, { wallet: PAYER });
    expect(off.status).toBe(503);
    expect((await off.json()).error).toBe("nownodes_off");
    keyOn(); fakeNode(); rpcCalls.length = 0;
    expect((await post(`/${A.id}/copy/pay-tx`, CREATOR, { wallet: PAYER })).status).toBe(400); // own listing copies free
    expect((await post(`/${F.id}/copy/pay-tx`, BUYER2, { wallet: PAYER })).status).toBe(404); // free listing: nothing to pay
    const r = await post(`/${A.id}/copy/pay-tx`, BUYER2, { wallet: PAYER });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ amountUsdc: 5, payTo: PAY, createsPayoutAccount: true, lastValidBlockHeight: 321 });
    expect(rpcCalls.map((c) => c.method).sort()).toEqual(["getLatestBlockhash", "getMultipleAccounts"]);
    const tx = VersionedTransaction.deserialize(Buffer.from(j.transaction, "base64"));
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(PAYER);
    const listing = M.listingOf(A.id)!;
    expect(M.paysListing(tx, listing)).toBe(true);
    expect(M.paysListing(tx, { ...listing, payTo: OTHER })).toBe(false);
    expect(M.paysListing(tx, { ...listing, priceUsdc: 6 })).toBe(false);
    expect((await post(`/${A.id}/copy/pay-send`, BUYER2, { transaction: j.transaction })).status).toBe(400); // unsigned
    tx.sign([PAYER_KP]);
    const signed = Buffer.from(tx.serialize()).toString("base64");
    const s = await post(`/${A.id}/copy/pay-send`, BUYER2, { transaction: signed });
    expect(s.status).toBe(200);
    expect(await s.json()).toEqual({ signature: "5".repeat(88) });
    expect(rpcCalls.at(-1)).toMatchObject({ method: "sendTransaction", params: [signed, { encoding: "base64" }] });
    // a payment for another listing is not relayed
    M._marketTest.setDeps({ now: LATER, copyBacktest: fakeCopyBt });
    await post(`/${F.id}/listing`, CREATOR, { ...LISTING, title: "Free mirror", priceUsdc: 2, payoutWallet: OTHER });
    expect((await post(`/${F.id}/copy/pay-send`, BUYER2, { transaction: signed })).status).toBe(403);
    walletUsdc = "1000000";
    const poor = await post(`/${A.id}/copy/pay-tx`, BUYER2, { wallet: PAYER });
    expect(poor.status).toBe(422);
    expect(await poor.json()).toMatchObject({ error: "insufficient_usdc", message: "This wallet holds 1 USDC; the price is 5 USDC." });
  });

  it("unlisting: gone from the market, copies keep their terms, the agent copies free again", async () => {
    keyOff();
    const d = await agents.request(`/${A.id}/listing`, { method: "DELETE", headers: { "x-session": BUYER } });
    expect(d.status).toBe(404);
    expect((await agents.request(`/${A.id}/listing`, { method: "DELETE", headers: { "x-session": CREATOR } })).status).toBe(200);
    T.reset();
    expect((await (await agents.request("/market")).json()).listings.map((l: any) => l.id)).toEqual([F.id]);
    expect(M._marketTest.shareSubs.has(copy1.id)).toBe(true);
    E.deleteBot(BUYER, (await (await post(`/${A.id}/copy`, BUYER, {})).json()).id);
  });
});
