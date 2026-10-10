// Monad trades for the agents, from Chord's API. Chord has no per-wallet tape route for Monad, so ONE shared feed reads its
// large-trade list (GET /v1/smart-money/whales: every swap of about $50 or more on Monad's DEXes over 24 h, newest first, with
// the wallet) every 10 s, pages back to the newest row it already holds, and keeps 24 h in memory. A wallet's trades are a
// filter of that feed; a token's trades come from GET /v1/tokens/trades/:token; the board from GET /v1/smart-money/top.
// Feed times are unix SECONDS; everything handed to the rest of the engine is converted to milliseconds. The feed's own lag
// behind the chain (Chord's indexer) is measured and shown, never hidden.
import { chordMonad } from "../monad/chord";
import { isAddress, isQuoteToken, lower } from "../monad/chain";
import { noteSymbol } from "./market";
import { validateDays } from "./validate";
import type { SourceTrade, Trader } from "./types";

/** One swap row. */
export interface TapeRow { ts: number; side: "buy" | "sell"; token: string; symbol: string | null; usd: number | null; priceUsd: number | null; tokenAmount: number; tx: string; wallet?: string | null; dex?: string | null }

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function rowOf(r: any): TapeRow | null {
  if (!r || typeof r.tx !== "string" || !isAddress(r.token) || (r.side !== "buy" && r.side !== "sell") || !Number.isFinite(Number(r.ts))) return null;
  const tokenAmount = Number(r.tokenAmt ?? r.tokenAmount) || 0;
  const usd = num(r.usd);
  const symbol = typeof r.symbol === "string" ? r.symbol : null;
  if (symbol) noteSymbol(r.token, symbol);
  return { ts: Number(r.ts), side: r.side, token: lower(r.token), symbol, usd, priceUsd: num(r.priceUsd) ?? (usd != null && tokenAmount > 0 ? usd / tokenAmount : null),
    tokenAmount, tx: lower(r.tx), wallet: isAddress(r.wallet) ? lower(r.wallet) : null, dex: typeof r.dex === "string" ? r.dex : null };
}

// ── the shared feed ─────────────────────────────────────────────────────────────────────────────────────────────────
export const FEED_MS = 10_000;
const KEEP_S = 24 * 3600;
const PAGE = 100;
const FIRST_PAGES = 40;   // the first fill reads back to 24 h (the list holds ~2,500 rows a day)
const NEXT_PAGES = 5;     // later polls stop at the first page that reaches what is held
const MAX_ROWS = 40_000;

let rows: TapeRow[] = [];           // newest first
const keys = new Set<string>();
let loaded: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let polling: Promise<void> | null = null;
let lastPollAt: number | null = null;
let lastError: string | null = null;
const keyOf = (r: TapeRow) => `${r.tx}|${r.wallet}|${r.token}|${r.side}`;

async function pullFeed(maxPages: number): Promise<void> {
  const newest = rows[0]?.ts ?? 0;
  const fresh: TapeRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const j = await chordMonad<{ trades?: any[]; hasMore?: boolean }>(`/smart-money/whales?min=50&page=${page}&pageSize=${PAGE}`, 12_000);
    const got = (Array.isArray(j?.trades) ? j.trades : []).map(rowOf).filter((r): r is TapeRow => !!r);
    for (const r of got) if (!keys.has(keyOf(r))) fresh.push(r);
    if (!j?.hasMore || !got.length || got[got.length - 1]!.ts < newest) break;
  }
  if (fresh.length) {
    for (const r of fresh) keys.add(keyOf(r));
    rows = [...fresh, ...rows].sort((a, b) => b.ts - a.ts);
  }
  const floor = Math.floor(Date.now() / 1000) - KEEP_S;
  if (rows.length > MAX_ROWS || (rows.length && rows[rows.length - 1]!.ts < floor)) {
    const keep = rows.filter((r, i) => i < MAX_ROWS && r.ts >= floor);
    for (const r of rows) if (!keep.includes(r)) keys.delete(keyOf(r));
    rows = keep;
  }
  lastPollAt = Date.now();
  lastError = null;
}

function poll(maxPages: number): Promise<void> {
  if (polling) return polling;
  polling = pullFeed(maxPages).catch((e) => { lastError = String((e as Error)?.message ?? e).slice(0, 200); }).finally(() => { polling = null; });
  return polling;
}

