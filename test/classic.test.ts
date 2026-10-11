import { describe, expect, it } from "bun:test";
import { atr, bollinger, donchian, ema, macd, rsi, sma } from "../src/classic/indicators";
import { CLASSIC, ClassicInputError, paramsFor, strategyById } from "../src/classic/strategies";
import { fundingAnnualPerBar, normalizeInput, simulate } from "../src/classic/backtest";
import { walkBook } from "../src/perpl/client";
import type { Candle } from "../src/classic/data";

const H = 3_600_000;
const bar = (i: number, c: number, o = c): Candle => ({ t: i * H, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 1 });

describe("indicators", () => {
  it("SMA / EMA / RSI / Bollinger / MACD / ATR / Donchian match hand values and stay null until warm", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    const e = ema([1, 2, 3, 4, 5], 3); // seed SMA(1,2,3)=2, k=0.5: 3, 4
    expect(e).toEqual([null, null, 2, 3, 4]);
    const r = rsi([1, 2, 3, 4, 5, 6], 3);
    expect(r[2]).toBeNull();
    expect(r[3]).toBe(100); // only gains
    expect(rsi([3, 2, 1, 0, -1], 3)[3]).toBe(0);
    const bb = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2); // classic σ = 2 example
    expect(bb.mid[7]).toBe(5);
    expect(bb.upper[7]).toBe(9);
    expect(bb.lower[7]).toBe(1);
    const m = macd(Array.from({ length: 60 }, (_, i) => i), 12, 26, 9);
    expect(m.macd[24]).toBeNull();
    expect(m.signal[33]).not.toBeNull();
    expect(m.macd[59]!).toBeCloseTo(7, 0); // a straight line: EMA12 − EMA26 → (26 − 12) / 2 = 7
    const a = atr([2, 3, 4], [1, 1, 2], [1.5, 2, 3], 2); // TR: 1, 2, 2 → seed 1.5, then (1.5 + 2) / 2
    expect(a).toEqual([null, 1.5, 1.75]);
    const d = donchian([1, 5, 3, 9], [0, 2, 1, 4], 2);
    expect(d.upper).toEqual([null, null, 5, 5]); // bar i looks at the 2 bars before it
    expect(d.lower).toEqual([null, null, 0, 1]);
  });
});

describe("classic strategies", () => {
  it("params: defaults filled, out of range named, unknown keys refused, fast < slow", () => {
    const g = strategyById("golden-cross")!;
    expect(paramsFor(g, {})).toEqual({ fast: 50, slow: 200, shorts: 1 });
    expect(() => paramsFor(g, { fast: 500 })).toThrow("Fast SMA: must be a number from 5 to 100");
    expect(() => paramsFor(g, { nope: 1 })).toThrow('has no parameter "nope"');
    expect(() => paramsFor(g, { fast: 60, slow: 50 })).toThrow("shorter");
  });
  it("no strategy reads the future: appending bars never changes an earlier target", () => {
    const closes = Array.from({ length: 400 }, (_, i) => 100 + 10 * Math.sin(i / 9) + i * 0.05);
    const bars = closes.map((c, i) => bar(i, c, closes[i - 1] ?? c));
    const ctx = { fundingAnnualPct: bars.map((_, i) => 30 * Math.sin(i / 20)) };
    for (const s of CLASSIC) {
      const p = paramsFor(s, s.id === "golden-cross" ? { fast: 10, slow: 40 } : {});
      const full = s.signal(bars, p, ctx), cut = s.signal(bars.slice(0, 300), p, { fundingAnnualPct: ctx.fundingAnnualPct.slice(0, 300) });
      expect({ id: s.id, t: full.slice(0, 299) }).toEqual({ id: s.id, t: cut.slice(0, 299) });
      expect(full.every((t) => t == null || (t >= -1 && t <= 1))).toBe(true);
    }
  });
  it("Monad spot: long only, no leverage, majors only; funding carry needs perps", () => {
    expect(normalizeInput({ strategy: "ema-cross", symbol: "eth", source: "binance", venue: "monad_spot", leverage: 3 })).toMatchObject({ symbol: "ETH", leverage: 1, params: { shorts: 0 } });
    expect(() => normalizeInput({ strategy: "ema-cross", symbol: "SOL", source: "binance", venue: "monad_spot" })).toThrow(ClassicInputError);
    expect(() => normalizeInput({ strategy: "funding-carry", symbol: "BTC", source: "binance", venue: "monad_spot" })).toThrow("needs perps");
    expect(() => normalizeInput({ strategy: "nope", symbol: "BTC", source: "binance" })).toThrow('no classic strategy "nope"');
  });
});

