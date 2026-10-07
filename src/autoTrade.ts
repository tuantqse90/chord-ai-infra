// Auto-trade (owner 07/10): an agent's fills are executed on-chain without a per-trade approval, non-custodially. The person
// grants once, in the page: their Privy Solana wallet gets our key quorum as a session signer under our policy (client
// addSigners), then POST /v1/agents/auto/enable records their limits. From then on every FILLED buy / sell of an agent they
// marked "auto-execute" is mirrored on their wallet:
//   Jupiter quote → Jupiter build (wrapAndUnwrapSol false) → instruction allowlist + destination check → simulateTransaction
//   (NOWNodes) → signTransaction (Privy wallet RPC, our authorization key) → signature check → sendTransaction (NOWNodes)
//   → getSignatureStatuses (NOWNodes) → an agent_executions row (mode "auto") and an event on the agent.
// Nothing falls back to anything: no Privy secret / quorum / policy / key, or no NOWNodes key = auto-trade is off and says so.
//
// Decision (engine): agents stay in paper mode and keep running their paper logic; their fills are the signals. "Auto-execute"
// is a row in auto_agents (owner, bot_id) beside the agent, not a bot mode, so src/bots never changes and createBot keeps
// refusing mode "live". Paper fills stay exactly as they are; this file only listens to them on the bus.
//
// Rules, all checked for every fill (any "no" is an event on the agent with the reason, never a silent drop):
//   - the owner's grant is enabled and not expired; the agent is the grant owner's, marked auto-execute, and running
//   - the fill is a FILLED buy / sell at most 30 s old; one execution per fill (auto_runs is keyed by fill id, and a fill the
//     manual lane already executed is refused); at most one trade in flight per wallet (a queue of 5, the 30 s rule still holds)
//   - USDC ↔ token only: a buy spends USDC (the fill's USD, capped by the per-trade limit and what is left of the daily limit),
//     a sell sells only what auto-trade bought for that agent (never the person's other holdings), in the share the agent sold
//   - buys skip tokens with a live (or unknown) mint or freeze authority (Jupiter's audit, as the paper agents do)
//   - slippage: the agent's own, capped by the grant's
//   - the built transaction: fee payer = the person's wallet and the only signer; every top-level instruction is Jupiter v6
//     (a known ExactIn swap), ComputeBudget or an idempotent ATA create for the person; the swap's output lands in the person's
//     own associated token account of the output mint and is not redirected; priority fee at most 0.002 SOL
//   - 3 failures in a row (build, guard, simulation, signing, sending, or a transaction that failed on-chain) switch auto-trade
//     off for the owner with the reason; POST /disable and pausing the agent stop it at once (re-checked right before signing)
// Caps bound buys (USDC spent). Sells are bounded by construction (only tokens auto-trade bought for that agent) and are not
// counted against the daily limit, so a person who hit the cap can still exit.
import { Database } from "bun:sqlite";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { config, USDC_MINT } from "./config";
import { liveExecutionOf, mapStatus, recordExecution, setExecutionStatus, setOtherLaneCheck, simHint, soldFraction, tokenBalance, type SigStatus, type SimValue } from "./agentExec";
import { subscribe } from "./bots/bus";
import { logEvent } from "./bots/executor";
import { tokenInfo } from "./bots/market";
import { botRow } from "./bots/store";
import type { Fill } from "./bots/types";
import { logger } from "./chord/utils/logger";
import { NowNodesOffError, nowRpc, nownodesReady } from "./nownodes";
import { embeddedSolanaWallet, PrivyApiError, privyServerConfig, signerOnWallet, signSolanaTransaction } from "./privyWallets";
import { isPubkey } from "./solana/tokens";
import { fromRaw, toRaw, TradeError } from "./trade/amounts";
import { solBuild, solQuote } from "./trade/solana";

export const MAX_FILL_AGE_MS = 30_000;
export const LIMITS = { perTradeUsd: [1, 100], dailyUsd: [1, 500], slippageBps: [10, 300], days: [1, 30] } as const;
export const MIN_TRADE_USD = 0.5;
export const STREAK_LIMIT = 3;
export const MAX_QUEUE = 5;
export const MAX_PRIORITY_LAMPORTS = 2_000_000; // 0.002 SOL of priority fee at most (Jupiter builds with a 0.001 SOL ceiling)
const OFF_MSG = "Auto-trade is not switched on for this server yet";
const TRADING_TYPES = new Set(["copy", "custom"]);

export const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const ALLOWED_PROGRAMS = [JUPITER_V6, COMPUTE_BUDGET, ATA_PROGRAM_ID] as const;
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
// A route through a middle token (USDC › SOL › meme on Pump.fun AMM, 07/10) makes Jupiter open the wallet's own account of that
// token first: rent ≈ 0.002 SOL each, kept in the wallet's account (closing it returns the rent).
export const MAX_MIDDLE_ACCOUNTS = 3;
// Jupiter v6 ExactIn swap instructions, from the program's on-chain Anchor IDL (account C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa,
// read 07/10/2026): the account index of the signer (user_transfer_authority), of the account the output lands in, of the
// optional destination_token_account that would send it elsewhere (None = the program id itself) and of destination_mint.
// Every other Jupiter instruction (exact-out, token ledger, claim, close, create…) is refused.
const JUP_SWAPS: Record<string, { name: string; authority: number; dest: number; redirect: number | null; outMint: number }> = {
  e517cb977ae3ad2a: { name: "route", authority: 1, dest: 3, redirect: 4, outMint: 5 },
  c1209b3341d69c81: { name: "shared_accounts_route", authority: 2, dest: 6, redirect: null, outMint: 8 },
  bb64facc31c4af14: { name: "route_v2", authority: 0, dest: 2, redirect: 7, outMint: 4 },
  d19853937cfed8e9: { name: "shared_accounts_route_v2", authority: 1, dest: 5, redirect: null, outMint: 7 },
};

