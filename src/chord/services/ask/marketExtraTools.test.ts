import { describe, expect, it } from "bun:test";
import {
  MARKET_EXTRA_TOOL_META, MARKET_EXTRA_TOOL_NAMES, MARKET_EXTRA_TOOL_SCHEMAS, btcIssuedSats, btcNetworkResult, btcSubsidySats, halvingInfo,
  isMarketExtraTool, nasdaqAsOf, normalizeMoverTable, parseMoverList, parseNasdaqNumber, pickSession, rhIndex, stampSession, stockMoversResult,
  summarizeHashrate, toEhs, toTera, usSessionAt,
} from "./marketExtraTools";

// Trimmed from api.nasdaq.com/api/marketmovers?assetclass=stocks&exchangestatus=currentMarket&limit=100 (2026-10-03).
const SHARE_VOL = {
  headers: { symbol: "Symbol", name: "Name", lastSalePrice: "Last", lastSaleChange: "Change", change: "Share Volume" },
  rows: [
    { symbol: "NIVF", name: "NewGenIvf Group Limited", lastSalePrice: "$0.1261", lastSaleChange: "+0.0251", change: "294,778,806.701619", deltaIndicator: "up" },
    { symbol: "AMOD", name: "Alpha Modus Holdings, Inc. Class A Common Stock", lastSalePrice: "$3.48", lastSaleChange: "+2.31", change: "188,020,361.76926", deltaIndicator: "up" },
    { symbol: "NVDA", name: "NVIDIA Corporation", lastSalePrice: "$233.96", lastSaleChange: "+3.1", change: "116,970,309.573549", deltaIndicator: "up" },
  ],
};
const ADVANCED = {
  headers: { symbol: "Symbol", name: "Name", lastSalePrice: "Last", lastSaleChange: "Change", change: "% Change" },
  rows: [
    { symbol: "AMOD", name: "Alpha Modus Holdings, Inc. Class A Common Stock", lastSalePrice: "$3.48", lastSaleChange: "+2.31", change: "+197.4359%", deltaIndicator: "up" },
    { symbol: "CYCUW", name: "Cycurion, Inc. Warrant", lastSalePrice: "$0.0365", lastSaleChange: "+0.0201", change: "+122.561%", deltaIndicator: "up" },
  ],
};
const NDX = {
  headers: { symbol: "Symbol", name: "Name", lastSalePrice: "Last", lastSaleChange: "Change", change: "% Change" },
  rows: [
    { symbol: "ADBE", name: "Adobe Inc. Common Stock", lastSalePrice: "237.69", lastSaleChange: "-2.2500", change: "-0.94%", deltaIndicator: "down" },
    { symbol: "AMD", name: "Advanced Micro Devices, Inc. Common Stock", lastSalePrice: "633.91", lastSaleChange: "+22.1500", change: "+3.62%", deltaIndicator: "up" },
  ],
};
const RESP = { data: { STOCKS: {
  MostActiveByShareVolume: { dataAsOf: "Data as of Oct 2, 2026 3:59 PM ET", lastTradeTimestamp: "Oct 2, 2026 3:59 PM ET", table: SHARE_VOL },
  MostAdvanced: { dataAsOf: "Data as of Oct 2, 2026 3:59 PM ET", table: ADVANCED },
  Nasdaq100Movers: { dataAsOf: "Data as of Oct 2, 2026 4:00 PM ET", table: NDX },
} }, status: { rCode: 200 } };
const NVDA_TOKEN = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const RH = rhIndex([
  { symbol: "NVDA", address: NVDA_TOKEN, priceUsd: 234.3123060085438, change24hPct: 1.2145281241788597, volume24h: 30764222.6 },
  { symbol: "ceg", address: "0x0000000000000000000000000000000000000c39", priceUsd: 300, change24hPct: null, volume24h: 10 },
]);

