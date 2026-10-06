// Ask tools for Lighter (2026-10-03 tool-parity batch, docs/prompts/ask-tool-parity-2026-10.md): the order-book perp + spot DEX,
// read through its PUBLIC REST API only (no key, no orders — perps on Chord trade from the Hyperliquid Perp tab). Lighter runs
// two SEPARATE exchanges with the same API: accounts, market ids and balances do not carry over, so every row names its venue.
//   · core       Lighter                     https://mainnet.zklighter.elliot.ai/api/v1 — USDC; crypto, FX, index, stock perps + a few spot pairs
//   · robinhood  Lighter on Robinhood Chain  https://api.rh.lighter.xyz/api/v1          — USDG; stock + crypto perps, stock-token spot (X/USDG)
// Tools:
//   lighter_markets — the board (price, 24h change / volume, OI, funding, max leverage) for one venue or both
//   lighter_market  — one market: stats, top of book + depth bands, the last prints, funding now + settled, a price line
//   lighter_account — a wallet's public account(s) on a venue: collateral, value, margin use, positions, liquidation prices
//
// Units (measured 2026-10-03; BTC mark 84,329 on Lighter vs 84,326 on Hyperliquid — read endpoints answer plain decimals, the
// integer scaling of size_decimals / price_decimals applies to signed orders only):
//   · funding-rates `rate` of exchange "lighter" = fraction per 8 h, Lighter's live estimate for the running hour; hourly = rate / 8
//     (BTC 9.6e-5 ↔ settled 0.0012 %/h). fundings `rate` = SETTLED % per hour, unsigned; `direction` = the side that paid
//     ("short" → negative). Positive funding = longs pay shorts (docs.lighter.xyz/trading/funding).
//   · open_interest = base units, ONE side (× mark = USD, the Hyperliquid convention): BTC 1,953.6 × 84,352 = $164.8M, half of
//     exchangeMetrics?kind=open_interest ($329M, both sides; exchange total $1.19B vs our $590M). daily_quote_token_volume = 24h
//     volume in USDC / USDG (≈ USD);
//     daily_price_change is already a percent. max leverage = 10000 / min_initial_margin_fraction (BTC 200 → 50x); a position's
//     initial_margin_fraction is a percent (5.00 → 20x).
//   · stock tokens on spot carry `multiplier` ≠ 1 (dividends): the price is per token, one token = `multiplier` shares.
//   · recentTrades: is_maker_ask true → the taker bought. Account total_funding_paid_out: + = received, − = paid (shorts in a
//     positive-funding week show +). account_type 0 = main, 1 = sub-account, higher = a pool.
//   · account?by=l1_address for a wallet with no account answers 400 {code 21100, "account not found"}.
//   · orderBookOrders returns single orders (best first, ≤ 250 a side): on BTC 250 orders reach only ±0.2 %, so a depth band past
//     the sample's reach is a floor, flagged `complete: false`.
// Rate budget: Lighter allows 60 requests / rolling minute per IP and exchange (recentTrades 40); extHttp keeps the whole box under
// 60 / min for both. The market list is one call per venue, shared by the board and lighter_market (same URL; the market tool
// asks for it fresher), funding-rates likewise.
import { ExtError, extFailure, extJson, num, qs, usdShort, type ExtToolResult } from "./extHttp";
import type { ToolMeta } from "./registry";
import type { Citation, Viz } from "../askAgent";

export type LighterVenue = "core" | "robinhood";
interface VenueConf { key: LighterVenue; name: string; api: string; app: string; collateral: string }
export const LIGHTER_VENUES: Record<LighterVenue, VenueConf> = {
  core: { key: "core", name: "Lighter", api: "https://mainnet.zklighter.elliot.ai/api/v1", app: "https://app.lighter.xyz", collateral: "USDC" },
  robinhood: { key: "robinhood", name: "Lighter on Robinhood Chain", api: "https://api.rh.lighter.xyz/api/v1", app: "https://robinhoodchain.lighter.xyz", collateral: "USDG" },
};
const VENUE_ORDER: LighterVenue[] = ["core", "robinhood"];
const ADDR = /^0x[0-9a-fA-F]{40}$/;

// ── TTLs (seconds) ──
const TTL_BOARD = 30, TTL_DETAIL = 15, TTL_BOOK = 10, TTL_TRADES = 10, TTL_CANDLES = 60, TTL_FUNDING = 60, TTL_ACCOUNT = 15;
/** A % move needs this much 24h volume behind it to make a gainers / losers board (thin books print anything). */
const CHANGE_MIN_VOL_USD = 50_000;
const BOOK_LIMIT = 250, TRADES_LIMIT = 100;

