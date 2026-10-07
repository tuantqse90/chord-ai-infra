import { describe, expect, it } from "bun:test";
import {
  amountsAt, binsFor, clmmRange, dlmmRange, FULL_RANGE, ilVsHold, invertRange, liquidityFor, liquidityForAny, presetLogWidth, rangeFromLogWidth, rangeFromPct, sigma, ticksFor,
  timeInRangeHistory, tokenShare, valueAt,
} from "./lpMath";

// Range [0.81, 1.21] (√ = 0.9 and 1.1) opened with 100 quote at p = 1:
//   per-L value = 2·1 − 0.9 − 1/1.1 = 0.190909…  → L = 523.8095
//   token = L(1 − 1/1.1) = 47.6190, quote = L(1 − 0.9) = 52.3810  (47.619 × 1 + 52.381 = 100)
const R = { lower: 0.81, upper: 1.21 };
const L = 100 / (2 - 0.9 - 1 / 1.1);

describe("concentrated-liquidity math (checked by hand)", () => {
  it("liquidity and amounts at the open", () => {
    expect(liquidityFor(100, 1, R)).toBeCloseTo(523.8095, 3);
    const a = amountsAt(L, 1, R);
    expect(a.token).toBeCloseTo(47.6190, 3);
    expect(a.quote).toBeCloseTo(52.3810, 3);
    expect(valueAt(L, 1, R)).toBeCloseTo(100, 9);
  });
  it("at the upper edge: all quote, value 104.762 vs hold 110 → IL −5.238 (−4.76 %)", () => {
    expect(amountsAt(L, 1.21, R)).toEqual({ token: 0, quote: expect.closeTo(104.7619, 3) });
    const x = ilVsHold(L, 1, 1.21, R);
    expect(x.lp).toBeCloseTo(104.7619, 3);
    expect(x.hold).toBeCloseTo(110, 3);
    expect(x.il).toBeCloseTo(-5.2381, 3);
    expect(x.ilPct).toBeCloseTo(-4.7619, 3);
  });
  it("at the lower edge: all token (105.820), value 85.714 vs hold 90.952 → IL −5.238", () => {
    const a = amountsAt(L, 0.81, R);
    expect(a.token).toBeCloseTo(105.8201, 3);
    expect(a.quote).toBe(0);
    const x = ilVsHold(L, 1, 0.81, R);
    expect(x.lp).toBeCloseTo(85.7143, 3);
    expect(x.hold).toBeCloseTo(90.9524, 3);
    expect(x.il).toBeCloseTo(-5.2381, 3);
  });
  it("outside the range the position stops changing, holding keeps moving", () => {
    const up = ilVsHold(L, 1, 1.44, R);
    expect(up.lp).toBeCloseTo(104.7619, 3);       // same as at 1.21
    expect(up.hold).toBeCloseTo(120.9524, 3);     // 47.619 × 1.44 + 52.381
    expect(up.il).toBeCloseTo(-16.1905, 3);
    const down = ilVsHold(L, 1, 0.64, R);
    expect(down.lp).toBeCloseTo(67.7249, 3);      // 105.820 × 0.64
    expect(down.hold).toBeCloseTo(82.8571, 3);    // 47.619 × 0.64 + 52.381
    expect(down.il).toBeCloseTo(-15.1323, 3);
  });
  it("full range is x·y = k: price × 4 → IL −20 % (2√r/(1+r) − 1)", () => {
    const Lf = liquidityFor(100, 1, FULL_RANGE);
    expect(Lf).toBeCloseTo(50, 9);
    const x = ilVsHold(Lf, 1, 4, FULL_RANGE);
    expect(x.lp).toBeCloseTo(200, 9);
    expect(x.hold).toBeCloseTo(250, 9);
    expect(x.ilPct).toBeCloseTo(-20, 9);
  });
  it("token share: 47.6 % at the center, 1 below, 0 above; opening outside the range throws", () => {
    expect(tokenShare(L, 1, R)).toBeCloseTo(0.47619, 4);
    expect(tokenShare(L, 0.7, R)).toBe(1);
    expect(tokenShare(L, 1.3, R)).toBe(0);
    expect(() => liquidityFor(100, 1.3, R)).toThrow(/inside the range/);
  });
});

