// A liquidity position on a Monad pool, hour by hour, with Uniswap V3 math. Prices are the side token in units of the anchor
// token (WMON or a dollar stable); the position's value is turned into dollars with the anchor's dollar price of that hour.
//   amounts       x = L·(1/√P − 1/√pb), y = L·(√P − √pa) inside [pa, pb]; all side token below pa, all anchor above pb.
//                 A full-range (V2-style) position is the limit pa → 0, pb → ∞: value 2·L·√P.
//   fees          the hour's volume × the pool fee × the position's share, only while in range. The share is the position's
//                 dollar value over the pool's TVL, times how much more liquidity per dollar its range puts at the price than
//                 a ±15 % range (CE(range) / CE(±15 %), CE = 1 / (1 − (pa/pb)^¼)): the pool's own liquidity is assumed to
//                 sit about that concentrated. Capped at half the pool. Fees are kept aside, not reinvested.
//   rebalance     out of range for `rebalanceAfterH` hours in a row: close, pay the pool fee on half the value (the swap back
//                 to an even split), reopen centred on the price.
//   HODL          the tokens deposited at the start, held.
export type Preset = "tight" | "balanced" | "wide" | "full";
export const PRESETS: Record<Preset, { width: number | null; label: string }> = {
  tight: { width: 0.05, label: "Tight ±5%" }, balanced: { width: 0.15, label: "Balanced ±15%" }, wide: { width: 0.4, label: "Wide ±40%" }, full: { width: null, label: "Full range" },
};
export const REF_WIDTH = 0.15, MAX_SHARE = 0.5, REBALANCE_AFTER_H = 6;

export interface Hour { t: number; volUsd: number; sideUsd: number; anchorUsd: number }
export interface SimInput { hours: Hour[]; amountUsd: number; preset: Preset; feeBps: number; tvlUsd: number; concentrated: boolean; rebalance: boolean; rebalanceAfterH?: number }
export interface Range { pa: number | null; pb: number | null; L: number; p0: number }

/** Liquidity per unit of capital vs full range, for a range [P(1−w), P(1+w)]. */
export const ce = (w: number | null) => (w == null ? 1 : 1 / (1 - Math.pow((1 - w) / (1 + w), 0.25)));
export function amounts(r: Range, P: number): { x: number; y: number } {
  if (r.pa == null || r.pb == null) return { x: r.L / Math.sqrt(P), y: r.L * Math.sqrt(P) };
  const sp = Math.sqrt(Math.min(Math.max(P, r.pa), r.pb)), sa = Math.sqrt(r.pa), sb = Math.sqrt(r.pb);
  return { x: r.L * (1 / sp - 1 / sb), y: r.L * (sp - sa) };
}
/** Value in anchor units at price P. */
export const valueAt = (r: Range, P: number) => { const a = amounts(r, P); return a.x * P + a.y; };
export const inRange = (r: Range, P: number) => r.pa == null || r.pb == null || (P > r.pa && P < r.pb);
/** Open a range centred on P worth `valueAnchor` (anchor units). */
export function openRange(P: number, valueAnchor: number, width: number | null): Range {
  const unit: Range = width == null ? { pa: null, pb: null, L: 1, p0: P } : { pa: P * (1 - width), pb: P * (1 + width), L: 1, p0: P };
  const v1 = valueAt(unit, P);
  return { ...unit, L: valueAnchor / v1 };
}
/** The share of an hour's fees the position earns (in range only). */
export function feeShare(valueUsd: number, tvlUsd: number, width: number | null, concentrated: boolean): number {
  if (!(tvlUsd > 0) || !(valueUsd > 0)) return 0;
  const k = concentrated ? ce(width) / ce(REF_WIDTH) : 1;
  return Math.min(MAX_SHARE, (valueUsd / tvlUsd) * k);
}

export interface SimResult {
  hours: number; inRangePct: number; rebalances: number; feesUsd: number; lpValueUsd: number; hodlUsd: number; ilUsd: number; pnlUsd: number; returnPct: number; aprPct: number;
  range: { pa: number | null; pb: number | null; p0: number }; equity: { t: number; usd: number; hodl: number }[];
}
export function simulate(x: SimInput): SimResult {
  const hs = x.hours.filter((h) => h.sideUsd > 0 && h.anchorUsd > 0);
  if (hs.length < 2) throw new Error("not enough priced hours to replay");
  const width = x.concentrated ? PRESETS[x.preset].width : null;
  const fee = x.feeBps / 1e4, after = x.rebalanceAfterH ?? REBALANCE_AFTER_H;
  const P0 = hs[0].sideUsd / hs[0].anchorUsd;
  let r = openRange(P0, x.amountUsd / hs[0].anchorUsd, width);
  const start = amounts(r, P0);
  let fees = 0, inside = 0, out = 0, rebalances = 0, last = { lp: x.amountUsd, hodl: x.amountUsd };
  const equity: SimResult["equity"] = [];
  for (const h of hs) {
    const P = h.sideUsd / h.anchorUsd;
    let lpUsd = valueAt(r, P) * h.anchorUsd;
    const hodl = start.x * h.sideUsd + start.y * h.anchorUsd;
    if (inRange(r, P)) { inside++; out = 0; fees += h.volUsd * fee * feeShare(lpUsd, x.tvlUsd, width, x.concentrated); }
    else if (x.rebalance && width != null && ++out >= after) {
      const cost = (lpUsd / 2) * fee;
      lpUsd -= cost; rebalances++; out = 0;
      r = openRange(P, lpUsd / h.anchorUsd, width);
    }
    last = { lp: lpUsd, hodl };
    equity.push({ t: h.t, usd: Math.round((lpUsd + fees - x.amountUsd) * 100) / 100, hodl: Math.round((hodl - x.amountUsd) * 100) / 100 });
  }
  const pnl = last.lp + fees - x.amountUsd, span = Math.max(1, hs.length);
  return {
    hours: hs.length, inRangePct: Math.round((inside / hs.length) * 1000) / 10, rebalances, feesUsd: r2(fees), lpValueUsd: r2(last.lp), hodlUsd: r2(last.hodl),
    ilUsd: r2(last.lp - last.hodl), pnlUsd: r2(pnl), returnPct: r2((pnl / x.amountUsd) * 100), aprPct: r2((fees / x.amountUsd) * (8760 / span) * 100),
    range: { pa: r.pa, pb: r.pb, p0: r.p0 }, equity,
  };
}
const r2 = (v: number) => Math.round(v * 100) / 100;