export class AutoError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); this.name = "AutoError"; }
}
/** Why one fill was not executed. failure = an error on the way (counts toward the streak); otherwise a rule said no. */
class Refusal extends Error {
  constructor(message: string, readonly failure: boolean) { super(message); this.name = "Refusal"; }
}
const refuse = (m: string) => new Refusal(m, false);
const failed = (m: string) => new Refusal(m, true);

// ── timing (tests replace it) ────────────────────────────────────────────────────────────────────────────────────────────
type Deps = { now: () => number; sleep: (ms: number) => Promise<void>; pollMs: number; confirmMs: number };
const defaultDeps = (): Deps => ({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), pollMs: 2_000, confirmMs: 75_000 });
let deps: Deps = defaultDeps();
const now = () => deps.now();

// ── config ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type AutoConfig = { on: boolean; message: string | null; missing: string[]; quorumId: string | null; policyId: string | null };
/** On only with every Privy setting, a readable authorization key and the NOWNodes key. Names of what is missing, never values. */
export function autoConfig(): AutoConfig {
  const p = privyServerConfig();
  const missing = [...(p.ok ? [] : p.missing), ...(nownodesReady() ? [] : ["NOWNODES_API_KEY"])];
  if (p.ok && !missing.length) return { on: true, message: null, missing: [], quorumId: p.quorumId, policyId: p.policyId };
  return { on: false, message: OFF_MSG, missing: !p.ok && p.problem ? [...missing, p.problem] : missing, quorumId: null, policyId: null };
}