/** Start the shared feed (idempotent); resolves once the first 24 h are held or the first read failed. */
export function startFeed(): Promise<void> {
  if (!loaded) loaded = poll(FIRST_PAGES);
  if (!timer) { timer = setInterval(() => { void poll(NEXT_PAGES); }, FEED_MS); (timer as any).unref?.(); }
  return loaded;
}
export function stopFeed(): void { if (timer) clearInterval(timer); timer = null; }

/** How fresh the feed is: rows held, the newest trade, its age (Chord's indexer lag + our poll), the last poll and error. */
export function feedStatus(): { rows: number; newestTs: number | null; lagS: number | null; lastPollAt: number | null; lastError: string | null } {
  const newestTs = rows[0]?.ts ?? null;
  return { rows: rows.length, newestTs: newestTs ? newestTs * 1000 : null, lagS: newestTs ? Math.max(0, Math.floor(Date.now() / 1000) - newestTs) : null, lastPollAt, lastError };
}
/** Every held row (newest first) — the backtests and the strategy sources read the same feed the live agents see. */
export async function feedRows(): Promise<TapeRow[]> { await startFeed(); return rows; }

/** The wallet's newest swaps (newest first), at most `limit` (≤ 200), strictly before `beforeS` (unix s) when given. */
export async function walletTrades(wallet: string, limit = 100, beforeS: number | null = null): Promise<TapeRow[]> {
  await startFeed();
  const w = lower(wallet), n = Math.max(1, Math.min(200, limit));
  const out: TapeRow[] = [];
  for (const r of rows) {
    if (r.wallet !== w || (beforeS && r.ts >= beforeS)) continue;
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}
/** The token's newest swaps across its pools (newest first), each with the wallet that made it. */
export async function tokenTrades(mint: string, limit = 100): Promise<TapeRow[]> {
  const j = await chordMonad<{ trades?: any[] }>(`/tokens/trades/${lower(mint)}?limit=${Math.max(1, Math.min(100, limit))}`);
  if (!Array.isArray(j?.trades)) throw new Error("Chord's token trades answered without a list");
  return j.trades.map(rowOf).filter((r): r is TapeRow => !!r);
}

/** A tape row as a source trade; null for rows the agents never act on (a quote token, or no wallet). */
export function toSource(r: TapeRow, wallet: string | null = r.wallet ?? null): SourceTrade | null {
  if (!wallet || isQuoteToken(r.token, r.symbol)) return null;
  return { wallet: lower(wallet), tx: r.tx, side: r.side, mint: r.token, symbol: r.symbol, usd: r.usd, priceUsd: r.priceUsd, ts: r.ts * 1000, via: "tape" };
}

// ── the smart-money board ───────────────────────────────────────────────────────────────────────────────────────────
function toTrader(r: any): Trader {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const t = r.topToken;
  return {
    wallet: lower(String(r.wallet)), score: n(r.smartScore), realizedPnlUsd: n(r.realizedUsd ?? r.pnlUsd), roi: null, winRate: n(r.winRate), trades: n(r.trades),
    tokens: n(r.tokensTraded), volumeUsd: n(r.volumeUsd), medianHoldS: null, lastTrade: n(r.lastActiveTs) * 1000,
    bestToken: t && typeof t === "object" && typeof t.symbol === "string" ? { mint: null, symbol: t.symbol, image: null, realizedPnlUsd: n(t.pnlUsd) } : null,
  };
}
const boardCache = new Map<string, { at: number; v: Trader[] }>();
/** Chord's Monad smart-money board over every DEX (bots removed by its rules), ranked by its Smart Score. Chord keeps 24 h and
 *  7 d windows: 1 day reads 24 h, 3 and 7 days read 7 d. ROI and hold time are not on the board (null). */
export async function smartTraders(days: 1 | 3 | 7, limit = 20): Promise<Trader[]> {
  const d = validateDays(days);
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 20));
  const window = d === 1 ? "24h" : "7d";
  const hit = boardCache.get(window);
  if (hit && Date.now() - hit.at < 60_000) return hit.v.slice(0, n);
  const j = await chordMonad<{ wallets?: unknown }>(`/smart-money/top?source=onchain&window=${window}&limit=100`);
  if (!Array.isArray(j?.wallets)) throw new Error("Chord's smart-money board answered without a list");
  const v = (j.wallets as any[]).filter((r) => r && isAddress(r.wallet)).map(toTrader);
  boardCache.set(window, { at: Date.now(), v });
  return v.slice(0, n);
}

export function _resetTape(): void { rows = []; keys.clear(); loaded = null; stopFeed(); polling = null; lastPollAt = null; lastError = null; boardCache.clear(); }