describe("stock_movers: Nasdaq parsing", () => {
  it("reads Nasdaq cells", () => {
    expect(parseNasdaqNumber("$3.48")).toBe(3.48);
    expect(parseNasdaqNumber("+0.0251")).toBe(0.0251);
    expect(parseNasdaqNumber("-2.2500")).toBe(-2.25);
    expect(parseNasdaqNumber("294,778,806.70")).toBe(294778806.7);
    expect(parseNasdaqNumber("$1,074.82")).toBe(1074.82);
    expect(parseNasdaqNumber("+197.4359%")).toBe(197.4359);
    expect(parseNasdaqNumber("UNCH")).toBe(0);
    expect(parseNasdaqNumber("N/A")).toBeNull();
    expect(parseNasdaqNumber("")).toBeNull();
    expect(parseNasdaqNumber(null)).toBeNull();
  });
  it("takes the column meaning from the table header and derives the missing %", () => {
    const rows = normalizeMoverTable(SHARE_VOL);
    expect(rows[1]).toEqual({ symbol: "AMOD", name: "Alpha Modus Holdings, Inc.", lastPrice: 3.48, change: 2.31, changePct: 197.44, shareVolume: 188020362 });
    expect(rows[0].lastPrice).toBe(0.1261); // a penny stock keeps its digits
    expect(rows[2].changePct).toBe(1.34); // 3.1 / 230.86
    const adv = normalizeMoverTable(ADVANCED);
    expect(adv[0].changePct).toBe(197.44);
    expect(adv[0].shareVolume).toBeUndefined();
    expect(normalizeMoverTable(NDX)[0]).toEqual({ symbol: "ADBE", name: "Adobe Inc.", lastPrice: 237.69, change: -2.25, changePct: -0.94 });
    expect(normalizeMoverTable(null)).toEqual([]);
  });
  it("echoes Nasdaq's as-of stamp and reads its session", () => {
    expect(nasdaqAsOf("Data as of Oct 2, 2026 3:59 PM ET")).toBe("Oct 2, 2026 3:59 PM ET");
    expect(nasdaqAsOf("")).toBeNull();
    expect(stampSession("Oct 2, 2026 4:09 PM ET")).toBe("regular"); // closing cross settles a few minutes after 4 PM
    expect(stampSession("Oct 2, 2026 10:31 AM ET")).toBe("regular");
    expect(stampSession("Oct 2, 2026 12:05 PM ET")).toBe("regular");
    expect(stampSession("Oct 2, 2026 8:15 AM ET")).toBe("pre");
    expect(stampSession("Oct 2, 2026 6:40 PM ET")).toBe("after");
    expect(stampSession(null)).toBeNull();
  });
  it("reads the list argument", () => {
    expect(parseMoverList(undefined)).toBe("most_active");
    expect(parseMoverList("top gainers")).toBe("gainers");
    expect(parseMoverList("losers")).toBe("losers");
    expect(parseMoverList("dollar volume")).toBe("most_active_dollar");
    expect(parseMoverList("Nasdaq-100")).toBe("nasdaq100");
  });
});

describe("stock_movers: US session by New York time", () => {
  const at = (iso: string) => Date.parse(iso);
  it("splits a summer weekday (EDT, UTC-4)", () => {
    expect(usSessionAt(at("2026-10-02T07:59:00Z"))).toBe("closed");
    expect(usSessionAt(at("2026-10-02T08:00:00Z"))).toBe("pre");
    expect(usSessionAt(at("2026-10-02T13:29:00Z"))).toBe("pre");
    expect(usSessionAt(at("2026-10-02T13:30:00Z"))).toBe("regular");
    expect(usSessionAt(at("2026-10-02T19:59:00Z"))).toBe("regular");
    expect(usSessionAt(at("2026-10-02T20:00:00Z"))).toBe("after");
    expect(usSessionAt(at("2026-10-02T23:59:00Z"))).toBe("after");
    expect(usSessionAt(at("2026-10-03T00:00:00Z"))).toBe("closed"); // Friday 20:00 New York
  });
  it("follows the clock change (EST, UTC-5) and closes on weekends", () => {
    expect(usSessionAt(at("2026-12-01T14:29:00Z"))).toBe("pre");
    expect(usSessionAt(at("2026-12-01T14:30:00Z"))).toBe("regular");
    expect(usSessionAt(at("2026-10-03T15:00:00Z"))).toBe("closed"); // Saturday
    expect(usSessionAt(at("2026-10-04T15:00:00Z"))).toBe("closed"); // Sunday
  });
  it("defaults to the live session, regular when closed; an explicit one wins", () => {
    expect(pickSession(undefined, at("2026-10-03T15:00:00Z"))).toBe("regular");
    expect(pickSession(undefined, at("2026-10-02T10:00:00Z"))).toBe("pre");
    expect(pickSession(undefined, at("2026-10-02T21:00:00Z"))).toBe("after");
    expect(pickSession("pre-market", at("2026-10-02T15:00:00Z"))).toBe("pre");
    expect(pickSession("after hours", at("2026-10-02T15:00:00Z"))).toBe("after");
    expect(pickSession("regular", at("2026-10-02T10:00:00Z"))).toBe("regular");
  });
});

