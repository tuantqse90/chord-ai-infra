// CoinGlass for Chord Ask (owner 2026-09-26: key given — "test xem có cần coingecko ko, viết thêm harness"). It covers what
// neither CoinGecko nor the venues' free APIs (services/derivs) give: LIQUIDATIONS (every coin, 1h–24h, per exchange,
// history), spot ETF flows (BTC / ETH / SOL), options (max pain per expiry, OI by venue), exchange reserves (on-chain
// balances), open interest aggregated over ~20 venues with 1h / 4h / 24h change, OI-weighted funding, taker buy / sell,
// and the sentiment boards (fear & greed, Coinbase premium, bull-market-peak indicators). CoinGecko stays: this plan has
// no market cap / rank / supply / categories / trending (`coins-markets` answers "Upgrade plan").
//
// Plan measured 2026-09-26 (Hobbyist): 30 calls / min per key (API-KEY-MAX-LIMIT), history intervals ≥ 4 h, liquidation
// ranges ≥ 4 h per exchange; locked: coins-markets, liquidation orders / heatmap, RSI, Hyperliquid whales, news, calendar.
// Key: COINGLASS_API_KEY (unset = the tools say CoinGlass is not configured). Every call is cached in Redis
// (`cgl:v1:{path}?{qs}`, fresh TTL per tool, stale copy ≤ 6 h) behind a per-minute budget shared by the box
// (`cgl:rl:{minute}` ≤ COINGLASS_RPM, default 25) and a 60 s pause after a 429 (`cgl:backoff`).
import { getRedis } from "../utils/redis";
import { logger } from "../utils/logger";

const BASE = "https://open-api-v4.coinglass.com";
const STALE_S = 6 * 3600;
const rpm = () => { const v = Number(process.env.COINGLASS_RPM); return Number.isFinite(v) && v > 0 ? v : 25; };
export const coinglassEnabled = (): boolean => !!process.env.COINGLASS_API_KEY;

async function budgetOk(): Promise<boolean> {
  try {
    const r = getRedis();
    if (await r.get("cgl:backoff")) return false;
    const k = `cgl:rl:${Math.floor(Date.now() / 60_000)}`;
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, 90);
    return n <= rpm();
  } catch { return true; }
}

/** GET a CoinGlass v4 path → `data`, cached: fresh within `ttl` s, stale (≤ 6 h) when the budget or CoinGlass says no. */
export async function cgl<T = any>(path: string, params: Record<string, string | number | undefined>, ttl: number): Promise<{ data: T; ageS: number }> {
  if (!coinglassEnabled()) throw new Error("CoinGlass is not configured");
  const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).sort().join("&");
  const key = `cgl:v1:${path}?${qs}`;
  const now = Math.floor(Date.now() / 1000);
  let cached: { t: number; d: T } | null = null;
  try { const raw = await getRedis().get(key); if (raw) cached = JSON.parse(raw); } catch { /* fetch */ }
  if (cached && now - cached.t < ttl) return { data: cached.d, ageS: now - cached.t };
  if (!(await budgetOk())) {
    if (cached) return { data: cached.d, ageS: now - cached.t };
    throw new Error("CoinGlass is busy right now — try again in a minute");
  }
  try {
    const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, { headers: { "CG-API-KEY": process.env.COINGLASS_API_KEY!, Accept: "application/json", "User-Agent": "chord-ask/1.0" }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 429) { await getRedis().set("cgl:backoff", "1", "EX", 60).catch(() => {}); throw new Error("CoinGlass is busy right now — try again in a minute"); }
    if (!res.ok) throw new Error(`CoinGlass HTTP ${res.status}`);
    const j = (await res.json()) as { code?: string | number; msg?: string; data?: T };
    const code = String(j.code ?? "");
    // CoinGlass answers HTTP 200 with its own code: "0" ok, "401" = not in the plan, "403" = interval not in the plan.
    if (code !== "0") throw Object.assign(new Error(code === "401" || code === "403" ? "not available on the current CoinGlass plan" : `CoinGlass: ${String(j.msg ?? code).slice(0, 80)}`), { plan: code === "401" || code === "403" });
    await getRedis().set(key, JSON.stringify({ t: now, d: j.data }), "EX", STALE_S).catch(() => {});
    return { data: j.data as T, ageS: 0 };
  } catch (e) {
    if ((e as { plan?: boolean }).plan) throw e;
    logger.debug({ err: String(e), path }, "coinglass: call failed");
    if (cached) return { data: cached.d, ageS: now - cached.t };
    throw e;
  }
}

// ── shaping (pure, tested) ───────────────────────────────────────────────────────────────────────────
const n = (v: unknown): number | null => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const usd = (v: unknown): number | null => { const x = n(v); return x == null ? null : Math.round(x); };
const pct = (v: unknown, d = 2): number | null => { const x = n(v); return x == null ? null : Number(x.toFixed(d)); };
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const COIN = (s: unknown) => String(s ?? "").trim().replace(/^\$/, "").toUpperCase().slice(0, 20);

