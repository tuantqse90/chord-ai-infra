import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { addr, useTempDb } from "../src/bots/_testkit";
import type { Fill } from "../src/bots/types";
import { setNowNodesFetch, _resetNowNodes } from "../src/nownodes";
import { setJupiterFetch } from "../src/trade/solana";
import { setSolanaFetch } from "../src/rpc/solana";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("../src/bots");
const S = await import("../src/bots/store");
const X = await import("../src/agentExec");
const { agentExec } = await import("../src/agentExecRoutes");

const OWNER = "sess-exec-owner-1", OTHER = "sess-exec-other-1";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT = addr(501), W = addr(502), DEST = new PublicKey(addr(503));
const kp = Keypair.generate(), WALLET = kp.publicKey.toBase58();
const prevKey = process.env.NOWNODES_API_KEY;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

// ── fakes: Jupiter (tokens, quote, swap), NOWNodes, the read RPC ───────────────────────────────────────────────────────
type Calls = { jup: string[]; now: { method: string; params: any[] }[]; read: number };
let calls: Calls;
let nowAnswers: Record<string, (params: any[]) => unknown>;
let swapN = 0;
function swapTx(payer: PublicKey): string {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111",
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: DEST, lamports: ++swapN })] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}
const signB64 = (b64: string) => { const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64")); tx.sign([kp]); return Buffer.from(tx.serialize()).toString("base64"); };
const sigOf = (b64: string) => bs58.encode(VersionedTransaction.deserialize(Buffer.from(b64, "base64")).signatures[0]);

function fakes(): void {
  calls = { jup: [], now: [], read: 0 };
  nowAnswers = {
    simulateTransaction: () => ({ value: { err: null, logs: ["Program JUP6 invoke [1]", "Program log: Instruction: Route", "Program JUP6 success"], unitsConsumed: 61234 } }),
    sendTransaction: (p) => sigOf(p[0]),
    getSignatureStatuses: () => ({ value: [null] }),
    getTokenAccountsByOwner: () => ({ value: [] }),
  };
  setJupiterFetch(async (u, init) => {
    calls.jup.push(u);
    if (u.includes("/tokens/v2/search")) {
      const q = decodeURIComponent(u.split("query=")[1]);
      return json([{ id: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, icon: null }, { id: MINT, symbol: "BONKX", name: "Bonk X", decimals: 5, icon: null }].filter((t) => q.includes(t.id)));
    }
    if (u.includes("/quote?")) {
      const p = new URL(u).searchParams;
      return json({ inputMint: p.get("inputMint"), outputMint: p.get("outputMint"), inAmount: p.get("amount"), outAmount: "12345600000", otherAmountThreshold: "12222100000",
        priceImpactPct: "0.0012", routePlan: [{ swapInfo: { label: "Raydium" } }, { swapInfo: { label: "Meteora DLMM" } }], swapUsdValue: "15" });
    }
    if (u.endsWith("/swap")) return json({ swapTransaction: swapTx(new PublicKey(JSON.parse(String(init?.body)).userPublicKey)), lastValidBlockHeight: 100 });
    return json({ error: "unexpected" }, 404);
  });
  setNowNodesFetch(async (_u, init) => {
    const b = JSON.parse(String(init?.body));
    calls.now.push({ method: b.method, params: b.params });
    const f = nowAnswers[b.method];
    return f ? json({ jsonrpc: "2.0", id: 1, result: f(b.params) }) : json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not mocked" } });
  });
  setSolanaFetch(async () => { calls.read++; return json({ jsonrpc: "2.0", id: 1, result: null }); });
}

let fillN = 0;
function addFill(botId: string, o: Partial<Fill> = {}): Fill {
  const n = ++fillN, side = o.side ?? "buy", mint = o.mint ?? MINT;
  const f: Fill = { id: `fx${n}`, botId, ts: Date.now() - 5_000 + n, side, mint, symbol: "BONKX", usd: 15, tokenAmount: 100, priceUsd: 0.15, status: "filled", reason: null, pnlUsd: null,
    quote: null, mode: "paper", source: { wallet: W, tx: `tx-${n}`, side, mint, symbol: "BONKX", usd: 500, priceUsd: 0.15, ts: Date.now() - 6_000, via: "websocket" }, ...o };
  expect(S.insertFill(f)).toBe(true);
  return f;
}
const req = (path: string, o: { method?: string; body?: unknown; session?: string | null } = {}) => agentExec.request(path, {
  method: o.method ?? (o.body ? "POST" : "GET"),
  headers: { ...(o.session === null ? {} : { "x-session": o.session ?? OWNER }), ...(o.body ? { "content-type": "application/json" } : {}) },
  body: o.body ? JSON.stringify(o.body) : undefined,
});

let copy: { id: string };
beforeAll(() => {
  E._resetBots(); X._execTest.reset();
  tmp = useTempDb("agent-exec");
  copy = E.createBot(OWNER, { name: "Exec test", type: "copy", params: { wallets: [W], usdPerTrade: 15 } });
});
afterAll(() => { X._execTest.reset(); E._resetBots(); tmp.restore(); });
beforeEach(() => { process.env.NOWNODES_API_KEY = "test-nownodes-key"; fakes(); });
afterEach(() => {
  setJupiterFetch(null); setSolanaFetch(null); _resetNowNodes(); X._execTest.setNow(null);
  if (prevKey === undefined) delete process.env.NOWNODES_API_KEY; else process.env.NOWNODES_API_KEY = prevKey;
});

describe("lane off", () => {
  it("prepare, send and status answer 503 nownodes_off and nothing is called (no Jupiter, no NOWNodes, no read RPC)", async () => {
    delete process.env.NOWNODES_API_KEY;
    const f = addFill(copy.id);
    const p = await req("/prepare", { body: { botId: copy.id, fillId: f.id, wallet: WALLET } });
    expect(p.status).toBe(503);
    expect(await p.json()).toMatchObject({ error: "nownodes_off", message: expect.stringContaining("NOWNodes key not set") });
    expect((await req("/send", { body: { prepareId: "x", signedTx: "AA==" } })).status).toBe(503);
    expect(calls).toEqual({ jup: [], now: [], read: 0 });
    const mine = await (await req(`/mine?botId=${copy.id}`)).json();
    expect(mine.lane).toMatchObject({ provider: "NOWNodes", on: false });
  });
});

describe("who and what can be executed", () => {
  it("no session = 401; another owner's agent = 404", async () => {
    const f = addFill(copy.id);
    expect((await req("/prepare", { body: { botId: copy.id, fillId: f.id, wallet: WALLET }, session: null })).status).toBe(401);
    const r = await req("/prepare", { body: { botId: copy.id, fillId: f.id, wallet: WALLET }, session: OTHER });
    expect(r.status).toBe(404);
    expect((await req("/mine", { session: null })).status).toBe(401);
    expect(calls.jup.length + calls.now.length).toBe(0);
  });
  it("a fill older than 2 minutes is a stale signal (410); a skipped fill and an alert agent are refused (409)", async () => {
    const old = addFill(copy.id, { ts: Date.now() - 3 * 60_000 });
    const r = await req("/prepare", { body: { botId: copy.id, fillId: old.id, wallet: WALLET } });
    expect(r.status).toBe(410);
    expect((await r.json()).message).toMatch(/180 s old|3 min old/);
    const sk = addFill(copy.id, { status: "skipped", reason: "liquidity $900 is below the bot's $20,000 minimum", tokenAmount: 0 });
    const r2 = await req("/prepare", { body: { botId: copy.id, fillId: sk.id, wallet: WALLET } });
    expect(r2.status).toBe(409);
    expect(await r2.json()).toMatchObject({ error: "not_executable", message: expect.stringContaining("skipped") });
    const alert = E.createBot(OWNER, { type: "alert", params: { wallets: [W], minUsd: 1000 } });
    const af = addFill(alert.id);
    const r3 = await req("/prepare", { body: { botId: alert.id, fillId: af.id, wallet: WALLET } });
    expect(r3.status).toBe(409);
    expect((await r3.json()).message).toMatch(/alert agent does not trade/);
    E.deleteBot(OWNER, alert.id);
    expect(calls.jup.length + calls.now.length).toBe(0);
  });
  it("bad wallet = 400", async () => {
    const f = addFill(copy.id);
    expect((await req("/prepare", { body: { botId: copy.id, fillId: f.id, wallet: "0xabc" } })).status).toBe(400);
  });
});

describe("buy: prepare → send → status", () => {
  it("quotes USDC → mint for the fill's USD, simulates on NOWNodes, sends the signed copy through NOWNodes, records the row", async () => {
    const f = addFill(copy.id, { usd: 15 });
    const r = await req("/prepare", { body: { botId: copy.id, fillId: f.id, wallet: WALLET } });
    expect(r.status).toBe(200);
    const p = await r.json();
    expect(p).toMatchObject({ side: "buy", mint: MINT, symbol: "BONKX", via: "NOWNodes", sell: null,
      quote: { inAmount: "15", outAmount: "123456", inToken: { symbol: "USDC" }, outToken: { symbol: "BONKX" }, priceImpactPct: 0.12, route: ["Raydium", "Meteora DLMM"], provider: "Jupiter", slippageBps: 100 },
      simulation: { ok: true, err: null, unitsConsumed: 61234, hint: null } });
    expect(p.simulation.logsTail.length).toBe(3);
    expect(calls.jup.find((u) => u.includes("/quote?"))).toContain(`inputMint=${USDC}&outputMint=${MINT}&amount=15000000`);
    expect(calls.now.map((c) => c.method)).toEqual(["simulateTransaction"]);
    expect(calls.now[0].params[1]).toMatchObject({ encoding: "base64", sigVerify: false, replaceRecentBlockhash: true });
    expect(calls.read).toBe(0);

    const signed = signB64(p.tx);
    const s = await req("/send", { body: { prepareId: p.prepareId, signedTx: signed } });
    expect(s.status).toBe(200);
    const sent = await s.json();
    expect(sent).toEqual({ signature: sigOf(signed), status: "pending", via: "NOWNodes" });
    const sendCall = calls.now.find((c) => c.method === "sendTransaction")!;
    expect(sendCall.params).toEqual([signed, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);

    const mine = await (await req(`/mine?botId=${copy.id}`)).json();
    expect(mine.lane.on).toBe(true);
    expect(mine.executions[0]).toMatchObject({ signature: sent.signature, fillId: f.id, botId: copy.id, wallet: WALLET, side: "buy", mint: MINT, usd: 15, status: "pending", via: "NOWNodes",
      url: `https://solscan.io/tx/${sent.signature}` });
    expect(X.executionsOf([f.id, "nope"])).toEqual({ [f.id]: { signature: sent.signature, at: expect.any(Number), status: "pending", side: "buy", url: `https://solscan.io/tx/${sent.signature}`, via: "NOWNodes" } });

    // the same signal again: refused, the prepared id is spent
    const again = await req("/prepare", { body: { botId: copy.id, fillId: f.id, wallet: WALLET } });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already_executed", signature: sent.signature });
    expect((await req("/send", { body: { prepareId: p.prepareId, signedTx: signed } })).status).toBe(410);

    // status on NOWNodes: pending → confirmed → finalized; a final state answers from the row
    nowAnswers.getSignatureStatuses = () => ({ value: [{ slot: 777, confirmations: 3, err: null, confirmationStatus: "confirmed" }] });
    expect(await (await req(`/status/${sent.signature}`)).json()).toMatchObject({ signature: sent.signature, status: "confirmed", slot: 777, err: null, via: "NOWNodes" });
    expect(calls.now.at(-1)).toEqual({ method: "getSignatureStatuses", params: [[sent.signature], { searchTransactionHistory: true }] });
    nowAnswers.getSignatureStatuses = () => ({ value: [{ slot: 778, confirmations: null, err: null, confirmationStatus: "finalized" }] });
    expect((await (await req(`/status/${sent.signature}`)).json()).status).toBe("finalized");
    const n = calls.now.length;
    const fin = await (await req(`/status/${sent.signature}`)).json();
    expect(fin).toEqual({ signature: sent.signature, status: "finalized", err: null, slot: 778, url: `https://solscan.io/tx/${sent.signature}`, via: "NOWNodes" }); // from the row, no owner inside
    expect(calls.now.length).toBe(n);
    expect(X.myExecutions(OWNER, copy.id)[0]).toMatchObject({ status: "finalized", slot: 778 });
    expect((await req(`/status/${sent.signature}`, { session: OTHER })).status).toBe(404);
  });
  it("the person can execute a smaller size than the agent's", async () => {
    const f = addFill(copy.id, { usd: 25 });
    const p = await (await req("/prepare", { body: { botId: copy.id, fillId: f.id, wallet: WALLET, usd: 1 } })).json();
    expect(p.quote.inAmount).toBe("1");
    expect(calls.jup.find((u) => u.includes("/quote?"))).toContain("amount=1000000&");
  });
  it("a signed transaction that is not the prepared one is refused, nothing is sent", async () => {
    const f = addFill(copy.id);
    const p = await (await req("/prepare", { body: { botId: copy.id, fillId: f.id, wallet: WALLET } })).json();
    const other = signB64(swapTx(kp.publicKey));
    const r = await req("/send", { body: { prepareId: p.prepareId, signedTx: other } });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "not_prepared" });
    const unsigned = await req("/send", { body: { prepareId: p.prepareId, signedTx: p.tx } });
    expect(unsigned.status).toBe(400);
    expect((await req("/send", { body: { prepareId: p.prepareId, signedTx: signB64(p.tx) }, session: OTHER })).status).toBe(410);
    expect(calls.now.filter((c) => c.method === "sendTransaction").length).toBe(0);
  });
  it("a failed simulation says why; a send the node refuses records nothing", async () => {
    nowAnswers.simulateTransaction = () => ({ value: { err: { InstructionError: [3, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds"], unitsConsumed: 20000 } });
    const f = addFill(copy.id);
    const p = await (await req("/prepare", { body: { botId: copy.id, fillId: f.id, wallet: WALLET } })).json();
    expect(p.simulation).toMatchObject({ ok: false, err: '{"InstructionError":[3,{"Custom":1}]}', hint: "Not enough USDC in this wallet for this buy." });
    setNowNodesFetch(async (_u, init) => {
      const b = JSON.parse(String(init?.body));
      calls.now.push({ method: b.method, params: b.params });
      return json({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed: Error processing Instruction 3" } });
    });
    const r = await req("/send", { body: { prepareId: p.prepareId, signedTx: signB64(p.tx) } });
    expect(r.status).toBe(422);
    expect((await r.json()).message).toMatch(/simulation failed.*Nothing was sent/);
    expect(X.executionsOf([f.id])).toEqual({});
  });
});

describe("sell", () => {
  it("nothing held in the wallet = 409 nothing to sell (read on NOWNodes)", async () => {
    addFill(copy.id, { side: "buy", tokenAmount: 100 });
    const s = addFill(copy.id, { side: "sell", tokenAmount: 100, usd: 18, pnlUsd: 3 });
    const r = await req("/prepare", { body: { botId: copy.id, fillId: s.id, wallet: WALLET } });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "nothing_to_sell", message: "nothing to sell in this wallet: it holds no BONKX" });
    expect(calls.now.map((c) => c.method)).toEqual(["getTokenAccountsByOwner"]);
    expect(calls.now[0].params).toEqual([WALLET, { mint: MINT }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    expect(calls.jup.filter((u) => u.includes("/quote?")).length).toBe(0);
  });
  it("sells the wallet's real balance (its associated account) × the share the agent sold", async () => {
    const MINT2 = addr(611);
    setJupiterFetch(async (u, init) => {
      calls.jup.push(u);
      if (u.includes("/tokens/v2/search")) return json([{ id: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, icon: null }, { id: MINT2, symbol: "WIFX", name: "Wif X", decimals: 6, icon: null }].filter((t) => decodeURIComponent(u).includes(t.id)));
      if (u.includes("/quote?")) { const p = new URL(u).searchParams; return json({ inputMint: p.get("inputMint"), outputMint: p.get("outputMint"), inAmount: p.get("amount"), outAmount: "4200000", otherAmountThreshold: "4100000", priceImpactPct: "0.003", routePlan: [] }); }
      return json({ swapTransaction: swapTx(new PublicKey(JSON.parse(String(init?.body)).userPublicKey)), lastValidBlockHeight: 100 });
    });
    const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const ata = PublicKey.findProgramAddressSync([kp.publicKey.toBuffer(), new PublicKey(TOKEN).toBuffer(), new PublicKey(MINT2).toBuffer()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0].toBase58();
    const acct = (pubkey: string, amount: string) => ({ pubkey, account: { owner: TOKEN, data: { parsed: { info: { mint: MINT2, owner: WALLET, tokenAmount: { amount, decimals: 6 } } } } } });
    nowAnswers.getTokenAccountsByOwner = () => ({ value: [acct(addr(612), "99000000"), acct(ata, "10000000")] });
    addFill(copy.id, { mint: MINT2, side: "buy", tokenAmount: 60 });
    addFill(copy.id, { mint: MINT2, side: "buy", tokenAmount: 40 });
    const s = addFill(copy.id, { mint: MINT2, side: "sell", tokenAmount: 25, usd: 4 }); // the agent sold a quarter of its 100
    expect(X.soldFraction(copy.id, s)).toBeCloseTo(0.25, 9);
    const r = await req("/prepare", { body: { botId: copy.id, fillId: s.id, wallet: WALLET } });
    expect(r.status).toBe(200);
    const p = await r.json();
    expect(p).toMatchObject({ side: "sell", sell: { pct: 25, walletBalance: "10" }, quote: { inAmount: "2.5", outAmount: "4.2", inToken: { symbol: "WIFX" }, outToken: { symbol: "USDC" } } });
    expect(calls.jup.find((u) => u.includes("/quote?"))).toContain(`inputMint=${MINT2}&outputMint=${USDC}&amount=2500000&`);
    // a full exit sells all of it
    const all = addFill(copy.id, { mint: MINT2, side: "sell", tokenAmount: 75, usd: 12 });
    expect(X.soldFraction(copy.id, all)).toBe(1);
  });
});

describe("status mapping", () => {
  it("chain answers → pending | confirmed | finalized | failed", () => {
    const t = 1_000_000;
    expect(X.mapStatus(null, t, t + 5_000)).toEqual({ status: "pending", err: null, slot: null });
    expect(X.mapStatus(null, t, t + X.LAND_TIMEOUT_MS + 1)).toMatchObject({ status: "failed", err: expect.stringContaining("expired") });
    expect(X.mapStatus({ slot: 5, err: null, confirmationStatus: "processed" }, t, t)).toEqual({ status: "pending", err: null, slot: 5 });
    expect(X.mapStatus({ slot: 5, err: null, confirmationStatus: "confirmed" }, t, t)).toEqual({ status: "confirmed", err: null, slot: 5 });
    expect(X.mapStatus({ slot: 6, err: null, confirmationStatus: "finalized" }, t, t)).toEqual({ status: "finalized", err: null, slot: 6 });
    expect(X.mapStatus({ slot: 7, err: { InstructionError: [2, { Custom: 6001 }] }, confirmationStatus: "confirmed" }, t, t)).toEqual({ status: "failed", err: '{"InstructionError":[2,{"Custom":6001}]}', slot: 7 });
  });
});
