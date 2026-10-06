import { describe, expect, it } from "bun:test";
import {
  jupHosts, PREDICT_TOOL_META, PREDICT_TOOL_NAMES, PREDICT_TOOL_SCHEMAS, alignHistory, eventLinks, eventRow, eventStatus, historyStats, isPredictTool,
  nextCloseMs, normCategory, normEvent, oddsOf, parseEventRef, pickBest, rankedOutcomes, rulesSummary,
} from "./predictTools";

// Trimmed from live Jupiter Prediction answers, 2026-10-03.
const FED = {
  eventId: "POLY-606422", isActive: true, isLive: false, category: "economics",
  metadata: { slug: "fed-decision-in-october-20260617190323537", title: "Fed Decision in October?", series: "polymarket", eventId: "POLY-606422", subtitle: "", closeTime: "2026-10-28T23:59:00Z" },
  volumeUsd: "23639729000000", volume24hr: "3264340000000", beginAt: null, closeCondition: "This market will close and expire after a winner is declared.",
  markets: [
    { provider: "polymarket", marketId: "POLY-2589813", status: "open", result: null, title: "25 bps increase", openTime: 1781740971, closeTime: 1793246340, resolveAt: null,
      pricing: { buyYesPriceUsd: 180000, sellYesPriceUsd: 170000, sellNoPriceUsd: 820000, buyNoPriceUsd: 830000, volume: 6007695 }, outcomes: ["Yes", "No"], clobTokenIds: ["2222222222222222222222", "3333333333333333333"],
      rulesPrimary: "The FED interest rates are defined in this market by the upper bound of the target federal funds range. The decisions on the target federal funds range are made by the Federal Open Market Committee (FOMC) meetings.\n\nThis market will resolve to the amount of basis points the upper bound of the target federal funds rate is changed by versus the level it was prior to the Federal Reserve's October 2026 meeting." },
    { provider: "polymarket", marketId: "POLY-2589812", status: "open", result: null, title: "No change", openTime: 1781740971, closeTime: 1793246340, resolveAt: null,
      pricing: { buyYesPriceUsd: 820000, sellYesPriceUsd: 810000, sellNoPriceUsd: 180000, buyNoPriceUsd: 190000, volume: 6792588 }, outcomes: ["Yes", "No"], clobTokenIds: ["111061902544814266207267295505639408607400625795891618462682726460921782993748", "4"] },
    { provider: "polymarket", marketId: "POLY-2589814", status: "open", result: null, title: "50+ bps decrease", openTime: 1781740971, closeTime: 1793246340, resolveAt: null,
      pricing: { buyYesPriceUsd: 3000, sellYesPriceUsd: 2000, sellNoPriceUsd: 997000, buyNoPriceUsd: 998000, volume: 3647835 }, outcomes: ["Yes", "No"], clobTokenIds: null },
  ],
};
const KALSHI = {
  eventId: "KXBTCMAXY-26DEC31", isActive: true, isLive: true, category: "crypto",
  metadata: { title: "How high will Bitcoin get in 2026?", series: "KXBTCMAXY", eventId: "KXBTCMAXY-26DEC31", subtitle: "Before Dec 31, 2026 at 11:59 PM ET", closeTime: "2027-01-01T04:59:00Z" },
  volumeUsd: "4948880000000", volume24hr: "0", beginAt: null,
  markets: [
    { provider: "kalshi", marketId: "KXBTCMAXY-26DEC31-99999.99", status: "open", result: null, title: "Above $99,999.99", openTime: 1767394800, closeTime: 1798779540,
      pricing: { buyYesPriceUsd: 400000, sellYesPriceUsd: 390000, sellNoPriceUsd: 600000, buyNoPriceUsd: 610000, volume: 1535358 }, outcomes: null, clobTokenIds: null },
  ],
};
// A "by date" ladder: two markets resolved NO, one still open with a broken book.
const LADDER = {
  eventId: "POLY-36173", isActive: true, isLive: false, category: "crypto",
  metadata: { slug: "when-will-bitcoin-hit-150k", title: "When will Bitcoin hit $150k?", series: "polymarket", eventId: "POLY-36173", subtitle: "", closeTime: "" },
  volumeUsd: "27289293000000", volume24hr: "3024000000",
  markets: [
    { provider: "polymarket", marketId: "POLY-573655", status: "closed", result: "no", title: "by June 30, 2026", closeTime: 1782878400, resolveAt: "2026-07-01T06:42:33.411Z", pricing: { buyYesPriceUsd: 0, sellYesPriceUsd: 0, sellNoPriceUsd: 0, buyNoPriceUsd: 0, volume: 22066952 } },
    { provider: "polymarket", marketId: "POLY-573656", status: "open", result: null, title: "by December 31, 2026", closeTime: 1798779600, pricing: { buyYesPriceUsd: 24000, sellYesPriceUsd: 22000, sellNoPriceUsd: 976000, buyNoPriceUsd: 978000, volume: 2860656 } },
    { provider: "polymarket", marketId: "POLY-1068707", status: "open", result: null, title: "December 31, 2026 (thin)", closeTime: 1798779600, pricing: { buyYesPriceUsd: 997000, sellYesPriceUsd: 10000, sellNoPriceUsd: 3000, buyNoPriceUsd: 990000, volume: 588 } },
  ],
};
const UPDOWN = {
  eventId: "POLY-5191832", isLive: true, category: "crypto",
  metadata: { slug: "btc-updown-15m-1790970300", title: "Bitcoin Up or Down - October 2, 3:45PM-4:00PM ET", closeTime: "2026-10-02T20:00:00Z" },
  volumeUsd: "109000000", volume24hr: "109000000",
  markets: [{ provider: "polymarket", marketId: "POLY-5191832-0", status: "open", title: "Up", closeTime: 1790971200, pricing: { buyYesPriceUsd: 560000, sellYesPriceUsd: 540000, volume: 8986 }, outcomes: ["Up", "Down"], clobTokenIds: ["64568329271237507766681150847931562793921014802731738260431247208949434836568", "1"] }],
};
const NOW = Date.parse("2026-10-03T00:00:00Z");