describe("stock_movers: result", () => {
  const base = { session: "regular" as const, liveNow: "closed" as const, limit: 10, rh: RH, ageS: 0 };
  it("drops sub-dollar rows, flags Robinhood Chain tokens with their own price and link", () => {
    const r = stockMoversResult(RESP, { ...base, list: "most_active", minPrice: 1 });
    const d = r.data as any;
    expect(d.asOf).toBe("Oct 2, 2026 3:59 PM ET");
    expect(d.dataSession).toBe("regular");
    expect(d.rows.map((x: any) => x.symbol)).toEqual(["AMOD", "NVDA"]);
    const nv = d.rows[1];
    expect(nv.onRobinhoodChain).toBe(true);
    expect(nv.rhToken).toEqual({ address: NVDA_TOKEN.toLowerCase(), priceUsd: 234.31, change24hPct: 1.21, volume24hUsd: 30764223, href: `/ask/trade/${NVDA_TOKEN.toLowerCase()}` });
    expect(d.rows[0].onRobinhoodChain).toBe(false);
    expect(r.addresses).toEqual([NVDA_TOKEN.toLowerCase()]);
    expect(r.chipCandidates?.[0]).toMatchObject({ symbol: "NVDA", chain: 4663, kind: "stock", price: 234.31 });
    expect(d.note).toContain("closed right now");
    expect(d.note).toContain("1 stock under $1 left out");
    expect(r.citations[0].href.startsWith("https://")).toBe(true);
    expect(r.viz?.[0]).toMatchObject({ kind: "table", columns: ["Symbol", "Company", "Last", "Change", "Volume", "On Robinhood Chain"] });
    expect(JSON.stringify(r.data)).not.toContain("—");
  });
  it("says when someone asked for extended hours but Nasdaq only has the regular session", () => {
    const asked = stockMoversResult(RESP, { ...base, session: "after", liveNow: "after", list: "most_active", minPrice: 1 }).data as any;
    expect(asked.sessionAsked).toBe("after");
    expect(asked.note).toContain("regular-session trading only, not after-hours");
    expect(asked.note).toContain("It is after-hours in New York right now.");
    const live = stockMoversResult({ data: { STOCKS: { MostAdvanced: { dataAsOf: "Data as of Oct 5, 2026 10:31 AM ET", table: ADVANCED } } } }, { ...base, liveNow: "regular", list: "gainers", minPrice: 1 }).data as any;
    expect(live.note).not.toContain("regular-session trading only");
    expect(live.note).not.toContain("closed");
  });
  it("min_price 0 keeps penny stocks; nasdaq100 ranks by the size of the move", () => {
    expect((stockMoversResult(RESP, { ...base, list: "gainers", minPrice: 0 }).data as any).rows).toHaveLength(2);
    const n = stockMoversResult(RESP, { ...base, list: "nasdaq100", minPrice: 1 }).data as any;
    expect(n.rows.map((x: any) => x.symbol)).toEqual(["AMD", "ADBE"]);
  });
  it("a missing Robinhood index is unknown, not false; a missing table is an error", () => {
    const d = stockMoversResult(RESP, { ...base, list: "most_active", minPrice: 1, rh: null }).data as any;
    expect(d.onRobinhoodChainCount).toBeNull();
    expect(d.note).toContain("unknown, not false");
    expect((stockMoversResult({ data: null }, { ...base, list: "losers", minPrice: 1 }).data as any).error).toBeDefined();
  });
  it("matches tickers case-insensitively and flags a thin on-chain market", () => {
    expect(RH.get("CEG")?.address).toBe("0x0000000000000000000000000000000000000c39");
    expect((stockMoversResult(RESP, { ...base, list: "most_active", minPrice: 1 }).data as any).note).not.toContain("thin on-chain market");
    const thin = rhIndex([{ symbol: "NVDA", address: NVDA_TOKEN, priceUsd: 234, change24hPct: 0, volume24h: 870 }]);
    expect((stockMoversResult(RESP, { ...base, list: "most_active", minPrice: 1, rh: thin }).data as any).note).toContain("thin on-chain market");
  });
});

