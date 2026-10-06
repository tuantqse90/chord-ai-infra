import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MARKET_TOOL_META, MARKET_TOOL_NAMES, MARKET_TOOL_SCHEMAS, isMarketTool, liveFeedOf, marketToolOffered, runMarketTool } from "./marketTools";
import { TOOL_META } from "./registry";
import { mockFetch, resetRedis, type MockFetchHandle } from "../../testkit/helpers";

const PORTED = ["cg_coin", "cg_markets", "cg_trending", "cg_global", "cg_categories", "cg_chart",
  "cgl_liquidations", "cgl_etf_flows", "cgl_options", "cgl_exchange_reserves", "cgl_market_pulse", "cgl_positioning",
  "llama_protocol", "llama_rankings", "llama_chains", "llama_stablecoins", "llama_yields",
  "macro_snapshot", "market_levels", "earnings_calendar", "hl_markets", "hl_market", "hl_funding", "hl_wallet",
  "derivs_coin", "derivs_board", "dex_search"];

// Keys the tests flip; restored after each test so a developer's shell env does not leak in or out.
const ENV_KEYS = ["CMC_API_KEY", "COINGLASS_API_KEY", "COINGLASS_ASK", "COINGECKO_API_KEY", "COINGECKO_PLAN"] as const;
let saved: Record<string, string | undefined> = {};
let fx: MockFetchHandle | null = null;
beforeEach(() => { saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); for (const k of ENV_KEYS) delete process.env[k]; });
afterEach(() => {
  fx?.restore(); fx = null; resetRedis();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("market tool family", () => {
  it("one schema and one registry row per ported tool, the rows equal to Chord's registry", () => {
    expect([...MARKET_TOOL_NAMES].sort()).toEqual([...PORTED].sort());
    expect(new Set(MARKET_TOOL_NAMES).size).toBe(MARKET_TOOL_NAMES.length);
    expect(Object.keys(MARKET_TOOL_META).sort()).toEqual([...PORTED].sort());
    for (const n of PORTED) expect(MARKET_TOOL_META[n]).toEqual(TOOL_META[n]);
    for (const s of MARKET_TOOL_SCHEMAS) expect(s.function.parameters.type).toBe("object");
  });

  it("knows its own tools only (backtest / arc_fx stay in Chord)", () => {
    for (const n of PORTED) expect(isMarketTool(n)).toBe(true);
    for (const n of ["backtest", "arc_fx", "dex_trending", "news_latest", ""]) expect(isMarketTool(n)).toBe(false);
  });

  it("CoinGlass is offered only with a key AND COINGLASS_ASK=1; everything else always", () => {
    expect(marketToolOffered("cgl_liquidations")).toBe(false);
    process.env.COINGLASS_API_KEY = "k";
    expect(marketToolOffered("cgl_liquidations")).toBe(false);
    process.env.COINGLASS_ASK = "1";
    for (const n of PORTED.filter((x) => x.startsWith("cgl_"))) expect(marketToolOffered(n)).toBe(true);
    delete process.env.COINGLASS_API_KEY;
    expect(marketToolOffered("cgl_market_pulse")).toBe(false);
    for (const n of PORTED.filter((x) => !x.startsWith("cgl_"))) expect(marketToolOffered(n)).toBe(true);
    expect(marketToolOffered("backtest")).toBe(false);
  });
});

describe("runMarketTool (offline)", () => {
  const META = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }, { name: "OLD", szDecimals: 0, maxLeverage: 3, isDelisted: true }] };
  const CTXS = [
    { funding: "0.0000125", openInterest: "100", prevDayPx: "100000", dayNtlVlm: "5000000000", premium: "0.0001", oraclePx: "101000", markPx: "101000", midPx: "101000" },
    { funding: "-0.00001", openInterest: "1000", prevDayPx: "4000", dayNtlVlm: "2000000000", premium: null, oraclePx: "3900", markPx: "3900", midPx: null },
    { funding: "0", openInterest: "1", prevDayPx: "1", dayNtlVlm: "1", premium: null, oraclePx: "1", markPx: "1", midPx: null },
  ];

  it("hl_markets: Chord's rows, sort, table and citations; delisted perps left out", async () => {
    fx = mockFetch({ "api.hyperliquid.xyz/info": [META, CTXS] });
    const r = await runMarketTool("hl_markets", {});
    const d = r.data as any;
    expect(d.venue).toBe("Hyperliquid");
    // Membership only, not order: Chord's case sorts `(asc ? 1 : -1) * (val(b) - val(a))`, which puts the LOWEST value first
    // when no "-" is given (the schema promises the reverse). Kept as in Chord; reported for a fix on both sides.
    expect(d.markets.map((m: any) => m.coin).sort()).toEqual(["BTC", "ETH"]);
    expect(d.markets.find((m: any) => m.coin === "BTC")).toEqual({ coin: "BTC", markPx: 101000, change24hPct: 1, volume24hUsd: 5e9, openInterestUsd: 10_100_000, fundingHourlyPct: 0.0013, fundingAnnualPct: 10.95, maxLeverage: 40 });
    expect(d.note).toBe("Funding is hourly; positive = longs pay shorts. Trade from /ask/perp.");
    expect(r.citations.map((c) => c.label).sort()).toEqual(["BTC perp on Hyperliquid", "ETH perp on Hyperliquid"]);
    expect(r.viz?.[0]).toMatchObject({ kind: "table", title: "Hyperliquid perps" });
    const one = (await runMarketTool("hl_markets", { sort: "-funding", limit: 1 })).data as any;
    expect(one.markets.length).toBe(1);
  });

  it("hl_wallet refuses a non-address without calling Hyperliquid", async () => {
    fx = mockFetch({});
    expect((await runMarketTool("hl_wallet", { wallet: "vitalik" })).data).toEqual({ error: "wallet must be a 0x address" });
    expect(fx.calls.length).toBe(0);
  });

  it("cg_global without a CMC key reads CoinGecko: dominance donut closes with Other", async () => {
    fx = mockFetch({
      "/global/decentralized_finance_defi": { data: { defi_market_cap: "100000000000", defi_dominance: "3.3", top_coin_name: "Lido Staked Ether" } },
      "api.coingecko.com/api/v3/global": { data: { total_market_cap: { usd: 3e12 }, total_volume: { usd: 1e11 }, market_cap_change_percentage_24h_usd: 1.234, active_cryptocurrencies: 17000, market_cap_percentage: { btc: 57.1, eth: 12.3, usdt: 4.5 } } },
    });
    const r = await runMarketTool("cg_global", {});
    const d = r.data as any;
    expect(d.totalMarketCapUsd).toBe(3e12);
    expect(d.dominance).toEqual([{ symbol: "BTC", pct: 57.1 }, { symbol: "ETH", pct: 12.3 }, { symbol: "USDT", pct: 4.5 }]);
    expect(d.note).toBe("CoinGecko global figures.");
    expect(r.citations).toEqual([{ label: "CoinGecko global", href: "https://www.coingecko.com/en/global-charts" }]);
    const donut = r.viz?.[0] as any;
    expect(donut.kind).toBe("donut");
    expect(donut.slices.at(-1)).toEqual({ name: "Other", value: 26.1 });
  });

  it("a source failure becomes an answer the model can repeat", async () => {
    fx = mockFetch({ "search/trending": new Response("{}", { status: 500 }) });
    expect((await runMarketTool("cg_trending", {})).data).toEqual({ error: "CoinGecko 500", note: "The source did not answer just now. Say the data is unavailable; do not guess numbers." });
  });

  it("no FX lake here: DXY drops out of the snapshot with Chord's note, an FX-only pair says the source did not answer", async () => {
    fx = mockFetch({});
    const snap = (await runMarketTool("macro_snapshot", { assets: ["DXY"] })).data as any;
    expect(snap.markets).toEqual([]);
    expect(snap.note).toContain("DXY is not available right now");
    const gbp = (await runMarketTool("market_levels", { asset: "GBP/USD" })).data as any;
    expect(gbp).toEqual({ found: false, asset: "GBP/USD", note: "The price source did not answer. Say so; do not guess." });
    expect(fx.calls.length).toBe(0);
  });

  it("unknown tool", async () => {
    expect((await runMarketTool("backtest", {})).data).toEqual({ error: "unknown tool backtest" });
  });
});

