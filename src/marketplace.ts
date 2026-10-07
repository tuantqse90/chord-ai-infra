// Agent marketplace (ask2049-notes/PROMPT-agents-marketplace.md B). The owner of an agent lists it with a price in USDC (x402 on
// Solana) and a profit share; anyone copies it into their own agents. A priced copy is paid by a USDC transfer from the copier's
// own wallet to the listing's payout wallet: this file READS that transfer through NOWNodes (src/nownodes.ts) and one signature
// buys one copy. For the page it also prepares that transfer (the person's wallet signs it) and relays the signed one, both on
// NOWNodes as well. Profit share is PAPER: a share of every profitable close of every copy accrues to the creator's ledger
// ("would earn"), never settled on chain. Owners never leave the server; the routes are in src/agentsApi.ts.
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { config, USDC_MINT } from "./config";
import { backtest as runCopyBacktest, getBot, lpBacktest as runLpBacktest, lpCopyBacktest as runLpCopyBacktest, subscribe, type Bot, type Fill } from "./bots";
import { fillsOf, store as botsStore } from "./bots/store";
import { backtestStrategy as runStrategyBacktest } from "./strategy";
import { NowNodesOffError, nowRpc, nownodesReady } from "./nownodes";
import { facilitatorReady, feePayer, requirements as x402Requirements, v1Of, type Requirements } from "./x402";
import { verifySolanaPayment } from "./payments";
import { parseTx } from "./solana/parse";
import { isPubkey, isSignature } from "./solana/tokens";
import { logger } from "./chord/utils/logger";

export const LIST_MIN_AGE_MS = 3_600_000;        // ≥ 1 h of live history before an agent can be listed
export const MAX_PRICE_USDC = 100;
export const MAX_SHARE_PCT = 30;
export const PAYMENT_MAX_AGE_S = 900;           // a payment is redeemable for 15 min after its block
export const USDC_DECIMALS = 6;
const HEADLINE_DAYS = 3;
const HEADLINE_EVERY_MS = 3_600_000;
const HEADLINE_WAIT_MS = 12_000;                 // publish waits this long for the backtest, then answers (it lands later)

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ATA_RENT_LAMPORTS = 2_039_280;

export class MarketError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "MarketError"; }
}

export type Headline = { days: number; pnlUsd: number; investedUsd: number; trades: number; winRate: number | null; at: number };
export interface Listing {
  agent: string; owner: string; title: string; pitch: string; priceUsdc: number; profitSharePct: number; payTo: string;
  headline: Headline | null; headlineAt: number | null; createdAt: number; updatedAt: number;
}

// ── deps (tests swap the backtests and the clock) ───────────────────────────────────────────────────────────────────────
type Deps = {
  now: () => number;
  strategyBacktest: (strategy: unknown, days: 3) => Promise<{ days: number; realizedUsd: number; unrealizedUsd: number; investedUsd: number; trades: number; winRate: number | null }>;
  copyBacktest: (input: { params: any; days: 3 }) => Promise<{ days: number; realizedUsd: number; unrealizedUsd: number; investedUsd: number; trades: number; winRate: number | null }>;
  lpBacktest: (input: { pool: string; amountUsd: number; preset?: string; rangePct?: number | null; rebalance?: unknown; exits?: unknown; days: 3 }) => Promise<{ days: number; pnlUsd: number; amountUsd: number; fills: unknown[] }>;
  lpCopyBacktest: (input: unknown) => Promise<{ days: number; pnlUsd: number; investedUsd: number; copied: number; winRate: number | null }>;
};
const defaults = (): Deps => ({ now: () => Date.now(), strategyBacktest: (s, d) => runStrategyBacktest(s, d), copyBacktest: (i) => runCopyBacktest(i), lpBacktest: (i) => runLpBacktest(i), lpCopyBacktest: (i) => runLpCopyBacktest(i) });
let deps: Deps = defaults();

