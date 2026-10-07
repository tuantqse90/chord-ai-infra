// Execute an agent's signal for real, semi-auto and non-custodial (ask2049-notes/PROMPT-agents-marketplace.md C). The owner
// of an agent picks one of its fresh paper fills (a BUY or SELL at most 2 minutes old); the server builds the matching Jupiter
// swap for the person's own wallet and simulates it on NOWNodes; the page signs; the server sends it through NOWNodes and
// follows its status there. Every chain call of this lane goes to NOWNodes (src/nownodes.ts): no key = the lane is off and
// says so, never a fallback to the read RPC. Only a transaction whose message this server prepared is ever sent.
//   prepareExecution  quote (Jupiter) → build (Jupiter, for the wallet) → simulateTransaction (NOWNodes)
//   sendExecution     message-hash check → sendTransaction (NOWNodes) → an agent_executions row
//   executionStatus   getSignatureStatuses (NOWNodes) → pending | confirmed | finalized | failed, the row updated
import { Database } from "bun:sqlite";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config, USDC_MINT } from "./config";
import { NowNodesOffError, nowRpc, nownodesReady } from "./nownodes";
import { botRow, fillsOf, store as botStore } from "./bots/store";
import type { Fill } from "./bots/types";
import { isPubkey } from "./solana/tokens";
import { fromRaw, TradeError } from "./trade/amounts";
import { solBuild, solQuote } from "./trade/solana";

export const SIGNAL_TTL_MS = 120_000;   // a paper fill older than this is a stale signal: prices moved since
export const PREPARE_TTL_MS = 90_000;   // Jupiter's blockhash lives ~60-90 s; after that the signed transaction cannot land
export const LAND_TIMEOUT_MS = 150_000; // sent, still unknown to the chain after this = expired before reaching a block
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_FEE_RESERVE = 10_000_000n;    // lamports kept back when a sell spends native SOL (fees, temporary wSOL account)
const PREPARES_PER_MIN = 20;
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export class ExecError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ExecError";
  }
}

let now = () => Date.now();

// ── storage: one row per transaction NOWNodes accepted ─────────────────────────────────────────────────────────────────
let db: Database | null = null;
function store(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run(`CREATE TABLE IF NOT EXISTS agent_executions (sig TEXT PRIMARY KEY, bot_id TEXT NOT NULL, fill_id TEXT NOT NULL, owner TEXT NOT NULL,
    wallet TEXT NOT NULL, side TEXT NOT NULL, mint TEXT NOT NULL, symbol TEXT, usd REAL, in_amount TEXT, out_amount TEXT, at INTEGER NOT NULL,
    status TEXT NOT NULL, err TEXT, slot INTEGER, updated INTEGER NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS agent_executions_owner ON agent_executions (owner, at)");
  db.run("CREATE INDEX IF NOT EXISTS agent_executions_fill ON agent_executions (fill_id)");
  // mode: "manual" = signed by the person in the page (this file), "auto" = signed through the Privy session signer (src/autoTrade.ts)
  const cols = db.query("PRAGMA table_info(agent_executions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "mode")) db.run("ALTER TABLE agent_executions ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'");
  return db;
}

export type ExecStatus = "pending" | "confirmed" | "finalized" | "failed";
export type ExecMode = "manual" | "auto";
type Row = { sig: string; bot_id: string; fill_id: string; owner: string; wallet: string; side: string; mint: string; symbol: string | null; usd: number | null;
  in_amount: string | null; out_amount: string | null; at: number; status: ExecStatus; err: string | null; slot: number | null; updated: number; mode: ExecMode | null };
export type Execution = { signature: string; botId: string; fillId: string; wallet: string; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number | null;
  inAmount: string | null; outAmount: string | null; at: number; status: ExecStatus; err: string | null; slot: number | null; url: string; via: "NOWNodes"; mode: ExecMode };
const toExecution = (r: Row): Execution => ({
  signature: r.sig, botId: r.bot_id, fillId: r.fill_id, wallet: r.wallet, side: r.side as "buy" | "sell", mint: r.mint, symbol: r.symbol, usd: r.usd,
  inAmount: r.in_amount, outAmount: r.out_amount, at: r.at, status: r.status, err: r.err, slot: r.slot, url: `https://solscan.io/tx/${r.sig}`, via: "NOWNodes", mode: r.mode ?? "manual",
});
const rowOf = (sig: string) => store().query("SELECT * FROM agent_executions WHERE sig = ?").get(sig) as Row | null;
/** A transaction of this fill that is pending or landed: executing the same signal twice is refused. */
export const liveExecutionOf = (fillId: string) =>
  store().query("SELECT * FROM agent_executions WHERE fill_id = ? AND status IN ('pending', 'confirmed', 'finalized') ORDER BY at DESC LIMIT 1").get(fillId) as Row | null;

