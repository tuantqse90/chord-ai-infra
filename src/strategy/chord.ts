// The Chord reads the strategy side needs on Monad beyond src/bots/tape.ts: the token board (most traded / newest), a token's
// view (price, changes, liquidity, pools), who traded it in the last hour, its candles. Straight to CHORD_API with
// chordHeaders() (the owner's key = no anonymous per-IP limit); every function takes the transport so tests run offline.
// Chord has no Monad launch board and no Monad LP tape: lpPool / lpEvents answer nothing (the schema refuses the triggers that
// would read them, src/strategy/schema.ts MONAD_UNAVAILABLE). Times leave this module as unix SECONDS unless a name says Ms.
import { chordHeaders, config } from "../config";
import { http } from "../bots/market";
import { feedRows } from "../bots/tape";
import { isAddress, lower, MONAD_CHAIN_ID } from "../monad/chain";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ChordNotFound extends Error {}

export async function chordJson<T>(path: string, f: Fetch = http, timeoutMs = 10_000): Promise<T> {
  const base = config.chordApi();
  if (!base) throw new Error("Chord's API is switched off on this server (CHORD_API=off)");
  const r = await f(`${base}${path}`, { headers: chordHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  const what = path.split("?")[0].replace(/\/0x[0-9a-fA-F]{40}(\/|$)/g, "/…$1");
  if (r.status === 404) throw new ChordNotFound(`Chord ${what}: not found`);
  if (!r.ok) throw new Error(`Chord ${what} answered ${r.status}`);
  return (await r.json()) as T;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Kept for the shared source code: Monad has no bonding-curve venue on Chord's board. */
export const LAUNCHPAD_DEXES = new Set<string>();
export const AMM_DEXES = new Set<string>();

export interface BoardRow { mint: string; symbol: string | null; name: string | null; priceUsd: number | null; liquidityUsd: number | null; marketCapUsd: number | null; volume24hUsd: number; dex: string | null; pool: string | null; firstSeen: number | null; change24hPct: number | null }

/** Chord's Monad token board: the curated token list joined with the price map (24 h volume and change). `volume` = most
 *  traded first; `new` = tokens the list dates (createdAt) in the last 24 h, newest first; `change` = biggest 24 h movers. */
export async function board(sort: "new" | "volume" | "change" | "trades", limit = 200, f?: Fetch): Promise<BoardRow[]> {
  const [list, market] = await Promise.all([
    chordJson<{ tokens?: any[] }>(`/v1/tokens?chain=${MONAD_CHAIN_ID}`, f),
    chordJson<{ market?: Record<string, any> }>(`/v1/tokens/market?chain=${MONAD_CHAIN_ID}`, f),
  ]);
  const m = market?.market ?? {};
  const rows: BoardRow[] = (Array.isArray(list?.tokens) ? list.tokens : []).filter((t) => isAddress(t?.address)).map((t) => {
    const k = lower(t.address), px = m[k] ?? {};
    const created = num(t.createdAt);
    return { mint: k, symbol: str(t.symbol), name: str(t.name), priceUsd: num(px.priceUsd), liquidityUsd: num(t.liquidityUsd), marketCapUsd: null,
      volume24hUsd: num(px.volume24h) ?? 0, dex: null, pool: null, firstSeen: created != null ? (created > 1e12 ? Math.floor(created / 1000) : created) : null, change24hPct: num(px.change24h) };
  });
  const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
  const out = sort === "new" ? rows.filter((r) => r.firstSeen != null && r.firstSeen >= dayAgo).sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0))
    : sort === "change" ? rows.filter((r) => r.change24hPct != null).sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))
    : rows.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  return out.slice(0, Math.max(1, Math.min(200, limit)));
}