describe("backtest ledger", () => {
  const bars = [bar(0, 100), bar(1, 100, 100), bar(2, 110, 110), bar(3, 120, 120), bar(4, 120, 120)];
  it("trades the previous bar's target at this bar's open, with fees and slippage", () => {
    // long decided at bar 0's close → bought at bar 1's open (100); flat decided at bar 2 → sold at bar 3's open (120)
    const r = simulate({ bars, targets: [1, 1, 0, 0, 0], start: 1, prints: [], tf: "1h", notional: 100, feeBps: 10, slipBps: 0, perps: true });
    expect(r.fills).toBe(2);
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0]).toMatchObject({ side: "long", entryPx: 100, exitPx: 120 });
    expect(r.fees).toBeCloseTo(0.1 + 0.12, 6); // 10 bps of $100, then of $120
    expect(r.trips[0].pnlUsd).toBeCloseTo(20 - 0.22, 2);
    expect(r.equity.at(-1)!.usd).toBeCloseTo(19.78, 2);
  });
  it("a flip is two fills; shorts gain when price falls", () => {
    const down = [bar(0, 100), bar(1, 100), bar(2, 90, 90), bar(3, 80, 80)];
    const r = simulate({ bars: down, targets: [1, -1, -1, -1], start: 1, prints: [], tf: "1h", notional: 100, feeBps: 0, slipBps: 0, perps: true });
    expect(r.fills).toBe(3); // buy at 100, then sell 2× at 90 (close long + open short)
    expect(r.trips[0]).toMatchObject({ side: "long", pnlUsd: -10 });
    expect(r.trips[1].side).toBe("short");
    expect(r.equity.at(-1)!.usd).toBeCloseTo(-10 + (100 / 90) * 10, 4);
  });
  it("funding: a long pays positive funding, a short receives it; spot pays none", () => {
    const flat = [bar(0, 100), bar(1, 100), bar(2, 100), bar(3, 100)];
    const prints = [{ t: 2 * H + 1000, rate: 0.001 }];
    const long = simulate({ bars: flat, targets: [1, 1, 1, 1], start: 1, prints, tf: "1h", notional: 100, feeBps: 0, slipBps: 0, perps: true });
    const shortR = simulate({ bars: flat, targets: [-1, -1, -1, -1], start: 1, prints, tf: "1h", notional: 100, feeBps: 0, slipBps: 0, perps: true });
    const spot = simulate({ bars: flat, targets: [1, 1, 1, 1], start: 1, prints, tf: "1h", notional: 100, feeBps: 0, slipBps: 0, perps: false });
    expect(long.fund).toBeCloseTo(-0.1, 6);
    expect(shortR.fund).toBeCloseTo(0.1, 6);
    expect(spot.fund).toBe(0);
  });
  it("funding per bar = 24 h average × prints per year", () => {
    const bs = [bar(0, 1), bar(24, 1), bar(48, 1)];
    const prints = [{ t: 0, rate: 0.0001 }, { t: 12 * H, rate: 0.0003 }, { t: 40 * H, rate: -0.0001 }];
    const f = fundingAnnualPerBar(bs, prints, "1h", 1000);
    expect(f[0]).toBeCloseTo(10, 6); // prints by 1 h: just the first
    expect(f[1]).toBeCloseTo(30, 6); // 24 h before 25 h: the 12 h print only
    expect(f[2]).toBeCloseTo(-10, 6); // 25 h–49 h: the 40 h print
  });
});

describe("grid", () => {
  it("centres on the anchor bar's close (the backtest: the last close before the window), nothing before it", () => {
    const g = strategyById("grid")!, p = paramsFor(g, {}); // ±10 %, 10 levels
    const bs = [bar(0, 120), bar(1, 100), bar(2, 100), bar(3, 95), bar(4, 111)];
    const t = g.signal(bs, p, { fundingAnnualPct: [], anchor: 1 }).map((x) => (x == null ? x : Math.round(x * 100) / 100));
    expect(t).toEqual([null, 0.5, 0.5, 0.7, 0]); // 95 = 2 levels under 100; 111 = above +10 %
    expect(g.signal(bs, p, { fundingAnnualPct: [] })[1]).toBeCloseTo(1, 9); // anchored on 120, 100 is under its −10 %
  });
  it("a grid trade is one sell: won when above the average cost after fees both ways", () => {
    // half the size bought at 100, a level more at 90 (average 98.18), a level sold at 99, another at 95
    const bs = [bar(0, 100), bar(1, 100, 100), bar(2, 90, 90), bar(3, 99, 99), bar(4, 95, 95), bar(5, 95, 95)];
    const r = simulate({ bars: bs, targets: [0.5, 0.6, 0.5, 0.4, 0.4, 0.4], start: 1, prints: [], tf: "1h", notional: 1000, feeBps: 10, slipBps: 0, perps: true });
    expect(r.fills).toBe(4); // buy $500 at 100, buy $100 at 90, sell $100 at 99, sell $100 at 95
    expect(r.exits).toBe(2);
    expect(r.exitWins).toBe(1); // average cost 98.2: 99 clears it and the fees, 95 does not
  });
});

describe("Perpl book walk", () => {
  it("VWAP across levels, impact against the mid, incomplete when the book is too thin", () => {
    const b = { bids: [{ price: 99, size: 1 }], asks: [{ price: 101, size: 1 }, { price: 102, size: 1 }], at: 0 };
    const w = walkBook(b, "buy", 203)!;
    expect(w.size).toBeCloseTo(2, 6);
    expect(w.vwap).toBeCloseTo(101.5, 6);
    expect(w.impactPct).toBeCloseTo(1.5, 2);
    expect(w.complete).toBe(true);
    expect(walkBook(b, "sell", 500)!.complete).toBe(false);
    expect(walkBook({ bids: [], asks: [], at: 0 }, "buy", 10)).toBeNull();
  });
});

describe("backtest board cells", () => {
  it("the median uses only sources that cover 90% of the window; a gain and a loss do not agree", async () => {
    const { cellOf } = await import("../src/classic/board");
    const r = (ret: number, cov: number) => ({ returnPct: ret, coveredDays: cov, maxDrawdownPct: 10, tradeCount: 5 }) as any;
    const c = cellOf({ binance: r(10, 180), okx: r(20, 180), hyperliquid: r(30, 170), perpl: r(-50, 60) }, 180);
    expect(c.median).toBe(20); // perpl covers 60 of 180 days: shown, not counted
    expect(c.bySource.perpl?.coveredDays).toBe(60);
    expect(c.agree).toBe(true);
    expect(cellOf({ binance: r(5, 30), okx: r(-3, 30) }, 30)).toMatchObject({ median: 1, agree: false });
    expect(cellOf({ perpl: r(5, 10) }, 30)).toMatchObject({ median: null, agree: null, trades: null });
  });
});