/** Another lane that executes signals (auto-trade, src/autoTrade.ts) says here which fills it holds, so one signal is never
 *  executed twice: a fill it is executing or executed is refused by prepare and send. */
let otherLane: (fillId: string) => string | null = () => null;
export function setOtherLaneCheck(f: ((fillId: string) => string | null) | null): void { otherLane = f ?? (() => null); }

/** The owner's executions, newest first (one agent with botId; one lane with mode). */
export function myExecutions(owner: string, botId?: string | null, limit = 50, mode?: ExecMode): Execution[] {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  const where = ["owner = ?", ...(botId ? ["bot_id = ?"] : []), ...(mode ? ["mode = ?"] : [])].join(" AND ");
  const rows = store().query(`SELECT * FROM agent_executions WHERE ${where} ORDER BY at DESC LIMIT ?`).all(owner, ...(botId ? [botId] : []), ...(mode ? [mode] : []), n);
  return (rows as Row[]).map(toExecution);
}

/** One transaction NOWNodes accepted, written by a lane that sent it (manual: sendExecution below; auto: src/autoTrade.ts). */
export function recordExecution(r: { sig: string; botId: string; fillId: string; owner: string; wallet: string; side: "buy" | "sell"; mint: string; symbol: string | null;
  usd: number | null; inAmount: string | null; outAmount: string | null; mode: ExecMode }): void {
  const t = now();
  store().run(`INSERT OR REPLACE INTO agent_executions (sig, bot_id, fill_id, owner, wallet, side, mint, symbol, usd, in_amount, out_amount, at, status, err, slot, updated, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
  [r.sig, r.botId, r.fillId, r.owner, r.wallet, r.side, r.mint, r.symbol, r.usd, r.inAmount, r.outAmount, t, t, r.mode]);
}
/** Write a status read on NOWNodes into the row (only when something changed). */
export function setExecutionStatus(sig: string, m: { status: ExecStatus; err: string | null; slot: number | null }): void {
  const row = rowOf(sig);
  if (!row || (row.status === m.status && row.slot === m.slot && row.err === m.err)) return;
  store().run("UPDATE agent_executions SET status = ?, err = ?, slot = ?, updated = ? WHERE sig = ?", [m.status, m.err, m.slot, now(), sig]);
}

/** For the public tape: the newest on-chain execution of each fill (no owner). Landed = status confirmed or finalized. */
export function executionsOf(fillIds: string[]): Record<string, { signature: string; at: number; status: ExecStatus; side: "buy" | "sell"; url: string; via: "NOWNodes"; mode: ExecMode }> {
  const ids = [...new Set(fillIds.filter((x) => typeof x === "string" && x))];
  const out: Record<string, { signature: string; at: number; status: ExecStatus; side: "buy" | "sell"; url: string; via: "NOWNodes"; mode: ExecMode }> = {};
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = store().query(`SELECT * FROM agent_executions WHERE fill_id IN (${part.map(() => "?").join(",")}) ORDER BY at ASC`).all(...part) as Row[];
    for (const r of rows) out[r.fill_id] = { signature: r.sig, at: r.at, status: r.status, side: r.side as "buy" | "sell", url: `https://solscan.io/tx/${r.sig}`, via: "NOWNodes", mode: r.mode ?? "manual" };
  }
  return out;
}

// ── prepared transactions (memory; the page refers to them by id and sends back only the signed copy) ────────────────
type Prepared = { id: string; owner: string; botId: string; fillId: string; wallet: string; side: "buy" | "sell"; mint: string; symbol: string | null;
  usd: number | null; inAmount: string; outAmount: string; hash: string; at: number; expiresAt: number };
const prepared = new Map<string, Prepared>();
const sweep = () => { const t = now(); for (const [k, p] of prepared) if (t > p.expiresAt) prepared.delete(k); };
const messageHash = (tx: VersionedTransaction) => createHash("sha256").update(tx.message.serialize()).digest("hex");