describe("ranges and volatility", () => {
  it("σ of hourly log returns (sample stdev): ±1 % alternating over 4 returns = 1.1547 %", () => {
    const p = [1, Math.exp(0.01), 1, Math.exp(0.01), 1];
    expect(sigma(p)!).toBeCloseTo(0.011547, 5);
    expect(sigma([1, 2])).toBeNull();
  });
  it("preset width = k σ √h, clamped; bounds in log space", () => {
    expect(presetLogWidth(0.01, 24, 2)).toBeCloseTo(0.0979796, 6);
    expect(presetLogWidth(0.0001, 1, 1)).toBe(0.005);
    expect(presetLogWidth(1, 24, 3)).toBe(3);
    const r = rangeFromLogWidth(2, 0.0979796);
    expect(r.lower).toBeCloseTo(2 * 0.906667, 4);
    expect(r.upper).toBeCloseTo(2 * 1.102940, 4);
    expect(rangeFromPct(2, 10)).toEqual({ lower: 1.8, upper: expect.closeTo(2.2, 9) });
  });
  it("time in range from history: 3 of 5 one-hour windows stay inside ±10 %", () => {
    expect(timeInRangeHistory([1, 1.05, 1.2, 1.0, 1.0, 1.0], 0.9, 1.1, 1)).toBeCloseTo(60, 9);
    expect(timeInRangeHistory([1, 1, 1], 0.9, 1.1, 1)).toBeNull();
  });
  it("single-sided liquidity: below the range all token, above it all quote; bins / ticks as prices", () => {
    // [0.81, 1.21] at p = 0.64 (below): 100 quote of token = L (1/0.9 − 1/1.1) × 0.64 → L = 771.6; at p = 1.44 (above): L (1.1 − 0.9) = 100 → L = 500
    const below = liquidityForAny(100, 0.64, R);
    expect(below).toBeCloseTo(100 / (0.64 * (1 / 0.9 - 1 / 1.1)), 6);
    expect(amountsAt(below, 0.64, R).quote).toBe(0);
    expect(valueAt(below, 0.64, R)).toBeCloseTo(100, 9);
    expect(liquidityForAny(100, 1.44, R)).toBeCloseTo(500, 9);
    expect(valueAt(500, 1.44, R)).toBeCloseTo(100, 9);
    expect(liquidityForAny(100, 1, R)).toBeCloseTo(liquidityFor(100, 1, R), 9);
    expect(dlmmRange(0, 0, 100, 6, 6)).toEqual({ lower: 1, upper: expect.closeTo(1.01, 12) });
    expect(dlmmRange(-10, 9, 25, 9, 6).lower).toBeCloseTo(1.0025 ** -10 * 1000, 9);
    expect(clmmRange(-60, 60, 6, 6)).toEqual({ lower: expect.closeTo(1.0001 ** -60, 12), upper: expect.closeTo(1.0001 ** 60, 12) });
    expect(invertRange({ lower: 2, upper: 4 })).toEqual({ lower: 0.25, upper: 0.5 });
    expect(invertRange(FULL_RANGE)).toEqual(FULL_RANGE);
  });
  it("DLMM bins and CLMM ticks a range spans", () => {
    expect(binsFor(R, 100)).toBe(41);            // ln(1.21/0.81) / ln(1.01) = 40.33
    expect(ticksFor(R, 60)).toBe(4020);          // 4013.6 ticks → 67 × 60
    expect(ticksFor(R, null)).toBe(4014);
    expect(binsFor(FULL_RANGE, 100)).toBeNull();
  });
});

describe("LP exodus is relative to the pool", () => {
  it("normal flows on a big pool are not an exodus; the same flows on a small pool are", async () => {
    const { isExodus } = await import("./lpData");
    expect(isExodus(11_834, 134_620, 7_300_000)).toBe(false); // SOL-USDC, 1.7 % of the pool (measured 07/10)
    expect(isExodus(0.56, 1_101, 2_000_000)).toBe(false);     // PUMP-SOL
    expect(isExodus(7_445, 25_337, 105_000)).toBe(true);      // PLAGUE-SOL, 17 % of the pool
    expect(isExodus(100, 900, 2_000)).toBe(false);            // under the $1,000 floor
    expect(isExodus(3_000, 5_000, null)).toBe(false);         // not 2× deposits
    expect(isExodus(1_000, 25_000, null)).toBe(true);         // TVL unknown: ratio + floor only
  });
});