describe("btc_network: issuance schedule", () => {
  it("block subsidy halves every 210,000 blocks", () => {
    expect(btcSubsidySats(0)).toBe(50e8);
    expect(btcSubsidySats(209_999)).toBe(50e8);
    expect(btcSubsidySats(210_000)).toBe(25e8);
    expect(btcSubsidySats(840_000)).toBe(3.125e8);
    expect(btcSubsidySats(969_627)).toBe(3.125e8);
    expect(btcSubsidySats(64 * 210_000)).toBe(0);
    expect(btcSubsidySats(33 * 210_000)).toBe(0); // 5e9 >> 33 rounds to zero sats
    expect(btcSubsidySats(32 * 210_000)).toBe(1);
  });
  it("issued supply at known heights (blocks 0..h inclusive)", () => {
    expect(btcIssuedSats(0)).toBe(50e8);
    expect(btcIssuedSats(209_999)).toBe(10_500_000e8);
    expect(btcIssuedSats(210_000)).toBe(10_500_025e8);
    expect(btcIssuedSats(840_000)).toBe(19_687_503.125e8);
    expect(btcIssuedSats(969_627)).toBe(20_092_587.5e8);
    // The schedule converges to 20,999,999.9769 BTC.
    expect(btcIssuedSats(64 * 210_000)).toBe(2_099_999_997_690_000);
  });
  it("halving distance from the tip", () => {
    expect(halvingInfo(0)).toMatchObject({ nextHalvingHeight: 210_000, blocksToHalving: 210_000, subsidyBtc: 50, subsidyAfterHalvingBtc: 25 });
    expect(halvingInfo(209_999)).toMatchObject({ nextHalvingHeight: 210_000, blocksToHalving: 1 });
    expect(halvingInfo(210_000)).toMatchObject({ nextHalvingHeight: 420_000, blocksToHalving: 210_000, subsidyBtc: 25, halvingsSoFar: 1 });
    expect(halvingInfo(840_000)).toMatchObject({ nextHalvingHeight: 1_050_000, blocksToHalving: 210_000, subsidyBtc: 3.125, subsidyAfterHalvingBtc: 1.5625 });
    expect(halvingInfo(969_627)).toMatchObject({ nextHalvingHeight: 1_050_000, blocksToHalving: 80_373, issuedBtc: 20_092_587.5, issuedPctOf21M: 95.68 });
  });
});

