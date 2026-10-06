import { describe, expect, test } from "bun:test";
import { checkNumbers, needsRepair, numbersIn } from "./verify";

const tool = { priceUsd: 83768.4, change24hPct: 0.2237, volume24h: 3_540_000_000, levels: [{ price: 82_910 }, { price: 80_180 }], funding: 0.0000125, board: "$20,262,656 mcap", buyShare: 0.58 };

describe("number check", () => {
  test("rounded prices, k/M/B, percent of a fraction, signs — all traced", () => {
    const a = "BTC sits at **$83,800** (+0.22% 24h) on $3.54B of volume. Support $82.9k then 80,180; buyers are 58% of flow; mcap $20.3M.";
    const r = checkNumbers(a, [tool], []);
    expect(r.unverified).toEqual([]);
    expect(r.total).toBeGreaterThanOrEqual(6);
  });

  test("an invented level is flagged; the person's own numbers are not", () => {
    const a = "Stop at $532 as you asked, size 9.4 shares, target $61,250.";
    const r = checkNumbers(a, [tool, { shares: 9.4 }], ["Plan $NET with a $5k wallet, stop $532"]);
    expect(r.unverified).toEqual(["$61,250"]);
  });

  test("dates, times, windows, tickers, addresses and list numbers are not claims", () => {
    const a = "1. On 2026-09-25 at 14:00 the 4h and 24h trend on XYZ100 turned; wallet 0xabc123def4567890 bought 3 times.\n2. Next.";
    expect(checkNumbers(a, [], []).total).toBe(0);
  });

  test("windows and counts are not claims", () => {
    expect(checkNumbers("Price sits under its 20-day and 50-day averages, over the last 90 days; RSI 14 at 52; top 10 holders own 41%; 3 tranches over 24 hours.", [{ rsi: 52.2, top10Pct: 41 }], []).unverified).toEqual([]);
  });

  test("years are dates; numbers written in words count on both sides", () => {
    expect(checkNumbers("Since 2025 and into 2026 the options expiry is ~$18B, ETF inflows $350 million.", [{ headline: "BTC, ETH options worth $18 billion expire" }, { flows: 350_000_000 }], []).unverified).toEqual([]);
  });

  test("numbers inside tool strings count", () => {
    expect(numbersIn({ note: "market cap $1.2M, 45% owned" })).toEqual([1_200_000, 45]);
  });

  test("repair only when several numbers and a real share are untraceable", () => {
    expect(needsRepair({ total: 20, unverified: ["1", "2"] })).toBe(false);
    expect(needsRepair({ total: 20, unverified: ["1", "2", "3", "4"] })).toBe(false);
    expect(needsRepair({ total: 8, unverified: ["1", "2", "3"] })).toBe(true);
  });
});
