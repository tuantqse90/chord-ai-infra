import { beforeEach, describe, expect, it } from "bun:test";
import { addr } from "./_testkit";
import { hourly, lpWorld, meteoraPool, safeInfo, type FakePool } from "./_lpkit";
import { BotInputError } from "./errors";
import { lpBacktest, lpRange, lpScan } from "./lp";
import { _resetLpData } from "./lpData";
import { sigma } from "./lpMath";
import { SOL_MINT, USDC_MINT } from "./market";

const NOW = 1_800_000_000_000, NOW_S = NOW / 1000; // an hour boundary
const P1 = addr(301), P2 = addr(302), P3 = addr(303), P4 = addr(304), P5 = addr(305);
const T1 = addr(311), T2 = addr(312), T3 = addr(313), T4 = addr(314), T5 = addr(315);
const DLMM = (p: string) => `https://dlmm.datapi.meteora.ag/pools/${p}`;
const wave = (n: number, base: number) => Array.from({ length: n }, (_, i) => base * Math.exp(i % 2 ? 0.01 : 0));
const from168 = NOW_S - 167 * 3600;

let w: ReturnType<typeof lpWorld>;
beforeEach(() => {
  _resetLpData();
  const pools: FakePool[] = [
    { pool: P1, dex: "meteora_dlmm", mintA: T1, mintB: USDC_MINT, symbolA: "GOOD", symbolB: "USDC", token: T1, priceUsd: 2, lastHour: { depositsUsd: 5000, withdrawalsUsd: 1000 },
      list: { lps: 120, depositsUsd: 50_000, withdrawalsUsd: 20_000, netFlowUsd: 30_000, feesClaimedUsd: 4000, openPositions: 80 } },
    { pool: P2, dex: "meteora_dlmm", mintA: T2, mintB: SOL_MINT, symbolA: "RUG", symbolB: "SOL", token: T2, priceUsd: 0.001, lastHour: { depositsUsd: 100, withdrawalsUsd: 5000 }, list: { lps: 300 } },
    { pool: P3, dex: "pumpswap", mintA: T3, mintB: SOL_MINT, symbolA: "PUMPY", symbolB: "SOL", token: T3, priceUsd: 0.01, tvlUsd: 80_000, list: { lps: 3 } },
    { pool: P4, dex: "raydium_clmm", mintA: USDC_MINT, mintB: T4, symbolA: "USDC", symbolB: "RAYT", token: T4, priceUsd: 5, list: { lps: 10 } },
    { pool: P5, dex: "meteora_dlmm", mintA: T5, mintB: USDC_MINT, symbolA: "BT", symbolB: "USDC", token: T5, priceUsd: 1.2 },
  ];
  w = lpWorld({
    nowMs: NOW, pools,
    candles: {
      [`${T1}@${P1}`]: hourly(from168, wave(168, 2)),
      [`${T2}@${P2}`]: hourly(from168, wave(168, 0.001)),
      [`${T3}@${P3}`]: hourly(NOW_S - 4 * 3600, [0.01, 0.011, 0.012, 0.011, 0.01]),
      [`${T4}@${P4}`]: hourly(from168, wave(168, 5)),
      [SOL_MINT]: hourly(from168, Array(168).fill(150)),
      // backtest pool: 1.0 for 6 hours, then 1.2 (out of a ±10 % range above) for the rest of the day
      [`${T5}@${P5}`]: hourly(NOW_S - 24 * 3600, Array.from({ length: 25 }, (_, i) => (i <= 5 ? 1 : 1.2))),
    },
    venue: {
      [DLMM(P1)]: meteoraPool({ tvl: 500_000, fees24h: 5500, protocol24h: 500, volume24h: 1_800_000, createdAtMs: NOW - 30 * 86_400_000, tokenX: T1 }),
      [DLMM(P2)]: meteoraPool({ tvl: 6000, fees24h: 900, protocol24h: 90, volume24h: 30_000, createdAtMs: NOW - 2 * 3_600_000, tokenX: T2 }),
      [`https://api-v3.raydium.io/pools/info/ids?ids=${P4}`]: new Error("api-v3.raydium.io answered 500"),
      [DLMM(P5)]: meteoraPool({ tvl: 100_000, fees24h: 1100, protocol24h: 100, volume24h: 1100 / 0.003, createdAtMs: NOW - 30 * 86_400_000, tokenX: T5 }),
    },
    prices: { [T1]: 2, [USDC_MINT]: 1, [SOL_MINT]: 150, [T5]: 1.2 },
    info: { [T2]: safeInfo(T2, { mintAuthorityDisabled: false }), [T3]: null },
  });
});