// ── storage ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
let db: Database | null = null;
function store(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run(`CREATE TABLE IF NOT EXISTS auto_trade (owner TEXT PRIMARY KEY, privy_user TEXT NOT NULL, wallet TEXT NOT NULL, wallet_id TEXT NOT NULL,
    per_trade_usd REAL NOT NULL, daily_usd REAL NOT NULL, slippage_bps INTEGER NOT NULL, expires_at INTEGER NOT NULL, enabled INTEGER NOT NULL,
    streak INTEGER NOT NULL DEFAULT 0, disabled_reason TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  db.run("CREATE TABLE IF NOT EXISTS auto_agents (owner TEXT NOT NULL, bot_id TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (owner, bot_id))");
  // one row per fill auto-trade looked at (the idempotency key) and what came of it: queued → running → sent → confirmed | failed, or refused
  db.run(`CREATE TABLE IF NOT EXISTS auto_runs (fill_id TEXT PRIMARY KEY, owner TEXT NOT NULL, bot_id TEXT NOT NULL, wallet TEXT NOT NULL, side TEXT NOT NULL,
    mint TEXT NOT NULL, symbol TEXT, usd REAL, in_raw TEXT, out_raw TEXT, at INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT, sig TEXT, updated INTEGER NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS auto_runs_owner ON auto_runs (owner, at)");
  db.run("CREATE INDEX IF NOT EXISTS auto_runs_wallet ON auto_runs (wallet, at)");
  db.run("CREATE INDEX IF NOT EXISTS auto_runs_held ON auto_runs (owner, bot_id, mint)");
  return db;
}

type GrantRow = { owner: string; privy_user: string; wallet: string; wallet_id: string; per_trade_usd: number; daily_usd: number; slippage_bps: number;
  expires_at: number; enabled: number; streak: number; disabled_reason: string | null; created: number; updated: number };
export type Grant = { enabled: boolean; expired: boolean; wallet: string; perTradeUsd: number; dailyUsd: number; slippageBps: number; expiresAt: number;
  disabledReason: string | null; failuresInARow: number; createdAt: number; updatedAt: number };
const grantRow = (owner: string) => store().query("SELECT * FROM auto_trade WHERE owner = ?").get(owner) as GrantRow | null;
const toGrant = (g: GrantRow): Grant => ({ enabled: g.enabled === 1 && g.expires_at > now(), expired: g.expires_at <= now(), wallet: g.wallet, perTradeUsd: g.per_trade_usd,
  dailyUsd: g.daily_usd, slippageBps: g.slippage_bps, expiresAt: g.expires_at, disabledReason: g.disabled_reason, failuresInARow: g.streak, createdAt: g.created, updatedAt: g.updated });
const isAutoAgent = (owner: string, botId: string) => !!store().query("SELECT 1 FROM auto_agents WHERE owner = ? AND bot_id = ?").get(owner, botId);
const autoAgentsOf = (owner: string) => (store().query("SELECT bot_id FROM auto_agents WHERE owner = ? ORDER BY created").all(owner) as { bot_id: string }[]).map((r) => r.bot_id);

type RunRow = { fill_id: string; owner: string; bot_id: string; wallet: string; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number | null;
  in_raw: string | null; out_raw: string | null; at: number; outcome: "queued" | "running" | "sent" | "confirmed" | "failed" | "refused"; reason: string | null; sig: string | null; updated: number };
function setRun(fillId: string, patch: Partial<Pick<RunRow, "usd" | "in_raw" | "out_raw" | "outcome" | "reason" | "sig" | "symbol">>): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  store().run(`UPDATE auto_runs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ? WHERE fill_id = ?`, [...keys.map((k) => patch[k] ?? null), now(), fillId]);
}
const utcMidnight = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000;
/** USDC the wallet's auto buys spent today (UTC): in flight, sent and confirmed. */
export function spentToday(wallet: string): number {
  const r = store().query("SELECT COALESCE(SUM(usd), 0) AS s FROM auto_runs WHERE wallet = ? AND side = 'buy' AND outcome IN ('running', 'sent', 'confirmed') AND at >= ?").get(wallet, utcMidnight(now())) as { s: number };
  return Math.round(Number(r?.s ?? 0) * 100) / 100;
}
/** Raw amount of a mint auto-trade bought for this agent and has not sold: confirmed buys minus sells sent or confirmed. */
function heldRaw(owner: string, botId: string, mint: string): bigint {
  const rows = store().query("SELECT side, in_raw, out_raw, outcome FROM auto_runs WHERE owner = ? AND bot_id = ? AND mint = ? AND outcome IN ('sent', 'confirmed')").all(owner, botId, mint) as Pick<RunRow, "side" | "in_raw" | "out_raw" | "outcome">[];
  let held = 0n;
  for (const r of rows) {
    if (r.side === "buy" && r.outcome === "confirmed" && /^\d+$/.test(r.out_raw ?? "")) held += BigInt(r.out_raw!);
    if (r.side === "sell" && /^\d+$/.test(r.in_raw ?? "")) held -= BigInt(r.in_raw!);
  }
  return held > 0n ? held : 0n;
}

// ── grant: enable / disable / agents / status ────────────────────────────────────────────────────────────────────────────
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
function inRange(name: string, v: unknown, [lo, hi]: readonly [number, number], whole = false): number {
  const n = num(v);
  if (!Number.isFinite(n) || n < lo || n > hi || (whole && !Number.isInteger(n))) throw new AutoError(400, "bad_request", `${name} must be ${whole ? "a whole number " : ""}from ${lo} to ${hi}`);
  return whole ? n : Math.round(n * 100) / 100;
}
function requireOn(): AutoConfig & { quorumId: string; policyId: string } {
  const c = autoConfig();
  if (!c.on) throw new AutoError(503, "auto_off", OFF_MSG, { missing: c.missing });
  return c as AutoConfig & { quorumId: string; policyId: string };
}

export type EnableInput = { perTradeUsd?: unknown; dailyUsd?: unknown; slippageBps?: unknown; days?: unknown; wallet?: unknown };
/** Record the owner's limits, after checking with Privy that the signed-in person's Solana wallet carries our session signer. */
export async function enableAutoTrade(owner: string, did: string, input: EnableInput): Promise<Grant> {
  const c = requireOn();
  const perTradeUsd = inRange("perTradeUsd", input?.perTradeUsd, LIMITS.perTradeUsd);
  const dailyUsd = inRange("dailyUsd", input?.dailyUsd, LIMITS.dailyUsd);
  const slippageBps = inRange("slippageBps", input?.slippageBps ?? 100, LIMITS.slippageBps, true);
  const days = inRange("days", input?.days ?? 7, LIMITS.days, true);
  const want = typeof input?.wallet === "string" && input.wallet ? input.wallet : null;
  if (want && !isPubkey(want)) throw new AutoError(400, "bad_request", "wallet must be a Solana address");
  let w: Awaited<ReturnType<typeof embeddedSolanaWallet>>;
  try {
    w = await embeddedSolanaWallet(did, want);
    if (!w) throw new AutoError(409, "no_wallet", want ? "This Solana wallet is not the embedded wallet of your Chord account." : "Your Chord account has no Solana wallet yet.");
    if (!w.id) throw new AutoError(409, "no_wallet", "Your Chord wallet cannot take a session signer (it is not a server-side wallet on Privy), so auto-trade cannot use it.");
    const s = await signerOnWallet(w.id, w.address, c.quorumId, c.policyId);
    if (!s.ok) throw new AutoError(409, "signer_missing", s.message, { fix: s.fix, quorumId: c.quorumId, policyId: c.policyId });
  } catch (e) {
    if (e instanceof PrivyApiError) throw new AutoError(e.status === 409 ? 409 : 502, "privy_error", e.message);
    throw e;
  }
  const t = now();
  store().run(`INSERT INTO auto_trade (owner, privy_user, wallet, wallet_id, per_trade_usd, daily_usd, slippage_bps, expires_at, enabled, streak, disabled_reason, created, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)
    ON CONFLICT(owner) DO UPDATE SET privy_user = excluded.privy_user, wallet = excluded.wallet, wallet_id = excluded.wallet_id, per_trade_usd = excluded.per_trade_usd,
      daily_usd = excluded.daily_usd, slippage_bps = excluded.slippage_bps, expires_at = excluded.expires_at, enabled = 1, streak = 0, disabled_reason = NULL, updated = excluded.updated`,
  [owner, did, w.address, w.id!, perTradeUsd, dailyUsd, slippageBps, t + days * 86_400_000, t, t]);
  announce(owner, "info", `Auto-trade on for this account: up to $${perTradeUsd} a trade and $${dailyUsd} a day from ${short(w.address)}, slippage at most ${slippageBps / 100}%, for ${days} day${days > 1 ? "s" : ""}.`);
  syncSubs();
  return toGrant(grantRow(owner)!);
}

/** The kill switch: off at once (a trade not yet signed is refused right before signing). Works with the feature off too. */
export function disableAutoTrade(owner: string, reason = "switched off"): boolean {
  const g = grantRow(owner);
  if (!g) return false;
  if (g.enabled === 1) {
    store().run("UPDATE auto_trade SET enabled = 0, disabled_reason = ?, updated = ? WHERE owner = ?", [reason, now(), owner]);
    announce(owner, reason === "switched off" ? "info" : "warn", reason === "switched off" ? "Auto-trade switched off: nothing more is executed on-chain." : `Auto-trade switched off: ${reason}.`);
  }
  syncSubs();
  return true;
}

/** Mark one of the owner's trading agents auto-execute (on needs an enabled grant), or unmark it. */
export function setAutoAgent(owner: string, botId: string, on: unknown): { botId: string; autoExecute: boolean } {
  if (typeof on !== "boolean") throw new AutoError(400, "bad_request", "send { on: true | false }");
  const bot = typeof botId === "string" ? botRow(botId) : null;
  if (!bot || bot.owner !== owner) throw new AutoError(404, "not_found", "no such agent on your account");
  if (!on) {
    if (store().run("DELETE FROM auto_agents WHERE owner = ? AND bot_id = ?", [owner, botId]).changes) logEvent(botId, "info", "Auto-execute off: this agent's fills stay on paper.", now());
    syncSubs();
    return { botId, autoExecute: false };
  }
  if (!TRADING_TYPES.has(bot.type)) throw new AutoError(409, "not_executable", bot.type === "lp" ? "an LP agent moves liquidity, not swaps: there is nothing to auto-execute" : "an alert agent does not trade: there is nothing to auto-execute");
  requireOn();
  const g = grantRow(owner);
  if (!g || g.enabled !== 1 || g.expires_at <= now()) throw new AutoError(409, "auto_disabled", "Enable auto-trade for your account first.");
  if (store().run("INSERT OR IGNORE INTO auto_agents (owner, bot_id, created) VALUES (?, ?, ?)", [owner, botId, now()]).changes) {
    logEvent(botId, "info", `Auto-execute on: each new BUY or SELL is executed from ${short(g.wallet)} within your limits ($${g.per_trade_usd} a trade, $${g.daily_usd} a day).`, now());
  }
  syncSubs();
  return { botId, autoExecute: true };
}

export type AutoRun = { fillId: string; botId: string; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number | null; at: number;
  outcome: RunRow["outcome"]; reason: string | null; signature: string | null; url: string | null };
const toRun = (r: RunRow): AutoRun => ({ fillId: r.fill_id, botId: r.bot_id, side: r.side, mint: r.mint, symbol: r.symbol, usd: r.usd, at: r.at, outcome: r.outcome,
  reason: r.reason, signature: r.sig, url: r.sig ? `https://solscan.io/tx/${r.sig}` : null });
export type AutoStatus = {
  on: boolean; message: string | null; missing: string[]; signer: { quorumId: string; policyId: string } | null;
  grant: Grant | null; spentTodayUsd: number; agents: string[]; agent: { botId: string; autoExecute: boolean } | null; recent: AutoRun[];
  limits: typeof LIMITS; via: "NOWNodes";
};
export function autoStatus(owner: string, botId?: string | null): AutoStatus {
  const c = autoConfig();
  const g = grantRow(owner);
  const runs = (botId
    ? store().query("SELECT * FROM auto_runs WHERE owner = ? AND bot_id = ? ORDER BY at DESC LIMIT 10").all(owner, botId)
    : store().query("SELECT * FROM auto_runs WHERE owner = ? ORDER BY at DESC LIMIT 10").all(owner)) as RunRow[];
  return {
    on: c.on, message: c.message, missing: c.missing, signer: c.on ? { quorumId: c.quorumId!, policyId: c.policyId! } : null,
    grant: g ? toGrant(g) : null, spentTodayUsd: g ? spentToday(g.wallet) : 0, agents: autoAgentsOf(owner),
    agent: botId ? { botId, autoExecute: isAutoAgent(owner, botId) } : null, recent: runs.map(toRun), limits: LIMITS, via: "NOWNodes",
  };
}

// ── the transaction guard ────────────────────────────────────────────────────────────────────────────────────────────────
export class GuardError extends Error { constructor(message: string) { super(message); this.name = "GuardError"; } }
export type TxCheck = { programs: string[]; swap: string; destination: string; priorityLamports: number; feePayer: string; middleAccounts: string[] };
const ataOf = (owner: string, mint: string, tokenProgram: string) =>
  PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ATA_PROGRAM_ID))[0].toBase58();

