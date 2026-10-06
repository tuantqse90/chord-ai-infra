// The Chord Solana reads the strategy side needs beyond src/bots/tape.ts: the new-token board, a token's view (pools, change,
// liquidity), its traders over the last hour, its candles, LP pools / events, the trending board. Straight to CHORD_API with
// chordHeaders() (the owner's key = no anonymous per-IP limit); every function takes the transport so tests run offline.
// Tape times are unix SECONDS; what leaves this module is converted where the name says Ms.
import { chordHeaders, config } from "../config";
import { http } from "../bots/market";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ChordNotFound extends Error {}

export async function chordJson<T>(path: string, f: Fetch = http, timeoutMs = 8_000): Promise<T> {
  const base = config.chordApi();
  if (!base) throw new Error("Chord's API is switched off on this server (CHORD_API=off)");
  const r = await f(`${base}${path}`, { headers: chordHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  const what = path.split("?")[0].replace(/\/[1-9A-HJ-NP-Za-km-z]{32,44}(\/|$)/g, "/…$1");
  if (r.status === 404) throw new ChordNotFound(`Chord ${what}: not found`);
  if (!r.ok) throw new Error(`Chord ${what} answered ${r.status}`);
  return (await r.json()) as T;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Bonding-curve venues (a token trading here has not graduated) and the pools tokens graduate into. */
export const LAUNCHPAD_DEXES = new Set(["pumpfun", "meteora_dbc", "raydium_launchlab"]);
export const AMM_DEXES = new Set(["pumpswap", "meteora_damm_v2", "raydium_cpmm", "raydium_v4", "meteora_pools", "meteora_dlmm", "raydium_clmm", "orca"]);

export interface BoardRow { mint: string; symbol: string | null; name: string | null; priceUsd: number | null; liquidityUsd: number | null; marketCapUsd: number | null; volume24hUsd: number; dex: string | null; pool: string | null; firstSeen: number | null; change24hPct: number | null }
function boardRow(r: any): BoardRow | null {
  if (!r || typeof r.token !== "string") return null;
  return {
    mint: r.token, symbol: str(r.symbol), name: str(r.name), priceUsd: num(r.priceUsd), liquidityUsd: num(r.liquidityUsd), marketCapUsd: num(r.marketCapUsd),
    volume24hUsd: num(r.volume24hUsd) ?? 0, dex: str(r.dex), pool: str(r.pool), firstSeen: num(r.firstSeen), change24hPct: num(r.change24hPct),
  };
}

/** GET /v1/chains/solana/tokens?sort=…: the 24 h token board. `new` = tokens first seen in the last 24 h (among the 400 most
 *  traded with $5k+ volume), newest first; `volume` = the trending board. */
export async function board(sort: "new" | "volume" | "change" | "trades", limit = 200, f?: Fetch): Promise<BoardRow[]> {
  const j = await chordJson<{ tokens?: unknown }>(`/v1/chains/solana/tokens?sort=${sort}&limit=${Math.max(1, Math.min(200, limit))}`, f);
  if (!Array.isArray(j?.tokens)) throw new Error("Chord's token board answered without a list");
  return (j.tokens as any[]).map(boardRow).filter((x): x is BoardRow => !!x);
}

export interface TokenPool { pool: string; dex: string; liquidityUsd: number | null; volumeUsd: number; firstSeen: number | null; lastTrade: number | null }
export interface TokenView {
  mint: string; symbol: string | null; priceUsd: number | null; change1hPct: number | null; change24hPct: number | null; marketCapUsd: number | null;
  liquidityUsd: number | null; volume24hUsd: number | null; firstSeen: number | null; pools: TokenPool[];
}
/** GET /v1/chains/solana/token/:mint?hours=… (null = the tape never saw it trade). */
export async function tokenView(mint: string, hours = 2, f?: Fetch): Promise<TokenView | null> {
  let j: any;
  try { j = await chordJson<any>(`/v1/chains/solana/token/${encodeURIComponent(mint)}?hours=${hours}`, f); }
  catch (e) { if (e instanceof ChordNotFound) return null; throw e; }
  if (!j || typeof j !== "object") return null;
  return {
    mint, symbol: str(j.symbol), priceUsd: num(j.priceUsd), change1hPct: num(j.change1hPct), change24hPct: num(j.change24hPct), marketCapUsd: num(j.marketCapUsd),
    liquidityUsd: num(j.liquidityUsd), volume24hUsd: num(j.volume24hUsd), firstSeen: num(j.firstSeen),
    pools: Array.isArray(j.pools) ? j.pools.filter((p: any) => typeof p?.pool === "string").map((p: any) => ({
      pool: p.pool, dex: String(p.dex ?? ""), liquidityUsd: num(p.liquidityUsd), volumeUsd: num(p.volumeUsd) ?? 0, firstSeen: num(p.firstSeen), lastTrade: num(p.lastTrade),
    })) : [],
  };
}

export interface TokenTrader { wallet: string; boughtUsd: number; soldUsd: number; lastTrade: number | null }
/** GET /v1/chains/solana/token/:mint/traders?hours=1&limit=100: the top wallets of the current and the previous UTC hour. */
export async function tokenTraders(mint: string, hours = 1, f?: Fetch): Promise<{ since: number | null; traders: TokenTrader[] } | null> {
  let j: any;
  try { j = await chordJson<any>(`/v1/chains/solana/token/${encodeURIComponent(mint)}/traders?hours=${hours}&limit=100`, f); }
  catch (e) { if (e instanceof ChordNotFound) return null; throw e; }
  if (!j || !Array.isArray(j.traders)) return null;
  return {
    since: num(j.since),
    traders: j.traders.filter((t: any) => typeof t?.wallet === "string").map((t: any) => ({ wallet: t.wallet, boughtUsd: num(t.boughtUsd) ?? 0, soldUsd: num(t.soldUsd) ?? 0, lastTrade: num(t.lastTrade) })),
  };
}

export interface Candle { t: number; o: number; h: number; l: number; c: number }
export const TF_MIN = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 } as const;
export type Timeframe = keyof typeof TF_MIN;
/** GET /v1/chains/solana/token/:mint/candles: OHLC of the token's main pool, oldest first, `t` in unix MILLISECONDS. */
export async function candles(mint: string, tf: Timeframe, limit: number, f?: Fetch): Promise<Candle[]> {
  let j: any;
  try { j = await chordJson<any>(`/v1/chains/solana/token/${encodeURIComponent(mint)}/candles?tf=${tf}&limit=${Math.max(1, Math.min(1000, Math.floor(limit)))}`, f); }
  catch (e) { if (e instanceof ChordNotFound) return []; throw e; }
  if (!Array.isArray(j?.candles)) return [];
  return (j.candles as any[])
    .map((c) => ({ t: Number(c?.t) * 1000, o: num(c?.o), h: num(c?.h), l: num(c?.l), c: num(c?.c) }))
    .filter((c): c is Candle => Number.isFinite(c.t) && c.o != null && c.h != null && c.l != null && c.c != null && c.c > 0)
    .sort((a, b) => a.t - b.t);
}

export interface LpHour { hour: number; depositsUsd: number; withdrawalsUsd: number }
export interface LpPoolView { pool: string; token: string | null; symbol: string | null; since: number | null; hourly: LpHour[] }
/** GET /v1/chains/solana/lp/pool/:pool?hours=…: liquidity in / out by hour (null = the tape never saw liquidity move there). */
export async function lpPool(pool: string, hours: number, f?: Fetch): Promise<LpPoolView | null> {
  let j: any;
  try { j = await chordJson<any>(`/v1/chains/solana/lp/pool/${encodeURIComponent(pool)}?hours=${Math.max(1, Math.min(168, Math.floor(hours)))}`, f); }
  catch (e) { if (e instanceof ChordNotFound) return null; throw e; }
  if (!j || typeof j !== "object") return null;
  const token = str(j.token);
  return {
    pool, token, symbol: token && token === j.mintA ? str(j.symbolA) : token && token === j.mintB ? str(j.symbolB) : null, since: num(j.since),
    hourly: Array.isArray(j.hourly) ? j.hourly.map((h: any) => ({ hour: Number(h?.hour), depositsUsd: num(h?.depositsUsd) ?? 0, withdrawalsUsd: num(h?.withdrawalsUsd) ?? 0 })).filter((h: LpHour) => Number.isFinite(h.hour)) : [],
  };
}

export interface LpEventRow { ts: number; signature: string | null; kind: string; pool: string; usd: number | null; owner: string | null }
/** GET /v1/chains/solana/lp/pool/:pool/events: newest first; `ts` unix seconds. */
export async function lpEvents(pool: string, limit = 50, beforeS: number | null = null, f?: Fetch): Promise<LpEventRow[]> {
  let j: any;
  try { j = await chordJson<any>(`/v1/chains/solana/lp/pool/${encodeURIComponent(pool)}/events?limit=${Math.max(1, Math.min(200, limit))}${beforeS ? `&before=${Math.floor(beforeS)}` : ""}`, f); }
  catch (e) { if (e instanceof ChordNotFound) return []; throw e; }
  if (!Array.isArray(j?.events)) return [];
  return (j.events as any[]).filter((e) => e && Number.isFinite(Number(e.ts)) && typeof e.kind === "string").map((e) => ({
    ts: Number(e.ts), signature: str(e.signature), kind: e.kind, pool: typeof e.pool === "string" ? e.pool : pool, usd: num(e.usd), owner: str(e.owner),
  }));
}
