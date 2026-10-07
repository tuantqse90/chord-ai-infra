// Auto-trade (src/autoTrade.ts), offline: fake Privy (users, wallets, wallet RPC), fake Jupiter (quote, swap), fake NOWNodes,
// fake Jupiter token audit. The fake wallet RPC checks our privy-authorization-signature against the canonicalize package
// (an independent RFC 8785 implementation) before it signs with the person's key.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import canonicalizePkg from "canonicalize";
import { generateKeyPairSync, verify as verifySig } from "node:crypto";
import { addr, useTempDb } from "../src/bots/_testkit";
import { emit } from "../src/bots/bus";
import { setBotsFetch } from "../src/bots/market";
import type { Fill } from "../src/bots/types";
import { setNowNodesFetch, _resetNowNodes } from "../src/nownodes";
import { AuthError } from "../src/privyAuth";
import { canonicalize, setPrivyFetch, _resetPrivyWallets } from "../src/privyWallets";
import { setJupiterFetch } from "../src/trade/solana";
import { setSolanaFetch } from "../src/rpc/solana";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("../src/bots");
const S = await import("../src/bots/store");
const X = await import("../src/agentExec");
const A = await import("../src/autoTrade");
const { autoTrade, _setAutoVerifier } = await import("../src/autoTradeRoutes");
const { agentExec } = await import("../src/agentExecRoutes");

const OWNER = "sess-auto-owner-1", OTHER = "sess-auto-other-1", DID = "did:privy:cmautotest0001";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT = addr(701), BAD_MINT = addr(702), W = addr(703), FOREIGN = addr(704), EVENT_AUTH = addr(705);
const person = Keypair.generate(), WALLET = person.publicKey.toBase58();
const stranger = Keypair.generate();
const auth = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const AUTH_KEY = `wallet-auth:${auth.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`;
const ENV = { NOWNODES_API_KEY: "test-nownodes-key", PRIVY_APP_ID: "test-app-id", PRIVY_APP_SECRET: "test-secret", PRIVY_AUTHORIZATION_PRIVATE_KEY: AUTH_KEY,
  PRIVY_SIGNER_QUORUM_ID: "quorum_test_1", PRIVY_SIGNER_POLICY_ID: "policy_test_1" } as const;
const prevEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const ata = (owner: string, mint: string) => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(TOKEN).toBuffer(), new PublicKey(mint).toBuffer()],
  new PublicKey(A.ATA_PROGRAM_ID))[0];

// ── fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Calls = { jup: string[]; swapBodies: any[]; now: { method: string; params: any[] }[]; privy: { method: string; path: string; body: any; authOk: boolean | null }[]; market: number; read: number };
let calls: Calls;
let signers: { signer_id: string; override_policy_ids?: string[] }[];
let swapMode: "ok" | "system" | "foreign" | "redirect" | "exactout";
let signMode: "ok" | "stranger" | "error";
let simErr: unknown;
let onSimulate: (() => void) | null;
let tokenBal: bigint;
let buildN = 0;

/** A Jupiter-shaped swap: like the real ones (scripts/auto-trade-check.ts), the mints, the token program and the event authority
 *  come from a lookup table and the person's token accounts are static. `table` adds more addresses to the table; `ataFor`
 *  puts an idempotent ATA create of the output mint for that owner in front. */
let lastTable: AddressLookupTableAccount | null = null;
const tableFor = (inMint: string, outMint: string, extra: PublicKey[] = []) => new AddressLookupTableAccount({ key: new PublicKey(addr(799)), state: {
  deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [new PublicKey(inMint), new PublicKey(outMint), new PublicKey(TOKEN), new PublicKey(EVENT_AUTH), ...extra] } });