/** The lookup tables of one built swap, read through NOWNodes (part of executing the agent's swap). [] when any of them cannot
 *  be read: the guard then sees the static accounts only, which is stricter (a middle token's account is refused). */
export async function lookupTables(txB64: string): Promise<AddressLookupTableAccount[]> {
  let ids: string[];
  try { ids = VersionedTransaction.deserialize(Buffer.from(txB64, "base64")).message.addressTableLookups.map((l) => l.accountKey.toBase58()); } catch { return []; }
  if (!ids.length) return [];
  try {
    const r = await nowRpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>("getMultipleAccounts", [ids, { encoding: "base64", commitment: "confirmed" }]);
    const tables = ids.map((id, i) => {
      const a = r?.value?.[i];
      if (!a || a.owner !== LOOKUP_TABLE_PROGRAM || !Array.isArray(a.data)) return null;
      return new AddressLookupTableAccount({ key: new PublicKey(id), state: AddressLookupTableAccount.deserialize(Buffer.from(a.data[0], "base64")) });
    });
    return tables.every((t) => t != null) ? (tables as AddressLookupTableAccount[]) : [];
  } catch (e) {
    if (e instanceof NowNodesOffError) throw e;
    return [];
  }
}

/** Refuse (GuardError) unless the built swap only moves the person's tokens into the person's own account (rules above).
 *  `tables` = the swap's lookup tables as read on-chain (lookupTables); without them only static accounts are known. */
