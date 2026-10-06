// Concentrated-liquidity math for the LP agent (Uniswap-v3 style, the same for Raydium CLMM ticks and Meteora DLMM bins
// with uniform "Spot" liquidity). Prices are QUOTE PER TOKEN; a range is [lower, upper] in those units, lower may be 0 and
// upper Infinity (a full-range, x·y = k position). Liquidity L is in "quote units per √price":
//   p ≤ lower:          token = L (1/√lower − 1/√upper), quote = 0
//   lower < p < upper:  token = L (1/√p − 1/√upper),     quote = L (√p − √lower)
//   p ≥ upper:          token = 0,                        quote = L (√upper − √lower)
// Value (in quote) = token · p + quote. Pure functions, no I/O.

export interface PriceRange { lower: number; upper: number }
export const FULL_RANGE: PriceRange = { lower: 0, upper: Infinity };

const sq = (x: number) => Math.sqrt(x);
const inv = (x: number) => (x === Infinity ? 0 : 1 / Math.sqrt(x));

export const isFull = (r: PriceRange) => r.lower <= 0 && r.upper === Infinity;
export const inRange = (p: number, r: PriceRange) => p >= r.lower && p <= r.upper;

/** Token and quote amounts held by liquidity L at price p. */
export function amountsAt(L: number, p: number, r: PriceRange): { token: number; quote: number } {
  if (p <= r.lower) return { token: L * (inv(r.lower) - inv(r.upper)), quote: 0 };
  if (p >= r.upper) return { token: 0, quote: L * (sq(r.upper) - sq(r.lower)) };
  return { token: L * (1 / sq(p) - inv(r.upper)), quote: L * (sq(p) - sq(r.lower)) };
}

/** Position value in QUOTE units at price p. */
export function valueAt(L: number, p: number, r: PriceRange): number {
  const a = amountsAt(L, p, r);
  return a.token * p + a.quote;
}

/** The liquidity a deposit worth `valueQuote` (in quote units) buys at price p (p must be inside the range). */
export function liquidityFor(valueQuote: number, p: number, r: PriceRange): number {
  if (!(p > 0) || !inRange(p, r)) throw new Error("the price must be inside the range to open a position");
  const perL = 2 * sq(p) - sq(r.lower) - p * inv(r.upper);
  if (!(perL > 0)) throw new Error("the range is too narrow at this price");
  return valueQuote / perL;
}

/** Like liquidityFor, for a price anywhere: below the range the deposit is all token, above it all quote (the single-sided
 *  "bid" / "ask" ranges DLMM LPs place away from the price). */
export function liquidityForAny(valueQuote: number, p: number, r: PriceRange): number {
  if (!(p > 0)) throw new Error("the price must be above 0");
  if (inRange(p, r)) return liquidityFor(valueQuote, p, r);
  const perL = p < r.lower ? p * (inv(r.lower) - inv(r.upper)) : sq(r.upper) - sq(r.lower);
  if (!(perL > 0)) throw new Error("the range is empty");
  return valueQuote / perL;
}

/** A Meteora DLMM position's bins as a price range, in the pool's own units (side B per side A, whole tokens): bin i starts at
 *  (1 + binStep / 10,000)^i × 10^(decimalsA − decimalsB); the upper bin is included, so the range ends where the next bin starts. */
export const dlmmRange = (lowerBin: number, upperBin: number, binStepBps: number, decA: number, decB: number): PriceRange => {
  const k = 10 ** (decA - decB), b = 1 + binStepBps / 10_000;
  return { lower: b ** lowerBin * k, upper: b ** (upperBin + 1) * k };
};
/** A Raydium CLMM position's ticks as a price range (side B per side A, whole tokens): 1.0001^tick × 10^(decimalsA − decimalsB). */
export const clmmRange = (lowerTick: number, upperTick: number, decA: number, decB: number): PriceRange => {
  const k = 10 ** (decA - decB);
  return { lower: 1.0001 ** lowerTick * k, upper: 1.0001 ** upperTick * k };
};
/** A range in B-per-A units seen from the other side (A per B): bounds invert and swap. */
export const invertRange = (r: PriceRange): PriceRange => ({ lower: r.upper === Infinity ? 0 : 1 / r.upper, upper: r.lower > 0 ? 1 / r.lower : Infinity });

