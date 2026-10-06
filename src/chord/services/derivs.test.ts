import { describe, expect, it } from "bun:test";
import { aggregate, changeSince, crowdFlags, foldSnaps, funding8hPct, normCoin, okxLongPct, parseSymbol, readFlow, sortBoard, type BoardRow, type VenueRow } from "./derivs";

const vr = (o: Partial<VenueRow> & Pick<VenueRow, "venue">): VenueRow => ({
  coin: "BTC", symbol: "BTCUSDT", mult: 1, price: null, change24hPct: null, volume24hUsd: null, oiUsd: null, fundingRate: null, fundingIntervalH: null, nextFundingTs: null, longPct: null, topLongPct: null, ...o,
});

describe("parseSymbol", () => {
  it("reads plain and bundled USDT perps", () => {
    expect(parseSymbol("binance", "BTCUSDT")).toEqual({ coin: "BTC", mult: 1 });
    expect(parseSymbol("binance", "1000PEPEUSDT")).toEqual({ coin: "PEPE", mult: 1000 });
    expect(parseSymbol("binance", "1MBABYDOGEUSDT")).toEqual({ coin: "BABYDOGE", mult: 1_000_000 });
    expect(parseSymbol("bybit", "10000SATSUSDT")).toEqual({ coin: "SATS", mult: 10_000 });
    expect(parseSymbol("bybit", "SHIB1000USDT")).toEqual({ coin: "SHIB", mult: 1000 });
    expect(parseSymbol("binance", "1INCHUSDT")).toEqual({ coin: "1INCH", mult: 1 });
  });
  it("skips dated futures and other margins", () => {
    expect(parseSymbol("binance", "BTCUSDT_261225")).toBeNull();
    expect(parseSymbol("binance", "BTCUSDC")).toBeNull();
    expect(parseSymbol("bybit", "BTC-26DEC25")).toBeNull();
    expect(parseSymbol("okx", "BTC-USD-SWAP")).toBeNull();
  });
  it("reads OKX swaps and Hyperliquid k-coins", () => {
    expect(parseSymbol("okx", "PEPE-USDT-SWAP")).toEqual({ coin: "PEPE", mult: 1 });
    expect(parseSymbol("hyperliquid", "kPEPE")).toEqual({ coin: "PEPE", mult: 1000 });
    expect(parseSymbol("hyperliquid", "HYPE")).toEqual({ coin: "HYPE", mult: 1 });
  });
});

describe("normCoin", () => {
  it("maps what people type to one key", () => {
    for (const q of ["pepe", "$PEPE", "1000PEPE", "PEPEUSDT", "kPEPE", "PEPE-USDT-SWAP"]) expect(normCoin(q)).toBe("PEPE");
    expect(normCoin("1INCH")).toBe("1INCH");
    expect(normCoin(" btc ")).toBe("BTC");
  });
});

describe("funding and ratios", () => {
  it("normalises funding to % per 8 h", () => {
    expect(funding8hPct(0.0001, 8)).toBeCloseTo(0.01, 10);
    expect(funding8hPct(0.0001, 4)).toBeCloseTo(0.02, 10);
    expect(funding8hPct(0.0000125, 1)).toBeCloseTo(0.01, 10); // Hyperliquid hourly
  });
  it("turns OKX's long/short ratio into a long share", () => {
    expect(okxLongPct(1)).toBeCloseTo(50, 10);
    expect(okxLongPct(3)).toBeCloseTo(75, 10);
  });
});

describe("aggregate", () => {
  it("sums OI, OI-weights funding, averages long share, prefers Binance for price", () => {
    const a = aggregate("BTC", [
      vr({ venue: "binance", price: 100, oiUsd: 300, fundingRate: 0.0001, fundingIntervalH: 8, longPct: 60, topLongPct: 40 }),
      vr({ venue: "bybit", price: 101, oiUsd: 100, fundingRate: 0.0003, fundingIntervalH: 8, longPct: 70 }),
      vr({ venue: "hyperliquid", symbol: "BTC", price: 99, oiUsd: null, fundingRate: 0.00005, fundingIntervalH: 1 }),
    ]);
    expect(a.price).toBe(100);
    expect(a.oiUsd).toBe(400);
    expect(a.funding8hPct!).toBeCloseTo((0.01 * 300 + 0.03 * 100) / 400, 10); // HL has no OI → no weight
    expect(a.longPct).toBe(65);
    expect(a.topLongPct).toBe(40);
    expect(a.hl).toBe("BTC");
  });
});