export function checkSwapTx(txB64: string, want: { wallet: string; inMint: string; outMint: string }, tables: AddressLookupTableAccount[] = []): TxCheck {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(txB64, "base64")); } catch { throw new GuardError("the built transaction does not decode"); }
  const m = tx.message;
  const keys = m.staticAccountKeys.map((k) => k.toBase58());
  // The checks that bind money (signer, fee payer, the swap's destination, whose account is created) use STATIC accounts only:
  // an index past the static keys reads as null and fails its check. Jupiter loads mints and token programs from its tables,
  // and an associated token account address binds its owner, mint and token program, so those checks rest on addresses.
  // Accounts from the tables (read on-chain) are used to prove what a middle token's account is, and to refuse a wrong output mint.
  const key = (i: number | undefined) => (i != null && i < keys.length ? keys[i] : null);
  let all = keys;
  if (tables.length && m.addressTableLookups.length) {
    try {
      const k = m.getAccountKeys({ addressLookupTableAccounts: tables }).accountKeysFromLookups;
      if (k) all = [...keys, ...k.writable.map((x) => x.toBase58()), ...k.readonly.map((x) => x.toBase58())];
    } catch { all = keys; } // a table that does not resolve: static accounts only
  }
  const loaded = (i: number | undefined) => (i != null && i < all.length ? all[i] : null);
  const middleAccounts: string[] = [];
  if (keys[0] !== want.wallet) throw new GuardError("the fee payer is not your wallet");
  if (m.header.numRequiredSignatures !== 1) throw new GuardError("it needs a signature besides your wallet's");
  const destAtas = TOKEN_PROGRAMS.map((p) => ataOf(want.wallet, want.outMint, p));
  const ownAtas = new Map<string, { mint: string; program: string }>();
  for (const mint of [want.inMint, want.outMint]) for (const program of TOKEN_PROGRAMS) ownAtas.set(ataOf(want.wallet, mint, program), { mint, program });
  const programs: string[] = [];
  let swap: string | null = null, destination: string | null = null, cuLimit: number | null = null, cuPrice = 0n;
  for (const ix of m.compiledInstructions) {
    const pid = key(ix.programIdIndex);
    if (!pid) throw new GuardError("a program id is not a static account");
    programs.push(pid);
    const data = Buffer.from(ix.data), a = ix.accountKeyIndexes;
    if (pid === COMPUTE_BUDGET) {
      const op = data[0];
      if (op === 2 && data.length >= 5) cuLimit = data.readUInt32LE(1);
      else if (op === 3 && data.length >= 9) cuPrice = data.readBigUInt64LE(1);
      else if (op !== 1 && op !== 4) throw new GuardError(`an unknown ComputeBudget instruction (${op})`);
    } else if (pid === ATA_PROGRAM_ID) {
      if (!(data.length === 0 || (data.length === 1 && data[0] === 1))) throw new GuardError("an associated-token instruction other than create");
      const payer = key(a[0]), ata = key(a[1]), owner = key(a[2]), mint = loaded(a[3]), tokenProgram = loaded(a[5]);
      if (payer !== want.wallet || owner !== want.wallet) throw new GuardError("it creates a token account for someone else");
      const own = ata ? ownAtas.get(ata) : undefined;
      if (own) {
        if ((mint && mint !== own.mint) || (tokenProgram && tokenProgram !== own.program)) {
          throw new GuardError("it creates a token account that is not your wallet's account of the swapped tokens");
        }
      } else {
        // a middle token of the route: only the wallet's own account of it, proven from the mint + token program the tables hold
        if (!ata || !mint || !tokenProgram || !TOKEN_PROGRAMS.includes(tokenProgram) || ataOf(want.wallet, mint, tokenProgram) !== ata) {
          throw new GuardError("it creates a token account that is not your wallet's own account");
        }
        if (!middleAccounts.includes(mint)) middleAccounts.push(mint);
        if (middleAccounts.length > MAX_MIDDLE_ACCOUNTS) throw new GuardError(`it opens token accounts for more than ${MAX_MIDDLE_ACCOUNTS} middle tokens of the route`);
      }
    } else if (pid === JUPITER_V6) {
      const disc = data.subarray(0, 8).toString("hex");
      const layout = JUP_SWAPS[disc];
      if (!layout) throw new GuardError(`a Jupiter instruction that is not an exact-in swap (${disc})`);
      if (swap) throw new GuardError("more than one Jupiter swap");
      swap = layout.name;
      if (key(a[layout.authority]) !== want.wallet) throw new GuardError("the swap is not authorized by your wallet");
      const dest = key(a[layout.dest]);
      if (!dest || !destAtas.includes(dest)) throw new GuardError("the swap's output does not go to your wallet's own token account");
      if (layout.redirect != null) {
        const r = key(a[layout.redirect]);
        if (r !== JUPITER_V6 && r !== dest) throw new GuardError("the swap sends its output to another account");
      }
      const outMint = loaded(a[layout.outMint]); // unknown without the tables: the destination address above already binds the mint
      if (outMint && outMint !== want.outMint) throw new GuardError("the swap's output token is not the one asked");
      destination = dest;
    } else {
      throw new GuardError(`it calls a program outside the allowlist: ${pid}`);
    }
  }
  if (!swap || !destination) throw new GuardError("there is no Jupiter swap in it");
  const priority = Number((cuPrice * BigInt(cuLimit ?? 1_400_000)) / 1_000_000n);
  if (priority > MAX_PRIORITY_LAMPORTS) throw new GuardError(`its priority fee (${priority} lamports) is above the ${MAX_PRIORITY_LAMPORTS} lamport ceiling`);
  return { programs, swap, destination, priorityLamports: priority, feePayer: keys[0], middleAccounts };
}