/** The account data of a lookup table as the chain stores it (56-byte header, then the addresses). */
const tableData = (t: AddressLookupTableAccount) => {
  const head = Buffer.alloc(56);
  head.writeUInt32LE(1, 0); head.writeBigUInt64LE(t.state.deactivationSlot, 4);
  return Buffer.concat([head, ...t.state.addresses.map((a) => a.toBuffer())]).toString("base64");
};
function swapTx(user: PublicKey, inMint: string, outMint: string, o: { table?: PublicKey[]; ataFor?: PublicKey; middle?: { mint: string; owner?: PublicKey; program?: string } } = {}): string {
  const JUP = new PublicKey(A.JUPITER_V6);
  const disc = swapMode === "exactout" ? "d033ef977b2bed5c" : "e517cb977ae3ad2a";
  const dest = swapMode === "foreign" ? ata(FOREIGN, outMint) : ata(user.toBase58(), outMint);
  const redirect = swapMode === "redirect" ? ata(FOREIGN, outMint) : JUP;
  const ro = (pubkey: PublicKey, w = false) => ({ pubkey, isSigner: false, isWritable: w });
  const route = new TransactionInstruction({ programId: JUP, data: Buffer.concat([Buffer.from(disc, "hex"), Buffer.from(Uint32Array.of(++buildN).buffer)]), keys: [
    ro(new PublicKey(TOKEN)), { pubkey: user, isSigner: true, isWritable: false }, ro(ata(user.toBase58(), inMint), true), ro(dest, true), ro(redirect, swapMode === "redirect"),
    ro(new PublicKey(outMint)), ro(JUP), ro(new PublicKey(EVENT_AUTH)), ro(JUP),
  ] });
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000 })];
  if (o.ataFor) {
    ixs.push(new TransactionInstruction({ programId: new PublicKey(A.ATA_PROGRAM_ID), data: Buffer.from([1]), keys: [
      { pubkey: user, isSigner: true, isWritable: true }, ro(ata(o.ataFor.toBase58(), outMint), true), ro(o.ataFor), ro(new PublicKey(outMint)), ro(SystemProgram.programId), ro(new PublicKey(TOKEN)),
    ] }));
  }
  if (o.middle) { // the person's account of a middle token of the route, its mint and token program from the table (like Jupiter's)
    const owner = o.middle.owner ?? user, program = new PublicKey(o.middle.program ?? TOKEN);
    const midAta = PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), new PublicKey(o.middle.mint).toBuffer()], new PublicKey(A.ATA_PROGRAM_ID))[0];
    ixs.push(new TransactionInstruction({ programId: new PublicKey(A.ATA_PROGRAM_ID), data: Buffer.from([1]), keys: [
      { pubkey: user, isSigner: true, isWritable: true }, ro(midAta, true), ro(user), ro(new PublicKey(o.middle.mint)), ro(SystemProgram.programId), ro(program),
    ] }));
  }
  ixs.push(route);
  if (swapMode === "system") ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: new PublicKey(FOREIGN), lamports: 1_000_000 }));
  const extra = [...(o.table ?? []), ...(o.middle ? [new PublicKey(o.middle.mint), ...(o.middle.program ? [new PublicKey(o.middle.program)] : [])] : [])];
  const table = tableFor(inMint, outMint, extra);
  lastTable = table;
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message([table]);
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}
const sigOf = (b64: string) => bs58.encode(VersionedTransaction.deserialize(Buffer.from(b64, "base64")).signatures[0]);

