// What the LP agent reads, every number with its source:
//  - Chord's Solana LP tape through chordGet (the unlimited key): /lp/pools (24 h flows per pool), /lp/pool/:address?hours=1
//    (the pool's mints, decimals, first LP event and the LAST HOUR of deposits / withdrawals), /lp/pool/:address?hours=N (hourly
//    flows, for the backtest's exodus replay), and the hourly candles of /token/:mint/candles (USD closes of the token in that
//    pool; the quote token's from its main pool).
//  - The venues' public pool APIs for TVL, 24 h volume / fees and the fee APR, cached 3 min (errors 1 min):
//    Meteora DLMM  https://dlmm.datapi.meteora.ag/pools/<pool>      (the old dlmm-api.meteora.ag/pair/<pool> answers 404 since 2026)
//    Meteora DAMM v2 https://damm-v2.datapi.meteora.ag/pools/<pool>
//    Raydium CLMM  https://api-v3.raydium.io/pools/info/ids?ids=<pool>
//    PumpSwap has no public pool API: its TVL is Chord's (sol_pools liquidity) and its fee APR stays unknown.
//  - Jupiter (src/bots/market.ts): live USD prices (batched, cached 30 s), token facts (mint / freeze authority), quotes.
import { chordGet, ChordApiNotFound } from "../chord/services/chordApi";
import { KNOWN_MINTS } from "../solana/tokens";
import { BotInputError } from "./errors";
import { http, paperQuote, prices, SOL_MINT, tokenInfo, USDC_MINT, USDT_MINT, type PaperQuote, type TokenInfo } from "./market";

export interface LpDeps {
  /** GET a Chord path (JSON), cached `ttlMs`. A 404 throws ChordApiNotFound. */
  chord: <T>(path: string, ttlMs: number, timeoutMs?: number) => Promise<T>;
  /** GET a venue URL (JSON). */
  venue: (url: string) => Promise<unknown>;
  prices: (mints: string[]) => Promise<Map<string, number>>;
  tokenInfo: (mint: string) => Promise<TokenInfo | null>;
  quote: (inMint: string, outMint: string, amount: number, slippageBps: number) => Promise<PaperQuote>;
  now: () => number;
}

