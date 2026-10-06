import { describe, expect, it } from "bun:test";
import { pickCoin, rangeStats } from "./coingecko";

describe("coingecko — coin choice and range facts", () => {
  const coins = [
    { id: "usdsui", symbol: "USDSUI", name: "USDSUI", rank: 354, thumb: null },
    { id: "sui-impostor", symbol: "SUI", name: "Sui Classic", rank: null, thumb: null },
    { id: "sui", symbol: "SUI", name: "Sui", rank: 29, thumb: null },
  ];
  it("exact ticker with the best rank wins over unranked copies and first hits", () => {
    expect(pickCoin("SUI", coins)?.id).toBe("sui");
    expect(pickCoin("$sui", coins)?.id).toBe("sui");
  });
  it("a CoinGecko id or an exact name also works; nothing = null", () => {
    expect(pickCoin("usdsui", coins)?.id).toBe("usdsui");
    expect(pickCoin("Sui Classic", coins)?.id).toBe("sui-impostor");
    expect(pickCoin("x", [])).toBeNull();
  });
  it("an unranked partial hit is not an answer; ranked first (\"fetch\" must not become Fetchr)", () => {
    const junk = [{ id: "fetchr-2", symbol: "FETCHR", name: "Fetchr", rank: null, thumb: null }, { id: "fetchr", symbol: "FETCHR", name: "Fetchr", rank: null, thumb: null }];
    expect(pickCoin("fetch", junk)).toBeNull();
    const fet = [{ id: "fetch-ai", symbol: "FET", name: "Artificial Superintelligence Alliance", rank: 107, thumb: null }, ...junk];
    expect(pickCoin("FET", fet)?.id).toBe("fetch-ai");
    expect(pickCoin("fetchr", junk)?.id).toBe("fetchr"); // an exact id / ticker still resolves, even unranked
  });
  it("range stats over a series", () => {
    const d = 86_400_000;
    const st = rangeStats([[0, 100], [d, 150], [2 * d, 75], [3 * d, 120]])!;
    expect(st.changePct).toBe(20);
    expect(st.high).toBe(150);
    expect(st.low).toBe(75);
    expect(st.fromHighPct).toBe(-20);
    expect(st.maxDrawdownPct).toBe(-50);
    expect(st.positionInRangePct).toBe(60);
    expect(rangeStats([[0, 1]])).toBeNull();
  });
});