function fakes(): void {
  calls = { jup: [], swapBodies: [], now: [], privy: [], market: 0, read: 0 };
  signers = [{ signer_id: ENV.PRIVY_SIGNER_QUORUM_ID, override_policy_ids: [ENV.PRIVY_SIGNER_POLICY_ID] }];
  swapMode = "ok"; signMode = "ok"; simErr = null; onSimulate = null; tokenBal = 10n ** 12n;
  setJupiterFetch(async (u, init) => {
    calls.jup.push(u);
    if (u.includes("/tokens/v2/search")) {
      const q = decodeURIComponent(u.split("query=")[1]);
      return json([{ id: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, icon: null }, { id: MINT, symbol: "BONKX", name: "Bonk X", decimals: 5, icon: null },
        { id: BAD_MINT, symbol: "RUGX", name: "Rug X", decimals: 6, icon: null }].filter((t) => q.includes(t.id)));
    }
    if (u.includes("/quote?")) {
      const p = new URL(u).searchParams;
      const outUsdc = p.get("outputMint") === USDC;
      return json({ inputMint: p.get("inputMint"), outputMint: p.get("outputMint"), inAmount: p.get("amount"), outAmount: outUsdc ? "5100000" : "3333300000", otherAmountThreshold: "1",
        priceImpactPct: "0.001", routePlan: [{ swapInfo: { label: "Raydium" } }], swapUsdValue: "5" });
    }
    if (u.endsWith("/swap")) {
      const b = JSON.parse(String(init?.body));
      calls.swapBodies.push(b);
      return json({ swapTransaction: swapTx(new PublicKey(b.userPublicKey), b.quoteResponse.inputMint, b.quoteResponse.outputMint), lastValidBlockHeight: 100 });
    }
    return json({ error: "unexpected" }, 404);
  });
  setBotsFetch(async (u) => {
    calls.market++;
    const q = decodeURIComponent(String(u).split("query=")[1] ?? "");
    const safe = { mintAuthorityDisabled: true, freezeAuthorityDisabled: true };
    return json([{ id: MINT, symbol: "BONKX", name: "Bonk X", decimals: 5, liquidity: 1e6, usdPrice: 0.0015, audit: safe },
      { id: BAD_MINT, symbol: "RUGX", name: "Rug X", decimals: 6, liquidity: 1e6, usdPrice: 1, audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true } }].filter((t) => q.includes(t.id)));
  });
  setNowNodesFetch(async (_u, init) => {
    const b = JSON.parse(String(init?.body));
    calls.now.push({ method: b.method, params: b.params });
    const ok = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });
    if (b.method === "simulateTransaction") { onSimulate?.(); return ok({ value: { err: simErr, logs: simErr ? ["Program log: Error: insufficient funds"] : ["Program JUP6 success"], unitsConsumed: 90_000 } }); }
    if (b.method === "sendTransaction") return ok(sigOf(b.params[0]));
    if (b.method === "getMultipleAccounts") {
      return ok({ value: b.params[0].map((k: string) => (lastTable && k === lastTable.key.toBase58() ? { owner: "AddressLookupTab1e1111111111111111111111111", data: [tableData(lastTable), "base64"] } : null)) });
    }
    if (b.method === "getSignatureStatuses") return ok({ value: [{ slot: 123, confirmations: 1, err: null, confirmationStatus: "confirmed" }] });
    if (b.method === "getTokenAccountsByOwner") {
      const mint = b.params[1].mint;
      return ok({ value: [{ pubkey: ata(WALLET, mint).toBase58(), account: { owner: TOKEN, data: { parsed: { info: { tokenAmount: { amount: String(tokenBal), decimals: 5 } } } } } }] });
    }
    return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not mocked" } });
  });
  setSolanaFetch(async () => { calls.read++; return json({ jsonrpc: "2.0", id: 1, result: null }); });
  setPrivyFetch(async (u, init) => {
    const url = new URL(u), h = new Headers(init?.headers), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    expect(h.get("authorization")).toBe(`Basic ${Buffer.from(`${ENV.PRIVY_APP_ID}:${ENV.PRIVY_APP_SECRET}`).toString("base64")}`);
    expect(h.get("privy-app-id")).toBe(ENV.PRIVY_APP_ID);
    let authOk: boolean | null = null;
    if (h.get("privy-authorization-signature")) {
      const payload = { version: 1, method: init?.method, url: u, body, headers: { "privy-app-id": ENV.PRIVY_APP_ID } };
      authOk = verifySig("sha256", Buffer.from(canonicalizePkg(payload)!), auth.publicKey, Buffer.from(h.get("privy-authorization-signature")!, "base64"));
    }
    calls.privy.push({ method: init?.method ?? "GET", path: url.pathname, body, authOk });
    if (url.pathname === `/v1/users/${DID}`) {
      return json({ id: DID, linked_accounts: [{ type: "email", address: "a@b.c" }, { type: "wallet", id: null, address: "0xabc", chain_type: "ethereum", wallet_client_type: "privy" },
        { type: "wallet", id: "wal_sol_1", address: WALLET, chain_type: "solana", wallet_client_type: "privy", connector_type: "embedded", wallet_index: 0, delegated: false }] });
    }
    if (url.pathname === "/v1/wallets/wal_sol_1") return json({ id: "wal_sol_1", address: WALLET, chain_type: "solana", policy_ids: [], owner_id: null, additional_signers: signers });
    if (url.pathname === "/v1/wallets/wal_sol_1/rpc") {
      if (!authOk) return json({ error: "Invalid authorization signature" }, 401);
      if (signMode === "error") return json({ error: "Policy denied this request" }, 403);
      const tx = VersionedTransaction.deserialize(Buffer.from(body.params.transaction, "base64"));
      tx.sign([person]);
      if (signMode === "stranger") tx.signatures[0] = Uint8Array.from(stranger.secretKey.subarray(0, 64)); // 64 bytes that are not the wallet's signature
      return json({ method: "signTransaction", data: { signed_transaction: Buffer.from(tx.serialize()).toString("base64"), encoding: "base64" } });
    }
    return json({ error: "not found" }, 404);
  });
}