const messageHash = (tx: VersionedTransaction) => createHash("sha256").update(tx.message.serialize()).digest("hex");
/** What Privy returned is our message, signed by the wallet (ed25519 check), and nothing else. */
function checkSigned(signedB64: string, builtB64: string, wallet: string): void {
  let s: VersionedTransaction;
  try { s = VersionedTransaction.deserialize(Buffer.from(signedB64, "base64")); } catch { throw failed("Privy returned something that is not a transaction"); }
  const b = VersionedTransaction.deserialize(Buffer.from(builtB64, "base64"));
  if (messageHash(s) !== messageHash(b)) throw failed("Privy returned a different transaction than the one checked: refused");
  const sig = s.signatures[0];
  if (!sig || sig.every((x) => x === 0)) throw failed("Privy returned the transaction unsigned");
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(new PublicKey(wallet).toBytes()).toString("base64url") }, format: "jwk" });
  if (!verify(null, Buffer.from(s.message.serialize()), pub, Buffer.from(sig))) throw failed("the signature Privy returned is not your wallet's");
}

// ── the executor ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const money = (n: number) => `$${n.toFixed(2)}`;
const tsMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 200);
const amt = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 4 : 8 }) : s; };

/** One event on every auto agent of the owner (a grant change concerns them all). */
function announce(owner: string, level: "info" | "warn" | "error", msg: string): void {
  for (const id of autoAgentsOf(owner)) { const b = botRow(id); if (b && b.owner === owner) logEvent(id, level, msg, now()); }
}

/** The grant as it stands right now; an expired one is switched off here (with its events). */
function liveGrant(owner: string): GrantRow {
  const g = grantRow(owner);
  if (!g || g.enabled !== 1) throw refuse(g?.disabled_reason ? `auto-trade is off (${g.disabled_reason})` : "auto-trade is off for this account");
  if (g.expires_at <= now()) {
    disableAutoTrade(owner, `the grant expired on ${new Date(g.expires_at).toISOString().slice(0, 16).replace("T", " ")} UTC; enable it again to go on`);
    throw refuse("auto-trade expired: enable it again to go on");
  }
  return g;
}

function bumpStreak(owner: string, reason: string): void {
  store().run("UPDATE auto_trade SET streak = streak + 1, updated = ? WHERE owner = ?", [now(), owner]);
  const g = grantRow(owner);
  if (g && g.enabled === 1 && g.streak >= STREAK_LIMIT) disableAutoTrade(owner, `${STREAK_LIMIT} auto trades failed in a row (last: ${reason})`);
}

type Job = { fill: Fill; botId: string; owner: string; wallet: string };
const queues = new Map<string, { n: number; p: Promise<void> }>();
function enqueue(wallet: string, job: () => Promise<void>): boolean {
  const q = queues.get(wallet) ?? { n: 0, p: Promise.resolve() };
  if (q.n >= MAX_QUEUE) return false;
  q.n++;
  queues.set(wallet, q);
  q.p = q.p.then(job).catch((e) => { logger.warn({ err: errText(e) }, "auto-trade: job crashed"); }).finally(() => {
    q.n--;
    if (q.n === 0 && queues.get(wallet) === q) queues.delete(wallet);
  });
  return true;
}

/** A fill on the bus of a subscribed agent: claim it (one execution per fill) and queue it on the owner's wallet. */
function onFill(botId: string, f: Fill): void {
  try {
    if (f.status !== "filled" || (f.side !== "buy" && f.side !== "sell") || f.kind) return; // skipped fills and LP moves are not signals
    const bot = botRow(botId);
    if (!bot || !isAutoAgent(bot.owner, botId)) return;
    const g = grantRow(bot.owner);
    if (!g || g.enabled !== 1) return;
    const t = now();
    const claimed = store().run(`INSERT OR IGNORE INTO auto_runs (fill_id, owner, bot_id, wallet, side, mint, symbol, usd, in_raw, out_raw, at, outcome, reason, sig, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'queued', NULL, NULL, ?)`, [f.id, bot.owner, botId, g.wallet, f.side, f.mint, f.symbol ?? null, t, t]).changes;
    if (!claimed) return; // this fill was already taken: one execution per fill
    const job: Job = { fill: f, botId, owner: bot.owner, wallet: g.wallet };
    if (!enqueue(g.wallet, () => execute(job))) settle(job, refuse(`${MAX_QUEUE} trades are already waiting on this wallet`));
  } catch (e) { logger.warn({ err: errText(e) }, "auto-trade: could not take a fill"); }
}

const sideWord = (f: Fill) => (f.side === "buy" ? "BUY" : "SELL");
const symOf = (f: Fill, fallback?: string | null) => f.symbol ?? fallback ?? short(f.mint);
/** A fill that ended without a landed transaction: the run row and an event on the agent say why. */
function settle(job: Job, e: unknown): void {
  const r = e instanceof Refusal ? e : e instanceof NowNodesOffError ? refuse("the NOWNodes lane is off") : failed(errText(e));
  try {
    setRun(job.fill.id, { outcome: r.failure ? "failed" : "refused", reason: r.message });
    if (botRow(job.botId)) logEvent(job.botId, r.failure ? "error" : "warn", `Auto-trade ${r.failure ? "could not execute" : "skipped"} this ${sideWord(job.fill)} of ${symOf(job.fill)}: ${r.message}`, now());
    if (r.failure) bumpStreak(job.owner, r.message);
  } catch (e2) { logger.warn({ err: errText(e2) }, "auto-trade: could not record a refusal"); }
}