describe("btc_network: units and summaries", () => {
  it("converts hashrate and difficulty", () => {
    expect(toEhs(985963490569821600000)).toBe(985.96);
    expect(toEhs(1.051046422306202e21)).toBe(1051.05);
    expect(toEhs("x")).toBeNull();
    expect(toTera(132757073449487.5)).toBe(132.76);
  });
  // Trimmed from mempool.space /api/v1/mining/hashrate/1m (2026-10-03).
  const HR = {
    hashrates: [
      { timestamp: 1788393600, avgHashrate: 853783943739951300000 }, { timestamp: 1788480000, avgHashrate: 987315669358353200000 },
      { timestamp: 1788566400, avgHashrate: 950000000000000000000 }, { timestamp: 1790726400, avgHashrate: 1.051046422306202e21 },
      { timestamp: 1790812800, avgHashrate: 928550707847577200000 }, { timestamp: 1790899200, avgHashrate: 910866911867997000000 },
    ],
    difficulty: [], currentHashrate: 985963490569821600000, currentDifficulty: 132757073449487.5,
  };
  it("compares 3-day averages over the month", () => {
    const h = summarizeHashrate(HR);
    expect(h.nowEhs).toBe(985.96);
    expect(h.avg3dEhs).toBe(963.49);
    expect(h.monthAgoEhs).toBe(930.37);
    expect(h.monthAgoDate).toBe("2026-09-03");
    expect(h.change1mPct).toBe(3.56);
    expect(h.daily).toHaveLength(6);
  });
  it("builds the network answer and survives missing sections", () => {
    const parts = {
      blocks: [{ height: 969627, timestamp: 1790969853, tx_count: 3223, extras: { totalFees: 3155251, medianFee: 2.061041292639138, pool: { name: "F2Pool" } } }, { height: 969626, timestamp: 1790969253 }],
      difficulty: { progressPercent: 96.57738095238095, difficultyChange: -0.09060913271673465, estimatedRetargetDate: 1791013063788, remainingBlocks: 69, remainingTime: 41458788, previousRetarget: 4.163398081310405, nextRetargetHeight: 969696, timeAvg: 600852 },
      fees: { fastestFee: 7, halfHourFee: 6, hourFee: 5, economyFee: 2, minimumFee: 1 },
      mempool: { count: 86404, vsize: 46735148, total_fee: 22242344 },
      hashrate: HR, prices: { USD: 84369 },
    };
    const r = btcNetworkResult(parts, 1790971611, { chart: true, ageS: 0, unavailable: [] });
    const d = r.data as any;
    expect(d.tipHeight).toBe(969627);
    expect(d.lastBlock).toMatchObject({ height: 969627, minutesAgo: 29.3, pool: "F2Pool", feesBtc: 0.03155251 });
    expect(d.recentBlocks).toEqual({ count: 2, avgIntervalMinutes: 10 });
    expect(d.difficulty.currentT).toBe(132.76);
    expect(d.difficulty.nextAdjustment).toMatchObject({ estimatedChangePct: -0.09, blocksLeft: 69, nextRetargetHeight: 969696 });
    expect(d.fees).toMatchObject({ nextBlockSatVb: 7, economySatVb: 2, typicalTxUsd: { nextBlock: 0.83 } });
    expect(d.mempool).toEqual({ txCount: 86404, vMB: 46.74, pendingFeesBtc: 0.22242344 });
    expect(d.halving).toMatchObject({ nextHalvingHeight: 1_050_000, blocksLeft: 80_373 });
    expect(d.supply).toMatchObject({ issuedBtc: 20_092_587.5, pctOf21M: 95.68 });
    expect(r.viz?.[0]).toMatchObject({ kind: "line", unit: "n" });
    // The tip falls back to the retarget maths when the blocks call failed.
    const noBlocks = btcNetworkResult({ difficulty: parts.difficulty }, 1790971611, { chart: false, ageS: 0, unavailable: ["last block"] }).data as any;
    expect(noBlocks.tipHeight).toBe(969627);
    expect(noBlocks.note).toContain("Not available right now: last block");
    expect((btcNetworkResult({}, 1790971611, { chart: false, ageS: 0, unavailable: ["fees"] }).data as any).error).toBeDefined();
    expect(JSON.stringify(r.data)).not.toContain("—");
  });
});

describe("module contract", () => {
  it("every schema has a META row and the dispatcher knows it", () => {
    const names = MARKET_EXTRA_TOOL_SCHEMAS.map((s) => s.function.name);
    expect(names).toEqual([...MARKET_EXTRA_TOOL_NAMES]);
    for (const n of names) {
      expect(MARKET_EXTRA_TOOL_META[n]).toBeDefined();
      expect(isMarketExtraTool(n)).toBe(true);
    }
    expect(MARKET_EXTRA_TOOL_META.stock_movers).toMatchObject({ group: "stocks", market: true });
    expect(MARKET_EXTRA_TOOL_META.btc_network.group).toBe("btc");
    expect(isMarketExtraTool("rh_stocks")).toBe(false);
  });
});