const rate = new Map<string, { m: number; n: number }>();
function limitPrepares(owner: string): void {
  const m = Math.floor(now() / 60_000), r = rate.get(owner);
  if (r && r.m === m && r.n >= PREPARES_PER_MIN) throw new ExecError(429, "rate_limited", `at most ${PREPARES_PER_MIN} executions prepared a minute`);
  rate.set(owner, r && r.m === m ? { m, n: r.n + 1 } : { m, n: 1 });
  if (rate.size > 5_000) for (const [k, v] of rate) if (v.m !== m) rate.delete(k);
}

/** NOWNodes call of this lane: lane off passes through (503); anything else is a 502 that names NOWNodes. */
async function nn<T>(method: string, params: unknown[]): Promise<T> {
  try { return await nowRpc<T>(method, params); } catch (e) {
    if (e instanceof NowNodesOffError) throw e;
    const msg = String((e as Error)?.message ?? e);
    throw new ExecError(502, "nownodes_error", msg.startsWith("NOWNodes") ? msg : `NOWNodes ${method} failed: ${msg}`);
  }
}

const tsMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);
const shortMint = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

/** The share of its holding the agent sold with this fill: replay the agent's filled buys and sells of the mint up to it. */
export function soldFraction(botId: string, fill: Pick<Fill, "id" | "mint" | "tokenAmount">): number {
  const rows = botStore().query("SELECT id, side, token_amount AS q FROM bot_fills WHERE bot_id = ? AND mint = ? AND status = 'filled' ORDER BY ts, rowid").all(botId, fill.mint) as { id: string; side: string; q: number }[];
  let held = 0;
  for (const r of rows) {
    if (r.id === fill.id) break;
    if (r.side === "buy") held += r.q;
    else { const left = held - r.q; held = left > held * 1e-6 ? left : 0; }
  }
  if (!(held > 0) || !(fill.tokenAmount > 0)) return 1;
  const f = fill.tokenAmount / held;
  return f >= 0.995 ? 1 : Math.max(0.0001, f);
}