async function venueGet(url: string): Promise<unknown> {
  const r = await http(url, { headers: { Accept: "application/json", "User-Agent": "ask2049-lp/1" }, signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

export const defaultLpDeps = (): LpDeps => ({ chord: chordGet, venue: venueGet, prices, tokenInfo, quote: paperQuote, now: () => Date.now() });

export const STABLE_USD = new Set([USDC_MINT, USDT_MINT]);
export const EXODUS_RATIO = 2;
export const EXODUS_MIN_USD = 1_000;
export const EXODUS_TVL_SHARE = 0.1;
/** The pool's TVL for the exodus rule: Chord's own estimate, else the venue's API (Meteora / Raydium, cached). Chord has none for
 *  DLMM / CLMM pools, so without the venue the 10 % share was never applied live (QA 07/10: SI-SOL exited on 0.45 % of its TVL). */
export async function poolTvl(d: LpDeps, info: Pick<PoolInfo, "tvlUsd" | "dex" | "pool" | "token">): Promise<number | null> {
  if (info.tvlUsd != null && info.tvlUsd > 0) return info.tvlUsd;
  const v = await venueStats(d, info.dex, info.pool, info.token).catch(() => null);
  return v?.v?.tvlUsd ?? null;
}
/** LP exodus: the last hour's withdrawals pass 2 × its deposits, at least $1,000, and (when the pool's TVL is known) the net
 *  outflow is at least 10 % of it. Without the TVL share every big pool "fled" on normal flows (measured 07/10: SOL-USDC with
 *  $7.3M TVL exited on $134k out vs $12k in, 1.7 % of the pool; PUMP-SOL $2M on $1.1k out). */
export const isExodus = (depositsUsd: number, withdrawalsUsd: number, tvlUsd: number | null = null) =>
  withdrawalsUsd >= EXODUS_MIN_USD && withdrawalsUsd > EXODUS_RATIO * depositsUsd &&
  (tvlUsd == null || !(tvlUsd > 0) || withdrawalsUsd - depositsUsd >= EXODUS_TVL_SHARE * tvlUsd);

export const DEX_LABEL: Record<string, string> = { meteora_dlmm: "Meteora DLMM", meteora_damm_v2: "Meteora DAMM v2", raydium_clmm: "Raydium CLMM", pumpswap: "PumpSwap" };
export const venueLabel = (dex: string) => DEX_LABEL[dex] ?? dex;
/** PumpSwap is x·y = k; DAMM v2 pools share one pool-wide price range for every LP. Both are modeled full-range. */
export const isFullRangeDex = (dex: string) => dex === "pumpswap" || dex === "meteora_damm_v2";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const symOf = (mint: string, sym: unknown) => (typeof sym === "string" && sym ? sym : KNOWN_MINTS[mint]?.symbol ?? null);

// ── pools ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PoolInfo {
  pool: string; dex: string; venue: string; mintA: string; mintB: string; decimalsA: number | null; decimalsB: number | null;
  token: string; tokenSymbol: string | null; quote: string; quoteSymbol: string | null; pair: string;
  priceUsd: number | null; tvlUsd: number | null; firstLpEvent: number | null; lastHour: { depositsUsd: number; withdrawalsUsd: number };
  fullRange: boolean;
}

const quoteRank = (m: string) => (STABLE_USD.has(m) ? 2 : m === SOL_MINT ? 1 : 0);
/** Which side is the volatile token: Chord's `token` when it names a side, else the side that is not USDC / USDT / SOL. */
export function orient(mintA: string, mintB: string, token: string | null): { token: string; quote: string } {
  if (token && (token === mintA || token === mintB)) return { token, quote: token === mintA ? mintB : mintA };
  return quoteRank(mintA) > quoteRank(mintB) ? { token: mintB, quote: mintA } : { token: mintA, quote: mintB };
}

export function toPoolInfo(pool: string, j: any): PoolInfo {
  if (!j || typeof j !== "object" || typeof j.mintA !== "string" || typeof j.mintB !== "string") throw new Error("Chord's LP pool answer had no mints");
  const dex = String(j.dex ?? "unknown");
  const o = orient(j.mintA, j.mintB, typeof j.token === "string" ? j.token : null);
  const symA = symOf(j.mintA, j.symbolA), symB = symOf(j.mintB, j.symbolB);
  const tokenSymbol = o.token === j.mintA ? symA : symB, quoteSymbol = o.quote === j.mintA ? symA : symB;
  return {
    pool, dex, venue: venueLabel(dex), mintA: j.mintA, mintB: j.mintB, decimalsA: num(j.decimalsA), decimalsB: num(j.decimalsB),
    token: o.token, tokenSymbol, quote: o.quote, quoteSymbol, pair: `${tokenSymbol ?? short(o.token)}-${quoteSymbol ?? short(o.quote)}`,
    priceUsd: num(j.priceUsd), tvlUsd: num(j.tvlUsd), firstLpEvent: num(j.firstLpEvent),
    lastHour: { depositsUsd: num(j.depositsUsd) ?? 0, withdrawalsUsd: num(j.withdrawalsUsd) ?? 0 }, fullRange: isFullRangeDex(dex),
  };
}

/** One pool from Chord (window = the last hour, so its flows ARE the exodus check). Cached 60 s. Throws BotInputError
 *  when the pool is not on Chord's LP tape. */
export async function poolInfo(d: LpDeps, pool: string): Promise<PoolInfo> {
  let j: any;
  try { j = await d.chord<any>(`/v1/chains/solana/lp/pool/${encodeURIComponent(pool)}?hours=1`, 60_000); }
  catch (e) {
    if (e instanceof ChordApiNotFound) j = null;
    else throw new Error(`Chord's LP tape could not be read for ${short(pool)}: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
  }
  if (!j) throw new BotInputError(`pool ${pool} is not on Chord's Solana LP tape (Meteora DLMM / DAMM v2, Raydium CLMM and PumpSwap pools with liquidity events); pick one from lp_scan`);
  return toPoolInfo(pool, j);
}

/** The pool's hourly deposits / withdrawals over the last `hours` (Chord), keyed by hour start (unix s). */
export async function poolHourly(d: LpDeps, pool: string, hours: number): Promise<{ since: number | null; byHour: Map<number, { depositsUsd: number; withdrawalsUsd: number }> }> {
  const j = await d.chord<any>(`/v1/chains/solana/lp/pool/${encodeURIComponent(pool)}?hours=${Math.max(1, Math.min(168, Math.round(hours)))}`, 120_000);
  const byHour = new Map<number, { depositsUsd: number; withdrawalsUsd: number }>();
  for (const h of Array.isArray(j?.hourly) ? j.hourly : []) {
    const t = num(h?.hour);
    if (t != null) byHour.set(t, { depositsUsd: num(h.depositsUsd) ?? 0, withdrawalsUsd: num(h.withdrawalsUsd) ?? 0 });
  }
  return { since: num(j?.since), byHour };
}

/** When Chord's LP decoding started (unix s), or null when its coverage already spans the 7-day window. */
export async function lpSince(d: LpDeps): Promise<number | null> {
  try {
    const j = await d.chord<any>("/v1/chains/solana/lp/pools?sort=fees&limit=1&hours=168", 10 * 60_000);
    const since = num(j?.since);
    return since != null && since > Math.floor(d.now() / 1000) - 168 * 3600 + 3600 ? since : null;
  } catch { return null; }
}

// ── venues ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface VenueStats {
  source: string; url: string;
  tvlUsd: number | null; volume24hUsd: number | null; fees24hUsd: number | null;
  feeAprPct: number | null; feeAprHow: string | null; feeRatePct: number | null; feeRateHow: string | null;
  createdAt: number | null; binStep: number | null; tickSpacing: number | null; freezeAuthorityDisabled: boolean | null;
}

export const venueUrl = (dex: string, pool: string): string | null =>
  dex === "meteora_dlmm" ? `https://dlmm.datapi.meteora.ag/pools/${pool}`
  : dex === "meteora_damm_v2" ? `https://damm-v2.datapi.meteora.ag/pools/${pool}`
  : dex === "raydium_clmm" ? `https://api-v3.raydium.io/pools/info/ids?ids=${pool}`
  : null;

export function parseMeteora(dex: string, url: string, j: any, token: string): VenueStats | null {
  if (!j || typeof j !== "object" || !("tvl" in j)) return null;
  const tvl = num(j.tvl), fees = num(j.fees?.["24h"]), prot = num(j.protocol_fees?.["24h"]), vol = num(j.volume?.["24h"]);
  const lpFees = fees != null ? fees - (prot ?? 0) : null;
  const effective = fees != null && vol != null && vol > 0 ? (fees / vol) * 100 : null;
  const base = num(j.pool_config?.base_fee_pct);
  const side = j.token_x?.address === token ? j.token_x : j.token_y?.address === token ? j.token_y : null;
  const label = dex === "meteora_dlmm" ? "Meteora DLMM API" : "Meteora DAMM v2 API";
  return {
    source: `${label} (${new URL(url).host})`, url, tvlUsd: tvl, volume24hUsd: vol, fees24hUsd: fees,
    feeAprPct: tvl != null && tvl > 0 && lpFees != null ? (lpFees / tvl) * 365 * 100 : null,
    feeAprHow: "Meteora's 24 h fees minus the protocol share, ÷ TVL × 365",
    feeRatePct: effective ?? base, feeRateHow: effective != null ? "24 h fees ÷ 24 h volume (Meteora)" : base != null ? "Meteora base fee" : null,
    createdAt: num(j.created_at), binStep: num(j.pool_config?.bin_step), tickSpacing: null,
    freezeAuthorityDisabled: typeof side?.freeze_authority_disabled === "boolean" ? side.freeze_authority_disabled : null,
  };
}

export function parseRaydium(url: string, j: any): VenueStats | null {
  const p = Array.isArray(j?.data) ? j.data.find((x: any) => x && typeof x === "object") : null;
  if (!p) return null;
  const rate = num(p.config?.tradeFeeRate ?? p.feeRate);
  const open = num(p.openTime);
  return {
    source: "Raydium API (api-v3.raydium.io)", url, tvlUsd: num(p.tvl), volume24hUsd: num(p.day?.volume), fees24hUsd: num(p.day?.volumeFee),
    feeAprPct: num(p.day?.feeApr), feeAprHow: "Raydium's day.feeApr",
    // config.tradeFeeRate is in millionths (10,000 = 1 %); a bare feeRate is a fraction (0.01 = 1 %)
    feeRatePct: rate == null ? null : p.config?.tradeFeeRate != null ? rate / 10_000 : rate * 100, feeRateHow: rate != null ? "Raydium trade fee rate" : null,
    createdAt: open && open > 0 ? open * 1000 : null, binStep: null, tickSpacing: num(p.config?.tickSpacing), freezeAuthorityDisabled: null,
  };
}

const VENUE_TTL = 3 * 60_000, VENUE_ERR_TTL = 60_000;
const venueCache = new Map<string, { at: number; v: VenueStats | null; err: string | null }>();
/** The venue's numbers for a pool (cached 3 min), or { v: null, err } when it has no API or did not answer. */
export async function venueStats(d: LpDeps, dex: string, pool: string, token: string): Promise<{ v: VenueStats | null; err: string | null }> {
  const url = venueUrl(dex, pool);
  if (!url) return { v: null, err: `${venueLabel(dex)} has no public pool API` };
  const hit = venueCache.get(pool);
  if (hit && d.now() - hit.at < (hit.err ? VENUE_ERR_TTL : VENUE_TTL)) return { v: hit.v, err: hit.err };
  let v: VenueStats | null = null, err: string | null = null;
  try {
    const j = await d.venue(url);
    v = dex === "raydium_clmm" ? parseRaydium(url, j) : parseMeteora(dex, url, j, token);
    if (!v) err = `${venueLabel(dex)} API had no data for this pool`;
  } catch (e) { err = `${venueLabel(dex)} API: ${String((e as Error)?.message ?? e).slice(0, 120)}`; }
  venueCache.set(pool, { at: d.now(), v, err });
  return { v, err };
}

// ── prices ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PricePoint { t: number /* unix s, hour start */; p: number /* quote per token */; tokenUsd: number; quoteUsd: number }

const CANDLES_TIMEOUT_MS = 16_000;
/** Candle steps the LP code reads (Chord also serves 1m / 4h / 1d). The copy backtest replays minutes-apart LP moves on 5 / 15 min. */
export const CANDLE_TF: Record<number, string> = { 3600: "1h", 900: "15m", 300: "5m" };
async function closes(d: LpDeps, mint: string, hours: number, pool: string | null, stepS = 3600): Promise<Map<number, number>> {
  const n = Math.round((hours * 3600) / stepS);
  const q = `tf=${CANDLE_TF[stepS] ?? "1h"}&limit=${Math.max(2, Math.min(1000, n))}${pool ? `&pool=${encodeURIComponent(pool)}` : ""}`;
  // Chord builds an uncached hourly series of a heavily traded token in 10-15 s (its own limit is 15 s): wait for it rather than
  // flag the pool "short history" at 8 s; the answer is then cached on both sides.
  const j = await d.chord<any>(`/v1/chains/solana/token/${encodeURIComponent(mint)}/candles?${q}`, 5 * 60_000, CANDLES_TIMEOUT_MS);
  const out = new Map<number, number>();
  for (const c of Array.isArray(j?.candles) ? j.candles : []) {
    const t = num(c?.t), v = num(c?.c);
    if (t != null && v != null && v > 0) out.set(t, v);
  }
  return out;
}

/** Hourly closes of the pool's price (quote per token) over the last `hours`: the token's USD closes in THIS pool divided by
 *  the quote's USD closes (its main pool; USDC / USDT = 1). Hours without a trade carry the last close forward. `stepS` 900 / 300
 *  reads 15 / 5 minute candles instead (same rules, `t` = the candle's start). */
export async function pricePath(d: LpDeps, info: PoolInfo, hours: number, stepS = 3600): Promise<{ points: PricePoint[]; notes: string[] }> {
  const notes: string[] = [];
  const stable = STABLE_USD.has(info.quote);
  const [tok, quo] = await Promise.all([closes(d, info.token, hours, info.pool, stepS), stable ? Promise.resolve(null) : closes(d, info.quote, hours, null, stepS)]);
  if (!tok.size) return { points: [], notes: [`Chord's tape has no ${stepS === 3600 ? "hourly" : `${CANDLE_TF[stepS]}`} candles for ${info.tokenSymbol ?? short(info.token)} in this pool yet.`] };
  if (quo && !quo.size) notes.push(`No candles for ${info.quoteSymbol ?? short(info.quote)}: its USD price is held at the token's own pool price, so the path is in USD terms.`);
  const ts = [...tok.keys()].sort((a, b) => a - b);
  const qts = quo ? [...quo.keys()].sort((a, b) => a - b) : [];
  let tUsd = tok.get(ts[0])!, qUsd = stable ? 1 : qts.length ? quo!.get(qts[0])! : 1;
  const points: PricePoint[] = [];
  for (let t = ts[0]; t <= ts[ts.length - 1]; t += stepS) {
    tUsd = tok.get(t) ?? tUsd;
    if (quo) qUsd = quo.get(t) ?? qUsd;
    points.push({ t, p: tUsd / qUsd, tokenUsd: tUsd, quoteUsd: qUsd });
  }
  return { points, notes };
}

/** Live USD prices of the pool's two sides: Jupiter price v3 first; the token falls back to Chord's pool price, a USD
 *  stablecoin quote to 1. Null when either side has no price. */
export function livePair(px: Map<string, number>, info: { token: string; quote: string; priceUsd?: number | null }): { tokenUsd: number; quoteUsd: number; source: string } | null {
  const jt = px.get(info.token), jq = px.get(info.quote);
  const tokenUsd = jt ?? (info.priceUsd != null && info.priceUsd > 0 ? info.priceUsd : null);
  const quoteUsd = jq ?? (STABLE_USD.has(info.quote) ? 1 : null);
  if (tokenUsd == null || quoteUsd == null) return null;
  return { tokenUsd, quoteUsd, source: jt != null ? "Jupiter price v3" : "Chord's pool price (Jupiter has none)" };
}

export function _resetLpData(): void { venueCache.clear(); }