let fillN = 0;
function fill(botId: string, o: Partial<Fill> = {}): Fill {
  const n = ++fillN, side = o.side ?? "buy", mint = o.mint ?? MINT;
  const f: Fill = { id: `af${n}`, botId, ts: Date.now() - 2_000, side, mint, symbol: mint === MINT ? "BONKX" : "RUGX", usd: 15, tokenAmount: 100, priceUsd: 0.15, status: "filled", reason: null,
    pnlUsd: null, quote: null, mode: "paper", source: { wallet: W, tx: `atx-${n}`, side, mint, symbol: "BONKX", usd: 500, priceUsd: 0.15, ts: Date.now() - 3_000, via: "websocket" }, ...o };
  expect(S.insertFill(f)).toBe(true);
  return f;
}
async function fire(botId: string, f: Fill): Promise<void> { emit(botId, { type: "fill", fill: f }); await A._autoTest.drain(); }
const lastEvent = (botId: string) => S.eventsOf(botId, 1)[0];
const req = (path: string, o: { method?: string; body?: unknown; session?: string | null; token?: string | null } = {}) => autoTrade.request(path, {
  method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
  headers: { ...(o.session === null ? {} : { "x-session": o.session ?? OWNER }), ...(o.token ? { "x-privy-token": o.token } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
  body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
});
const LIMITS = { perTradeUsd: 5, dailyUsd: 8, slippageBps: 100, days: 7, wallet: "" };
async function enable(limits: Partial<typeof LIMITS> = {}): Promise<Response> {
  return req("/enable", { body: { ...LIMITS, wallet: WALLET, ...limits }, token: "good-token" });
}

let copy: { id: string }, other: { id: string };
beforeAll(() => {
  E._resetBots(); X._execTest.reset(); A._autoTest.reset();
  tmp = useTempDb("auto-trade");
  copy = E.createBot(OWNER, { name: "Auto test", type: "copy", params: { wallets: [W], usdPerTrade: 15 } });
  other = E.createBot(OTHER, { name: "Other's agent", type: "copy", params: { wallets: [W], usdPerTrade: 15 } });
  _setAutoVerifier(async (t) => { if (t === "good-token") return { did: DID }; throw new AuthError(401, "AUTH_FAILED", "invalid token signature"); });
});
afterAll(() => {
  _setAutoVerifier(null); A._autoTest.reset(); X._execTest.reset(); E._resetBots(); tmp.restore();
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => {
  Object.assign(process.env, ENV);
  fakes();
  A._autoTest.setDeps({ sleep: async () => {}, pollMs: 0, confirmMs: 5_000 });
});
afterEach(() => {
  setJupiterFetch(null); setSolanaFetch(null); setBotsFetch(null); _resetNowNodes(); _resetPrivyWallets(); A._autoTest.setDeps(null);
});

describe("RFC 8785 + authorization signature", () => {
  it("canonicalize matches the canonicalize package on a wallet RPC payload", () => {
    const p = { version: 1, method: "POST", url: "https://api.privy.io/v1/wallets/x/rpc", body: { params: { transaction: "AQAB+/=", encoding: "base64" }, method: "signTransaction", n: 1.5, z: [3, "é", null, { b: 1, a: true }] }, headers: { "privy-app-id": "app" } };
    expect(canonicalize(p)).toBe(canonicalizePkg(p)!);
  });
});

describe("feature off", () => {
  it("without the Privy secret: status says so, enable is 503, nothing is called", async () => {
    delete process.env.PRIVY_APP_SECRET;
    const s = await (await req(`/status?botId=${copy.id}`)).json();
    expect(s).toMatchObject({ on: false, message: "Auto-trade is not switched on for this server yet", signer: null, grant: null });
    expect(s.missing).toContain("PRIVY_APP_SECRET");
    expect(JSON.stringify(s)).not.toContain(ENV.PRIVY_APP_ID); // names only, never values
    const r = await enable();
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "auto_off", message: "Auto-trade is not switched on for this server yet" });
    expect((await req(`/agents/${copy.id}`, { body: { on: true } })).status).toBe(503);
    expect(calls.privy.length + calls.jup.length + calls.now.length).toBe(0);
  });
  it("an unreadable authorization key is off too", async () => {
    process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY = "wallet-auth:bm90LWEta2V5";
    const s = await (await req("/status")).json();
    expect(s.on).toBe(false);
    expect(s.missing.join(" ")).toMatch(/not readable/);
  });
});

describe("grant", () => {
  it("enable needs a session and a Privy token; limits are checked", async () => {
    expect((await req("/enable", { body: LIMITS, session: null, token: "good-token" })).status).toBe(401);
    expect((await req("/enable", { body: LIMITS })).status).toBe(401);
    expect((await req("/enable", { body: LIMITS, token: "bad" })).status).toBe(401);
    for (const bad of [{ perTradeUsd: 0 }, { perTradeUsd: 101 }, { dailyUsd: 501 }, { slippageBps: 301 }, { slippageBps: 50.5 }, { days: 31 }, { days: 0 }]) {
      const r = await enable(bad);
      expect(r.status).toBe(400);
    }
    expect(calls.privy.length).toBe(0);
  });
  it("signer not on the wallet: 409 signer_missing (add), then without our policy (replace)", async () => {
    signers = [];
    const r = await enable();
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "signer_missing", fix: "add", quorumId: ENV.PRIVY_SIGNER_QUORUM_ID, policyId: ENV.PRIVY_SIGNER_POLICY_ID });
    signers = [{ signer_id: ENV.PRIVY_SIGNER_QUORUM_ID, override_policy_ids: [] }];
    expect(await (await enable()).json()).toMatchObject({ error: "signer_missing", fix: "replace" });
    expect((await req("/status")).status).toBe(200);
    expect((await (await req("/status")).json()).grant).toBeNull();
    expect(calls.privy.map((c) => `${c.method} ${c.path}`)).toContain(`GET /v1/users/${DID}`);
  });
  it("another wallet than the account's embedded one is refused", async () => {
    const r = await enable({ wallet: FOREIGN });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("no_wallet");
  });
  it("with our signer and policy: the grant is recorded, status shows the limits", async () => {
    const r = await enable();
    expect(r.status).toBe(200);
    expect((await r.json()).grant).toMatchObject({ enabled: true, wallet: WALLET, perTradeUsd: 5, dailyUsd: 8, slippageBps: 100 });
    const s = await (await req(`/status?botId=${copy.id}`)).json();
    expect(s).toMatchObject({ on: true, signer: { quorumId: ENV.PRIVY_SIGNER_QUORUM_ID, policyId: ENV.PRIVY_SIGNER_POLICY_ID }, spentTodayUsd: 0, agent: { botId: copy.id, autoExecute: false } });
    expect(s.grant.expiresAt - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  });
  it("agents: someone else's agent is 404, an alert agent 409, one's own copy agent turns on and is listened to", async () => {
    expect((await req(`/agents/${other.id}`, { body: { on: true } })).status).toBe(404);
    const alert = E.createBot(OWNER, { type: "alert", params: { wallets: [W], minUsd: 1000 } });
    expect((await req(`/agents/${alert.id}`, { body: { on: true } })).status).toBe(409);
    E.deleteBot(OWNER, alert.id);
    expect((await req(`/agents/${copy.id}`, { body: { on: "yes" } })).status).toBe(400);
    const r = await req(`/agents/${copy.id}`, { body: { on: true } });
    expect(await r.json()).toEqual({ botId: copy.id, autoExecute: true });
    expect(A._autoTest.subscribed()).toEqual([copy.id]);
    expect(lastEvent(copy.id).msg).toMatch(/^Auto-execute on/);
  });
});