describe("history", () => {
  const now = 1_800_000_000_000;
  const snaps = foldSnaps([
    { ts: now - 24 * 3_600_000, coin: "ETH", venue: "binance", price: 2000, oi_usd: 1000, funding_8h_pct: 0.01, long_pct: 50 },
    { ts: now - 24 * 3_600_000, coin: "ETH", venue: "okx", price: 2001, oi_usd: 500, funding_8h_pct: 0.02, long_pct: 60 },
    { ts: now - 3_600_000, coin: "ETH", venue: "binance", price: 2100, oi_usd: 1100, funding_8h_pct: 0.01, long_pct: 50 },
  ]).get("ETH")!;
  it("folds venue rows into one snapshot per poll", () => {
    expect(snaps).toHaveLength(2);
    expect(snaps[0].oiUsd).toBe(1500);
    expect(snaps[0].price).toBe(2000);
    expect(snaps[0].funding8hPct!).toBeCloseTo((0.01 * 1000 + 0.02 * 500) / 1500, 10);
  });
  it("counts only venues present at both ends", () => {
    // OKX is live now but absent an hour ago → its OI must not read as growth
    const c = changeSince(snaps, { price: 2200, rows: [{ venue: "binance", oiUsd: 1210 }, { venue: "okx", oiUsd: 700 }] }, 1, now)!;
    expect(c.oiPct!).toBeCloseTo(10, 10);
    expect(c.pricePct!).toBeCloseTo((2200 / 2100 - 1) * 100, 10);
    const d = changeSince(snaps, { price: 2200, rows: [{ venue: "binance", oiUsd: 1210 }, { venue: "okx", oiUsd: 700 }] }, 24, now)!;
    expect(d.oiPct!).toBeCloseTo(((1210 + 700) / 1500 - 1) * 100, 10);
  });
  it("answers null when no snapshot sits near the window", () => {
    expect(changeSince(snaps, { price: 1, rows: [] }, 4, now)).toBeNull();
  });
});

describe("reads", () => {
  it("names the OI × price quadrant", () => {
    expect(readFlow(5, 2)).toStartWith("new longs");
    expect(readFlow(5, -2)).toStartWith("new shorts");
    expect(readFlow(-5, 2)).toStartWith("short covering");
    expect(readFlow(-5, -2)).toStartWith("long unwind");
    expect(readFlow(1, 0.5)).toBe("no clear positioning change");
    expect(readFlow(null, 2)).toBeNull();
  });
  it("flags crowding only past the thresholds", () => {
    expect(crowdFlags({ funding8hPct: 0.01, longPct: 55, topLongPct: 52 })).toEqual([]);
    const f = crowdFlags({ funding8hPct: 0.05, longPct: 75, topLongPct: 45 });
    expect(f).toHaveLength(3);
    expect(f[0]).toContain("crowded long");
    expect(crowdFlags({ funding8hPct: -0.02, longPct: 30, topLongPct: null })[0]).toContain("crowded short");
  });
  it("sorts the board and drops rows without the key", () => {
    const r = (coin: string, funding8hPct: number | null): BoardRow => ({ ...aggregate(coin, []), funding8hPct, oiChange1hPct: null, oiChange4hPct: null, oiChange24hPct: null, flow24h: null });
    const rows = [r("A", 0.01), r("B", -0.02), r("C", null), r("D", 0.05)];
    expect(sortBoard(rows, "funding").map((x) => x.coin)).toEqual(["D", "A", "B"]);
    expect(sortBoard(rows, "-funding").map((x) => x.coin)).toEqual(["B", "A", "D"]);
  });
});