export type LiqWindow = "1h" | "4h" | "12h" | "24h";
export interface LiqCoinRow { symbol: string; [k: string]: unknown }

/** One coin's liquidations across windows: total, longs, shorts and which side got flushed. */
export function liqWindows(row: LiqCoinRow) {
  const w = (h: LiqWindow) => {
    const total = usd(row[`liquidation_usd_${h}`]) ?? 0, longs = usd(row[`long_liquidation_usd_${h}`]) ?? 0, shorts = usd(row[`short_liquidation_usd_${h}`]) ?? 0;
    return { totalUsd: total, longsUsd: longs, shortsUsd: shorts, longSharePct: total > 0 ? pct((longs / total) * 100, 1) : null };
  };
  return { h1: w("1h"), h4: w("4h"), h12: w("12h"), h24: w("24h") };
}

/** The most liquidated coins over a window, plus the whole market's total and long share. */
export function liqBoard(rows: LiqCoinRow[], window: LiqWindow, top = 12) {
  const val = (r: LiqCoinRow, k: string) => n(r[`${k}_${window}`]) ?? 0;
  const sorted = [...rows].sort((a, b) => val(b, "liquidation_usd") - val(a, "liquidation_usd"));
  const total = rows.reduce((a, r) => a + val(r, "liquidation_usd"), 0);
  const longs = rows.reduce((a, r) => a + val(r, "long_liquidation_usd"), 0);
  return {
    window, marketTotalUsd: Math.round(total), marketLongSharePct: total > 0 ? pct((longs / total) * 100, 1) : null,
    coins: sorted.slice(0, top).map((r) => { const t = val(r, "liquidation_usd"), l = val(r, "long_liquidation_usd"); return { coin: String(r.symbol), totalUsd: Math.round(t), longsUsd: Math.round(l), shortsUsd: Math.round(val(r, "short_liquidation_usd")), longSharePct: t > 0 ? pct((l / t) * 100, 1) : null }; }),
  };
}