describe("lpScan", () => {
  it("ranks pools with every flag shown; best = the top pool with none", async () => {
    const s = await lpScan({ limit: 4 }, w.deps);
    const by = Object.fromEntries(s.rows.map((r) => [r.pool, r]));
    expect(s.rows.length).toBe(4);
    expect(s.best).toBe(P1);
    expect(s.rows[0].pool).toBe(P1);
    expect(by[P1].flags).toEqual([]);
    expect(by[P1]).toMatchObject({ pair: "GOOD-USDC", tvlUsd: 500_000, feeAprPct: 365, volumeTvl: 3.6, fees24hUsd: 5500, lps24h: 120, netFlow24hUsd: 30_000, openPositions: 80, binStep: 100,
      lastHour: { depositsUsd: 5000, withdrawalsUsd: 1000 }, safety: { mintAuthority: "renounced", freezeAuthority: "renounced", liquidityUsd: 1e6 } });
    expect(by[P1].tvlSource).toMatch(/Meteora DLMM API \(dlmm\.datapi\.meteora\.ag\)/);
    expect(by[P1].feeAprSource).toMatch(/24 h fees minus the protocol share/);
    expect(by[P1].feeRatePct).toBeCloseTo(0.305556, 5);
    expect(by[P1].ageHours).toBe(720);
    expect(by[P1].volatility!.hourlyPct).toBeCloseTo(1, 1); // ±1 % zig-zag

    expect(by[P2].flags.map((f) => f.code)).toEqual(["thin_tvl", "new_pool", "lp_exodus", "mint_authority"]);
    expect(by[P2].flags.find((f) => f.code === "lp_exodus")!.msg).toMatch(/\$5,000 withdrawn vs \$100 deposited in the last hour/);
    expect(by[P2].flags.find((f) => f.code === "new_pool")!.msg).toMatch(/2 h old/);
    expect(by[P3].flags.map((f) => f.code)).toEqual(["no_fee_apr", "safety_unknown", "short_history"]);
    expect(by[P3]).toMatchObject({ tvlUsd: 80_000, tvlSource: "Chord (pool reserves)", feeAprPct: null });
    expect(by[P4].flags.map((f) => f.code)).toEqual(["no_tvl", "no_fee_apr"]);
    expect(by[P4].flags[0].msg).toMatch(/Raydium CLMM API: api-v3\.raydium\.io answered 500/);
    expect(by[P4]).toMatchObject({ token: T4, quote: USDC_MINT, pair: "RAYT-USDC" });
    for (const r of s.rows) expect(r.score).toBeLessThanOrEqual(s.rows[0].score);
    expect(s.notes.join(" ")).toMatch(/PumpSwap has none/);
  });
  it("says when the price history or the last hour's LP flows could not be read (never a silent empty)", async () => {
    const chord = w.deps.chord;
    const deps = { ...w.deps, chord: async <T>(path: string, ttl: number): Promise<T> => {
      if (path.includes(`/token/${T1}/candles`) || path === `/v1/chains/solana/lp/pool/${P1}?hours=1`) throw new Error("Chord API /v1/chains/solana/… answered 429");
      return chord<T>(path, ttl);
    } };
    const s = await lpScan({ limit: 4 }, deps);
    const r = s.rows.find((x) => x.pool === P1)!;
    expect(r.flags.map((f) => f.code)).toEqual(["short_history"]);
    expect(r.flags[0].msg).toMatch(/could not be read on Chord \(Chord API .* answered 429\)/);
    expect(r.lastHour).toBeNull();
    expect(s.notes.join(" ")).toMatch(/GOOD-USDC: the last hour's LP flows could not be read on Chord .*so its LP exodus was not checked/);
  });
  it("filters by dex and refuses bad options", async () => {
    const s = await lpScan({ dex: "pumpswap" }, w.deps);
    expect(s.rows.map((r) => r.pool)).toEqual([P3]);
    expect(s.best).toBeNull();
    expect(s.notes.join(" ")).toMatch(/Every pool in this scan carries at least one flag/);
    await expect(lpScan({ sort: "apr" as any }, w.deps)).rejects.toThrow(/sort must be one of/);
    await expect(lpScan({ dex: "orca" }, w.deps)).rejects.toThrow(BotInputError);
  });
});

describe("lpRange", () => {
  it("tight / balanced / wide from σ of hourly returns × √24, with bins and the history's time in range", async () => {
    const r = await lpRange(P1, 24, w.deps);
    expect(r).toMatchObject({ pool: P1, pair: "GOOD-USDC", price: 2, priceUsd: 2, quoteUsd: 1, priceSource: "Jupiter price v3", fullRange: false, horizonHours: 24 });
    expect(r.volatility!.hourlyPct).toBeCloseTo(1, 1);
    const s = sigma(wave(168, 2))!; // the exact σ (the answer rounds it to 0.01 %)
    expect(r.presets.map((p) => p.preset)).toEqual(["tight", "balanced", "wide"]);
    const bal = r.presets[1];
    const wd = 2 * s * Math.sqrt(24);
    expect(bal.lower).toBeCloseTo(2 * Math.exp(-wd), 4);
    expect(bal.upper).toBeCloseTo(2 * Math.exp(wd), 4);
    expect(bal.upPct).toBeCloseTo((Math.exp(wd) - 1) * 100, 1);
    expect(bal.bins).toBe(Math.ceil((2 * wd) / Math.log(1.01)));
    expect(bal.expectedTimeInRangePct).toBe(100); // a ±1 % zig-zag never leaves a ±10 % range
    expect(r.presets[0].upPct).toBeLessThan(bal.upPct);
    expect(r.presets[2].upPct).toBeGreaterThan(bal.upPct);
    expect(r.venueShape).toMatch(/Spot/);
  });
  it("full-range venues get no presets; a pool Chord does not know is a BotInputError", async () => {
    const r = await lpRange(P3, 24, w.deps);
    expect(r.fullRange).toBe(true);
    expect(r.presets).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/full range/);
    await expect(lpRange(addr(399), 24, w.deps)).rejects.toThrow(/not on Chord's Solana LP tape/);
    await expect(lpRange(P1, 500, w.deps)).rejects.toThrow(/horizonHours/);
  });
});

describe("lpBacktest (canned day: 1.0 for 6 h, then 1.2, ±10 % range, fee APR 365 %)", () => {
  // Hand numbers: L = 1000 / (2 − √0.9 − 1/√1.1) = 10,219.3; hold = 475.58 token + 524.42 USDC.
  // Hours 1–5 in range: 5 × 1000 × 3.65/8760 = $2.083. Hour 6 closes at 1.2 (above 1.1): value = L(√1.1 − √0.9) = $1,023.21,
  // half an hour of fees = $0.213, then the rebalance: recentered on [1.08, 1.32], 47.56 % of $1,025.51 swapped at 0.3 % fee +
  // 0.2 % impact = $2.439 → $1,023.07 back in (realized +$23.07). Hours 7–24 in range: 18 × 1023.07 × 3.65/8760 = $7.673.
  it("time in range, fees, one rebalance and its cost, LP vs HODL vs 100 % quote", async () => {
    const b = await lpBacktest({ pool: P5, amountUsd: 1000, rangePct: 10, days: 1 }, w.deps);
    expect(b).toMatchObject({ pool: P5, pair: "BT-USDC", days: 1, hours: 24, rebalances: 1, feeAprPct: 365, exited: null, fullRange: false, quoteOnlyUsd: 1000 });
    expect(b.range!.lower).toBeCloseTo(0.9, 9);
    expect(b.range!.upper).toBeCloseTo(1.1, 9);
    expect(b.timeInRangePct).toBeCloseTo(97.9, 1);
    expect(b.feesUsd).toBeCloseTo(2.083 + 0.213 + 7.673, 1);
    expect(b.rebalanceCostUsd).toBeCloseTo(2.44, 1);
    expect(b.fills.map((f) => f.kind)).toEqual(["open", "rebalance"]);
    expect(b.fills[1].pnlUsd!).toBeCloseTo(23.07, 1);
    expect(b.finalUsd).toBeCloseTo(1030.74, 1);
    expect(b.hodlUsd).toBeCloseTo(1095.12, 1);
    expect(b.lpVsHodlUsd).toBeCloseTo(1030.74 - 1095.12, 1);
    expect(b.pnlUsd).toBeCloseTo(30.74, 1);
    expect(b.equity.length).toBe(25);
    expect(b.equity[6]).toMatchObject({ lower: expect.closeTo(1.08, 6), upper: expect.closeTo(1.32, 6), inRange: true });
    expect(b.costSource).toMatch(/swap fee 0\.30% .*Meteora DLMM API.*price impact 0\.20% \(Jupiter quote now for \$500\)/);
    expect(b.notes.join(" ")).toMatch(/Fees are an ESTIMATE/);
    expect(w.world.calls).toContain(`quote ${USDC_MINT}>${T5} 500`);
  });
  it("replays an LP exodus exit from Chord's hourly flows; the equity freezes at the exit", async () => {
    w.world.pools.find((p) => p.pool === P5)!.hourly = [{ hour: NOW_S - 12 * 3600, depositsUsd: 100, withdrawalsUsd: 20_000 }];
    const b = await lpBacktest({ pool: P5, amountUsd: 1000, rangePct: 10, days: 1 }, w.deps);
    expect(b.fills.map((f) => f.kind)).toEqual(["open", "rebalance", "close"]);
    expect(b.exited!.reason).toMatch(/LP exodus: \$20,000 withdrawn vs \$100 deposited that hour/);
    expect(b.exited!.ts).toBe((NOW_S - 12 * 3600) * 1000);
    expect(b.equity[b.equity.length - 1].usd).toBe(b.equity[12].usd);
    expect(b.equity[b.equity.length - 1].inRange).toBe(false);
  });
  it("validates its input", async () => {
    await expect(lpBacktest({ pool: P5, amountUsd: 1000, rangePct: 10, preset: "wide", days: 1 }, w.deps)).rejects.toThrow(/preset or rangePct, not both/);
    await expect(lpBacktest({ pool: P5, amountUsd: 1000, days: 2 }, w.deps)).rejects.toThrow(/days must be 1, 3 or 7/);
    await expect(lpBacktest({ pool: P5, amountUsd: 5, days: 1 }, w.deps)).rejects.toThrow(/amountUsd must be between 10 and 10000/);
  });
});