async function execute(job: Job): Promise<void> {
  try { await attempt(job); } catch (e) { settle(job, e); }
}

async function attempt(job: Job): Promise<void> {
  const { fill: f, botId, owner, wallet } = job;
  const g = liveGrant(owner);
  if (g.wallet !== wallet) throw refuse("the auto-trade wallet changed since this signal came in");
  const bot = botRow(botId);
  if (!bot || bot.owner !== owner) throw refuse("this agent is not on the account that granted auto-trade");
  if (!isAutoAgent(owner, botId)) throw refuse("auto-execute is off for this agent");
  if (bot.status !== "running") throw refuse(`the agent is ${bot.status}`);
  if (!TRADING_TYPES.has(bot.type)) throw refuse("this agent does not trade");
  const age = now() - tsMs(f.ts);
  if (age > MAX_FILL_AGE_MS) throw refuse(`the signal is ${Math.round(age / 1000)} s old (auto-trade acts within ${MAX_FILL_AGE_MS / 1000} s)`);
  if (f.mint === USDC_MINT || !isPubkey(f.mint)) throw refuse("only USDC ↔ token trades are executed");
  const done = liveExecutionOf(f.id);
  if (done) throw refuse(`this signal was already executed (${done.sig})`);
  if (!nownodesReady() || !autoConfig().on) throw refuse(OFF_MSG.toLowerCase());
  const params = bot.params as { slippageBps?: unknown };
  const slippageBps = Math.min(g.slippage_bps, Number.isInteger(params?.slippageBps) ? Math.max(10, params.slippageBps as number) : g.slippage_bps);

  let q: Awaited<ReturnType<typeof solQuote>>, usd: number, inMint: string, outMint: string;
  try {
    if (f.side === "buy") {
      let info: Awaited<ReturnType<typeof tokenInfo>>;
      try { info = await tokenInfo(f.mint); } catch (e) { throw refuse(`could not check ${symOf(f)}'s mint and freeze authority on Jupiter (${errText(e)})`); }
      if (!info) throw refuse(`Jupiter does not list ${symOf(f)}, so its mint and freeze authority cannot be checked`);
      if (info.mintAuthorityDisabled !== true) throw refuse(info.mintAuthorityDisabled === false ? `${symOf(f)} still has a live mint authority` : `Jupiter has no mint-authority check for ${symOf(f)}`);
      if (info.freezeAuthorityDisabled !== true) throw refuse(info.freezeAuthorityDisabled === false ? `${symOf(f)} still has a live freeze authority` : `Jupiter has no freeze-authority check for ${symOf(f)}`);
      const spent = spentToday(wallet), left = Math.floor((g.daily_usd - spent) * 100) / 100;
      if (left < MIN_TRADE_USD) throw refuse(`today's limit is reached: ${money(spent)} of ${money(g.daily_usd)} spent (the day restarts at 00:00 UTC)`);
      usd = Math.floor(Math.min(f.usd, g.per_trade_usd, left) * 100) / 100;
      if (!(usd >= MIN_TRADE_USD)) throw refuse(`${money(usd)} is below the ${money(MIN_TRADE_USD)} minimum`);
      inMint = USDC_MINT; outMint = f.mint;
      setRun(f.id, { outcome: "running", usd });
      q = await solQuote(USDC_MINT, f.mint, usd.toFixed(2), slippageBps);
    } else {
      const held = heldRaw(owner, botId, f.mint);
      if (held <= 0n) throw refuse(`auto-trade has not bought ${symOf(f)} for this agent, so there is nothing to sell (your own ${symOf(f)} is never sold)`);
      const share = soldFraction(botId, f);
      const bal = await tokenBalance(wallet, f.mint);
      const wantRaw = share >= 0.995 ? held : (held * BigInt(Math.round(share * 1_000_000))) / 1_000_000n;
      const raw = wantRaw < bal.raw ? wantRaw : bal.raw;
      if (raw <= 0n) throw refuse(`the wallet holds no ${symOf(f)} to sell`);
      inMint = f.mint; outMint = USDC_MINT;
      setRun(f.id, { outcome: "running" });
      q = await solQuote(f.mint, USDC_MINT, fromRaw(raw, bal.decimals), slippageBps);
      usd = Number(q.amountOut);
    }
  } catch (e) {
    if (e instanceof TradeError) throw failed(`no Jupiter quote: ${e.message}`);
    throw e;
  }
  const symbol = f.symbol ?? (f.side === "buy" ? q.tokenOut.symbol : q.tokenIn.symbol) ?? null;
  const inRaw = q.amountInRaw, outRaw = toRaw(q.amountOut, q.tokenOut.decimals);
  setRun(f.id, { usd, in_raw: inRaw, out_raw: outRaw, symbol });

  let built: { transaction: string };
  try { built = await solBuild(q.quoteId, wallet, { wrapAndUnwrapSol: false }); } catch (e) { throw failed(`Jupiter could not build the swap: ${errText(e)}`); }
  const tables = await lookupTables(built.transaction);
  try { checkSwapTx(built.transaction, { wallet, inMint, outMint }, tables); } catch (e) { throw failed(`refused before signing: ${errText(e)}`); }

  let sim: SimValue;
  try {
    const r = await nowRpc<{ value: SimValue }>("simulateTransaction", [built.transaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]);
    sim = r?.value ?? { err: "no simulation result", logs: null };
  } catch (e) { if (e instanceof NowNodesOffError) throw e; throw failed(`NOWNodes could not simulate it: ${errText(e)}`); }
  if (sim.err != null) throw failed(`the simulation on NOWNodes failed: ${simHint(f.side, sim) ?? (typeof sim.err === "string" ? sim.err : JSON.stringify(sim.err))}`);

  // the kill switch and the agent's state, once more, right before anything is signed
  liveGrant(owner);
  const now2 = botRow(botId);
  if (!now2 || now2.status !== "running" || !isAutoAgent(owner, botId)) throw refuse("the agent was paused or auto-execute switched off before signing");

  let signed: string;
  try { signed = await signSolanaTransaction(g.wallet_id, built.transaction); } catch (e) { throw failed(`Privy did not sign: ${errText(e)}`); }
  checkSigned(signed, built.transaction, wallet);

  let sig: string;
  try {
    sig = await nowRpc<string>("sendTransaction", [signed, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
  } catch (e) {
    if (e instanceof NowNodesOffError) throw e;
    throw failed(`NOWNodes did not take the transaction (nothing was spent): ${errText(e)}`);
  }
  if (typeof sig !== "string" || !sig) throw failed("NOWNodes answered no signature");
  recordExecution({ sig, botId, fillId: f.id, owner, wallet, side: f.side, mint: f.mint, symbol, usd, inAmount: q.amountIn, outAmount: q.amountOut, mode: "auto" });
  setRun(f.id, { outcome: "sent", sig });

  const sentAt = now(), what = f.side === "buy" ? `BUY ${money(usd)} ${symbol ?? short(f.mint)}` : `SELL ${amt(q.amountIn)} ${symbol ?? short(f.mint)} for ${money(usd)}`;
  while (now() - sentAt < deps.confirmMs) {
    await deps.sleep(deps.pollMs);
    let s: SigStatus = null;
    try { s = (await nowRpc<{ value: SigStatus[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]))?.value?.[0] ?? null; } catch { continue; }
    const m = mapStatus(s, sentAt, now());
    setExecutionStatus(sig, m);
    if (m.status === "confirmed" || m.status === "finalized") {
      setRun(f.id, { outcome: "confirmed" });
      store().run("UPDATE auto_trade SET streak = 0, updated = ? WHERE owner = ?", [now(), owner]);
      logEvent(botId, "info", `Executed on-chain: ${what} · ${sig}`, now());
      return;
    }
    if (m.status === "failed") {
      setRun(f.id, { outcome: "failed", reason: m.err });
      logEvent(botId, "error", `Auto-trade sent ${what} but it failed on Solana: ${m.err ?? "unknown error"} · ${sig}`, now());
      bumpStreak(owner, `failed on Solana: ${m.err ?? "unknown error"}`);
      return;
    }
  }
  logEvent(botId, "warn", `Sent on-chain, not confirmed after ${Math.round(deps.confirmMs / 1000)} s: ${what} · ${sig} (check Solscan)`, now());
}

// The manual lane refuses a fill auto-trade has taken (queued, running, sent or landed): one signal, one execution.
function laneCheck(fillId: string): string | null {
  try {
    const r = store().query("SELECT outcome, sig FROM auto_runs WHERE fill_id = ?").get(fillId) as { outcome: RunRow["outcome"]; sig: string | null } | null;
    return r && ["queued", "running", "sent", "confirmed"].includes(r.outcome) ? `auto-trade ${r.outcome === "confirmed" ? "executed" : "is executing"} this signal${r.sig ? `: ${r.sig}` : ""}` : null;
  } catch { return null; }
}
setOtherLaneCheck(laneCheck);

// ── subscriptions ────────────────────────────────────────────────────────────────────────────────────────────────────────
const subs = new Map<string, () => void>();
/** Listen to exactly the agents that can execute: auto-execute, owner's grant enabled and unexpired, feature on. */
function syncSubs(): void {
  const want = new Set<string>();
  if (autoConfig().on) {
    const rows = store().query("SELECT a.bot_id, a.owner FROM auto_agents a JOIN auto_trade g ON g.owner = a.owner WHERE g.enabled = 1 AND g.expires_at > ?").all(now()) as { bot_id: string; owner: string }[];
    for (const r of rows) { const b = botRow(r.bot_id); if (b && b.owner === r.owner) want.add(r.bot_id); }
  }
  for (const [id, off] of subs) if (!want.has(id)) { off(); subs.delete(id); }
  for (const id of want) if (!subs.has(id)) subs.set(id, subscribe(id, (e) => { if (e.type === "fill") onFill(id, e.fill); }));
}

/** On server boot, after initBots: listen to every agent that auto-executes. */
export function initAutoTrade(): void {
  try {
    syncSubs();
    const c = autoConfig();
    logger.info({ on: c.on, agents: subs.size, missing: c.missing }, "auto-trade: started");
  } catch (e) { logger.warn({ err: errText(e) }, "auto-trade: could not start"); }
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const _autoTest = {
  setDeps(d: Partial<Deps> | null) { deps = d ? { ...defaultDeps(), ...d } : defaultDeps(); },
  async drain() { while (queues.size) await Promise.all([...queues.values()].map((q) => q.p)); },
  sync: syncSubs,
  subscribed: () => [...subs.keys()],
  run: (fillId: string) => store().query("SELECT * FROM auto_runs WHERE fill_id = ?").get(fillId) as RunRow | null,
  reset() { for (const off of subs.values()) off(); subs.clear(); queues.clear(); db?.close(); db = null; deps = defaultDeps(); setOtherLaneCheck(laneCheck); },
};