// ── store: listings, copies made through them, redeemed payments, the paper profit-share ledger ───────────────────────────
let db: Database | null = null;
function store(): Database {
  if (db) return db;
  botsStore(); // the bots table lives in the same file and the joins below need it
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run(`CREATE TABLE IF NOT EXISTS market_listings (agent TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, pitch TEXT NOT NULL,
    price_usdc REAL NOT NULL, share_pct REAL NOT NULL, pay_to TEXT NOT NULL, headline TEXT, headline_at INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS market_copies (copy TEXT PRIMARY KEY, listing TEXT NOT NULL, owner TEXT NOT NULL, price_usdc REAL NOT NULL,
    share_pct REAL NOT NULL, sig TEXT, at INTEGER NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS market_copies_listing ON market_copies (listing)");
  db.run(`CREATE TABLE IF NOT EXISTS market_payments (sig TEXT PRIMARY KEY, listing TEXT NOT NULL, owner TEXT NOT NULL, payer TEXT, paid_usdc REAL NOT NULL,
    copy TEXT, at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS market_ledger (fill TEXT PRIMARY KEY, listing TEXT NOT NULL, copy TEXT NOT NULL, pnl_usd REAL NOT NULL, pct REAL NOT NULL,
    share_usd REAL NOT NULL, at INTEGER NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS market_ledger_listing ON market_ledger (listing)");
  // x402 nonces: a payment buys a copy only for the caller the 402 was issued to (its memo carries x402:<nonce>), so a transfer
  // seen on chain cannot be redeemed by someone else first
  db.run("CREATE TABLE IF NOT EXISTS market_nonces (nonce TEXT PRIMARY KEY, listing TEXT NOT NULL, owner TEXT NOT NULL, expires INTEGER NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS market_nonces_owner ON market_nonces (listing, owner)");
  return db;
}

type ListingRow = { agent: string; owner: string; title: string; pitch: string; price_usdc: number; share_pct: number; pay_to: string; headline: string | null; headline_at: number | null; created: number; updated: number };
const toListing = (r: ListingRow): Listing => ({
  agent: r.agent, owner: r.owner, title: r.title, pitch: r.pitch, priceUsdc: r.price_usdc, profitSharePct: r.share_pct, payTo: r.pay_to,
  headline: r.headline ? JSON.parse(r.headline) : null, headlineAt: r.headline_at, createdAt: r.created, updatedAt: r.updated,
});
/** The listing of an agent that still exists, else null. */
export function listingOf(agent: string): Listing | null {
  const r = store().query("SELECT l.* FROM market_listings l JOIN bots b ON b.id = l.agent WHERE l.agent = ?").get(agent) as ListingRow | null;
  return r ? toListing(r) : null;
}
/** Every listing whose agent still exists. */
export function listings(): Listing[] {
  return (store().query("SELECT l.* FROM market_listings l JOIN bots b ON b.id = l.agent").all() as ListingRow[]).map(toListing);
}

// ── publishing ────────────────────────────────────────────────────────────────────────────────────────────────────────
const bad = (msg: string) => new MarketError(400, "bad_listing", msg);
const numOf = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** { title ≤ 48, pitch ≤ 280, priceUsdc 0 or 0.01..100, profitSharePct 0..30, payoutWallet (Solana address, case kept) }. */
export function validateListing(raw: unknown): { title: string; pitch: string; priceUsdc: number; profitSharePct: number; payTo: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("send { title, pitch, priceUsdc, profitSharePct, payoutWallet }");
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? clean(o.title) : "";
  if (!title) throw bad("title is required: at most 48 characters");
  if (title.length > 48) throw bad(`title is ${title.length} characters: at most 48`);
  if (o.pitch != null && typeof o.pitch !== "string") throw bad("pitch must be text: at most 280 characters");
  const pitch = clean(String(o.pitch ?? ""));
  if (pitch.length > 280) throw bad(`pitch is ${pitch.length} characters: at most 280`);
  const price = numOf(o.priceUsdc ?? 0);
  if (!Number.isFinite(price) || price < 0 || price > MAX_PRICE_USDC) throw bad(`priceUsdc must be 0 (free) to ${MAX_PRICE_USDC} USDC`);
  if (price > 0 && price < 0.01) throw bad("priceUsdc must be 0 (free) or at least 0.01 USDC");
  const share = numOf(o.profitSharePct ?? 0);
  if (!Number.isFinite(share) || share < 0 || share > MAX_SHARE_PCT) throw bad(`profitSharePct must be 0 to ${MAX_SHARE_PCT}`);
  const w = typeof o.payoutWallet === "string" ? o.payoutWallet.trim() : "";
  if (!w) throw bad("payoutWallet is required: the Solana wallet that receives the USDC of each paid copy");
  if (!isPubkey(w)) throw bad(`payoutWallet ${JSON.stringify(w.slice(0, 60))} is not a Solana address (base58, 32 to 44 characters, case-sensitive)`);
  return { title, pitch, priceUsdc: Math.round(price * 10 ** USDC_DECIMALS) / 10 ** USDC_DECIMALS, profitSharePct: Math.round(share * 100) / 100, payTo: w };
}

/** List (or update the listing of) an agent the caller owns: not an alert agent, at least 1 h old. The first publish waits up to
 *  12 s for the 3-day backtest headline; a slower or failing backtest never blocks it (null, filled in when it lands). */
export async function publishListing(owner: string, agentId: string, body: unknown): Promise<Listing> {
  const mine = getBot(owner, agentId);
  if (!mine) {
    if (getBot(null, agentId)) throw new MarketError(403, "not_owner", "Only the agent's owner can list it.");
    throw new MarketError(404, "not_found", "This agent does not exist.");
  }
  const b = mine.bot;
  if (b.type === "alert") throw new MarketError(422, "not_listable", "Alert agents only watch and never trade, so they cannot be listed.");
  const age = deps.now() - b.createdAt;
  if (age < LIST_MIN_AGE_MS) {
    const left = Math.max(1, Math.ceil((LIST_MIN_AGE_MS - age) / 60_000));
    throw new MarketError(422, "too_new", `An agent needs 1 hour of live history before it can be listed: ${left} min to go.`);
  }
  const v = validateListing(body);
  const prev = listingOf(agentId);
  const now = deps.now();
  store().run(`INSERT INTO market_listings (agent, owner, title, pitch, price_usdc, share_pct, pay_to, headline, headline_at, created, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    ON CONFLICT (agent) DO UPDATE SET owner = excluded.owner, title = excluded.title, pitch = excluded.pitch, price_usdc = excluded.price_usdc,
      share_pct = excluded.share_pct, pay_to = excluded.pay_to, updated = excluded.updated`,
  [agentId, owner, v.title, v.pitch, v.priceUsdc, v.profitSharePct, v.payTo, now, now]);
  if (!prev?.headline) {
    const done = refreshHeadline(agentId);
    await Promise.race([done, new Promise((r) => { const t = setTimeout(r, HEADLINE_WAIT_MS); (t as any).unref?.(); })]);
  }
  return listingOf(agentId)!;
}

/** Unlist; copies already made keep their terms (and their profit share keeps accruing on paper). */
export function unlistAgent(owner: string, agentId: string): boolean {
  return store().run("DELETE FROM market_listings WHERE agent = ? AND owner = ?", [agentId, owner]).changes > 0;
}

// ── backtest headline (3 days, real history), refreshed hourly in the background, one listing at a time ─────────────────────
const r2 = (n: number) => Math.round(n * 100) / 100;
/** The agent's own replay: custom → its strategy, copy → its wallets and rules, LP → its pool and range. null when it fails. */
export async function headlineFor(b: Pick<Bot, "type" | "params">): Promise<Headline | null> {
  const p = (b.params ?? {}) as any;
  const at = deps.now();
  try {
    if (b.type === "custom") {
      const bt = await deps.strategyBacktest(p.strategy, HEADLINE_DAYS);
      return { days: bt.days, pnlUsd: r2(bt.realizedUsd + bt.unrealizedUsd), investedUsd: r2(bt.investedUsd), trades: bt.trades, winRate: bt.winRate, at };
    }
    if (b.type === "copy") {
      const bt = await deps.copyBacktest({ params: p, days: HEADLINE_DAYS });
      return { days: bt.days, pnlUsd: r2(bt.realizedUsd + bt.unrealizedUsd), investedUsd: r2(bt.investedUsd), trades: bt.trades, winRate: bt.winRate, at };
    }
    if (b.type === "lp" && p.mode === "copy") {
      const bt = await deps.lpCopyBacktest({ ...p, days: HEADLINE_DAYS });
      return { days: bt.days, pnlUsd: r2(bt.pnlUsd), investedUsd: r2(bt.investedUsd), trades: bt.copied, winRate: bt.winRate, at };
    }
    if (b.type === "lp") {
      const bt = await deps.lpBacktest({ pool: p.pool, amountUsd: p.amountUsd, preset: p.preset, rangePct: p.rangePct, rebalance: p.rebalance, exits: p.exits, days: HEADLINE_DAYS });
      return { days: bt.days, pnlUsd: r2(bt.pnlUsd), investedUsd: r2(bt.amountUsd), trades: bt.fills.length, winRate: null, at };
    }
  } catch (e) {
    logger.warn({ err: String((e as Error)?.message ?? e).slice(0, 200) }, "market: headline backtest failed");
  }
  return null;
}
const inflight = new Map<string, Promise<void>>();
function refreshHeadline(agentId: string): Promise<void> {
  const cur = inflight.get(agentId);
  if (cur) return cur;
  const p = (async () => {
    const b = getBot(null, agentId)?.bot;
    if (!b) return;
    const h = await headlineFor(b);
    store().run("UPDATE market_listings SET headline = ?, headline_at = ? WHERE agent = ?", [h ? JSON.stringify(h) : null, deps.now(), agentId]);
  })().catch((e) => logger.warn({ err: String((e as Error)?.message ?? e).slice(0, 200) }, "market: headline refresh failed")).finally(() => inflight.delete(agentId));
  inflight.set(agentId, p);
  return p;
}
let refreshing = false;
/** Listings whose headline is an hour old (or missing), one backtest at a time. */
async function refreshStale(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    for (const l of listings()) if (deps.now() - (l.headlineAt ?? 0) >= HEADLINE_EVERY_MS) await refreshHeadline(l.agent);
  } finally { refreshing = false; }
}

// ── copies, sales, the paper ledger ─────────────────────────────────────────────────────────────────────────────────────
/** A copy made through a listing, with the terms the copier saw (price paid, profit share). */
export function recordCopy(r: { copy: string; listing: string; owner: string; priceUsdc: number; sharePct: number; sig: string | null }): void {
  store().run("INSERT OR IGNORE INTO market_copies (copy, listing, owner, price_usdc, share_pct, sig, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [r.copy, r.listing, r.owner, r.priceUsdc, r.sharePct, r.sig, deps.now()]);
  if (r.sharePct > 0) watch(r.copy, r.listing, r.sharePct);
}
/** One profitable close (filled, pnlUsd > 0) of a copy adds pct of it to the creator's ledger, once per fill. */
export function accrue(f: Fill, listing: string, pct: number): boolean {
  if (!f || f.status !== "filled" || f.pnlUsd == null || !(f.pnlUsd > 0) || !(pct > 0)) return false;
  return store().run("INSERT OR IGNORE INTO market_ledger (fill, listing, copy, pnl_usd, pct, share_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [f.id, listing, f.botId, f.pnlUsd, pct, (f.pnlUsd * pct) / 100, f.ts]).changes > 0;
}
const shareSubs = new Map<string, () => void>();
function watch(copy: string, listing: string, pct: number): void {
  if (shareSubs.has(copy)) return;
  shareSubs.set(copy, subscribe(copy, (e) => { if (e.type === "fill") accrue(e.fill, listing, pct); }));
  for (const f of fillsOf(copy, 200)) accrue(f, listing, pct); // anything it closed before this subscription (a restart)
}
/** One subscription per live copy with a profit share; copies that were deleted are dropped. */
function syncShares(): void {
  const rows = store().query("SELECT c.copy, c.listing, c.share_pct FROM market_copies c JOIN bots b ON b.id = c.copy WHERE c.share_pct > 0").all() as { copy: string; listing: string; share_pct: number }[];
  const live = new Set(rows.map((r) => r.copy));
  for (const [id, off] of shareSubs) if (!live.has(id)) { off(); shareSubs.delete(id); }
  for (const r of rows) watch(r.copy, r.listing, r.share_pct);
}
/** "Earned $X.XX (paper) from N copies": the share of every profitable close so far, and how many copies produced it. */
export function earningsOf(listing: string): { paperUsd: number; fromCopies: number; closes: number } {
  const r = store().query("SELECT COALESCE(SUM(share_usd), 0) AS usd, COUNT(DISTINCT copy) AS copies, COUNT(*) AS n FROM market_ledger WHERE listing = ?").get(listing) as { usd: number; copies: number; n: number };
  return { paperUsd: r2(r.usd), fromCopies: r.copies, closes: r.n };
}
/** Paid copies: how many and the USDC verified for them. */
export function salesOf(listing: string): { count: number; usdc: number } {
  const r = store().query("SELECT COUNT(*) AS n, COALESCE(SUM(paid_usdc), 0) AS usdc FROM market_payments WHERE listing = ? AND copy IS NOT NULL").get(listing) as { n: number; usdc: number };
  return { count: r.n, usdc: Math.round(r.usdc * 1e6) / 1e6 };
}

// ── x402: the 402 body, verifying a payment through NOWNodes, one signature = one copy ─────────────────────────────────────
const usdcText = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: USDC_DECIMALS });
export const unitsOf = (usdc: number): bigint => BigInt(Math.round(usdc * 10 ** USDC_DECIMALS));

/** What anyone may see of a priced agent's settings: its kind, never the recipe (that is what a copy pays for). The live fills
 *  stay public on purpose: they are the proof the agent trades. Free and unlisted agents are shown in full. */
export function forSale<T extends { id: string; type: string; params: unknown }>(b: T, viewer: string | null = null): T {
  const l = listingOf(b.id);
  if (!l || l.priceUsdc <= 0 || (viewer && viewer === l.owner)) return b;
  const p = (b.params ?? {}) as any;
  const kind = b.type === "custom" ? { strategy: { name: p.strategy?.name ?? null, trigger: { type: p.strategy?.trigger?.type ?? null }, action: { type: p.strategy?.action?.type ?? null } } }
    : b.type === "lp" ? { mode: p.mode ?? "single" } : b.type === "copy" ? { wallets: Array.isArray(p.wallets) ? p.wallets.length : null } : {};
  return { ...b, params: { redacted: true, priceUsdc: l.priceUsdc, ...kind } };
}

/** The caller's nonce for this listing (reused while it is valid): the payment's memo must be `x402:<nonce>`. */
export function nonceFor(listing: string, owner: string): string {
  const now = deps.now();
  const hit = store().query("SELECT nonce FROM market_nonces WHERE listing = ? AND owner = ? AND expires > ? ORDER BY expires DESC LIMIT 1").get(listing, owner, now + 5 * 60_000) as { nonce: string } | null;
  if (hit) return hit.nonce;
  const nonce = randomBytes(8).toString("hex");
  store().run("DELETE FROM market_nonces WHERE expires < ?", [now - 86_400_000]);
  store().run("INSERT INTO market_nonces (nonce, listing, owner, expires) VALUES (?, ?, ?, ?)", [nonce, listing, owner, now + 2 * PAYMENT_MAX_AGE_S * 1000]);
  return nonce;
}
export const memoOf = (nonce: string) => `x402:${nonce}`;
/** Memo texts of a jsonParsed transaction (top-level spl-memo instructions). */
function memosOf(raw: any): string[] {
  const ixs: any[] = raw?.transaction?.message?.instructions ?? [];
  return ixs.filter((ix) => ix && (ix.program === "spl-memo" || ix.programId === MEMO_PROGRAM.toBase58()) && typeof ix.parsed === "string").map((ix) => ix.parsed as string);
}

/** The x402-style answer to a copy without payment. `terms` and `nownodes` let a page show the deal and refuse to pay when the
 *  payment could not be verified (NOWNodes key not set). */
export function paymentRequired(l: Listing, resource: string, owner: string, message?: string, error = "payment_required") {
  const price = usdcText(l.priceUsdc);
  const memo = memoOf(nonceFor(l.agent, owner));
  const share = l.profitSharePct > 0 ? ` ${l.profitSharePct}% of each profitable close of the copy accrues to the creator on paper (never charged).` : "";
  const ready = nownodesReady();
  const description = `A paper copy of the agent "${l.title}", running in your agents.${share}`;
  // standard x402 (exact on Solana, our facilitator pays the fee) when the fee payer is configured; the legacy path stays either way
  const std = facilitatorReady() ? x402RequirementsFor(l, owner) : null;
  return {
    x402Version: 1,
    error,
    message: message ?? (std
      ? `Copying this agent costs ${price} USDC. Sign a USDC TransferChecked to ${l.payTo} with the memo ${memo} and the fee payer ${std.extra.feePayer} (this server's facilitator pays the network fee), then repeat this request with it in PAYMENT-SIGNATURE (x402 v2) or X-PAYMENT (v1). Legacy: send the USDC yourself, then X-PAYMENT: solana:<signature> within 15 minutes.`
      : `Copying this agent costs ${price} USDC. Send ${price} USDC on Solana to ${l.payTo} with the memo ${memo} (it ties the payment to you), then repeat this request with the header X-PAYMENT: solana:<signature> within 15 minutes.`),
    accepts: [std ? { ...v1Of(std, resource, description), extra: { ...std.extra, verifiedBy: "NOWNodes" } } : {
      scheme: "exact", network: "solana", asset: USDC_MINT, payTo: l.payTo, maxAmountRequired: unitsOf(l.priceUsdc).toString(), resource,
      description, mimeType: "application/json",
      maxTimeoutSeconds: PAYMENT_MAX_AGE_S, extra: { name: "USDC", decimals: USDC_DECIMALS, memo, header: "X-PAYMENT: solana:<signature>", verifiedBy: "NOWNodes" },
    }],
    facilitator: std ? { scheme: "exact", network: std.network, feePayer: std.extra.feePayer, headers: ["PAYMENT-SIGNATURE", "X-PAYMENT"], settledBy: "NOWNodes" } : null,
    terms: { agent: l.agent, title: l.title, priceUsdc: l.priceUsdc, profitSharePct: l.profitSharePct, payTo: l.payTo, profitShare: "paper" as const },
    nownodes: { ready, message: ready ? null : "NOWNodes key not set: payments cannot be verified on this server yet, so do not pay." },
  };
}

/** The listing's x402 requirements for this buyer: the exact USDC amount to the payout wallet, the buyer's memo nonce. */
export function x402RequirementsFor(l: Listing, owner: string): Requirements {
  return x402Requirements({ units: unitsOf(l.priceUsdc), payTo: l.payTo, asset: USDC_MINT, decimals: USDC_DECIMALS, memo: memoOf(nonceFor(l.agent, owner)), timeoutS: 120 });
}

/** "solana:<signature>" (the X-PAYMENT header) → the signature, else null. */
export function parsePaymentHeader(h: string | null | undefined): string | null {
  const m = /^\s*solana:([1-9A-HJ-NP-Za-km-z]+)\s*$/.exec(String(h ?? ""));
  return m && isSignature(m[1]) ? m[1] : null;
}

export type PayCheck = { ok: true; paidUsdc: number; payer: string } | { ok: false; status: 402 | 409 | 502 | 503; code: string; message: string };
export const paymentUsed = (sig: string): boolean => !!store().query("SELECT 1 FROM market_payments WHERE sig = ?").get(sig);

/** The payment must be confirmed, successful, at most 15 min old, and move ≥ the price in USDC to the listing's payout wallet.
 *  The transaction is read through NOWNodes only (getTransaction, jsonParsed, confirmed); no key = 503, never another RPC. */
export async function verifyCopyPayment(sig: string, l: Listing, owner: string): Promise<PayCheck> {
  if (paymentUsed(sig)) return { ok: false, status: 409, code: "payment_used", message: "This payment already bought a copy. One payment buys one copy." };
  let raw: unknown;
  try {
    raw = await nowRpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  } catch (e) {
    if (e instanceof NowNodesOffError || (e as { code?: string })?.code === "nownodes_off") return { ok: false, status: 503, code: "nownodes_off", message: (e as Error).message };
    return { ok: false, status: 502, code: "payment_unverified", message: `Could not read the payment through NOWNodes: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
  const tx = parseTx(raw);
  if (!tx || tx.blockTime == null) return { ok: false, status: 402, code: "payment_pending", message: "The payment is not confirmed yet. Repeat the request in a few seconds." };
  const ageS = deps.now() / 1000 - tx.blockTime;
  if (ageS > PAYMENT_MAX_AGE_S) return { ok: false, status: 402, code: "payment_expired", message: `This payment is ${Math.round(ageS / 60)} min old: a payment buys a copy within 15 min of its block.` };
  const nonces = memosOf(raw).map((m) => /\bx402:([0-9a-f]{16})\b/.exec(m)?.[1]).filter((n): n is string => !!n);
  const mine = nonces.length ? store().query(`SELECT 1 FROM market_nonces WHERE listing = ? AND owner = ? AND expires >= ? AND nonce IN (${nonces.map(() => "?").join(",")})`).get(l.agent, owner, tx.blockTime * 1000, ...nonces) : null;
  if (!mine) return { ok: false, status: 402, code: "payment_rejected", message: nonces.length ? "This payment's memo was issued to another buyer or has expired: pay with the memo in your own 402 answer." : "The payment has no x402 memo: send it with the memo from the 402 answer, so it is tied to you." };
  const v = verifySolanaPayment(tx, { recipient: l.payTo, mint: USDC_MINT, minUnits: l.priceUsdc, symbol: "USDC" });
  if (!v.ok) {
    const why = v.reason.replace("the treasury in the payment token", "the listing's payout wallet in USDC").replace(/^paid (\S+), the price is (\S+)$/, "paid $1 USDC, the price is $2 USDC");
    return { ok: false, status: 402, code: "payment_rejected", message: why };
  }
  return { ok: true, paidUsdc: v.paid, payer: tx.feePayer };
}
/** Claim the signature before the copy is made (a second request with it gets false). */
export function reservePayment(sig: string, listing: string, owner: string, payer: string, paidUsdc: number): boolean {
  return store().run("INSERT OR IGNORE INTO market_payments (sig, listing, owner, payer, paid_usdc, copy, at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
    [sig, listing, owner, payer, paidUsdc, deps.now()]).changes > 0;
}
/** The copy could not be made (agent limit, engine refused): the signature can be used again. */
export function releasePayment(sig: string): void { store().run("DELETE FROM market_payments WHERE sig = ? AND copy IS NULL", [sig]); }
export function settlePayment(sig: string, copy: string): void { store().run("UPDATE market_payments SET copy = ? WHERE sig = ?", [copy, sig]); }

// ── the page's wallet path: prepare the USDC transfer (the wallet signs it), relay the signed one, both on NOWNodes ────────
const ataOf = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
type ParsedAcct = { lamports?: number; data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } | null;

/** An unsigned v0 transaction from `wallet`: create the payout wallet's USDC account when missing (idempotent), transferChecked
 *  the price to it, a memo naming the agent. Refused early when the wallet lacks the USDC or the SOL for fees. */
export async function buildPaymentTx(l: Listing, wallet: string, owner: string): Promise<{ transaction: string; lastValidBlockHeight: number; amountUsdc: number; payTo: string; createsPayoutAccount: boolean }> {
  if (!isPubkey(wallet)) throw new MarketError(400, "bad_wallet", "wallet must be a Solana address");
  if (wallet === l.payTo) throw new MarketError(400, "self_payment", "This wallet is the listing's payout wallet: it cannot pay itself.");
  const payer = new PublicKey(wallet), to = new PublicKey(l.payTo), mint = new PublicKey(USDC_MINT);
  const src = ataOf(payer, mint), dst = ataOf(to, mint);
  const [accts, bh] = await Promise.all([
    nowRpc<{ value: ParsedAcct[] }>("getMultipleAccounts", [[wallet, src.toBase58(), dst.toBase58()], { encoding: "jsonParsed", commitment: "confirmed" }]),
    nowRpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]),
  ]);
  const [sol, from, payout] = accts?.value ?? [];
  const units = unitsOf(l.priceUsdc);
  const have = BigInt(from?.data?.parsed?.info?.tokenAmount?.amount ?? "0");
  if (have < units) throw new MarketError(422, "insufficient_usdc", `This wallet holds ${usdcText(Number(have) / 10 ** USDC_DECIMALS)} USDC; the price is ${usdcText(l.priceUsdc)} USDC.`);
  const creates = !payout;
  const need = 10_000 + (creates ? ATA_RENT_LAMPORTS : 0);
  if ((sol?.lamports ?? 0) < need) throw new MarketError(422, "insufficient_sol", `This wallet needs about ${(need / 1e9).toFixed(4)} SOL for the network fee${creates ? " and the payout wallet's USDC account" : ""}.`);
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(units, 1);
  data[9] = USDC_DECIMALS;
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [ // CreateIdempotent
      { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: dst, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }] }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM, data, keys: [
      { pubkey: src, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dst, isSigner: false, isWritable: true }, { pubkey: payer, isSigner: true, isWritable: false }] }),
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(memoOf(nonceFor(l.agent, owner))) }),
  ];
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bh.value.blockhash, instructions: ixs }).compileToV0Message();
  return { transaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"), lastValidBlockHeight: bh.value.lastValidBlockHeight, amountUsdc: l.priceUsdc, payTo: l.payTo, createsPayoutAccount: creates };
}

/** An unsigned x402 "exact" payment from `wallet` (the spec's layout: compute limit, compute price, TransferChecked, memo), fee
 *  payer = this server's facilitator: the wallet signs as the payer only and needs no SOL. Refused early without the USDC or
 *  without the payout wallet's USDC account (the facilitator never creates accounts). */
export async function buildX402Tx(l: Listing, wallet: string, owner: string): Promise<{ transaction: string; requirements: Requirements; lastValidBlockHeight: number; amountUsdc: number; payTo: string }> {
  if (!isPubkey(wallet)) throw new MarketError(400, "bad_wallet", "wallet must be a Solana address");
  if (wallet === l.payTo) throw new MarketError(400, "self_payment", "This wallet is the listing's payout wallet: it cannot pay itself.");
  const fp = feePayer();
  if (!fp || !facilitatorReady()) throw new MarketError(503, "facilitator_off", "The x402 facilitator is not configured on this server.");
  const req = x402RequirementsFor(l, owner);
  const payer = new PublicKey(wallet), to = new PublicKey(l.payTo), mint = new PublicKey(USDC_MINT);
  const src = ataOf(payer, mint), dst = ataOf(to, mint);
  const [accts, bh] = await Promise.all([
    nowRpc<{ value: ParsedAcct[] }>("getMultipleAccounts", [[src.toBase58(), dst.toBase58()], { encoding: "jsonParsed", commitment: "confirmed" }]),
    nowRpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]),
  ]);
  const [from, payout] = accts?.value ?? [];
  const units = BigInt(req.amount);
  const have = BigInt(from?.data?.parsed?.info?.tokenAmount?.amount ?? "0");
  if (have < units) throw new MarketError(422, "insufficient_usdc", `This wallet holds ${usdcText(Number(have) / 10 ** USDC_DECIMALS)} USDC; the price is ${usdcText(l.priceUsdc)} USDC.`);
  if (!payout) throw new MarketError(422, "payout_account_missing", "The creator's wallet has no USDC account yet, so it cannot receive an x402 payment.");
  const data = Buffer.alloc(10);
  data[0] = 12; data.writeBigUInt64LE(units, 1); data[9] = USDC_DECIMALS;
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM, data, keys: [
      { pubkey: src, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dst, isSigner: false, isWritable: true }, { pubkey: payer, isSigner: true, isWritable: false }] }),
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(req.extra.memo!) }),
  ];
  const msg = new TransactionMessage({ payerKey: fp.publicKey, recentBlockhash: bh.value.blockhash, instructions: ixs }).compileToV0Message();
  return { transaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"), requirements: req, lastValidBlockHeight: bh.value.lastValidBlockHeight, amountUsdc: l.priceUsdc, payTo: l.payTo };
}

/** True when the transaction (fee payer = the signer) carries a USDC transferChecked of at least the price to the payout
 *  wallet's USDC account, signed by its owner. A wallet may add its own instructions; the payment must still be in there. */
export function paysListing(tx: VersionedTransaction, l: Listing): boolean {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const payer = keys[0];
  if (!payer) return false;
  const dst = ataOf(new PublicKey(l.payTo), new PublicKey(USDC_MINT)).toBase58();
  const units = unitsOf(l.priceUsdc);
  return tx.message.compiledInstructions.some((ix) => {
    if (keys[ix.programIdIndex] !== TOKEN_PROGRAM.toBase58()) return false;
    const d = Buffer.from(ix.data);
    if (d.length !== 10 || d[0] !== 12 || d[9] !== USDC_DECIMALS) return false;
    const [, mint, to, auth] = ix.accountKeyIndexes.map((i) => keys[i]);
    return mint === USDC_MINT && to === dst && auth === payer && d.readBigUInt64LE(1) >= units;
  });
}

/** Relay a signed payment through NOWNodes (sendTransaction), only when it pays this listing. */
export async function sendPaymentTx(l: Listing, signedB64: string): Promise<{ signature: string }> {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(String(signedB64 ?? ""), "base64")); } catch { throw new MarketError(400, "bad_transaction", "not a Solana transaction"); }
  if (!paysListing(tx, l)) throw new MarketError(403, "not_this_payment", "This server only relays a USDC payment of this listing's price to its payout wallet.");
  if (!tx.signatures[0] || tx.signatures[0].every((b) => b === 0)) throw new MarketError(400, "unsigned", "The transaction is not signed.");
  const signature = await nowRpc<string>("sendTransaction", [signedB64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
  return { signature };
}

// ── boot ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const timers: ReturnType<typeof setInterval>[] = [];
let started = false;
/** On server boot, next to initBots(): profit-share subscriptions for every live copy (with a catch-up over its fills), and the
 *  hourly headline refresh. Safe to call twice; tests never start the timers. */
export function initMarketplace(): void {
  if (started) return;
  started = true;
  try { syncShares(); } catch (e) { logger.warn({ err: String(e).slice(0, 200) }, "market: profit-share sync failed"); }
  if (process.env.NODE_ENV === "test") return;
  timers.push(setInterval(() => { try { syncShares(); } catch (e) { logger.warn({ err: String(e).slice(0, 200) }, "market: profit-share sync failed"); } }, 60_000));
  timers.push(setInterval(() => void refreshStale(), 10 * 60_000));
  const warm = setTimeout(() => void refreshStale(), 30_000);
  (warm as any).unref?.();
  for (const t of timers) (t as any).unref?.();
}

// ── tests ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const _marketTest = {
  setDeps(d: Partial<Deps>) { deps = { ...defaults(), ...d }; },
  syncShares, refreshStale, refreshHeadline, shareSubs,
  reset() {
    for (const off of shareSubs.values()) off();
    shareSubs.clear(); inflight.clear();
    for (const t of timers) clearInterval(t);
    timers.length = 0; started = false; refreshing = false;
    deps = defaults();
    db?.close(); db = null;
  },
};