// ── formatting ──
const sig = (n: number | null | undefined, p = 5) => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(p)));
const r2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
/** Whole dollars from $1k up, cents below. */
const usd = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.abs(n) >= 1000 ? Math.round(n) : Math.round(n * 100) / 100);
const pctCell = (n: number | null | undefined) => (n == null ? null : `${n > 0 ? "+" : ""}${n}%`);
const vTable = (title: string, columns: string[], rows: (string | number | null)[][], align?: ("l" | "r")[]): Viz => ({ kind: "table", title, columns, rows, align });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "rh" / "robinhood chain" / 4663 → robinhood, "lighter" / "core" / "mainnet" → core, empty / "both" → both, anything else → null. */
export function parseLighterVenue(v: unknown): LighterVenue | "both" | null {
  const s = String(v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (!s || s === "both" || s === "all" || s === "any") return "both";
  if (["core", "lighter", "lighter core", "mainnet", "main", "zklighter", "lighter mainnet", "usdc"].includes(s)) return "core";
  if (["robinhood", "rh", "robinhood chain", "lighter rh", "lighter robinhood", "lighter on robinhood chain", "4663", "hood", "usdg"].includes(s)) return "robinhood";
  return null;
}

/** The public trade page of a market (the app routes spot pairs as BASE_QUOTE). */
export const lighterTradeUrl = (venue: LighterVenue, symbol: string) => `${LIGHTER_VENUES[venue].app}/trade/${encodeURIComponent(symbol.replace("/", "_"))}`;
/** The public explorer page of an account (the app takes an 0x owner or an account index). */
export const lighterAccountUrl = (venue: LighterVenue, key: string) => `${LIGHTER_VENUES[venue].app}/explorer/accounts/${encodeURIComponent(key)}`;
const apiUrl = (venue: LighterVenue, path: string, params?: Record<string, string | number | boolean | undefined>) => `${LIGHTER_VENUES[venue].api}/${path}${params ? qs(params) : ""}`;

/** Funding as Lighter's funding-rates gives it (fraction per 8 h) → % per hour and % per year. */
export const fundingHourlyPct = (rate8h: number | null | undefined) => (rate8h == null || !Number.isFinite(rate8h) ? null : sig((rate8h / 8) * 100, 3));
export const fundingAprPct = (hourlyPct: number | null | undefined) => (hourlyPct == null ? null : r2(hourlyPct * 24 * 365));

// ── markets ──
export interface LighterMarket {
  venue: LighterVenue; marketId: number; symbol: string; type: "perp" | "spot"; active: boolean; reduceOnly: boolean; isolatedOnly: boolean;
  last: number | null; mark: number | null; index: number | null; change24hPct: number | null; high24h: number | null; low24h: number | null;
  volume24hUsd: number; trades24h: number; oiBase: number | null; oiUsd: number | null;
  /** fraction per 8 h (funding-rates), null for spot or when that call failed */
  funding8h: number | null; maxLeverage: number | null; multiplier: number; takerFeePct: number | null; makerFeePct: number | null; minOrderBase: number | null;
}

/** orderBookDetails (+ funding-rates) of one venue → markets (pure, tested). Hidden markets are dropped. */
export function normalizeMarkets(venue: LighterVenue, details: any, funding?: any): LighterMarket[] {
  const rates = new Map<number, number>();
  for (const f of funding?.funding_rates ?? []) {
    if (f?.exchange !== "lighter") continue;
    const r = num(f.rate), id = num(f.market_id);
    if (r != null && id != null) rates.set(id, r);
  }
  const out: LighterMarket[] = [];
  for (const m of [...(details?.order_book_details ?? []), ...(details?.spot_order_book_details ?? [])]) {
    const id = num(m?.market_id), symbol = String(m?.symbol ?? "").trim();
    if (id == null || !symbol) continue;
    const cfg = m.market_config ?? {};
    if (cfg.hidden === true) continue;
    const type: "perp" | "spot" = m.market_type === "spot" ? "spot" : "perp";
    const last = num(m.last_trade_price), mark = type === "perp" ? num(m.mark_price) : null;
    const oiBase = type === "perp" ? num(m.open_interest) : null;
    const px = mark ?? last;
    const imf = num(m.min_initial_margin_fraction);
    const vol = num(m.daily_quote_token_volume) ?? 0;
    out.push({
      venue, marketId: id, symbol, type, active: m.status === "active", reduceOnly: cfg.force_reduce_only === true, isolatedOnly: cfg.market_margin_mode === 1,
      last, mark, index: type === "perp" ? num(m.index_price) : null,
      change24hPct: vol > 0 ? num(m.daily_price_change) : null, high24h: num(m.daily_price_high), low24h: num(m.daily_price_low),
      volume24hUsd: vol, trades24h: num(m.daily_trades_count) ?? 0,
      oiBase, oiUsd: oiBase != null && px != null ? oiBase * px : null,
      funding8h: type === "perp" ? rates.get(id) ?? null : null,
      maxLeverage: type === "perp" && imf ? Math.round(10_000 / imf) : null,
      multiplier: num(m.multiplier) ?? 1,
      takerFeePct: num(m.taker_fee), makerFeePct: num(m.maker_fee), minOrderBase: num(m.min_base_amount),
    });
  }
  return out;
}

export type LighterSort = "volume" | "change" | "-change" | "oi" | "funding" | "-funding";
const SORTS: LighterSort[] = ["volume", "change", "-change", "oi", "funding", "-funding"];

/** The board: active markets, filtered and sorted (pure, tested). */
export function boardRows(ms: LighterMarket[], o: { sort: LighterSort; query?: string; type?: "perp" | "spot" | null; limit: number }): LighterMarket[] {
  const q = (o.query ?? "").trim().toUpperCase().replace(/^\$/, "");
  let rows = ms.filter((m) => m.active && (!o.type || m.type === o.type) && (!q || m.symbol.toUpperCase().includes(q)));
  const key = (m: LighterMarket): number | null => {
    switch (o.sort) {
      case "change": case "-change": return m.change24hPct;
      case "oi": return m.oiUsd;
      case "funding": case "-funding": return m.reduceOnly ? null : m.funding8h;
      default: return m.volume24hUsd;
    }
  };
  if (o.sort === "change" || o.sort === "-change") rows = rows.filter((m) => q || m.volume24hUsd >= CHANGE_MIN_VOL_USD);
  rows = rows.filter((m) => key(m) != null);
  const dir = o.sort.startsWith("-") ? 1 : -1;
  return rows.sort((a, b) => dir * ((key(a) as number) - (key(b) as number)) || b.volume24hUsd - a.volume24hUsd).slice(0, o.limit);
}

/** One board row as the model reads it. */
export function marketRow(m: LighterMarket) {
  const fh = fundingHourlyPct(m.funding8h);
  return {
    venue: m.venue, symbol: m.symbol, type: m.type, price: sig(m.last ?? m.mark), change24hPct: r2(m.change24hPct),
    volume24hUsd: usd(m.volume24hUsd), ...(m.type === "perp" ? { openInterestUsd: usd(m.oiUsd), fundingHourlyPct: fh, fundingAprPct: fundingAprPct(fh), maxLeverage: m.maxLeverage } : {}),
    ...(m.reduceOnly ? { reduceOnly: true } : {}), ...(m.multiplier !== 1 ? { sharesPerToken: sig(m.multiplier, 6) } : {}),
  };
}

const spotBase = (m: LighterMarket) => { const b = m.symbol.split("/")[0]; return (b.startsWith("rh") ? b.slice(2) : b).toUpperCase(); };

/** A friendly market name → one market of a venue: "btc", "$NVDA", "ETH-PERP", "eth/usdc", "NVDA spot", "pepe" (→ 1000PEPE),
 *  "kPEPE" (Hyperliquid's name). Active before inactive, perp before spot unless `type` says otherwise (pure, tested). */
export function resolveLighterMarket(ms: LighterMarket[], query: string, type: "perp" | "spot" | null = null): LighterMarket | null {
  let q = query.trim().replace(/^\$/, "").toUpperCase();
  if (/\sSPOT$/.test(q) && !type) type = "spot";
  q = q.replace(/\s+(SPOT|PERP|PERPS|PERPETUAL)$/, "").replace(/[-_ ]?PERPS?$/, "").trim();
  if (!q) return null;
  const parts = q.split(/[/\-_\s]+/).filter(Boolean);
  const base = parts[0], quote = parts[1] ?? null;
  const pool = ms.filter((m) => !type || m.type === type);
  const rank = (m: LighterMarket) => (m.active ? 0 : 2) + (m.type === "perp" ? 0 : 1);
  const pick = (f: (m: LighterMarket) => boolean) => pool.filter(f).sort((a, b) => rank(a) - rank(b) || b.volume24hUsd - a.volume24hUsd)[0] ?? null;
  const U = (m: LighterMarket) => m.symbol.toUpperCase();
  let hit = pick((m) => U(m) === q) ?? (quote ? pick((m) => U(m) === `${base}/${quote}`) : null);
  if (!hit && quote && /^(USD|USDC|USDG|USDT)$/.test(quote)) hit = pick((m) => m.type === "spot" && spotBase(m) === base) ?? pick((m) => m.type === "perp" && U(m) === base);
  if (!hit && !quote) {
    hit = pick((m) => U(m) === base) ?? (type === "spot" ? pick((m) => m.type === "spot" && spotBase(m) === base) : null);
    if (!hit) for (const alt of [`1000${base}`, base.replace(/^K(?=[A-Z0-9]{2,}$)/, "1000"), `1000000${base}`]) { hit = pick((m) => U(m) === alt); if (hit) break; }
  }
  return hit;
}

// ── order book ──
export interface BookSummary {
  bestBid: number | null; bestAsk: number | null; mid: number | null; spreadBps: number | null;
  depth: { bandPct: number; bidUsd: number | null; askUsd: number | null; complete: boolean }[];
  ordersRead: { bids: number; asks: number }; reachPct: { bids: number | null; asks: number | null };
}
const BANDS = [0.1, 1, 2];
/** orderBookOrders (single resting orders, best first) → top of book + USD depth within ±0.1 / 1 / 2 % of mid (pure, tested).
 *  A band past the sample's reach on a side that was cut at `limit` is a floor (`complete: false`). */
export function bookSummary(obo: any, limit = BOOK_LIMIT): BookSummary | null {
  const side = (xs: any[]) => (xs ?? []).map((o) => ({ p: num(o?.price), s: num(o?.remaining_base_amount) })).filter((o): o is { p: number; s: number } => o.p != null && o.p > 0 && o.s != null && o.s > 0);
  const asks = side(obo?.asks).sort((a, b) => a.p - b.p), bids = side(obo?.bids).sort((a, b) => b.p - a.p);
  if (!asks.length && !bids.length) return null;
  const bestBid = bids[0]?.p ?? null, bestAsk = asks[0]?.p ?? null;
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
  if (mid == null) return null;
  const rawAsks = (obo?.asks ?? []).length, rawBids = (obo?.bids ?? []).length;
  const reachAsk = asks.length ? (asks[asks.length - 1].p / mid - 1) * 100 : null, reachBid = bids.length ? (1 - bids[bids.length - 1].p / mid) * 100 : null;
  const depth = BANDS.map((b) => {
    const bidUsd = bids.filter((o) => o.p >= mid * (1 - b / 100)).reduce((s, o) => s + o.p * o.s, 0);
    const askUsd = asks.filter((o) => o.p <= mid * (1 + b / 100)).reduce((s, o) => s + o.p * o.s, 0);
    const bidOk = rawBids < limit || (reachBid != null && reachBid >= b), askOk = rawAsks < limit || (reachAsk != null && reachAsk >= b);
    return { bandPct: b, bidUsd: usd(bidUsd), askUsd: usd(askUsd), complete: bidOk && askOk };
  });
  return {
    bestBid: sig(bestBid, 6), bestAsk: sig(bestAsk, 6), mid: sig(mid, 6),
    spreadBps: bestBid != null && bestAsk != null ? r2(((bestAsk - bestBid) / mid) * 10_000) : null,
    depth, ordersRead: { bids: bids.length, asks: asks.length }, reachPct: { bids: r2(reachBid), asks: r2(reachAsk) },
  };
}

// ── prints ──
/** recentTrades → taker buy vs sell USD over the sample, the largest prints, liquidations (pure, tested). */
export function tradesSummary(resp: any, nowMs = Date.now()) {
  const ts = ((resp?.trades ?? []) as any[]).map((t) => ({
    usd: num(t?.usd_amount), price: num(t?.price), ts: num(t?.timestamp), type: String(t?.type ?? "trade"),
    side: t?.is_maker_ask === true ? ("buy" as const) : t?.is_maker_ask === false ? ("sell" as const) : null,
  })).filter((t): t is { usd: number; price: number | null; ts: number; type: string; side: "buy" | "sell" | null } => t.usd != null && t.ts != null);
  if (!ts.length) return null;
  const buyUsd = ts.filter((t) => t.side === "buy").reduce((s, t) => s + t.usd, 0), sellUsd = ts.filter((t) => t.side === "sell").reduce((s, t) => s + t.usd, 0);
  const newest = Math.max(...ts.map((t) => t.ts)), oldest = Math.min(...ts.map((t) => t.ts));
  return {
    prints: ts.length, windowSeconds: Math.round((newest - oldest) / 1000), lastPrintSecondsAgo: Math.max(0, Math.round((nowMs - newest) / 1000)),
    buyUsd: usd(buyUsd), sellUsd: usd(sellUsd), buySharePct: buyUsd + sellUsd > 0 ? r2((buyUsd / (buyUsd + sellUsd)) * 100) : null,
    liquidations: ts.filter((t) => t.type !== "trade").length,
    largest: [...ts].sort((a, b) => b.usd - a.usd).slice(0, 5).map((t) => ({ side: t.side, usd: usd(t.usd), price: sig(t.price, 6), secondsAgo: Math.max(0, Math.round((nowMs - t.ts) / 1000)), ...(t.type !== "trade" ? { kind: t.type } : {}) })),
  };
}

// ── funding history ──
/** fundings → settled hourly % (signed: + = longs paid), oldest first (pure, tested). */
export function fundingSeries(resp: any): { t: number; hourlyPct: number }[] {
  return ((resp?.fundings ?? []) as any[]).map((f) => {
    const r = num(f?.rate), t = num(f?.timestamp);
    return r == null || t == null ? null : { t, hourlyPct: f?.direction === "short" ? -Math.abs(r) : Math.abs(r) };
  }).filter((x): x is { t: number; hourlyPct: number } => !!x).sort((a, b) => a.t - b.t);
}
export function fundingStats(series: { t: number; hourlyPct: number }[]) {
  if (!series.length) return null;
  const v = series.map((x) => x.hourlyPct), avg = v.reduce((s, x) => s + x, 0) / v.length, last = series[series.length - 1];
  return {
    hours: series.length, lastSettledHourlyPct: sig(last.hourlyPct, 3), lastSettledAt: new Date(last.t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC",
    avgHourlyPct: sig(avg, 3), avgAprPct: fundingAprPct(avg), minHourlyPct: sig(Math.min(...v), 3), maxHourlyPct: sig(Math.max(...v), 3),
    hoursLongsPaid: v.filter((x) => x > 0).length, hoursShortsPaid: v.filter((x) => x < 0).length,
  };
}

// ── candles ──
export type LighterTf = "1h" | "1d";
const TF: Record<LighterTf, { count: number; ms: number }> = { "1h": { count: 48, ms: 3_600_000 }, "1d": { count: 60, ms: 86_400_000 } };
/** candles → closes oldest first; leading empty candles (before the market listed: flat, no volume) dropped (pure, tested). */
export function candleCloses(resp: any): { t: number; close: number; high: number | null; low: number | null; volUsd: number }[] {
  const cs = ((resp?.c ?? []) as any[]).map((c) => ({ t: num(c?.t), close: num(c?.c), high: num(c?.h), low: num(c?.l), volUsd: num(c?.V) ?? 0 }))
    .filter((c): c is { t: number; close: number; high: number | null; low: number | null; volUsd: number } => c.t != null && c.close != null && c.close > 0)
    .sort((a, b) => a.t - b.t);
  let i = 0;
  while (i < cs.length - 1 && cs[i].volUsd === 0) i++;
  return cs.slice(i);
}
const tfLabel = (t: number, tf: LighterTf) => { const iso = new Date(t).toISOString(); return tf === "1d" ? iso.slice(5, 10) : iso.slice(5, 16).replace("T", " "); };

// ── accounts ──
const POSITIONS_SHOWN = 20;
const ACCOUNT_KIND = (t: unknown) => (Number(t) === 0 ? "main" : Number(t) === 1 ? "sub-account" : "pool");
/** account?by=… → each account with its open positions (pure, tested). */
export function accountSummary(resp: any) {
  return ((resp?.accounts ?? []) as any[]).filter((a) => a && num(a.index) != null).slice(0, 8).map((a) => {
    const positions = ((a.positions ?? []) as any[]).map((p) => {
      const size = num(p?.position);
      if (!size) return null;
      const value = num(p.position_value), imf = num(p.initial_margin_fraction), liq = num(p.liquidation_price);
      const mark = value != null ? value / size : null, isolated = Number(p.margin_mode) === 1;
      return {
        market: String(p.symbol ?? p.market_id), side: Number(p.sign) === -1 ? "short" : "long", size: sig(size, 6), entry: sig(num(p.avg_entry_price), 6), mark: sig(mark, 6),
        notionalUsd: usd(value), unrealizedPnlUsd: usd(num(p.unrealized_pnl)),
        liquidationPrice: liq && liq > 0 ? sig(liq, 6) : null, liquidationDistancePct: liq && liq > 0 && mark ? r2(Math.abs(liq / mark - 1) * 100) : null,
        leverage: imf ? r2(100 / imf) : null, marginMode: isolated ? "isolated" : "cross",
        marginUsd: isolated ? usd(num(p.allocated_margin)) : value != null && imf ? usd((value * imf) / 100) : null,
        fundingNetUsd: usd(num(p.total_funding_paid_out)), openOrders: num(p.open_order_count) ?? 0,
      };
    }).filter((p): p is NonNullable<typeof p> => !!p).sort((x, y) => (y.notionalUsd ?? 0) - (x.notionalUsd ?? 0));
    const crossValue = num(a.cross_asset_value), crossMaint = num(a.cross_maintenance_margin_requirement), crossInit = num(a.cross_initial_margin_requirement);
    const spot = ((a.assets ?? []) as any[]).map((x) => ({ symbol: String(x?.symbol ?? ""), balance: (num(x?.balance) ?? 0) + (num(x?.locked_balance) ?? 0) })).filter((x) => x.symbol && x.balance > 0).map((x) => ({ symbol: x.symbol, balance: sig(x.balance, 6) }));
    const accountValue = num(a.total_asset_value), notional = positions.reduce((s, p) => s + (p.notionalUsd ?? 0), 0);
    return {
      index: num(a.index), kind: ACCOUNT_KIND(a.account_type),
      collateralUsd: usd(num(a.collateral)), accountValueUsd: usd(accountValue), availableUsd: usd(num(a.available_balance)),
      unrealizedPnlUsd: usd(positions.reduce((s, p) => s + (p.unrealizedPnlUsd ?? 0), 0)), notionalUsd: usd(notional),
      leverage: accountValue && accountValue > 0 ? r2(notional / accountValue) : null,
      crossInitialMarginUsd: usd(crossInit), crossMaintenanceMarginUsd: usd(crossMaint),
      /** cross maintenance margin / cross account value: liquidation starts at 100 % */
      maintenanceUsagePct: crossValue && crossValue > 0 && crossMaint != null ? r2((crossMaint / crossValue) * 100) : null,
      openOrders: num(a.total_order_count) ?? 0, openPositions: positions.length, positions: positions.slice(0, POSITIONS_SHOWN),
      ...(positions.length > POSITIONS_SHOWN ? { positionsNotShown: positions.length - POSITIONS_SHOWN } : {}), spot,
    };
  });
}

// ── tool plumbing ──
const bad = (error: string, note?: string): ExtToolResult => ({ data: { error, ...(note ? { note } : {}) }, addresses: [], citations: [] });
const ageOf = (...xs: (number | null | undefined)[]) => Math.max(0, ...xs.map((x) => x ?? 0));
const withAge = (ageS: number) => (ageS > 0 ? { dataAgeS: ageS } : {});
const venuesOf = (v: LighterVenue | "both") => (v === "both" ? VENUE_ORDER : [v]);
const venueCite = (v: LighterVenue): Citation => ({ label: LIGHTER_VENUES[v].name, href: LIGHTER_VENUES[v].app });

async function loadMarkets(venue: LighterVenue, ttlS: number): Promise<{ markets: LighterMarket[]; ageS: number; fundingOk: boolean }> {
  const [d, f] = await Promise.all([
    extJson("lighter", apiUrl(venue, "orderBookDetails"), { ttlS, timeoutMs: 12_000 }),
    extJson("lighter", apiUrl(venue, "funding-rates"), { ttlS: TTL_FUNDING, timeoutMs: 10_000 }).catch(() => null),
  ]);
  return { markets: normalizeMarkets(venue, d.data, f?.data), ageS: ageOf(d.ageS, f?.ageS), fundingOk: !!f };
}

const UNIT_NOTE = "Lighter and Lighter on Robinhood Chain are separate exchanges (separate books, accounts and collateral: USDC vs USDG); name the venue with every number. Funding is paid hourly; positive = longs pay shorts; 'now' is Lighter's live estimate for the running hour, the annualized figure just scales it. Open interest = one side (longs = shorts) x mark, as Hyperliquid counts it; Lighter's own exchange stats count both sides, so they read 2x. Volume = 24h quote volume in USD.";

async function marketsTool(args: Record<string, any>): Promise<ExtToolResult> {
  const venue = parseLighterVenue(args.venue);
  if (!venue) return bad("venue must be core, robinhood or both");
  const sort = SORTS.find((s) => s === args.sort) ?? "volume";
  const type = args.type === "perp" || args.type === "spot" ? args.type : null;
  const limit = Math.max(1, Math.min(25, Number(args.limit) || 15));
  const query = String(args.query ?? "").trim().slice(0, 24);
  const vs = venuesOf(venue);
  const got = await Promise.all(vs.map((v) => loadMarkets(v, TTL_BOARD).then((r) => ({ v, r, e: null as unknown }), (e) => ({ v, r: null, e }))));
  const ok = got.filter((g) => g.r);
  if (!ok.length) return { data: extFailure("Lighter", got[0]?.e), addresses: [], citations: [] };
  const all = ok.flatMap((g) => g.r!.markets);
  const rows = boardRows(all, { sort, query, type, limit });
  const out = rows.map(marketRow);
  const totals = ok.map((g) => {
    const act = g.r!.markets.filter((m) => m.active);
    return { venue: g.v, collateral: LIGHTER_VENUES[g.v].collateral, markets: act.length, perps: act.filter((m) => m.type === "perp").length, spot: act.filter((m) => m.type === "spot").length, volume24hUsd: usd(act.reduce((s, m) => s + m.volume24hUsd, 0)), openInterestUsd: usd(act.reduce((s, m) => s + (m.oiUsd ?? 0), 0)) };
  });
  const missing = got.filter((g) => !g.r).map((g) => LIGHTER_VENUES[g.v].name);
  const noFunding = ok.filter((g) => !g.r!.fundingOk).map((g) => LIGHTER_VENUES[g.v].name);
  const note = [
    UNIT_NOTE,
    sort === "change" || sort === "-change" ? (query ? null : `Movers need $${CHANGE_MIN_VOL_USD / 1000}k of 24h volume to be listed.`) : null,
    out.some((r) => "sharesPerToken" in r) ? "Stock-token spot prices are per token; sharesPerToken > 1 means one token holds that many shares (dividends), so it trades a little above the share price." : null,
    out.some((r) => "reduceOnly" in r) ? "reduceOnly markets accept no new positions right now." : null,
    missing.length ? `${missing.join(" and ")} did not answer just now; these rows cover the rest only; say so.` : null,
    noFunding.length ? `Funding for ${noFunding.join(" and ")} did not load; do not quote funding there.` : null,
    !out.length ? `No active market matches${query ? ` '${query}'` : ""} on ${vs.map((v) => LIGHTER_VENUES[v].name).join(" or ")}.` : null,
  ].filter(Boolean).join(" ");
  const title = `${venue === "both" ? "Lighter (both venues)" : LIGHTER_VENUES[venue].name} · ${sort === "volume" ? "24h volume" : sort.replace("-", "lowest ")}`;
  return {
    data: { source: "Lighter API", ...withAge(ageOf(...ok.map((g) => g.r!.ageS))), sort, ...(query ? { query } : {}), ...(type ? { type } : {}), venues: totals, rows: out, note },
    addresses: [],
    citations: ok.map((g) => venueCite(g.v)),
    viz: out.length ? [vTable(title, ["Venue", "Market", "Price", "24h", "Volume", "OI", "Funding APR", "Max lev"],
      out.map((r: any) => [r.venue === "core" ? "Lighter" : "Lighter RH", r.symbol, r.price, pctCell(r.change24hPct), usdShort(r.volume24hUsd), r.type === "perp" ? usdShort(r.openInterestUsd) : "spot", r.type === "perp" ? pctCell(r.fundingAprPct) : null, r.maxLeverage ? `${r.maxLeverage}x` : null]),
      ["l", "l", "r", "r", "r", "r", "r", "r"])] : [],
  };
}

async function marketTool(args: Record<string, any>): Promise<ExtToolResult> {
  const q = String(args.symbol ?? args.market ?? args.coin ?? "").trim().slice(0, 40);
  if (!q) return bad("symbol is required, e.g. BTC, NVDA or ETH/USDC");
  const venue = parseLighterVenue(args.venue);
  if (!venue) return bad("venue must be core or robinhood (or leave it out)");
  const type = args.type === "perp" || args.type === "spot" ? args.type : null;
  const tf: LighterTf = args.tf === "1d" ? "1d" : "1h";
  const vs = venuesOf(venue);
  const lists = await Promise.all(vs.map((v) => loadMarkets(v, TTL_DETAIL).then((r) => ({ v, r, e: null as unknown }), (e) => ({ v, r: null, e }))));
  const ok = lists.filter((l) => l.r);
  if (!ok.length) return { data: extFailure("Lighter", lists[0]?.e), addresses: [], citations: [] };
  let found: { v: LighterVenue; m: LighterMarket; ageS: number; fundingOk: boolean } | null = null;
  const others: { venue: LighterVenue; symbol: string }[] = [];
  for (const l of ok) {
    const m = resolveLighterMarket(l.r!.markets, q, type);
    if (!m) continue;
    if (!found) found = { v: l.v, m, ageS: l.r!.ageS, fundingOk: l.r!.fundingOk };
    else others.push({ venue: l.v, symbol: m.symbol });
  }
  if (!found) {
    const qq = q.toUpperCase().replace(/^\$/, "").split(/[/\-_\s]+/)[0];
    const near = ok.flatMap((l) => l.r!.markets).filter((m) => m.active && qq.length >= 2 && m.symbol.toUpperCase().includes(qq)).slice(0, 8).map((m) => ({ venue: m.venue, symbol: m.symbol, type: m.type }));
    const failed = lists.filter((l) => !l.r).map((l) => LIGHTER_VENUES[l.v].name);
    return { data: { found: false, query: q, ...(near.length ? { similar: near } : {}), note: `No Lighter market matches '${q}' on ${ok.map((l) => LIGHTER_VENUES[l.v].name).join(" or ")}.${failed.length ? ` ${failed.join(" and ")} did not answer, so it may list there.` : ""} Say so; do not guess a price.` }, addresses: [], citations: ok.map((l) => venueCite(l.v)) };
  }
  const { v, m } = found;
  const now = Date.now();
  const end = Math.floor(now / 60_000) * 60_000; // minute buckets keep the candle / funding URLs cacheable
  const T = TF[tf];
  const [book, trades, candles, fundings] = await Promise.all([
    extJson("lighter", apiUrl(v, "orderBookOrders", { market_id: m.marketId, limit: BOOK_LIMIT }), { ttlS: TTL_BOOK }).catch(() => null),
    extJson("lighter", apiUrl(v, "recentTrades", { market_id: m.marketId, limit: TRADES_LIMIT }), { ttlS: TTL_TRADES }).catch(() => null),
    extJson("lighter", apiUrl(v, "candles", { market_id: m.marketId, resolution: tf, start_timestamp: end - (T.count + 1) * T.ms, end_timestamp: end, count_back: T.count }), { ttlS: TTL_CANDLES }).catch(() => null),
    m.type === "perp" ? extJson("lighter", apiUrl(v, "fundings", { market_id: m.marketId, resolution: "1h", start_timestamp: Math.floor(end / 1000) - 25 * 3600, end_timestamp: Math.floor(end / 1000), count_back: 24 }), { ttlS: TTL_FUNDING }).catch(() => null) : Promise.resolve(null),
  ]);
  const bk = book ? bookSummary(book.data) : null;
  const tr = trades ? tradesSummary(trades.data, now) : null;
  const closes = candles ? candleCloses(candles.data).slice(-T.count) : [];
  const fs = fundings ? fundingStats(fundingSeries(fundings.data).slice(-24)) : null;
  const fh = fundingHourlyPct(m.funding8h);
  const first = closes[0]?.close ?? null, lastClose = closes[closes.length - 1]?.close ?? null;
  const highs = closes.map((c) => c.high ?? c.close), lows = closes.map((c) => c.low ?? c.close);
  const name = LIGHTER_VENUES[v].name;
  const failedParts = [!book && "order book", !trades && "recent prints", !candles && "candles", m.type === "perp" && !fundings && "funding history", m.type === "perp" && !found.fundingOk && "current funding"].filter(Boolean) as string[];
  const note = [
    UNIT_NOTE,
    others.length ? `It also lists on ${others.map((o) => `${LIGHTER_VENUES[o.venue].name} (${o.symbol})`).join(", ")}; these numbers are ${name} only.` : null,
    !m.active ? "This market is INACTIVE (delisted or paused): its numbers are stale; say so." : null,
    m.reduceOnly ? "This market is reduce-only right now: no new positions." : null,
    m.multiplier !== 1 ? `Price is per token; one token = ${sig(m.multiplier, 6)} shares (dividend multiplier).` : null,
    bk && bk.depth.some((d) => !d.complete) ? `Depth comes from the best ${BOOK_LIMIT} resting orders a side, which reach only ${bk.reachPct.bids}% (bids) / ${bk.reachPct.asks}% (asks) from mid: bands marked complete=false are floors ('at least').` : null,
    tr ? `The flow covers only the last ${tr.prints} prints (${tr.windowSeconds < 120 ? `${tr.windowSeconds} s` : `${Math.round(tr.windowSeconds / 60)} min`}), not the whole day.` : null,
    failedParts.length ? `Not loaded just now: ${failedParts.join(", ")}; do not quote those.` : null,
  ].filter(Boolean).join(" ");
  const data = {
    source: "Lighter API", ...withAge(ageOf(found.ageS, book?.ageS, trades?.ageS, candles?.ageS, fundings?.ageS)),
    venue: v, venueName: name, collateral: LIGHTER_VENUES[v].collateral, symbol: m.symbol, type: m.type, marketId: m.marketId, status: m.active ? "active" : "inactive",
    price: { last: sig(m.last, 6), ...(m.type === "perp" ? { mark: sig(m.mark, 6), index: sig(m.index, 6), markVsIndexPct: m.mark && m.index ? r2((m.mark / m.index - 1) * 100) : null } : {}) },
    change24hPct: r2(m.change24hPct), high24h: sig(m.high24h, 6), low24h: sig(m.low24h, 6), volume24hUsd: usd(m.volume24hUsd), trades24h: m.trades24h,
    ...(m.type === "perp" ? { openInterest: { base: sig(m.oiBase, 6), usd: usd(m.oiUsd) }, maxLeverage: m.maxLeverage, ...(m.isolatedOnly ? { isolatedMarginOnly: true } : {}) } : {}),
    ...(m.multiplier !== 1 ? { sharesPerToken: sig(m.multiplier, 6) } : {}),
    feesPct: { taker: m.takerFeePct, maker: m.makerFeePct, tier: "Standard account" },
    ...(bk ? { book: bk } : {}),
    ...(tr ? { prints: tr } : {}),
    ...(m.type === "perp" ? { funding: { nowHourlyPct: fh, nowAprPct: fundingAprPct(fh), whoPaysNow: fh == null ? null : fh > 0 ? "longs pay shorts" : fh < 0 ? "shorts pay longs" : "nobody", ...(fs ? { last24h: fs } : {}) } } : {}),
    ...(closes.length > 1 ? { chart: { tf, points: closes.length, changePct: first && lastClose ? r2((lastClose / first - 1) * 100) : null, high: sig(Math.max(...highs), 6), low: sig(Math.min(...lows), 6) } } : {}),
    note,
  };
  const viz: Viz[] = [];
  if (closes.length > 2) viz.push({ kind: "line", title: `${m.symbol} on ${name} · ${tf === "1d" ? "daily" : "hourly"} close`, x: closes.map((c) => tfLabel(c.t, tf)), series: [{ name: "Close", values: closes.map((c) => sig(c.close, 6)) }], unit: "price" });
  if (bk) viz.push(vTable(`${m.symbol} on ${name} · book depth (USD)`, ["Band", "Bids", "Asks", "Complete"], bk.depth.map((d) => { const at = (x: number | null) => (x == null ? null : `${d.complete ? "" : "≥ "}${usdShort(x)}`); return [`±${d.bandPct}%`, at(d.bidUsd), at(d.askUsd), d.complete ? "yes" : "floor (sample ends first)"]; }), ["l", "r", "r", "l"]));
  return { data, addresses: [], citations: [{ label: `${m.symbol} on ${name}`, href: lighterTradeUrl(v, m.symbol) }], viz };
}

async function accountTool(args: Record<string, any>): Promise<ExtToolResult> {
  const w = String(args.wallet ?? args.address ?? "").trim();
  const byIndex = /^\d{1,16}$/.test(w);
  if (!ADDR.test(w) && !byIndex) return bad("wallet must be a 0x address (or a Lighter account index with a venue)");
  const venue = parseLighterVenue(args.venue);
  if (!venue) return bad("venue must be core, robinhood or both");
  if (byIndex && venue === "both") return bad("an account index belongs to one exchange: say venue core or robinhood", "Ask which Lighter venue the index is on, or use the wallet's 0x address.");
  const vs = venuesOf(venue);
  const res = await Promise.all(vs.map(async (v) => {
    try {
      const r = await extJson("lighter", apiUrl(v, "account", byIndex ? { by: "index", value: w } : { by: "l1_address", value: w }), { ttlS: TTL_ACCOUNT });
      const accounts = accountSummary(r.data);
      return { v, accounts, ageS: r.ageS, missing: !accounts.length, err: null as unknown };
    } catch (e) {
      // Lighter answers 400 {code 21100 "account not found"} for a wallet that never opened an account.
      if (e instanceof ExtError && (e.notFound || e.status === 400)) return { v, accounts: [] as ReturnType<typeof accountSummary>, ageS: 0, missing: true, err: null };
      return { v, accounts: [] as ReturnType<typeof accountSummary>, ageS: 0, missing: false, err: e };
    }
  }));
  if (res.every((r) => r.err)) return { data: extFailure("Lighter", res[0].err), addresses: byIndex ? [] : [w], citations: [] };
  const venuesOut = res.map((r) => {
    const name = LIGHTER_VENUES[r.v].name;
    if (r.err) return { venue: r.v, venueName: name, error: `${name} did not answer just now` };
    if (r.missing) return { venue: r.v, venueName: name, found: false, note: `no Lighter account for this address on ${name}` };
    const totals = {
      accountValueUsd: usd(r.accounts.reduce((s, a) => s + (a.accountValueUsd ?? 0), 0)),
      unrealizedPnlUsd: usd(r.accounts.reduce((s, a) => s + (a.unrealizedPnlUsd ?? 0), 0)),
      openPositions: r.accounts.reduce((s, a) => s + a.openPositions, 0),
    };
    return { venue: r.v, venueName: name, collateralAsset: LIGHTER_VENUES[r.v].collateral, found: true, ...totals, accounts: r.accounts };
  });
  const found = res.filter((r) => !r.err && !r.missing);
  const rows = found.flatMap((r) => r.accounts.flatMap((a) => a.positions.map((p) => ({ r, a, p })))).sort((x, y) => (y.p.notionalUsd ?? 0) - (x.p.notionalUsd ?? 0)).slice(0, 25);
  const viz: Viz[] = rows.length ? [vTable(`${byIndex ? `Account ${w}` : short(w)} · Lighter positions`, ["Venue", "Acct", "Market", "Side", "Size", "Entry", "Mark", "uPnL", "Liq", "Lev"],
    rows.map(({ r, a, p }) => [r.v === "core" ? "Lighter" : "Lighter RH", a.kind === "main" ? "main" : `${a.kind === "pool" ? "pool" : "sub"} ${String(a.index).slice(-4)}`, p.market, p.side, p.size, p.entry, p.mark, usd(p.unrealizedPnlUsd), p.liquidationPrice, p.leverage ? `${p.leverage}x` : null]),
    ["l", "l", "l", "l", "r", "r", "r", "r", "r", "r"])] : [];
  const note = [
    "This is Lighter's public account data: anyone can read it, no keys involved. Each venue is a separate exchange with its own accounts.",
    "leverage per position = 100 / its initial margin %; account leverage = position notional / account value. maintenanceUsagePct = cross maintenance margin over cross account value: liquidation starts at 100%.",
    "liquidationPrice null = no liquidation price inside the account's margin (or none reported). fundingNetUsd: positive = funding received, negative = funding paid since the position opened.",
    found.length && !rows.length ? "The account holds no open perp position right now." : null,
    found.some((r) => r.accounts.some((a) => "positionsNotShown" in a)) ? `Only the ${POSITIONS_SHOWN} largest positions of an account are listed; its totals count all of them.` : null,
    res.some((r) => r.err) ? "One venue did not answer; say its data is unavailable right now." : null,
  ].filter(Boolean).join(" ");
  return {
    data: { source: "Lighter API", ...withAge(ageOf(...res.map((r) => r.ageS))), wallet: w, venues: venuesOut, note },
    addresses: byIndex ? [] : [w],
    citations: res.filter((r) => !r.err && !r.missing).slice(0, 2).map((r) => ({ label: `${byIndex ? `Account ${w}` : short(w)} on ${LIGHTER_VENUES[r.v].name}`, href: lighterAccountUrl(r.v, w) })),
    viz,
  };
}

// ── exports for the registry / schemas / runTool ──
export const LIGHTER_TOOL_NAMES = ["lighter_markets", "lighter_market", "lighter_account"] as const;
export const isLighterTool = (name: string): boolean => (LIGHTER_TOOL_NAMES as readonly string[]).includes(name);

export const LIGHTER_TOOL_META: Record<string, ToolMeta> = {
  lighter_markets: { group: "lighter", label: "Reading Lighter markets", market: true, timeoutMs: 20_000 },
  lighter_market: { group: "lighter", label: "Reading the Lighter market", timeoutMs: 20_000 },
  lighter_account: { group: "lighter", label: "Reading the Lighter account", timeoutMs: 20_000 },
};

const VENUE_PARAM = { type: "string", enum: ["both", "core", "robinhood"], description: "core = Lighter (USDC collateral: crypto, FX, index and stock perps), robinhood = Lighter on Robinhood Chain (USDG collateral: stock + crypto perps, stock-token spot); default both" };
export const LIGHTER_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "lighter_markets",
      description: "Lighter perp and spot markets (an order-book DEX that runs two separate exchanges: Lighter, and Lighter on Robinhood Chain for stocks): last price, 24h change, 24h volume, open interest, funding per hour and annualized (positive = longs pay), max leverage, the venue of every row and each venue's totals. Use for 'what is moving on Lighter', 'highest funding on Lighter', 'biggest Lighter markets by open interest', 'which stocks trade on Lighter Robinhood', 'is NVDA listed on Lighter'.",
      parameters: { type: "object", properties: {
        venue: VENUE_PARAM,
        sort: { type: "string", enum: SORTS, description: "default volume; a leading - sorts ascending (e.g. most negative funding, worst 24h change)" },
        type: { type: "string", enum: ["perp", "spot", "all"], description: "default all" },
        query: { type: "string", description: "symbol substring filter, e.g. NVDA, USD, PEPE" },
        limit: { type: "integer", description: "default 15, max 25" },
      } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lighter_market",
      description: "One Lighter market (BTC, ETH, NVDA, TSLA, ETH/USDC, NVDA/USDG …): last, mark and index price, 24h change, range and volume, open interest, max leverage, best bid / ask with the spread in bps and USD depth within 0.1 %, 1 % and 2 % of mid, taker buy vs sell flow and the largest of the last 100 prints, funding now and over the last 24 settled hours, and a price line (tf 1h = 48 hours, 1d = 60 days). Use for 'BTC on Lighter', 'Lighter NVDA spread and depth', 'is ETH funding high on Lighter', 'how liquid is X on Lighter Robinhood'.",
      parameters: { type: "object", properties: {
        symbol: { type: "string", description: "market as listed: BTC, NVDA, 1000PEPE; a spot pair as ETH/USDC or NVDA/USDG" },
        venue: { type: "string", enum: ["core", "robinhood"], description: "default: Lighter first, then Lighter on Robinhood Chain" },
        type: { type: "string", enum: ["perp", "spot"], description: "default perp when both exist" },
        tf: { type: "string", enum: ["1h", "1d"], description: "price line: 1h (48 hours, default) or 1d (60 days)" },
      }, required: ["symbol"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lighter_account",
      description: "A wallet's public Lighter account, read by its 0x owner address (no keys; anyone can read it): collateral, account value, available balance, margin use, every open position (market, side, size, entry, mark, unrealized PnL, liquidation price and its distance, leverage, cross or isolated margin, funding received or paid), open order count and spot balances, for the main account and its sub-accounts, on Lighter, Lighter on Robinhood Chain or both. Use for 'my Lighter positions', 'what is wallet W holding on Lighter', 'how close is this Lighter account to liquidation'.",
      parameters: { type: "object", properties: {
        wallet: { type: "string", description: "0x address that owns the Lighter account (an account index works with a venue)" },
        venue: VENUE_PARAM,
      }, required: ["wallet"] },
    },
  },
];

/** Runs one lighter_* tool. Only called for names in LIGHTER_TOOL_NAMES; never throws. */
export async function runLighterTool(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  try {
    switch (name) {
      case "lighter_markets": return await marketsTool(args ?? {});
      case "lighter_market": return await marketTool(args ?? {});
      case "lighter_account": return await accountTool(args ?? {});
      default: return bad(`unknown tool ${name}`);
    }
  } catch (e) {
    return { data: extFailure("Lighter", e), addresses: [], citations: [] };
  }
}