// Copied from Chord's services/askAgent.test.ts (liveFeedOf moved here with cg_coin).
describe("liveFeedOf (live price source for a CoinGecko / CoinMarketCap coin, 2026-09-29)", () => {
  it("takes the first platform on a chain Chord indexes, lower-cased", () => {
    expect(liveFeedOf([{ chain: "ethereum", address: `0x${"1".repeat(40)}` }, { chain: "monad", address: "0x350035555E10d9AfAF1566AaebfCED5BA6C27777" }]))
      .toEqual({ chain: 143, address: "0x350035555e10d9afaf1566aaebfced5ba6c27777" });
    expect(liveFeedOf([{ chain: "Monad", address: `0x${"a".repeat(40)}` }])?.chain).toBe(143); // CoinMarketCap spelling
    expect(liveFeedOf([{ chain: "arc", address: `0x${"3".repeat(40)}` }])?.chain).toBe(5042);
  });
  it("ignores other chains, Arbitrum included, and bad addresses", () => {
    expect(liveFeedOf([{ chain: "Arbitrum One", address: `0x${"2".repeat(40)}` }])).toBeNull();
    expect(liveFeedOf([{ chain: "monad", address: "not-an-address" }])).toBeNull();
    expect(liveFeedOf(undefined)).toBeNull();
  });
});