describe("execution", () => {
  it("a BUY: capped to $5, built without wrapping SOL, checked, simulated, signed through Privy, sent and confirmed on NOWNodes", async () => {
    const f = fill(copy.id);
    await fire(copy.id, f);
    const q = calls.jup.find((u) => u.includes("/quote?"))!;
    expect(new URL(q).searchParams.get("inputMint")).toBe(USDC);
    expect(new URL(q).searchParams.get("outputMint")).toBe(MINT);
    expect(new URL(q).searchParams.get("amount")).toBe("5000000");
    expect(new URL(q).searchParams.get("slippageBps")).toBe("100");
    expect(calls.swapBodies[0]).toMatchObject({ userPublicKey: WALLET, wrapAndUnwrapSol: false });
    expect(calls.now.map((c) => c.method)).toEqual(["getMultipleAccounts", "simulateTransaction", "sendTransaction", "getSignatureStatuses"]);
    expect(calls.now[0].params[0]).toEqual([addr(799)]); // Jupiter's lookup table, read before the guard
    const rpc = calls.privy.find((c) => c.path.endsWith("/rpc"))!;
    expect(rpc.authOk).toBe(true);
    expect(rpc.body).toMatchObject({ method: "signTransaction", params: { encoding: "base64", transaction: calls.now[1].params[0] } });
    const sent = calls.now[2].params[0];
    expect(VersionedTransaction.deserialize(Buffer.from(sent, "base64")).signatures[0].some((b) => b !== 0)).toBe(true);
    const ex = X.myExecutions(OWNER, copy.id, 5, "auto");
    expect(ex[0]).toMatchObject({ fillId: f.id, side: "buy", mint: MINT, usd: 5, status: "confirmed", mode: "auto", via: "NOWNodes", signature: sigOf(sent) });
    expect(lastEvent(copy.id)).toMatchObject({ level: "info", msg: `Executed on-chain: BUY $5.00 BONKX · ${sigOf(sent)}` });
    const s = await (await req(`/status?botId=${copy.id}`)).json();
    expect(s.spentTodayUsd).toBe(5);
    expect(s.recent[0]).toMatchObject({ fillId: f.id, outcome: "confirmed", usd: 5, url: `https://solscan.io/tx/${sigOf(sent)}` });
    expect(calls.read).toBe(0);
  });
  it("one execution per fill: the same fill again does nothing, and the manual lane refuses it", async () => {
    const f = S.fillsOf(copy.id, 50).find((x) => x.id === "af1")!;
    await fire(copy.id, f);
    expect(calls.jup.length + calls.now.length + calls.privy.length).toBe(0);
    const r = await agentExec.request("/prepare", { method: "POST", headers: { "x-session": OWNER, "content-type": "application/json" }, body: JSON.stringify({ botId: copy.id, fillId: f.id, wallet: WALLET }) });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("already_executed");
  });
  it("the daily limit: $3 left is spent next, then the limit is reached (an event says so)", async () => {
    const f2 = fill(copy.id);
    await fire(copy.id, f2);
    expect(new URL(calls.jup.find((u) => u.includes("/quote?"))!).searchParams.get("amount")).toBe("3000000");
    expect(A._autoTest.run(f2.id)).toMatchObject({ outcome: "confirmed", usd: 3 });
    fakes();
    const f3 = fill(copy.id);
    await fire(copy.id, f3);
    expect(calls.jup.length + calls.privy.length).toBe(0);
    expect(A._autoTest.run(f3.id)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("today's limit is reached: $8.00 of $8.00") });
    expect(lastEvent(copy.id)).toMatchObject({ level: "warn", msg: expect.stringContaining("Auto-trade skipped this BUY of BONKX: today's limit is reached") });
  });
  it("a SELL sells what auto-trade bought for the agent (capped by the wallet), never more", async () => {
    // the agent's paper buys of MINT (tokenAmount 100 each, three of them) and now a sell of all 300
    const f = fill(copy.id, { side: "sell", tokenAmount: 300, usd: 40 });
    tokenBal = 10n ** 15n;
    await fire(copy.id, f);
    const q = new URL(calls.jup.find((u) => u.includes("/quote?"))!).searchParams;
    expect(q.get("inputMint")).toBe(MINT);
    expect(q.get("outputMint")).toBe(USDC);
    expect(q.get("amount")).toBe(String(2n * 3333300000n)); // the two confirmed auto buys' output, not the wallet's 10^15
    expect(lastEvent(copy.id).msg).toMatch(/^Executed on-chain: SELL 66,666 BONKX for \$5\.10 · /);
    // the daily limit counts buys only
    expect((await (await req("/status")).json()).spentTodayUsd).toBe(8);
    // nothing left that auto-trade bought: the next sell is refused, the person's own tokens stay
    fakes();
    const g = fill(copy.id, { side: "sell", tokenAmount: 100 });
    await fire(copy.id, g);
    expect(calls.jup.length).toBe(0);
    expect(A._autoTest.run(g.id)?.reason).toMatch(/nothing to sell \(your own BONKX is never sold\)/);
  });
});