describe("predict_* odds and units", () => {
  it("reads micro-USD YES prices as a mid, a spread and NO = 100 − YES", () => {
    expect(oddsOf({ buyYesPriceUsd: 820000, sellYesPriceUsd: 810000 })).toEqual({ bidPct: 81, askPct: 82, yesPct: 81.5, noPct: 18.5, spreadPts: 1, wide: false });
    expect(oddsOf({ buyYesPriceUsd: 5000, sellYesPriceUsd: 4000 }).yesPct).toBe(0.45);
  });
  it("refuses a probability when the book is too wide to read one", () => {
    const o = oddsOf({ buyYesPriceUsd: 997000, sellYesPriceUsd: 10000 });
    expect(o.wide).toBe(true);
    expect(o.yesPct).toBeNull();
    expect(o.spreadPts).toBe(98.7);
    expect(oddsOf({ buyYesPriceUsd: 0, sellYesPriceUsd: 0 }).yesPct).toBeNull();
    expect(oddsOf({ buyYesPriceUsd: 1000000, sellYesPriceUsd: 0 })).toMatchObject({ yesPct: null, askPct: 100, wide: true }); // one-sided
  });
  it("normalises an event: micro-USD volumes to dollars, Kalshi has no 24h volume", () => {
    const fed = normEvent(FED)!;
    expect(fed.volumeUsd).toBe(23_639_729);
    expect(fed.volume24hUsd).toBe(3_264_340);
    expect(fed.providers).toEqual(["polymarket"]);
    expect(fed.markets[1].volumeUsd).toBe(6_792_588);
    expect(fed.markets[1].yesToken).toBe("111061902544814266207267295505639408607400625795891618462682726460921782993748");
    const k = normEvent(KALSHI)!;
    expect(k.volume24hUsd).toBeNull();
    expect(k.providers).toEqual(["kalshi"]);
    expect(normEvent({})).toBeNull();
  });
  it("keeps a sports event's moneyline and drops the prop markets search brings along", () => {
    const ev = normEvent({ eventId: "POLY-1047243", category: "sports", metadata: { title: "France vs. Italy", slug: "unl-fra-ita-2026-10-02" }, markets: [
      { provider: "polymarket", marketId: "POLY-4720683", status: "open", title: "France", sportsMarketType: "moneyline", pricing: { buyYesPriceUsd: 840000, sellYesPriceUsd: 830000, volume: 740133 } },
      { provider: "polymarket", marketId: "POLY-4720685", status: "open", title: "Italy", sportsMarketType: "moneyline", pricing: { buyYesPriceUsd: 21000, sellYesPriceUsd: 20000, volume: 234910 } },
      { provider: "polymarket", marketId: "POLY-9", status: "open", title: "Over", sportsMarketType: "totals", pricing: { buyYesPriceUsd: 1000000, volume: 1895 } },
    ] })!;
    expect(ev.markets.map((m) => m.label)).toEqual(["France", "Italy"]);
  });
  it("names a one-market event's outcome by its YES side (Up / Yes)", () => {
    const ev = normEvent(UPDOWN)!;
    expect(ev.markets[0].label).toBe("Up");
    expect(ev.markets[0].odds.yesPct).toBe(55);
  });
  it("ranks open outcomes by odds and summarises a row", () => {
    const fed = normEvent(FED)!;
    expect(rankedOutcomes(fed).map((m) => m.label)).toEqual(["No change", "25 bps increase", "50+ bps decrease"]);
    const row = eventRow(fed, NOW);
    expect(row.top[0]).toEqual({ outcome: "No change", yesPct: 81.5 });
    expect(row.status).toBe("open");
    expect(row.closesAt).toBe("2026-10-29T03:59Z"); // the market close (11:59 PM ET), not the event header
  });
  it("status + next close of a by-date ladder; resolved markets have no odds", () => {
    const ev = normEvent(LADDER)!;
    expect(eventStatus(ev, NOW)).toBe("open");
    expect(nextCloseMs(ev, NOW)).toBe(1798779600 * 1000);
    expect(ev.markets[0].odds.yesPct).toBeNull();
    expect(ev.markets[0].result).toBe("no");
    expect(rankedOutcomes(ev)[0].label).toBe("by December 31, 2026"); // the broken book ranks last
    const closed = normEvent({ ...LADDER, markets: [LADDER.markets[0]] })!;
    expect(eventStatus(closed, NOW)).toBe("resolved");
  });
  it("links Jupiter always, the venue page when it can", () => {
    expect(eventLinks(normEvent(FED)!).map((c) => c.href)).toEqual(["https://jup.ag/prediction/POLY-606422", "https://polymarket.com/event/fed-decision-in-october-20260617190323537"]);
    expect(eventLinks(normEvent(KALSHI)!)[1].href).toBe("https://kalshi.com/markets/kxbtcmaxy");
  });
  it("cuts rules at a sentence and keeps them short", () => {
    const r = rulesSummary(FED.markets[0].rulesPrimary, 300)!;
    expect(r.length).toBeLessThanOrEqual(300);
    expect(r.endsWith(".")).toBe(true);
    expect(rulesSummary("")).toBeNull();
  });
});