export interface TokenPool { pool: string; dex: string; liquidityUsd: number | null; volumeUsd: number; firstSeen: number | null; lastTrade: number | null }
export interface TokenView {
  mint: string; symbol: string | null; priceUsd: number | null; change1hPct: number | null; change24hPct: number | null; marketCapUsd: number | null;
  liquidityUsd: number | null; volume24hUsd: number | null; firstSeen: number | null; pools: TokenPool[];
  /** Monad extras from Chord's stats: the last 5 min and hour of buys / sells */
  change5mPct?: number | null; buys1h?: number | null; sells1h?: number | null; buyVol1h?: number | null; sellVol1h?: number | null;
}
/** GET /v1/tokens/stats/:token (null = Chord never saw it trade). */
export async function tokenView(mint: string, _hours = 2, f?: Fetch): Promise<TokenView | null> {
  let j: any;
  try { j = await chordJson<any>(`/v1/tokens/stats/${lower(mint)}`, f); }
  catch (e) { if (e instanceof ChordNotFound) return null; throw e; }
  if (!j || typeof j !== "object") return null;
  const w = j.windows ?? {};
  const h24 = w.h24 ?? {}, h1 = w.h1 ?? {}, m5 = w.m5 ?? {};
  const vol24 = (num(h24.buyVol) ?? 0) + (num(h24.sellVol) ?? 0);
  return {
    mint: lower(mint), symbol: null, priceUsd: num(j.priceUsd), change1hPct: num(h1.change), change24hPct: num(h24.change), marketCapUsd: null,
    liquidityUsd: num(j.liquidityUsd), volume24hUsd: vol24 || null, firstSeen: num(j.firstTradeTs),
    pools: Array.isArray(j.markets) ? j.markets.filter((p: any) => typeof p?.pool === "string").map((p: any) => ({
      pool: lower(p.pool), dex: String(p.dex ?? ""), liquidityUsd: null, volumeUsd: num(p.vol24h) ?? 0, firstSeen: null, lastTrade: null,
    })) : [],
    change5mPct: num(m5.change), buys1h: num(h1.buys), sells1h: num(h1.sells), buyVol1h: num(h1.buyVol), sellVol1h: num(h1.sellVol),
  };
}

export interface TokenTrader { wallet: string; boughtUsd: number; soldUsd: number; lastTrade: number | null }
/** Who traded the token in the last `hours` of Chord's Monad feed (swaps of about $50 or more), newest activity first.
 *  `since` is the start of that window on the feed's own clock (unix s). */
export async function tokenTraders(mint: string, hours = 1, _f?: Fetch): Promise<{ since: number | null; traders: TokenTrader[] } | null> {
  const rows = await feedRows();
  const head = rows[0]?.ts ?? Math.floor(Date.now() / 1000);
  const since = head - hours * 3600, m = lower(mint);
  const by = new Map<string, TokenTrader>();
  for (const r of rows) {
    if (r.ts < since) break;
    if (r.token !== m || !r.wallet) continue;
    const t = by.get(r.wallet) ?? { wallet: r.wallet, boughtUsd: 0, soldUsd: 0, lastTrade: null };
    if (r.side === "buy") t.boughtUsd += r.usd ?? 0; else t.soldUsd += r.usd ?? 0;
    t.lastTrade = Math.max(t.lastTrade ?? 0, r.ts);
    by.set(r.wallet, t);
  }
  return { since, traders: [...by.values()].sort((a, b) => (b.lastTrade ?? 0) - (a.lastTrade ?? 0)) };
}

export interface Candle { t: number; o: number; h: number; l: number; c: number }
export const TF_MIN = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 } as const;
export type Timeframe = keyof typeof TF_MIN;
/** GET /v1/candles?chain=143&token&tf: OHLC from Chord's own Monad trade index, oldest first, `t` in unix MILLISECONDS. */
export async function candles(mint: string, tf: Timeframe, limit: number, f?: Fetch): Promise<Candle[]> {
  let j: any;
  try { j = await chordJson<any>(`/v1/candles?chain=${MONAD_CHAIN_ID}&token=${lower(mint)}&tf=${tf}&limit=${Math.max(1, Math.min(1000, Math.floor(limit)))}`, f); }
  catch (e) { if (e instanceof ChordNotFound) return []; throw e; }
  if (!Array.isArray(j?.candles)) return [];
  return (j.candles as any[])
    .map((c) => ({ t: Number(c?.t) * 1000, o: num(c?.o), h: num(c?.h), l: num(c?.l), c: num(c?.c) }))
    .filter((c): c is Candle => Number.isFinite(c.t) && c.o != null && c.h != null && c.l != null && c.c != null && c.c > 0)
    .sort((a, b) => a.t - b.t);
}

export interface LpHour { hour: number; depositsUsd: number; withdrawalsUsd: number }
export interface LpPoolView { pool: string; token: string | null; symbol: string | null; since: number | null; hourly: LpHour[] }
/** No Monad LP tape on Chord: nothing to read. */
export async function lpPool(_pool: string, _hours: number, _f?: Fetch): Promise<LpPoolView | null> { return null; }

export interface LpEventRow { ts: number; signature: string | null; kind: string; pool: string; usd: number | null; owner: string | null }
/** No Monad LP tape on Chord: nothing to read. */
export async function lpEvents(_pool: string, _limit = 50, _beforeS: number | null = null, _f?: Fetch): Promise<LpEventRow[]> { return []; }