describe("refusals", () => {
  beforeAll(() => { A.disableAutoTrade(OWNER); });
  beforeEach(async () => { expect((await enable({ dailyUsd: 500 })).status).toBe(200); A._autoTest.sync(); });
  it("a signal older than 30 s is not executed", async () => {
    const f = fill(copy.id, { ts: Date.now() - 31_000 });
    await fire(copy.id, f);
    expect(calls.jup.length).toBe(0);
    expect(A._autoTest.run(f.id)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("s old") });
  });
  it("a token with a live mint authority is not bought", async () => {
    const f = fill(copy.id, { mint: BAD_MINT });
    await fire(copy.id, f);
    expect(calls.jup.length).toBe(0);
    expect(lastEvent(copy.id).msg).toContain("RUGX still has a live mint authority");
  });
  it("a System transfer in the built transaction: refused before signing, Privy never asked", async () => {
    swapMode = "system";
    const f = fill(copy.id);
    await fire(copy.id, f);
    expect(calls.privy.some((c) => c.path.endsWith("/rpc"))).toBe(false);
    expect(calls.now.map((c) => c.method)).toEqual(["getMultipleAccounts"]); // the lookup table read, nothing simulated or sent
    expect(A._autoTest.run(f.id)).toMatchObject({ outcome: "failed", reason: "refused before signing: it calls a program outside the allowlist: 11111111111111111111111111111111" });
    expect(lastEvent(copy.id)).toMatchObject({ level: "error" });
  });
  it("output to a foreign token account, or redirected, or an exact-out instruction: refused before signing", async () => {
    for (const [mode, why] of [["foreign", "does not go to your wallet's own token account"], ["redirect", "sends its output to another account"], ["exactout", "not an exact-in swap"]] as const) {
      fakes(); swapMode = mode;
      const f = fill(copy.id);
      await fire(copy.id, f);
      expect(calls.privy.some((c) => c.path.endsWith("/rpc"))).toBe(false);
      expect(A._autoTest.run(f.id)?.reason).toContain(why);
      A.disableAutoTrade(OWNER); expect((await enable({ dailyUsd: 500 })).status).toBe(200); // reset the streak
    }
  });
  it("a signature Privy returns that is not the wallet's is never sent", async () => {
    signMode = "stranger";
    const f = fill(copy.id);
    await fire(copy.id, f);
    expect(calls.now.map((c) => c.method)).toEqual(["getMultipleAccounts", "simulateTransaction"]);
    expect(A._autoTest.run(f.id)?.reason).toMatch(/not your wallet's/);
  });
  it("a paused agent does not execute", async () => {
    E.setStatus(OWNER, copy.id, "paused");
    const f = fill(copy.id);
    await fire(copy.id, f);
    expect(A._autoTest.run(f.id)).toMatchObject({ outcome: "refused", reason: "the agent is paused" });
    E.setStatus(OWNER, copy.id, "running");
  });
  it("the kill switch: disabled while the trade is simulated = nothing is signed; disabled = nothing more is taken", async () => {
    onSimulate = () => { A.disableAutoTrade(OWNER); };
    const f = fill(copy.id);
    await fire(copy.id, f);
    expect(calls.privy.some((c) => c.path.endsWith("/rpc"))).toBe(false);
    expect(A._autoTest.run(f.id)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("auto-trade is off") });
    expect(A._autoTest.subscribed()).toEqual([]);
    fakes();
    const g = fill(copy.id);
    await fire(copy.id, g);
    expect(A._autoTest.run(g.id)).toBeNull();
    expect(calls.jup.length).toBe(0);
    const r = await req("/disable", { body: {} });
    expect(await r.json()).toEqual({ ok: true, removeSigners: true });
  });
  it("an expired grant switches itself off with the reason", async () => {
    const later = Date.now() + 8 * 86_400_000;
    A._autoTest.setDeps({ now: () => later, sleep: async () => {}, pollMs: 0 });
    const f = fill(copy.id, { ts: later - 1_000 });
    await fire(copy.id, f);
    expect(A._autoTest.run(f.id)?.reason).toMatch(/expired/);
    const s = await (await req("/status")).json();
    expect(s.grant).toMatchObject({ enabled: false, expired: true, disabledReason: expect.stringContaining("expired") });
    expect(A._autoTest.subscribed()).toEqual([]);
  });
  it("three failures in a row switch auto-trade off and say why", async () => {
    simErr = { InstructionError: [2, { Custom: 1 }] };
    for (let i = 0; i < 3; i++) await fire(copy.id, fill(copy.id));
    const s = await (await req("/status")).json();
    expect(s.grant).toMatchObject({ enabled: false, disabledReason: expect.stringContaining("3 auto trades failed in a row") });
    expect(S.eventsOf(copy.id, 5).some((e) => /Auto-trade switched off: 3 auto trades failed in a row/.test(e.msg))).toBe(true);
    fakes();
    const g = fill(copy.id);
    await fire(copy.id, g);
    expect(A._autoTest.run(g.id)).toBeNull();
    expect(calls.privy.length + calls.jup.length).toBe(0);
  });
  it("owner mismatch: another owner's agent never runs on this grant", async () => {
    const f = fill(other.id);
    await fire(other.id, f);
    expect(A._autoTest.run(f.id)).toBeNull();
    expect(calls.jup.length).toBe(0);
  });
});