type TokenAccounts = { value: { pubkey: string; account: { owner: string; data: { parsed?: { info?: { tokenAmount?: { amount: string; decimals: number } } } } } }[] };
/** The wallet's spendable balance of a mint, raw. Jupiter sells from the associated token account, so that one counts. */
async function walletBalance(wallet: string, mint: string): Promise<{ raw: bigint; decimals: number }> {
  if (mint === SOL_MINT) {
    const r = await nn<{ value: number }>("getBalance", [wallet, { commitment: "confirmed" }]);
    const lamports = BigInt(Math.max(0, Math.floor(Number(r?.value ?? 0))));
    return { raw: lamports > SOL_FEE_RESERVE ? lamports - SOL_FEE_RESERVE : 0n, decimals: 9 };
  }
  return tokenBalance(wallet, mint);
}
/** The balance of the wallet's token account for a mint (wSOL too: auto-trade keeps SOL wrapped), read on NOWNodes. */
export async function tokenBalance(wallet: string, mint: string): Promise<{ raw: bigint; decimals: number }> {
  const r = await nn<TokenAccounts>("getTokenAccountsByOwner", [wallet, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const accts = (r?.value ?? []).map((a) => ({ pubkey: a.pubkey, program: a.account?.owner, amt: a.account?.data?.parsed?.info?.tokenAmount }))
    .filter((a) => a.amt && /^\d+$/.test(String(a.amt.amount)));
  if (!accts.length) return { raw: 0n, decimals: 0 };
  const ata = (program: string) => {
    try { return PublicKey.findProgramAddressSync([new PublicKey(wallet).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0].toBase58(); } catch { return null; }
  };
  const pick = accts.find((a) => a.program && a.pubkey === ata(a.program)) ?? accts.reduce((a, b) => (BigInt(b.amt!.amount) > BigInt(a.amt!.amount) ? b : a));
  return { raw: BigInt(pick.amt!.amount), decimals: Number(pick.amt!.decimals) };
}

export type SimValue = { err: unknown; logs: string[] | null; unitsConsumed?: number };
/** A sentence for the simulation failures people actually hit. */
export function simHint(side: "buy" | "sell", sim: SimValue): string | null {
  if (sim.err == null) return null;
  const err = JSON.stringify(sim.err), logs = (sim.logs ?? []).join("\n");
  if (/AccountNotFound/.test(err)) return "This wallet has no SOL on chain yet: it needs a little SOL for the network fee.";
  if (/InsufficientFundsForFee|InsufficientFundsForRent/.test(err)) return "Not enough SOL in this wallet for the network fee.";
  if (/insufficient (funds|lamports)/i.test(logs)) return side === "buy" ? "Not enough USDC in this wallet for this buy." : "The wallet's balance changed since the quote: prepare again.";
  if (/0x1771|SlippageToleranceExceeded|slippage/i.test(`${err}\n${logs}`)) return "The price moved past the slippage limit: prepare again.";
  return null;
}

export type PrepareInput = { botId?: unknown; fillId?: unknown; wallet?: unknown; usd?: unknown; pct?: unknown; slippageBps?: unknown };
export type PrepareAnswer = {
  prepareId: string; tx: string; side: "buy" | "sell"; mint: string; symbol: string | null;
  signal: { fillId: string; ts: number; ageS: number; usd: number; tokenAmount: number };
  sell: { pct: number; walletBalance: string } | null;
  quote: { inAmount: string; outAmount: string; minOutAmount: string; inToken: { address: string; symbol: string; decimals: number }; outToken: { address: string; symbol: string; decimals: number };
    priceImpactPct: number | null; route: string[]; valueUsd: number | null; slippageBps: number; provider: "Jupiter" };
  simulation: { ok: boolean; err: string | null; unitsConsumed: number | null; logsTail: string[]; hint: string | null };
  via: "NOWNodes"; expiresAt: number;
};

const str = (v: unknown, max = 80) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** Build the swap that mirrors one of the owner's agent fills for the person's wallet, simulated on NOWNodes. */
export async function prepareExecution(owner: string, input: PrepareInput): Promise<PrepareAnswer> {
  if (!nownodesReady()) throw new NowNodesOffError();
  const botId = str(input?.botId), fillId = str(input?.fillId), wallet = str(input?.wallet, 64);
  if (!botId || !fillId) throw new ExecError(400, "bad_request", "send { botId, fillId, wallet }");
  if (!wallet || !isPubkey(wallet)) throw new ExecError(400, "bad_request", "wallet must be a Solana address");
  const slippageIn = input?.slippageBps == null ? null : Number(input.slippageBps);
  if (slippageIn != null && !(Number.isInteger(slippageIn) && slippageIn >= 10 && slippageIn <= 1000)) throw new ExecError(400, "bad_request", "slippageBps must be a whole number from 10 to 1000");
  limitPrepares(owner);

  const bot = botRow(botId);
  if (!bot || bot.owner !== owner) throw new ExecError(404, "not_found", "no such agent on your account");
  if (bot.type === "lp") throw new ExecError(409, "not_executable", "an LP agent moves liquidity, not swaps: there is no signal to execute");
  if (bot.type === "alert") throw new ExecError(409, "not_executable", "an alert agent does not trade: there is no signal to execute");
  const fill = fillsOf(botId, 500).find((f) => f.id === fillId);
  if (!fill) throw new ExecError(404, "not_found", "no such signal on this agent");
  if (fill.kind) throw new ExecError(409, "not_executable", "an LP move is not a swap: there is nothing to execute");
  if (fill.status !== "filled") throw new ExecError(409, "not_executable", `the agent skipped this signal${fill.reason ? ` (${fill.reason})` : ""}: there is nothing to execute`);
  if (fill.side !== "buy" && fill.side !== "sell") throw new ExecError(409, "not_executable", "only a BUY or a SELL can be executed");
  const age = now() - tsMs(fill.ts);
  if (age > SIGNAL_TTL_MS) throw new ExecError(410, "stale_signal", `this signal is ${ago(age)} old: prices have moved since, so it is no longer executed (signals stay open for 2 minutes)`);
  const done = liveExecutionOf(fillId);
  if (done) throw new ExecError(409, "already_executed", `this signal was already executed (${done.status}): ${done.sig}`, { signature: done.sig, status: done.status });
  const held = otherLane(fillId);
  if (held) throw new ExecError(409, "already_executed", held);
  const params = bot.params as { slippageBps?: number };
  const slippageBps = slippageIn ?? (Number.isInteger(params?.slippageBps) ? Math.min(1000, Math.max(10, params.slippageBps!)) : 100);
  const symbol = fill.symbol ?? null;

  let q: Awaited<ReturnType<typeof solQuote>>;
  let usd: number | null = null;
  let sell: PrepareAnswer["sell"] = null;
  try {
    if (fill.side === "buy") {
      usd = input?.usd == null ? fill.usd : Number(input.usd);
      if (!(Number.isFinite(usd) && usd >= 0.1 && usd <= 10_000)) throw new ExecError(400, "bad_request", "usd must be from 0.1 to 10000");
      q = await solQuote(USDC_MINT, fill.mint, usd.toFixed(6).replace(/\.?0+$/, ""), slippageBps);
    } else {
      const pctIn = input?.pct == null ? null : Number(input.pct);
      if (pctIn != null && !(Number.isFinite(pctIn) && pctIn > 0 && pctIn <= 100)) throw new ExecError(400, "bad_request", "pct must be more than 0 and at most 100");
      const share = pctIn != null ? pctIn / 100 : soldFraction(botId, fill);
      const bal = await walletBalance(wallet, fill.mint);
      const raw = share >= 0.995 ? bal.raw : (bal.raw * BigInt(Math.round(share * 1_000_000))) / 1_000_000n;
      if (raw <= 0n) throw new ExecError(409, "nothing_to_sell", `nothing to sell in this wallet: it holds no ${fill.mint === SOL_MINT ? "SOL beyond the 0.01 kept for fees" : symbol ?? shortMint(fill.mint)}`);
      sell = { pct: +(share * 100).toFixed(2), walletBalance: fromRaw(bal.raw, bal.decimals) };
      q = await solQuote(fill.mint, USDC_MINT, fromRaw(raw, bal.decimals), slippageBps);
      usd = Number(q.amountOut);
    }
  } catch (e) {
    if (e instanceof TradeError) throw new ExecError(e.status >= 500 ? 502 : 422, "no_quote", e.message);
    throw e;
  }
  let built: { transaction: string; lastValidBlockHeight: number };
  try { built = await solBuild(q.quoteId, wallet); } catch (e) {
    if (e instanceof TradeError) throw new ExecError(e.status >= 500 ? 502 : 422, "no_quote", e.message);
    throw e;
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
  const simR = await nn<{ value: SimValue }>("simulateTransaction", [built.transaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]);
  const sim: SimValue = simR?.value ?? { err: "no simulation result", logs: null };

  sweep();
  const at = now();
  const p: Prepared = { id: randomUUID(), owner, botId, fillId, wallet, side: fill.side, mint: fill.mint, symbol: symbol ?? (fill.side === "buy" ? q.tokenOut.symbol : q.tokenIn.symbol),
    usd, inAmount: q.amountIn, outAmount: q.amountOut, hash: messageHash(tx), at, expiresAt: at + PREPARE_TTL_MS };
  prepared.set(p.id, p);
  const tok = (t: { address: string; symbol: string; decimals: number }) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals });
  return {
    prepareId: p.id, tx: built.transaction, side: fill.side, mint: fill.mint, symbol: p.symbol,
    signal: { fillId, ts: tsMs(fill.ts), ageS: Math.round(age / 1000), usd: fill.usd, tokenAmount: fill.tokenAmount },
    sell,
    quote: { inAmount: q.amountIn, outAmount: q.amountOut, minOutAmount: q.minAmountOut, inToken: tok(q.tokenIn), outToken: tok(q.tokenOut),
      priceImpactPct: q.priceImpactPct, route: q.route, valueUsd: q.valueUsd, slippageBps, provider: "Jupiter" },
    simulation: { ok: sim.err == null, err: sim.err == null ? null : typeof sim.err === "string" ? sim.err : JSON.stringify(sim.err),
      unitsConsumed: sim.unitsConsumed ?? null, logsTail: (sim.logs ?? []).slice(-8), hint: simHint(fill.side, sim) },
    via: "NOWNodes", expiresAt: p.expiresAt,
  };
}

/** Send the signed copy of a prepared transaction through NOWNodes; anything but the prepared message is refused. */
export async function sendExecution(owner: string, input: { prepareId?: unknown; signedTx?: unknown }): Promise<{ signature: string; status: ExecStatus; via: "NOWNodes" }> {
  if (!nownodesReady()) throw new NowNodesOffError();
  const prepareId = str(input?.prepareId), signedTx = str(input?.signedTx, 4_000);
  if (!prepareId || !signedTx) throw new ExecError(400, "bad_request", "send { prepareId, signedTx (base64) }");
  sweep();
  const p = prepared.get(prepareId);
  if (!p || p.owner !== owner) throw new ExecError(410, "expired", "this execution expired or was never prepared here: prepare it again");
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(signedTx, "base64")); } catch { throw new ExecError(400, "bad_request", "signedTx is not a Solana transaction"); }
  if (messageHash(tx) !== p.hash) throw new ExecError(403, "not_prepared", "the signed transaction is not the one prepared: refused (sign the prepared transaction as it is)");
  const sig0 = tx.signatures[0];
  if (!sig0 || sig0.every((b) => b === 0)) throw new ExecError(400, "not_signed", "the transaction is not signed");
  const done = liveExecutionOf(p.fillId);
  if (done) throw new ExecError(409, "already_executed", `this signal was already executed (${done.status}): ${done.sig}`, { signature: done.sig, status: done.status });
  const held = otherLane(p.fillId);
  if (held) throw new ExecError(409, "already_executed", held);
  let sig: string;
  try {
    sig = await nowRpc<string>("sendTransaction", [signedTx, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
  } catch (e) {
    if (e instanceof NowNodesOffError) throw e;
    const msg = String((e as Error)?.message ?? e);
    // The node refused it (preflight failed): nothing reached the chain, nothing was spent.
    if (/^NOWNodes sendTransaction:/.test(msg)) throw new ExecError(422, "send_refused", `${msg}. Nothing was sent.`);
    throw new ExecError(502, "nownodes_error", msg.startsWith("NOWNodes") ? msg : `NOWNodes sendTransaction failed: ${msg}`);
  }
  if (typeof sig !== "string" || !sig) sig = bs58.encode(sig0);
  recordExecution({ sig, botId: p.botId, fillId: p.fillId, owner, wallet: p.wallet, side: p.side, mint: p.mint, symbol: p.symbol, usd: p.usd, inAmount: p.inAmount, outAmount: p.outAmount, mode: "manual" });
  prepared.delete(p.id);
  return { signature: sig, status: "pending", via: "NOWNodes" };
}

export type SigStatus = { slot?: number; confirmations?: number | null; err: unknown; confirmationStatus?: string | null } | null;
/** getSignatureStatuses → our four states. Unknown to the chain long after sending = expired before reaching a block. */
export function mapStatus(s: SigStatus, sentAt: number, at = now()): { status: ExecStatus; err: string | null; slot: number | null } {
  if (!s) {
    return at - sentAt > LAND_TIMEOUT_MS
      ? { status: "failed", err: "not landed: the transaction expired before reaching a block (nothing was spent)", slot: null }
      : { status: "pending", err: null, slot: null };
  }
  const slot = typeof s.slot === "number" ? s.slot : null;
  if (s.err != null) return { status: "failed", err: typeof s.err === "string" ? s.err : JSON.stringify(s.err), slot };
  if (s.confirmationStatus === "finalized") return { status: "finalized", err: null, slot };
  if (s.confirmationStatus === "confirmed") return { status: "confirmed", err: null, slot };
  return { status: "pending", err: null, slot };
}

/** The status of one of the owner's executions, read on NOWNodes (final states answer from the row). */
export async function executionStatus(owner: string, sig: string): Promise<{ signature: string; status: ExecStatus; err: string | null; slot: number | null; url: string; via: "NOWNodes" }> {
  const row = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig) ? rowOf(sig) : null;
  if (!row || row.owner !== owner) throw new ExecError(404, "not_found", "no execution with this signature on your account");
  const answer = (r: { status: ExecStatus; err: string | null; slot: number | null }) => ({ signature: sig, ...r, url: `https://solscan.io/tx/${sig}`, via: "NOWNodes" as const });
  if (row.status === "finalized" || row.status === "failed") return answer({ status: row.status, err: row.err, slot: row.slot });
  if (!nownodesReady()) throw new NowNodesOffError();
  const r = await nn<{ value: SigStatus[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
  const m = mapStatus(r?.value?.[0] ?? null, row.at);
  setExecutionStatus(sig, m);
  return answer(m);
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const _execTest = {
  prepared, messageHash,
  setNow(f: (() => number) | null) { now = f ?? (() => Date.now()); },
  reset() { db?.close(); db = null; prepared.clear(); rate.clear(); now = () => Date.now(); otherLane = () => null; },
};
