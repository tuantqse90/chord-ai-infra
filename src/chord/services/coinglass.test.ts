import { afterEach, describe, expect, it } from "bun:test";
import { cgl, etfFlows, liqBoard, liqWindows, optionsView, positioningView, pulseView, reservesView } from "./coinglass";
import { mockFetch, resetRedis, type MockFetchHandle } from "../testkit/helpers";
// ask2049: Chord's testkit jsonResponse, inline (ask2049's testkit/helpers has no jsonResponse).
const jsonResponse = (status: number, body: object = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Shapes below are trimmed copies of real v4 payloads (probe 2026-09-26, Hobbyist key).
const btcLiq = { symbol: "BTC", liquidation_usd_24h: 37445035.8, long_liquidation_usd_24h: 29286485.2, short_liquidation_usd_24h: 8158550.6, liquidation_usd_12h: 2991656, long_liquidation_usd_12h: 1389470, short_liquidation_usd_12h: 1602186, liquidation_usd_4h: 419053, long_liquidation_usd_4h: 348474, short_liquidation_usd_4h: 70578, liquidation_usd_1h: 354808, long_liquidation_usd_1h: 345952, short_liquidation_usd_1h: 8856 };
const ethLiq = { ...btcLiq, symbol: "ETH", liquidation_usd_24h: 19876366, long_liquidation_usd_24h: 9000000, short_liquidation_usd_24h: 10876366 };

describe("coinglass shaping", () => {
  it("liquidations: per-window split and the market board", () => {
    const w = liqWindows(btcLiq);
    expect(w.h24.totalUsd).toBe(37445036);
    expect(w.h24.longSharePct).toBe(78.2);
    const b = liqBoard([ethLiq, btcLiq], "24h");
    expect(b.coins.map((c) => c.coin)).toEqual(["BTC", "ETH"]);
    expect(b.marketTotalUsd).toBe(57321402);
    expect(b.marketLongSharePct).toBe(66.8);
  });

  it("ETF flows: window, totals, streak, latest fund split", () => {
    const d = 86_400_000;
    const rows = [
      { timestamp: 3 * d, flow_usd: -50e6, etf_flows: [{ etf_ticker: "IBIT", flow_usd: -80e6 }, { etf_ticker: "FBTC", flow_usd: 30e6 }, { etf_ticker: "BTC" }] },
      { timestamp: 1 * d, flow_usd: 200e6 },
      { timestamp: 2 * d, flow_usd: -20e6 },
    ];
    const f = etfFlows(rows, 10);
    expect(f.days.map((x) => x.netFlowUsd)).toEqual([200e6, -20e6, -50e6]);
    expect(f.totalUsd).toBe(130e6);
    expect(f.streak).toEqual({ direction: "outflow", days: 2 });
    expect(f.latestByFund).toEqual([{ ticker: "IBIT", flowUsd: -80e6 }, { ticker: "FBTC", flowUsd: 30e6 }]);
  });

  it("options: totals, venues, upcoming expiries with put/call", () => {
    const o = optionsView(
      [{ exchange_name: "All", open_interest_usd: 34.7e9, open_interest_change_24h: -1.14, volume_usd_24h: 2.1e9 }, { exchange_name: "Deribit", open_interest_usd: 29.2e9, oi_market_share: 84.15 }],
      [{ date: "991231", max_pain_price: "84000", call_open_interest_notional: 250e6, put_open_interest_notional: 125e6 }, { date: "200101", max_pain_price: "7000", call_open_interest_notional: 1, put_open_interest_notional: 1 }],
    );
    expect(o.totalOiUsd).toBe(34.7e9);
    expect(o.venues[0]).toEqual({ venue: "Deribit", oiUsd: 29.2e9, sharePct: 84.2 });
    expect(o.expiries).toEqual([{ expiry: "2099-12-31", maxPainPrice: 84000, callOiUsd: 250e6, putOiUsd: 125e6, putCallRatio: 0.5 }]);
  });

  it("reserves: sum across exchanges and change %", () => {
    const r = reservesView([
      { exchange_name: "Coinbase", total_balance: 843509, balance_change_1d: -923, balance_change_7d: -2206, balance_change_30d: -11545, balance_change_percent_7d: -0.26, balance_change_percent_30d: -1.35 },
      { exchange_name: "Binance", total_balance: 671895, balance_change_1d: -5696, balance_change_7d: -18516, balance_change_30d: -4430, balance_change_percent_7d: -2.68, balance_change_percent_30d: -0.66 },
    ]);
    expect(r.totalBalance).toBe(1515404);
    expect(r.d7.change).toBe(-20722);
    expect(r.d7.changePct).toBe(-1.35);
    expect(r.top[0].exchange).toBe("Coinbase");
  });

  it("pulse: fear & greed now / week / month, closest peak indicators", () => {
    const vals = Array.from({ length: 40 }, (_, i) => i + 40);
    const p = pulseView({ data_list: vals, time_list: vals.map((_, i) => i * 86_400_000) }, [{ time: 1790294400, premium: -23.87, premium_rate: -0.0283 }],
      [{ indicator_name: "Ahr999", current_value: "0.57", target_value: "4", hit_status: false }, { indicator_name: "Pi Cycle", current_value: "84034", target_value: "157160", hit_status: false }, { indicator_name: "X", current_value: "9", target_value: "5", hit_status: true }]);
    expect(p.fearGreed?.now).toEqual({ value: 79, label: "extreme greed", date: "1970-02-09" });
    expect(p.fearGreed?.weekAgo?.value).toBe(72);
    expect(p.coinbasePremium[0]).toEqual({ date: "2026-09-25", premiumUsd: -23.87, premiumPct: -0.0283 });
    expect(p.bullPeakIndicators).toEqual({ hit: 1, total: 3, closest: [{ name: "Pi Cycle", current: 84034, target: 157160, hit: false, progressPct: 53 }, { name: "Ahr999", current: 0.57, target: 4, hit: false, progressPct: 14 }] });
  });

  it("positioning: all-exchange OI with change windows, funding, taker, long/short", () => {
    const p = positioningView(
      [{ exchange: "All", open_interest_usd: 55e9, open_interest_change_percent_1h: -0.38, open_interest_change_percent_4h: -0.26, open_interest_change_percent_24h: -1.97 }, { exchange: "Binance", open_interest_usd: 11e9, open_interest_change_percent_24h: -2.5 }],
      [{ time: 1790409600000, close: "0.000371" }], { buy_ratio: 49.26, sell_ratio: 50.74, buy_vol_usd: 17.4e9, sell_vol_usd: 17.9e9 },
      [{ global_account_long_percent: 61.2 }], [{ top_account_long_percent: 55.5 }]);
    expect(p.oiChangePct).toEqual({ h1: -0.38, h4: -0.26, h24: -1.97 });
    expect(p.venues[0]).toEqual({ venue: "Binance", oiUsd: 11e9, sharePct: 20, change24hPct: -2.5 });
    expect(p.fundingOiWeighted[0].ratePct).toBe(0.0004);
    expect(p.binanceLongAccountsPct).toBe(61.2);
  });
});

describe("cgl() — cache, plan errors, budget", () => {
  let fx: MockFetchHandle | null = null;
  afterEach(() => { fx?.restore(); fx = null; resetRedis(); delete process.env.COINGLASS_API_KEY; });

  it("not configured without a key", async () => {
    await expect(cgl("/api/futures/liquidation/coin-list", {}, 60)).rejects.toThrow("not configured");
  });

  it("caches a success; a plan-locked endpoint says so in words", async () => {
    process.env.COINGLASS_API_KEY = "k";
    fx = mockFetch({ "coin-list": { code: "0", data: [btcLiq] }, "coins-markets": { code: "401", msg: "Upgrade plan" } });
    const a = await cgl<any[]>("/api/futures/liquidation/coin-list", {}, 60);
    const b = await cgl<any[]>("/api/futures/liquidation/coin-list", {}, 60);
    expect(a.data[0].symbol).toBe("BTC");
    expect(b.ageS).toBeGreaterThanOrEqual(0);
    expect(fx.calls.filter((c) => c.url.includes("coin-list")).length).toBe(1);
    expect(fx.calls[0].init?.headers).toMatchObject({ "CG-API-KEY": "k" });
    await expect(cgl("/api/futures/coins-markets", {}, 60)).rejects.toThrow("not available on the current CoinGlass plan");
  });

  it("a 429 pauses calls and falls back to a stale copy", async () => {
    process.env.COINGLASS_API_KEY = "k";
    fx = mockFetch({ "coin-list": { code: "0", data: [btcLiq] } });
    await cgl("/api/futures/liquidation/coin-list", {}, 0);
    fx.restore();
    fx = mockFetch({ "coin-list": jsonResponse(429, {}) });
    const s = await cgl<any[]>("/api/futures/liquidation/coin-list", {}, 0);
    expect(s.data[0].symbol).toBe("BTC");
  });
});