describe("the guard on its own", () => {
  it("passes a plain Jupiter route and names its programs", () => {
    swapMode = "ok";
    const tx = swapTx(person.publicKey, USDC, MINT);
    expect(VersionedTransaction.deserialize(Buffer.from(tx, "base64")).message.addressTableLookups.length).toBe(1); // shaped like Jupiter's
    const c = A.checkSwapTx(tx, { wallet: WALLET, inMint: USDC, outMint: MINT });
    expect(c).toMatchObject({ swap: "route", destination: ata(WALLET, MINT).toBase58(), feePayer: WALLET, priorityLamports: 600 });
    expect(new Set(c.programs)).toEqual(new Set([A.COMPUTE_BUDGET, A.JUPITER_V6]));
    expect(() => A.checkSwapTx(tx, { wallet: FOREIGN, inMint: USDC, outMint: MINT })).toThrow(/fee payer/);
    expect(() => A.checkSwapTx(tx, { wallet: WALLET, inMint: USDC, outMint: BAD_MINT })).toThrow(/own token account/);
  });
  it("an idempotent ATA create: the person's own account passes, someone else's is refused", () => {
    swapMode = "ok";
    const mine = A.checkSwapTx(swapTx(person.publicKey, USDC, MINT, { ataFor: person.publicKey }), { wallet: WALLET, inMint: USDC, outMint: MINT });
    expect(mine.programs).toContain(A.ATA_PROGRAM_ID);
    expect(() => A.checkSwapTx(swapTx(person.publicKey, USDC, MINT, { ataFor: new PublicKey(FOREIGN) }), { wallet: WALLET, inMint: USDC, outMint: MINT })).toThrow(/someone else/);
  });
  it("a route through a middle token: the wallet's own account of it passes once the table is read, nothing else does", () => {
    swapMode = "ok";
    const MID = addr(706), T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    const want = { wallet: WALLET, inMint: USDC, outMint: MINT };
    const tx = swapTx(person.publicKey, USDC, MINT, { middle: { mint: MID } });
    expect(() => A.checkSwapTx(tx, want)).toThrow(/not your wallet's own account/); // the table unread: the mint is unknown, refused
    const c = A.checkSwapTx(tx, want, [tableFor(USDC, MINT, [new PublicKey(MID)])]);
    expect(c.middleAccounts).toEqual([MID]);
    expect(c.destination).toBe(ata(WALLET, MINT).toBase58());
    // under Token-2022 too
    const t22 = swapTx(person.publicKey, USDC, MINT, { middle: { mint: MID, program: T22 } });
    expect(A.checkSwapTx(t22, want, [tableFor(USDC, MINT, [new PublicKey(MID), new PublicKey(T22)])]).middleAccounts).toEqual([MID]);
    // a table that says another mint than the account was made for: refused
    expect(() => A.checkSwapTx(tx, want, [tableFor(USDC, MINT, [new PublicKey(addr(707))])])).toThrow(/not your wallet's own account/);
    // a program that is not a token program: refused
    const odd = swapTx(person.publicKey, USDC, MINT, { middle: { mint: MID, program: EVENT_AUTH } });
    expect(() => A.checkSwapTx(odd, want, [tableFor(USDC, MINT, [new PublicKey(MID), new PublicKey(EVENT_AUTH)])])).toThrow(/not your wallet's own account/);
    // the output mint read from the table must be the one asked
    expect(() => A.checkSwapTx(swapTx(person.publicKey, USDC, MINT), { ...want, outMint: MINT }, [tableFor(USDC, BAD_MINT)])).toThrow(/output token is not the one asked/);
  });
  it("a destination that can only be read through a lookup table is refused (it cannot be checked here)", () => {
    swapMode = "ok";
    const tx = swapTx(person.publicKey, USDC, MINT, { table: [ata(WALLET, MINT)] });
    expect(() => A.checkSwapTx(tx, { wallet: WALLET, inMint: USDC, outMint: MINT })).toThrow(/own token account/);
  });
  it("a priority fee above 0.002 SOL is refused", () => {
    swapMode = "ok";
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTx(person.publicKey, USDC, MINT), "base64"));
    const price = tx.message.compiledInstructions[1];
    price.data = Buffer.concat([Buffer.from([3]), Buffer.from(new BigUint64Array([10_000_000n]).buffer)]); // 10 lamports per CU × 300k CU = 3,000,000
    expect(() => A.checkSwapTx(Buffer.from(tx.serialize()).toString("base64"), { wallet: WALLET, inMint: USDC, outMint: MINT })).toThrow(/priority fee/);
  });
});
