import { describe, expect, it } from "bun:test";
import { mockFetch } from "../testkit/helpers";
import { dxyOf, hlCandles, pickLevels, rsi14, sma, swingLevels, trendOf, type Candle } from "./marketData";
// ask2049: Chord's testkit jsonResponse, inline (ask2049's testkit/helpers has no jsonResponse).
const jsonResponse = (status: number, body: object = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const bar = (t: number, h: number, l: number, c = (h + l) / 2): Candle => ({ t: t * 86_400_000, o: c, h, l, c, v: 1 });

describe("marketData indicators", () => {
  it("sma needs n points", () => {
    expect(sma([1, 2, 3], 4)).toBeNull();
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
  });
  it("rsi14 is 100 on a straight rise and ~0 on a straight fall", () => {
    expect(rsi14(Array.from({ length: 30 }, (_, i) => i + 1))).toBe(100);
    expect(rsi14(Array.from({ length: 30 }, (_, i) => 30 - i))!).toBeLessThan(1);
  });
  it("dxyOf matches the ICE formula and refuses a missing leg", () => {
    // Reference point: the formula's constant is set so the basket at these rates reads ~100.
    const v = dxyOf({ EURUSD: 1.1375, USDJPY: 158.3, GBPUSD: 1.33, USDCAD: 1.39, USDSEK: 9.5, USDCHF: 0.8 })!;
    expect(v).toBeGreaterThan(95);
    expect(v).toBeLessThan(105);
    expect(dxyOf({ EURUSD: 1.1 })).toBeNull();
  });
  it("swing levels cluster repeated highs", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 40; i++) c.push(bar(i, i % 10 === 5 ? 110 : 100 + (i % 3), 95 - (i % 10 === 0 ? 5 : 0)));
    const lv = swingLevels(c, 3, 1);
    const top = lv.find((l) => l.price > 109)!;
    expect(top.touches).toBe(4);
    expect(top.kind).toBe("high");
  });
  it("pickLevels splits support below and resistance above the price", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 60; i++) c.push(bar(i, i % 10 === 5 ? 120 : 105, i % 10 === 0 ? 80 : 95));
    const { support, resistance } = pickLevels(100, c, c, 5);
    expect(support.every((s) => s.price < 100)).toBe(true);
    expect(resistance.every((s) => s.price > 100)).toBe(true);
    expect(resistance[0].price).toBeCloseTo(120, 0);
  });
  it("trend labels", () => {
    expect(trendOf(110, 100, 90, 5)).toMatch(/^uptrend/);
    expect(trendOf(80, 90, 100, -5)).toMatch(/^downtrend/);
    expect(trendOf(95, 100, 90, 0)).toMatch(/pullback/);
  });
});

// ask2049: Chord's `decodeEntities` describe (askAgent's news-headline helper) is left out — ask2049's askAgent.ts holds
// only the result types, and the news tools are not part of this module.

describe("hlCandles when Hyperliquid stumbles", () => {
  const k = [{ t: 1, o: "1", h: "2", l: "1", c: "1.5", v: "3" }];
  it("retries one 502 and returns the second answer", async () => {
    let n = 0;
    const m = mockFetch({ "api.hyperliquid.xyz": () => (++n === 1 ? jsonResponse(502) : k) });
    try { expect((await hlCandles("TESTRETRY", "1h", 5))[0].c).toBe(1.5); expect(m.calls.length).toBe(2); } finally { m.restore(); }
  });
  it("gives up after the retry with a message that carries no status code", async () => {
    const m = mockFetch({ "api.hyperliquid.xyz": () => jsonResponse(502) });
    try { await expect(hlCandles("TESTDOWN", "1h", 5)).rejects.toThrow(/^(?!.*\d{3}).*not answering/); } finally { m.restore(); }
  });
});