export interface EtfDay { timestamp: number; flow_usd?: number; price_usd?: number; etf_flows?: { etf_ticker: string; flow_usd?: number }[] }
/** Daily net flows for the last `days`, totals, the current streak and the latest day's biggest funds. */
export function etfFlows(rows: EtfDay[], days = 10) {
  const sorted = [...rows].filter((r) => Number.isFinite(r.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  const last = sorted.slice(-Math.max(1, Math.min(60, days)));
  const flows = last.map((r) => ({ date: day(r.timestamp), netFlowUsd: usd(r.flow_usd) ?? 0, priceUsd: usd(r.price_usd) }));
  let streak = 0;
  const sign = Math.sign(flows.at(-1)?.netFlowUsd ?? 0);
  for (let i = flows.length - 1; i >= 0 && sign !== 0 && Math.sign(flows[i].netFlowUsd) === sign; i--) streak++;
  const latest = last.at(-1);
  const funds = (latest?.etf_flows ?? []).filter((f) => n(f.flow_usd) != null && f.flow_usd !== 0).map((f) => ({ ticker: f.etf_ticker, flowUsd: usd(f.flow_usd)! })).sort((a, b) => Math.abs(b.flowUsd) - Math.abs(a.flowUsd)).slice(0, 8);
  return {
    days: flows, totalUsd: flows.reduce((a, f) => a + f.netFlowUsd, 0), inflowDays: flows.filter((f) => f.netFlowUsd > 0).length, outflowDays: flows.filter((f) => f.netFlowUsd < 0).length,
    streak: sign === 0 ? null : { direction: sign > 0 ? "inflow" : "outflow", days: streak }, latestDate: flows.at(-1)?.date ?? null, latestByFund: funds,
  };
}

/** YYMMDD (Deribit expiry) → YYYY-MM-DD. */
const expiry = (s: string) => (/^\d{6}$/.test(s) ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : s);
export function optionsView(info: any[], maxPain: any[], upcoming = 6) {
  const all = info.find((r) => r.exchange_name === "All");
  const today = new Date().toISOString().slice(0, 10);
  return {
    totalOiUsd: usd(all?.open_interest_usd), oiChange24hPct: pct(all?.open_interest_change_24h), volume24hUsd: usd(all?.volume_usd_24h),
    venues: info.filter((r) => r.exchange_name !== "All").map((r) => ({ venue: r.exchange_name, oiUsd: usd(r.open_interest_usd), sharePct: pct(r.oi_market_share, 1) })).slice(0, 6),
    expiries: maxPain.map((r) => {
      const c = n(r.call_open_interest_notional) ?? 0, p = n(r.put_open_interest_notional) ?? 0;
      return { expiry: expiry(String(r.date)), maxPainPrice: n(r.max_pain_price), callOiUsd: Math.round(c), putOiUsd: Math.round(p), putCallRatio: c > 0 ? pct(p / c) : null };
    }).filter((e) => e.expiry >= today).sort((a, b) => a.expiry.localeCompare(b.expiry)).slice(0, upcoming),
  };
}

export function reservesView(rows: any[], top = 8) {
  const valid = rows.filter((r) => n(r.total_balance) != null);
  const sum = (k: string) => valid.reduce((a, r) => a + (n(r[k]) ?? 0), 0);
  const total = sum("total_balance");
  const ch = (k: string) => { const c = sum(k); return { change: Math.round(c), changePct: total - c > 0 ? pct((c / (total - c)) * 100) : null }; };
  return {
    exchanges: valid.length, totalBalance: Math.round(total), d1: ch("balance_change_1d"), d7: ch("balance_change_7d"), d30: ch("balance_change_30d"),
    top: [...valid].sort((a, b) => (n(b.total_balance) ?? 0) - (n(a.total_balance) ?? 0)).slice(0, top).map((r) => ({ exchange: r.exchange_name, balance: Math.round(n(r.total_balance)!), change7dPct: pct(r.balance_change_percent_7d), change30dPct: pct(r.balance_change_percent_30d) })),
  };
}

const fgLabel = (v: number) => (v <= 24 ? "extreme fear" : v <= 44 ? "fear" : v <= 55 ? "neutral" : v <= 75 ? "greed" : "extreme greed");
export function pulseView(fg: { data_list?: number[]; time_list?: number[] } | null, premium: any[] | null, peak: any[] | null) {
  const d = fg?.data_list ?? [], t = fg?.time_list ?? [];
  const at = (back: number) => (d.length > back ? { value: d[d.length - 1 - back], label: fgLabel(d[d.length - 1 - back]), date: t.length > back ? day(t[t.length - 1 - back]) : null } : null);
  const prem = (premium ?? []).slice(-3).map((r) => ({ date: day((n(r.time) ?? 0) * (Number(r.time) > 1e11 ? 1 : 1000)), premiumUsd: pct(r.premium), premiumPct: pct(r.premium_rate, 4) }));
  const ind = (peak ?? []).map((r) => {
    const cur = n(r.current_value), tgt = n(r.target_value);
    return { name: String(r.indicator_name), current: cur, target: tgt, hit: !!r.hit_status, progressPct: cur != null && tgt ? pct((cur / tgt) * 100, 0) : null };
  });
  return {
    fearGreed: d.length ? { now: at(0), yesterday: at(1), weekAgo: at(7), monthAgo: at(30) } : null,
    coinbasePremium: prem,
    bullPeakIndicators: ind.length ? { hit: ind.filter((x) => x.hit).length, total: ind.length, closest: ind.filter((x) => !x.hit && x.progressPct != null).sort((a, b) => (b.progressPct ?? 0) - (a.progressPct ?? 0)).slice(0, 5) } : null,
  };
}

export function positioningView(oiEx: any[], fundHist: any[], taker: any, lsGlobal: any[] | null, lsTop: any[] | null) {
  const all = oiEx.find((r) => r.exchange === "All");
  const total = n(all?.open_interest_usd) ?? 0;
  const lastLs = (rows: any[] | null, k: string) => { const r = rows?.at(-1); return r ? pct(r[`${k}_long_percent`], 1) : null; };
  return {
    openInterestUsd: Math.round(total),
    oiChangePct: { h1: pct(all?.open_interest_change_percent_1h), h4: pct(all?.open_interest_change_percent_4h), h24: pct(all?.open_interest_change_percent_24h) },
    venues: oiEx.filter((r) => r.exchange !== "All" && n(r.open_interest_usd)).sort((a, b) => (n(b.open_interest_usd) ?? 0) - (n(a.open_interest_usd) ?? 0)).slice(0, 6).map((r) => ({ venue: r.exchange, oiUsd: usd(r.open_interest_usd), sharePct: total > 0 ? pct((n(r.open_interest_usd)! / total) * 100, 1) : null, change24hPct: pct(r.open_interest_change_percent_24h) })),
    // OI-weighted funding per 8 h, in %: CoinGlass gives the rate in % already (0.0032 = 0.0032 %).
    fundingOiWeighted: fundHist.slice(-6).map((r) => ({ time: new Date(Number(r.time)).toISOString().slice(0, 16).replace("T", " "), ratePct: pct(r.close, 4) })),
    takerBuySell24h: taker ? { buyPct: pct(taker.buy_ratio, 1), sellPct: pct(taker.sell_ratio, 1), buyUsd: usd(taker.buy_vol_usd), sellUsd: usd(taker.sell_vol_usd) } : null,
    binanceLongAccountsPct: lastLs(lsGlobal, "global_account"), binanceTopTradersLongPct: lastLs(lsTop, "top_account"),
  };
}