/** Share of the value held in the token at price p: 1 at or below the range, 0 at or above it. */
export function tokenShare(L: number, p: number, r: PriceRange): number {
  const a = amountsAt(L, p, r);
  const v = a.token * p + a.quote;
  return v > 0 ? (a.token * p) / v : 0;
}

/** Impermanent loss of the position against holding what it was opened with (all in quote units): lp − hold. */
export function ilVsHold(L: number, p0: number, p: number, r: PriceRange): { lp: number; hold: number; il: number; ilPct: number } {
  const a0 = amountsAt(L, p0, r);
  const lp = valueAt(L, p, r);
  const hold = a0.token * p + a0.quote;
  return { lp, hold, il: lp - hold, ilPct: hold > 0 ? ((lp - hold) / hold) * 100 : 0 };
}

/** A symmetric range in log space: [p·e^−w, p·e^+w]. */
export const rangeFromLogWidth = (p: number, w: number): PriceRange => ({ lower: p * Math.exp(-w), upper: p * Math.exp(w) });
/** A ±pct range: [p·(1 − pct/100), p·(1 + pct/100)]. */
export const rangeFromPct = (p: number, pct: number): PriceRange => ({ lower: p * (1 - pct / 100), upper: p * (1 + pct / 100) });
/** How far the bounds sit from p, in % (down is positive). */
export const boundsPct = (p: number, r: PriceRange) => ({ downPct: r.lower > 0 ? (1 - r.lower / p) * 100 : 100, upPct: r.upper === Infinity ? Infinity : (r.upper / p - 1) * 100 });

/** σ of the hourly log returns (sample stdev), null below 3 returns. */
export function sigma(prices: number[]): number | null {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) if (prices[i] > 0 && prices[i - 1] > 0) r.push(Math.log(prices[i] / prices[i - 1]));
  if (r.length < 3) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}

export const PRESET_SIGMAS = { tight: 1, balanced: 2, wide: 3 } as const;
export const MIN_LOG_WIDTH = 0.005;   // ±0.5 %
export const MAX_LOG_WIDTH = 3;       // lower bound at 5 % of the price
/** Log half-width of a preset: k σ √horizon, clamped to [0.5 %, ln 20]. */
export function presetLogWidth(sigmaHourly: number, horizonHours: number, k: number): number {
  return Math.min(MAX_LOG_WIDTH, Math.max(MIN_LOG_WIDTH, k * sigmaHourly * Math.sqrt(horizonHours)));
}

/** Empirical share of time a range set around each hour's price would have kept the price inside over the next `h` hours
 *  (bounds as ratios of the start price). Null below 6 prices. Windows near the end are shorter (the caller notes it). */
export function timeInRangeHistory(prices: number[], loRatio: number, hiRatio: number, h: number): number | null {
  if (prices.length < 6) return null;
  let sum = 0, windows = 0;
  for (let i = 0; i < prices.length - 1; i++) {
    const end = Math.min(prices.length - 1, i + Math.max(1, Math.round(h)));
    let inside = 0;
    for (let j = i + 1; j <= end; j++) if (prices[j] >= prices[i] * loRatio && prices[j] <= prices[i] * hiRatio) inside++;
    sum += inside / (end - i);
    windows++;
  }
  return windows ? (sum / windows) * 100 : null;
}

/** Meteora DLMM bins a range spans (bin step in basis points). */
export const binsFor = (r: PriceRange, binStepBps: number) => (isFull(r) || !(binStepBps > 0) ? null : Math.max(1, Math.ceil(Math.log(r.upper / r.lower) / Math.log(1 + binStepBps / 10_000))));
/** Raydium CLMM ticks a range spans (1 tick = ×1.0001), rounded up to the pool's tick spacing. */
export function ticksFor(r: PriceRange, tickSpacing: number | null): number | null {
  if (isFull(r)) return null;
  const t = Math.log(r.upper / r.lower) / Math.log(1.0001);
  return tickSpacing && tickSpacing > 0 ? Math.ceil(t / tickSpacing) * tickSpacing : Math.ceil(t);
}