describe("predict_market input", () => {
  it("reads ids, links, slugs and words", () => {
    expect(parseEventRef("POLY-606422")).toEqual({ kind: "id", id: "POLY-606422" });
    expect(parseEventRef("606422")).toEqual({ kind: "id", id: "POLY-606422" });
    expect(parseEventRef("kxbtcmaxy-26dec31")).toEqual({ kind: "id", id: "KXBTCMAXY-26DEC31" });
    expect(parseEventRef("SENATETX-26")).toEqual({ kind: "id", id: "SENATETX-26" });
    expect(parseEventRef("https://polymarket.com/event/fed-decision-in-october-20260617190323537/no-change")).toEqual({ kind: "slug", slug: "fed-decision-in-october-20260617190323537" });
    expect(parseEventRef("https://jup.ag/prediction/POLY-606422")).toEqual({ kind: "id", id: "POLY-606422" });
    expect(parseEventRef("kalshi.com/markets/kxbtcmaxy/how-high-will-bitcoin-get-this-year/kxbtcmaxy-26dec31")).toEqual({ kind: "id", id: "KXBTCMAXY-26DEC31" });
    expect(parseEventRef("when-will-bitcoin-hit-150k")).toEqual({ kind: "slug", slug: "when-will-bitcoin-hit-150k" });
    expect(parseEventRef("fed decision october")).toEqual({ kind: "query", q: "fed decision october" });
    expect(parseEventRef("  ")).toBeNull();
  });
  it("maps friendly categories and rejects unknown ones", () => {
    expect(normCategory("Crypto")).toBe("crypto");
    expect(normCategory("macro")).toBe("economics");
    expect(normCategory("AI")).toBe("tech");
    expect(normCategory("all")).toBeNull();
    expect(normCategory("bitcoin")).toBeNull();
  });
  it("picks the event whose title matches, open before closed", () => {
    const evs = [normEvent(LADDER)!, normEvent(FED)!, normEvent(KALSHI)!];
    expect(pickBest("fed october", evs, NOW).best?.id).toBe("POLY-606422");
    expect(pickBest("how high bitcoin 2026", evs, NOW).best?.id).toBe("KXBTCMAXY-26DEC31");
  });
});

