// LP data on Monad, from Chord's API (owner rule: Monad data comes from getchord): the pool board (GET /v1/lp/pools?chain=143:
// TVL, volume, fees, fee APR, flags), one pool with its hourly volume and price (GET /v1/lp/pools/:pool?chain=143; `price` is
// the dollar price of the pool's side token), and the anchor's dollar price per hour (WMON from Chord's 1h candles, else from
// the deepest WMON/USDC pool's hourly price; a dollar stable is $1). chordGet serves the last good answer for 6 h when Chord
// is slow, so a throttled index does not stop a running LP agent from marking.
import { chordGet } from "../chord/services/chordApi";
import type { Hour } from "./sim";

export const LP_CHAIN = 143;
export const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const STABLE = /^(USDC|AUSD|USDT0|USDT|MUSD|GHO|USDM)$/i;

export interface LpToken { address: string; symbol: string; decimals?: number; logo?: string | null }
export interface LpPool {
  pool: string; dex: string; kind: string; feeBps: number; token0: LpToken; token1: LpToken; tokenSide: 0 | 1; tvlUsd: number;
  vol: { h1?: number; h6?: number; h24?: number; d7?: number }; fees?: { h24?: number }; aprPct?: number | null; trades24h?: number; wallets24h?: number;
  priceUsd?: number; lpAccess?: string; suspect?: boolean; firstSeenTs?: number; providers24h?: number;
  hourly?: { hour: number; vol: number; trades?: number; price: number }[];
}
export class LpUnsupported extends Error {}

export const sideOf = (p: LpPool) => (p.tokenSide === 0 ? p.token0 : p.token1);
export const anchorOf = (p: LpPool) => (p.tokenSide === 0 ? p.token1 : p.token0);
export const pairOf = (p: LpPool) => `${sideOf(p).symbol}/${anchorOf(p).symbol}`;
export const isConcentrated = (p: LpPool) => p.kind === "clmm";
/** What this app can model: a side token against WMON or a dollar stable, open to anyone, not flagged. */
export function supportReason(p: LpPool): string | null {
  const a = anchorOf(p);
  if (p.suspect) return "Chord flags this pool as suspect";
  if (p.lpAccess && p.lpAccess !== "open") return "this pool is not open to new liquidity";
  if (a.address.toLowerCase() !== WMON && !STABLE.test(a.symbol)) return `pairs against ${a.symbol} are not modelled (WMON or a dollar stable only)`;
  return null;
}

export async function pools(): Promise<LpPool[]> {
  // the default order is fee / TVL; naming it (&sort=fee_tvl) misses Chord's warm answer and costs ~30 s of its Postgres
  const j = await chordGet<{ pools?: LpPool[] }>(`/v1/lp/pools?chain=${LP_CHAIN}&limit=40`, 300_000, 30_000);
  return Array.isArray(j?.pools) ? j.pools : [];
}
/** One pool with `hours` of its hourly series (Chord: 168 by default, up to 720). */
export async function pool(address: string, hours = 168): Promise<LpPool> {
  const h = Math.max(24, Math.min(720, Math.ceil(hours)));
  return chordGet<LpPool>(`/v1/lp/pools/${address.toLowerCase()}?chain=${LP_CHAIN}${h > 168 ? `&hours=${h}` : ""}`, 300_000, 30_000);
}

/** WMON's dollar price per hour (unix seconds → $), from Chord's 1h candles, else the deepest WMON/USDC pool. */
export async function wmonHourly(fromS: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const hours = Math.min(1000, Math.ceil((Date.now() / 1000 - fromS) / 3600) + 2);
    const j = await chordGet<{ candles?: { t: number; c: number }[] }>(`/v1/candles?chain=${LP_CHAIN}&token=${WMON}&tf=1h&limit=${hours}`, 300_000, 30_000);
    for (const c of j?.candles ?? []) if (Number(c.c) > 0) out.set(Math.floor(Number(c.t) / 3600) * 3600, Number(c.c));
  } catch { /* the pool fallback below */ }
  if (out.size) return out;
  const ref = (await pools()).filter((p) => { const s = sideOf(p), a = anchorOf(p); return s.address.toLowerCase() === WMON && STABLE.test(a.symbol); }).sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
  if (!ref) return out;
  for (const h of (await pool(ref.pool)).hourly ?? []) if (h.price > 0) out.set(Math.floor(h.hour / 3600) * 3600, h.price);
  return out;
}

/** A pool's hours since `fromS` as the simulator wants them: volume, side and anchor dollar prices (hours without an
 *  anchor price carry the last one seen; hours before the first are dropped). */
export async function poolHours(p: LpPool, fromS: number): Promise<Hour[]> {
  const why = supportReason(p);
  if (why) throw new LpUnsupported(why);
  const need = Math.ceil((Date.now() / 1000 - fromS) / 3600) + 2;
  const full = p.hourly && (need <= 168 || p.hourly.length >= need) ? p : await pool(p.pool, need);
  const rows = (full.hourly ?? []).filter((h) => h.hour >= fromS && h.price > 0).sort((a, b) => a.hour - b.hour);
  const stable = STABLE.test(anchorOf(p).symbol);
  const wm = stable ? null : await wmonHourly(fromS);
  if (wm && !wm.size) throw new LpUnsupported("WMON's dollar price is not readable right now");
  let last = 0;
  const out: Hour[] = [];
  for (const h of rows) {
    const k = Math.floor(h.hour / 3600) * 3600, a = stable ? 1 : wm!.get(k) ?? last;
    if (a > 0) last = a;
    if (!(a > 0)) continue;
    out.push({ t: h.hour * 1000, volUsd: Math.max(0, Number(h.vol) || 0), sideUsd: Number(h.price), anchorUsd: a });
  }
  return out;
}
