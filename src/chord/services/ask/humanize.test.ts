import { describe, expect, test } from "bun:test";
import { humanizeInternals } from "./humanize";

describe("humanizeInternals", () => {
  test("parentheses of tool names go; tool names in prose become source names", () => {
    expect(humanizeInternals("Hyperliquid perp price and swing clusters (market_levels) plus positioning (derivs_coin, hl_market).")).toBe("Hyperliquid perp price and swing clusters plus positioning.");
    expect(humanizeInternals("*Source: CoinGecko and news_latest, 07:10 UTC*")).toBe("*Source: CoinGecko and the news feed, 07:10 UTC*");
    expect(humanizeInternals("*Nguồn: CoinGecko và news_latest; lịch từ `macro_calendar`*", "vi")).toBe("*Nguồn: CoinGecko và nguồn tin tức; lịch từ lịch kinh tế*");
    expect(humanizeInternals("rh_token says NVDA is at $224")).toBe("Chord's Robinhood Chain index says NVDA is at $224");
  });
  test("field names become words", () => {
    expect(humanizeInternals("`navUsd` and `basisPct` come back null")).toBe("NAV (USD) and basis % come back null");
    expect(humanizeInternals("openInterestUsd rose")).toBe("open interest (USD) rose");
  });
  test("tool names that are English words stay", () => {
    expect(humanizeInternals("The backtest shows a 12% drawdown; remember to size down.")).toBe("The backtest shows a 12% drawdown; remember to size down.");
  });

  test("normal prose is untouched", () => {
    const t = "BTC holds $83,800; support 82,910 (swing low) and resistance 86,960. Market levels look firm — use arc and rh wisely.";
    expect(humanizeInternals(t)).toBe(t);
  });
});