describe("odds history", () => {
  it("aligns several outcomes on one axis, carrying values forward, in percent", () => {
    const a = { name: "No change", pts: [{ t: 100, p: 0.365 }, { t: 200, p: 0.5 }, { t: 300, p: 0.815 }] };
    const b = { name: "25 bps increase", pts: [{ t: 150, p: 0.6 }, { t: 290, p: 0.17 }] };
    const { ts, values } = alignHistory([a, b], 60);
    expect(ts).toEqual([100, 200, 300]);
    expect(values[0]).toEqual([36.5, 50, 81.5]);
    expect(values[1]).toEqual([null, 60, 17]);
    expect(historyStats(a.pts)).toEqual({ firstPct: 36.5, lastPct: 81.5, changePts: 45, highPct: 81.5, lowPct: 36.5 });
  });
  it("thins long histories and keeps the last point", () => {
    const pts = Array.from({ length: 169 }, (_, i) => ({ t: i, p: i / 200 }));
    const { ts } = alignHistory([{ name: "x", pts }], 60);
    expect(ts.length).toBeLessThanOrEqual(61);
    expect(ts[ts.length - 1]).toBe(168);
  });
});

describe("Jupiter host order", () => {
  it("Kalshi and searches go lite first; one Polymarket event api first; Polymarket lists never touch lite (prop-market bloat)", () => {
    expect(jupHosts("list", "kalshi")[0]).toBe("https://lite-api.jup.ag");
    expect(jupHosts("search", "polymarket")[0]).toBe("https://lite-api.jup.ag");
    expect(jupHosts("event", "polymarket")).toEqual(["https://api.jup.ag", "https://lite-api.jup.ag"]);
    expect(jupHosts("list", "polymarket")).toEqual(["https://api.jup.ag"]);
  });
});

describe("predict_* registry surface", () => {
  it("every schema has a META row in group predict, and the dispatcher knows it", () => {
    for (const s of PREDICT_TOOL_SCHEMAS) {
      expect(PREDICT_TOOL_META[s.function.name]?.group).toBe("predict");
      expect(PREDICT_TOOL_META[s.function.name]?.untrusted).toBe(true);
      expect(isPredictTool(s.function.name)).toBe(true);
    }
    expect(PREDICT_TOOL_SCHEMAS.map((s) => s.function.name)).toEqual([...PREDICT_TOOL_NAMES]);
    expect(isPredictTool("dex_trending")).toBe(false);
  });
});
