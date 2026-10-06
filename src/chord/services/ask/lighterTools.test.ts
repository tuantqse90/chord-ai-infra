import { describe, expect, it } from "bun:test";
import {
  LIGHTER_TOOL_META, LIGHTER_TOOL_NAMES, LIGHTER_TOOL_SCHEMAS, accountSummary, boardRows, bookSummary, candleCloses, fundingAprPct,
  fundingHourlyPct, fundingSeries, fundingStats, isLighterTool, lighterAccountUrl, lighterTradeUrl, marketRow, normalizeMarkets,
  parseLighterVenue, resolveLighterMarket, runLighterTool, tradesSummary,
} from "./lighterTools";

// Fixtures trimmed from live responses of mainnet.zklighter.elliot.ai / api.rh.lighter.xyz, 2026-10-03.
const CORE_DETAILS = {
  code: 200,
  order_book_details: [
    { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", taker_fee: "0.0000", maker_fee: "0.0000", min_base_amount: "0.00007", multiplier: "1.000000000000000000", min_initial_margin_fraction: 200, mark_price: "84217.7", index_price: "84240.7", last_trade_price: 84221.1, daily_trades_count: 675393, daily_quote_token_volume: 800735330.807254, daily_price_low: 83839.9, daily_price_high: 87223.5, daily_price_change: -0.42350637742434344, open_interest: 2050.42159, market_config: { market_margin_mode: 0, force_reduce_only: false, hidden: false } },
    { symbol: "1000PEPE", market_id: 10, market_type: "perp", status: "active", taker_fee: "0.0000", maker_fee: "0.0000", min_base_amount: "500", multiplier: "1.000000000000000000", min_initial_margin_fraction: 1000, mark_price: "0.004180", index_price: "0.004181", last_trade_price: 0.00418, daily_trades_count: 9000, daily_quote_token_volume: 2500000, daily_price_low: 0.0041, daily_price_high: 0.0044, daily_price_change: 3.5, open_interest: 267824393, market_config: { market_margin_mode: 0, force_reduce_only: false, hidden: false } },
    { symbol: "MKR", market_id: 50, market_type: "perp", status: "inactive", min_initial_margin_fraction: 0, mark_price: "0", last_trade_price: 0, daily_quote_token_volume: 0, daily_price_change: 0, open_interest: 0, market_config: { hidden: false } },
    { symbol: "SECRET", market_id: 77, market_type: "perp", status: "active", min_initial_margin_fraction: 1000, mark_price: "1", last_trade_price: 1, daily_quote_token_volume: 9e9, open_interest: 1, market_config: { hidden: true } },
    { symbol: "BE", market_id: 196, market_type: "perp", status: "active", min_initial_margin_fraction: 1000, mark_price: "290", last_trade_price: 290, daily_quote_token_volume: 0, daily_price_change: 0, open_interest: 10, market_config: { force_reduce_only: true, hidden: false } },
  ],
  spot_order_book_details: [
    { symbol: "ETH/USDC", market_id: 2048, market_type: "spot", status: "active", multiplier: "1.000000000000000000", last_trade_price: 2668.1, daily_trades_count: 53317, daily_quote_token_volume: 5216302.315577, daily_price_low: 2600, daily_price_high: 2700, daily_price_change: -1.2 },
    { symbol: "rhSPY/USDC", market_id: 2060, market_type: "spot", status: "active", multiplier: "1.001717991187472003", last_trade_price: 772.99, daily_trades_count: 40, daily_quote_token_volume: 20000, daily_price_change: 0.4 },
  ],
};
const CORE_FUNDING = { code: 200, funding_rates: [
  { market_id: 1, exchange: "binance", symbol: "BTC", rate: 4.645e-5 },
  { market_id: 1, exchange: "lighter", symbol: "BTC", rate: 9.599999999999999e-5 },
  { market_id: 10, exchange: "lighter", symbol: "1000PEPE", rate: -0.000376 },
] };
const RH_DETAILS = {
  code: 200,
  order_book_details: [
    { symbol: "NVDA", market_id: 15, market_type: "perp", status: "active", min_initial_margin_fraction: 500, mark_price: "234.25", index_price: "234.10", last_trade_price: 234.3, daily_trades_count: 34158, daily_quote_token_volume: 20692877, daily_price_change: 1.21, open_interest: 27807.4, market_config: { hidden: false } },
  ],
  spot_order_book_details: [
    { symbol: "NVDA/USDG", market_id: 2058, market_type: "spot", status: "active", multiplier: "1.000775159164630595", last_trade_price: 234.35, daily_trades_count: 50, daily_quote_token_volume: 31364, daily_price_change: 0.96 },
  ],
};

describe("lighter markets", () => {
  const core = normalizeMarkets("core", CORE_DETAILS, CORE_FUNDING);
  const rh = normalizeMarkets("robinhood", RH_DETAILS);

  it("normalizes perps and spot, drops hidden markets, joins Lighter's own funding by market id", () => {
    expect(core.map((m) => m.symbol)).toEqual(["BTC", "1000PEPE", "MKR", "BE", "ETH/USDC", "rhSPY/USDC"]);
    const btc = core.find((m) => m.symbol === "BTC")!;
    expect(btc.type).toBe("perp");
    expect(btc.maxLeverage).toBe(50); // 10000 / 200
    expect(btc.funding8h).toBeCloseTo(9.6e-5, 10); // the lighter row, not binance
    expect(btc.oiUsd).toBeCloseTo(2050.42159 * 84217.7, 0); // base units x mark
    expect(core.find((m) => m.symbol === "ETH/USDC")!.funding8h).toBeNull();
    expect(core.find((m) => m.symbol === "MKR")!.active).toBe(false);
    expect(core.find((m) => m.symbol === "MKR")!.maxLeverage).toBeNull();
    expect(core.find((m) => m.symbol === "BE")!.reduceOnly).toBe(true);
  });

  it("funding: fraction per 8 h → % per hour → % per year (BTC 9.6e-5 = 0.0012 %/h = 10.51 %/yr)", () => {
    expect(fundingHourlyPct(9.6e-5)).toBe(0.0012);
    expect(fundingAprPct(0.0012)).toBe(10.51);
    expect(fundingHourlyPct(-0.000376)).toBe(-0.0047);
    expect(fundingHourlyPct(null)).toBeNull();
  });

  it("board: active only, sorted, filtered", () => {
    expect(boardRows(core, { sort: "volume", limit: 10 }).map((m) => m.symbol)).toEqual(["BTC", "ETH/USDC", "1000PEPE", "rhSPY/USDC", "BE"]);
    // funding skips spot and reduce-only markets; a leading - sorts ascending
    expect(boardRows(core, { sort: "-funding", limit: 5 }).map((m) => m.symbol)).toEqual(["1000PEPE", "BTC"]);
    // movers need $50k of volume unless the person searched
    expect(boardRows(core, { sort: "change", limit: 5 }).map((m) => m.symbol)).toEqual(["1000PEPE", "BTC", "ETH/USDC"]);
    expect(boardRows(core, { sort: "change", query: "spy", limit: 5 }).map((m) => m.symbol)).toEqual(["rhSPY/USDC"]);
    expect(boardRows(core, { sort: "volume", type: "spot", limit: 5 }).every((m) => m.type === "spot")).toBe(true);
  });

  it("board rows carry units the model can repeat", () => {
    const row = marketRow(core[0]);
    expect(row).toMatchObject({ venue: "core", symbol: "BTC", type: "perp", price: 84221, change24hPct: -0.42, volume24hUsd: 800735331, fundingHourlyPct: 0.0012, fundingAprPct: 10.51, maxLeverage: 50 });
    expect(marketRow(rh[1])).toMatchObject({ symbol: "NVDA/USDG", type: "spot", sharesPerToken: 1.00078 });
    expect("fundingHourlyPct" in marketRow(rh[1])).toBe(false);
  });

  it("resolves friendly market names", () => {
    expect(resolveLighterMarket(core, "btc")?.symbol).toBe("BTC");
    expect(resolveLighterMarket(core, "$BTC")?.symbol).toBe("BTC");
    expect(resolveLighterMarket(core, "BTC-PERP")?.symbol).toBe("BTC");
    expect(resolveLighterMarket(core, "BTC-USD")?.symbol).toBe("BTC"); // no BTC spot → the perp
    expect(resolveLighterMarket(core, "eth/usdc")?.symbol).toBe("ETH/USDC");
    expect(resolveLighterMarket(core, "ETH-USDC")?.symbol).toBe("ETH/USDC");
    expect(resolveLighterMarket(core, "pepe")?.symbol).toBe("1000PEPE");
    expect(resolveLighterMarket(core, "kPEPE")?.symbol).toBe("1000PEPE");
    expect(resolveLighterMarket(core, "SPY", "spot")?.symbol).toBe("rhSPY/USDC");
    expect(resolveLighterMarket(rh, "NVDA")?.symbol).toBe("NVDA");
    expect(resolveLighterMarket(rh, "NVDA spot")?.symbol).toBe("NVDA/USDG");
    expect(resolveLighterMarket(rh, "nvda/usdc")?.symbol).toBe("NVDA/USDG");
    expect(resolveLighterMarket(core, "NOPE")).toBeNull();
    expect(resolveLighterMarket(core, "")).toBeNull();
  });

  it("venue names and public links", () => {
    expect(parseLighterVenue(undefined)).toBe("both");
    expect(parseLighterVenue("Lighter")).toBe("core");
    expect(parseLighterVenue("RH")).toBe("robinhood");
    expect(parseLighterVenue("Robinhood Chain")).toBe("robinhood");
    expect(parseLighterVenue("binance")).toBeNull();
    expect(lighterTradeUrl("core", "BTC")).toBe("https://app.lighter.xyz/trade/BTC");
    expect(lighterTradeUrl("core", "ETH/USDC")).toBe("https://app.lighter.xyz/trade/ETH_USDC");
    expect(lighterTradeUrl("robinhood", "NVDA")).toBe("https://robinhoodchain.lighter.xyz/trade/NVDA");
    expect(lighterAccountUrl("core", "0xabc")).toBe("https://app.lighter.xyz/explorer/accounts/0xabc");
  });
});

describe("lighter book, prints, funding, candles", () => {
  it("book: best bid / ask, spread, USD depth per band; a cut sample is a floor", () => {
    const obo = {
      asks: [{ price: "100.10", remaining_base_amount: "2" }, { price: "100.50", remaining_base_amount: "1" }, { price: "101.50", remaining_base_amount: "3" }],
      bids: [{ price: "99.90", remaining_base_amount: "1" }, { price: "99.00", remaining_base_amount: "4" }, { price: "97.00", remaining_base_amount: "10" }],
    };
    const b = bookSummary(obo, 250)!;
    expect(b.bestBid).toBe(99.9);
    expect(b.bestAsk).toBe(100.1);
    expect(b.spreadBps).toBe(20);
    const d1 = b.depth.find((d) => d.bandPct === 1)!;
    expect(d1.bidUsd).toBe(99.9 + 396); // 99.90 x 1 + 99.00 x 4
    expect(d1.askUsd).toBe(200.2 + 100.5);
    expect(d1.complete).toBe(true); // fewer orders than the limit = the whole book
    const cut = bookSummary(obo, 3)!; // the sample was cut at 3 a side and reaches ~1.4 % (asks) / ~3 % (bids)
    expect(cut.depth.find((d) => d.bandPct === 1)!.complete).toBe(true);
    expect(cut.depth.find((d) => d.bandPct === 2)!.complete).toBe(false);
    expect(bookSummary({ asks: [], bids: [] })).toBeNull();
  });

  it("prints: is_maker_ask true = taker bought", () => {
    const now = 1_790_971_100_000;
    const t = tradesSummary({ trades: [
      { type: "trade", price: "84193.7", usd_amount: "16.838740", is_maker_ask: false, timestamp: 1_790_971_025_793 },
      { type: "trade", price: "84194.0", usd_amount: "5000.00", is_maker_ask: true, timestamp: 1_790_971_020_000 },
      { type: "liquidation", price: "84100.0", usd_amount: "900.00", is_maker_ask: false, timestamp: 1_790_971_000_000 },
    ] }, now)!;
    expect(t.buyUsd).toBe(5000);
    expect(t.sellUsd).toBe(916.84);
    expect(t.buySharePct).toBe(84.5);
    expect(t.liquidations).toBe(1);
    expect(t.windowSeconds).toBe(26);
    expect(t.largest[0]).toMatchObject({ side: "buy", usd: 5000, secondsAgo: 80 });
    expect(tradesSummary({ trades: [] })).toBeNull();
  });

  it("funding history: rate is % per hour, direction = the side that paid", () => {
    const s = fundingSeries({ fundings: [
      { timestamp: 1790956800, value: "1.02", rate: "0.0012", direction: "long" },
      { timestamp: 1790953200, value: "0.07", rate: "0.0043", direction: "short" },
      { timestamp: 1790960400, value: "1.02", rate: "0.0012", direction: "long" },
    ] });
    expect(s.map((x) => x.hourlyPct)).toEqual([-0.0043, 0.0012, 0.0012]); // sorted oldest first
    const st = fundingStats(s)!;
    expect(st.lastSettledHourlyPct).toBe(0.0012);
    expect(st.hoursShortsPaid).toBe(1);
    expect(st.minHourlyPct).toBe(-0.0043);
    expect(st.lastSettledAt).toBe("2026-10-02 17:00 UTC");
    expect(fundingStats([])).toBeNull();
  });

  it("candles: closes oldest first, empty pre-listing days dropped", () => {
    const c = candleCloses({ r: "1d", c: [
      { t: 1785888000000, o: 593.92, h: 593.92, l: 593.92, c: 593.92, v: 0, V: 0 },
      { t: 1785801600000, o: 593.92, h: 593.92, l: 593.92, c: 593.92, v: 0, V: 0 },
      { t: 1790899200000, o: 728.54, h: 740.7, l: 726.74, c: 728.8, v: 12.8193, V: 9378.536814 },
      { t: 1790985600000, o: 728.8, h: 731, l: 727, c: 730.1, v: 1, V: 730 },
    ] });
    expect(c.map((x) => x.close)).toEqual([728.8, 730.1]);
  });
});

describe("lighter account", () => {
  // trimmed from account?by=l1_address on both venues (a cross long with a liquidation price, an isolated short, a flat row)
  const resp = { code: 200, total: 2, accounts: [
    { account_type: 0, index: 27927, l1_address: "0x667AcBF513Aa97Acd46b0a58A655E9c487972D56", total_order_count: 18, available_balance: "136482.291646", collateral: "284803.365838", total_asset_value: "253904.320877", cross_asset_value: "253904.320877", cross_initial_margin_requirement: "117422.029231", cross_maintenance_margin_requirement: "28181.287015",
      positions: [
        { market_id: 1, symbol: "BTC", initial_margin_fraction: "5.00", open_order_count: 18, sign: 1, position: "27.87321", avg_entry_price: "85363.0", position_value: "2348440.584624", unrealized_pnl: "-30899.044961", liquidation_price: "76057.83386457566", total_funding_paid_out: "-694.728225", margin_mode: 0, allocated_margin: "0.000000" },
        { market_id: 0, symbol: "ETH", initial_margin_fraction: "5.00", open_order_count: 0, sign: 1, position: "0.0000", avg_entry_price: "0.00", position_value: "-0.000000", unrealized_pnl: "0.000000", liquidation_price: "0", margin_mode: 0 },
      ],
      assets: [{ symbol: "USDC", balance: "0.000000", locked_balance: "0.000000", margin_balance: "284803.365838" }, { symbol: "LIT", balance: "12.5", locked_balance: "0" }] },
    { account_type: 1, index: 281474976709861, total_order_count: 3, available_balance: "9052.5", collateral: "9670.82", total_asset_value: "9662.7", cross_asset_value: "9662.7", cross_initial_margin_requirement: "0", cross_maintenance_margin_requirement: "0",
      positions: [{ market_id: 4, symbol: "ZEC", initial_margin_fraction: "10.00", open_order_count: 1, sign: -1, position: "0.0741", avg_entry_price: "1301.37", position_value: "94.785015", unrealized_pnl: "1.646190", liquidation_price: "1350.1996155119296", total_funding_paid_out: "0.08", margin_mode: 1, allocated_margin: "9.621575" }],
      assets: [] },
  ] };

  it("summarises each account with its open positions", () => {
    const [main, sub] = accountSummary(resp);
    expect(main).toMatchObject({ index: 27927, kind: "main", collateralUsd: 284803, accountValueUsd: 253904, openOrders: 18, openPositions: 1, maintenanceUsagePct: 11.1 });
    expect(main.positions).toHaveLength(1); // the flat ETH row is dropped
    expect(main.positions[0]).toMatchObject({ market: "BTC", side: "long", size: 27.8732, entry: 85363, leverage: 20, marginMode: "cross", liquidationPrice: 76057.8, fundingNetUsd: -694.73 });
    expect(main.positions[0].mark).toBeCloseTo(84254, -1); // position_value / size
    expect(main.positions[0].liquidationDistancePct).toBeCloseTo(9.73, 1);
    expect(main.leverage).toBeCloseTo(9.25, 1);
    expect(main.spot).toEqual([{ symbol: "LIT", balance: 12.5 }]);
    expect(sub).toMatchObject({ kind: "sub-account" });
    expect(sub.positions[0]).toMatchObject({ market: "ZEC", side: "short", leverage: 10, marginMode: "isolated", marginUsd: 9.62 });
    expect(accountSummary({ accounts: [] })).toEqual([]);
  });
});

describe("lighter tool plumbing", () => {
  it("every schema has a registry row in group lighter, and the dispatcher knows the names", () => {
    expect(LIGHTER_TOOL_SCHEMAS.map((s) => s.function.name)).toEqual([...LIGHTER_TOOL_NAMES]);
    for (const n of LIGHTER_TOOL_NAMES) {
      expect(LIGHTER_TOOL_META[n]?.group).toBe("lighter");
      expect(isLighterTool(n)).toBe(true);
    }
    expect(isLighterTool("hl_market")).toBe(false);
  });

  it("schema and note text is English without em dashes", () => {
    const text = JSON.stringify(LIGHTER_TOOL_SCHEMAS);
    expect(text.includes("—")).toBe(false);
  });

  it("bad input answers an error without calling the network", async () => {
    expect((await runLighterTool("lighter_account", { wallet: "hello" })).data).toMatchObject({ error: expect.stringContaining("0x address") });
    expect((await runLighterTool("lighter_account", { wallet: "27927" })).data).toMatchObject({ error: expect.stringContaining("one exchange") });
    expect((await runLighterTool("lighter_market", {})).data).toMatchObject({ error: expect.stringContaining("symbol") });
    expect((await runLighterTool("lighter_markets", { venue: "binance" })).data).toMatchObject({ error: expect.stringContaining("venue") });
    expect((await runLighterTool("lighter_nope", {})).data).toMatchObject({ error: expect.stringContaining("unknown") });
  });
});
