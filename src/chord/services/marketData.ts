// marketData.ts — prices and levels for assets that are not on our own chains (owner 2026-09-25, after Minara's
// gold / FX / meme / BTC answers: Ask said "no gold feed" and read BTC levels off cirBTC on Arc).
//
// Sources, all live-checked 2026-09-25:
//   - Hyperliquid main dex: crypto perps (BTC, ETH, DOGE, kPEPE, kBONK …) — metaAndAssetCtxs + candleSnapshot.
//   - Hyperliquid HIP-3 dex "xyz" (trade.xyz, the only HIP-3 dex with volume): GOLD, SILVER, CL (WTI), COPPER, NATGAS,
//     PLATINUM, EUR (EUR/USD), JPY (USD/JPY), XYZ100 (Nasdaq-100) and US stocks, 24/7 — coin ids are "xyz:GOLD".
//     The other HIP-3 dexes (flx, km, cash …) show 0 volume and stale marks: never read them.
//   - Dukascopy FX lake (services/fxLake, BID, ≤ 1 day behind): FX majors xyz does not list, and the DXY basket.
//   - Nasdaq public API (api.nasdaq.com, browser UA): the real stock quote and the earnings calendar.
// Everything here is read-only public data; nothing is invented when a source is down — the field is null.
import { getRedis } from "../utils/redis";
import { logger } from "../utils/logger";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const NASDAQ = "https://api.nasdaq.com/api";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
export type AssetClass = "crypto" | "commodity" | "fx" | "index" | "stock";
export interface Asset { id: string; label: string; short: string; cls: AssetClass; hlCoin: string | null; fxSym: string | null; stock: string | null }
export interface CtxRow { coin: string; markPx: number; prevDayPx: number; volume24hUsd: number; openInterestUsd: number; fundingHourlyPct: number }

// One retry on 5xx / 429 / network: HL answers bursts with short runs of 502 (2026-09-26, 08:30 UTC — eleven in one
// minute while the api booted, and market_levels BTC/ETH came back empty). The thrown text carries no status code:
// it reaches the model, which quoted "Hyperliquid returned a 502" to the user.
const HL_DOWN = "Hyperliquid market data is not answering right now";
async function hlInfo<T>(body: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const r = await fetch(HL_INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      if (r.ok) return (await r.json()) as T;
      status = r.status;
      if (status < 500 && status !== 429) { logger.warn({ status, type: body.type }, "hyperliquid info refused"); throw new Error(HL_DOWN); }
    } catch (e) {
      if (String(e).includes(HL_DOWN)) throw e;
    }
    if (attempt >= 1) { logger.warn({ status, type: body.type }, "hyperliquid info failed after retry"); throw new Error(HL_DOWN); }
    await new Promise((res) => setTimeout(res, 700));
  }
}
/** Past its TTL a cached row still beats nothing when HL is down — up to this age. */
const STALE_OK_MS = 30 * 60_000;

// ask2049: Chord's Dukascopy FX lake (services/fxLake — a worker that downloads .bi5 files and keeps gzip CSVs under
// /app/data/fx) is not part of this app, so the lake answers no bars. DXY and the FX pairs trade.xyz does not list
// (GBP/USD, AUD/USD, USD/CAD, USD/CHF …) come back with price null and drop out of macro_snapshot / answer "the price
// source did not answer" in market_levels; EUR/USD and USD/JPY still read the trade.xyz perps.
const fxLake = async () => ({
  loadFx: async (_sym: string, _intervalMs: number, _from: number, _to: number): Promise<Candle[]> => [],
  FX_SYMBOLS: {} as Record<string, { lo: number; hi: number }>,
});

// ── market contexts (main dex + xyz), 10 s cache ─────────────────────────────────────────────────
const ctxCache = new Map<string, { at: number; rows: CtxRow[] }>();
export async function hlContexts(dex: "" | "xyz"): Promise<CtxRow[]> {
  const hit = ctxCache.get(dex);
  if (hit && Date.now() - hit.at < 10_000) return hit.rows;
  const res = await hlInfo<[{ universe: { name: string; isDelisted?: boolean }[] }, { markPx: string; prevDayPx: string; dayNtlVlm: string; openInterest: string; funding: string }[]]>(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" })
    .catch((e) => { if (hit && Date.now() - hit.at < STALE_OK_MS) return null; throw e; });
  if (!res) return hit!.rows;
  const [meta, ctxs] = res;
  const rows = meta.universe.map((u, i) => {
    const c = ctxs[i];
    const mark = Number(c?.markPx ?? 0);
    return { coin: u.name, markPx: mark, prevDayPx: Number(c?.prevDayPx ?? 0), volume24hUsd: Number(c?.dayNtlVlm ?? 0), openInterestUsd: Number(c?.openInterest ?? 0) * mark, fundingHourlyPct: Number(c?.funding ?? 0) * 100, delisted: !!u.isDelisted };
  }).filter((r) => !r.delisted && r.markPx > 0).map(({ delisted: _d, ...r }) => r);
  ctxCache.set(dex, { at: Date.now(), rows });
  return rows;
}

// ── candles, cached per (coin, interval) ─────────────────────────────────────────────────────────
const IV_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const candleCache = new Map<string, { at: number; rows: Candle[] }>();
export async function hlCandles(coin: string, interval: "1h" | "4h" | "1d", bars: number): Promise<Candle[]> {
  const key = `${coin}|${interval}|${bars}`;
  const ttl = interval === "1d" ? 600_000 : 120_000;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.rows;
  const end = Date.now();
  const raw = await hlInfo<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({ type: "candleSnapshot", req: { coin, interval, startTime: end - bars * IV_MS[interval], endTime: end } })
    .catch((e) => { if (hit && Date.now() - hit.at < STALE_OK_MS) return null; throw e; });
  if (!raw) return hit!.rows;
  const rows = (Array.isArray(raw) ? raw : []).map((k) => ({ t: k.t, o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), v: Number(k.v) })).filter((k) => k.c > 0);
  if (candleCache.size > 400) candleCache.clear();
  candleCache.set(key, { at: Date.now(), rows });
  return rows;
}

// ── asset resolution ─────────────────────────────────────────────────────────────────────────────
/** The chip / ticker name of an xyz market. */
const XYZ_SHORT: Record<string, string> = { GOLD: "Gold", SILVER: "Silver", CL: "WTI", COPPER: "Copper", NATGAS: "NatGas", PLATINUM: "Platinum", PALLADIUM: "Palladium", URANIUM: "Uranium", EUR: "EUR/USD", JPY: "USD/JPY", XYZ100: "NDX" };
const XYZ_ALIAS: Record<string, { coin: string; label: string; cls: AssetClass }> = {
  GOLD: { coin: "GOLD", label: "Gold (XAU/USD)", cls: "commodity" }, XAU: { coin: "GOLD", label: "Gold (XAU/USD)", cls: "commodity" }, XAUUSD: { coin: "GOLD", label: "Gold (XAU/USD)", cls: "commodity" }, VANG: { coin: "GOLD", label: "Gold (XAU/USD)", cls: "commodity" },
  SILVER: { coin: "SILVER", label: "Silver (XAG/USD)", cls: "commodity" }, XAG: { coin: "SILVER", label: "Silver (XAG/USD)", cls: "commodity" }, XAGUSD: { coin: "SILVER", label: "Silver (XAG/USD)", cls: "commodity" },
  OIL: { coin: "CL", label: "WTI crude oil", cls: "commodity" }, WTI: { coin: "CL", label: "WTI crude oil", cls: "commodity" }, CL: { coin: "CL", label: "WTI crude oil", cls: "commodity" }, CRUDE: { coin: "CL", label: "WTI crude oil", cls: "commodity" },
  COPPER: { coin: "COPPER", label: "Copper", cls: "commodity" }, NATGAS: { coin: "NATGAS", label: "Natural gas", cls: "commodity" }, GAS: { coin: "NATGAS", label: "Natural gas", cls: "commodity" },
  PLATINUM: { coin: "PLATINUM", label: "Platinum", cls: "commodity" }, PALLADIUM: { coin: "PALLADIUM", label: "Palladium", cls: "commodity" }, URANIUM: { coin: "URANIUM", label: "Uranium", cls: "commodity" },
  EUR: { coin: "EUR", label: "EUR/USD", cls: "fx" }, EURUSD: { coin: "EUR", label: "EUR/USD", cls: "fx" },
  JPY: { coin: "JPY", label: "USD/JPY", cls: "fx" }, USDJPY: { coin: "JPY", label: "USD/JPY", cls: "fx" },
  NASDAQ: { coin: "XYZ100", label: "Nasdaq-100 (XYZ100)", cls: "index" }, NASDAQ100: { coin: "XYZ100", label: "Nasdaq-100 (XYZ100)", cls: "index" }, NDX: { coin: "XYZ100", label: "Nasdaq-100 (XYZ100)", cls: "index" }, NQ: { coin: "XYZ100", label: "Nasdaq-100 (XYZ100)", cls: "index" }, XYZ100: { coin: "XYZ100", label: "Nasdaq-100 (XYZ100)", cls: "index" },
};
const FX_ONLY: Record<string, string> = { GBPUSD: "GBP/USD", GBP: "GBP/USD", AUDUSD: "AUD/USD", AUD: "AUD/USD", NZDUSD: "NZD/USD", USDCAD: "USD/CAD", CAD: "USD/CAD", USDCHF: "USD/CHF", CHF: "USD/CHF", EURJPY: "EUR/JPY", GBPJPY: "GBP/JPY", EURGBP: "EUR/GBP" };
const FX_SYM: Record<string, string> = { GBP: "GBPUSD", AUD: "AUDUSD", CAD: "USDCAD", CHF: "USDCHF" };

/** "gold" / "XAU/USD" / "vàng" / "PEPE" / "NVDA" / "EUR/USD" / "DXY" → where to read it. null = not covered here. */
export async function resolveAsset(q: string): Promise<Asset | null> {
  const k = q.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toUpperCase().replace(/^\$/, "").replace(/[^A-Z0-9]/g, "");
  if (!k) return null;
  if (k === "DXY" || k === "USDX" || k === "DOLLARINDEX") return { id: "DXY", label: "US Dollar Index (DXY)", short: "DXY", cls: "fx", hlCoin: null, fxSym: null, stock: null };
  const alias = XYZ_ALIAS[k];
  if (alias) return { id: alias.coin, label: alias.label, short: XYZ_SHORT[alias.coin] ?? alias.coin, cls: alias.cls, hlCoin: `xyz:${alias.coin}`, fxSym: alias.cls === "fx" ? (alias.coin === "EUR" ? "EURUSD" : "USDJPY") : null, stock: null };
  if (FX_ONLY[k]) return { id: FX_SYM[k] ?? k, label: FX_ONLY[k], short: FX_ONLY[k], cls: "fx", hlCoin: null, fxSym: FX_SYM[k] ?? k, stock: null };
  const [main, xyz] = await Promise.all([hlContexts("").catch(() => [] as CtxRow[]), hlContexts("xyz").catch(() => [] as CtxRow[])]);
  const hit = main.find((r) => r.coin.toUpperCase() === k) ?? main.find((r) => r.coin.toUpperCase() === `K${k}`);
  // A ticker that is both a crypto perp and a stock (rare) resolves to crypto; stocks come from xyz.
  if (hit) return { id: hit.coin, label: hit.coin.replace(/^k(?=[A-Z])/, "1000 × "), short: hit.coin.replace(/^k(?=[A-Z])/, ""), cls: "crypto", hlCoin: hit.coin, fxSym: null, stock: null };
  const s = xyz.find((r) => r.coin.toUpperCase() === `XYZ:${k}`);
  if (s) return { id: k, label: k, short: k, cls: "stock", hlCoin: s.coin, fxSym: null, stock: k };
  return null;
}

// ── indicators (pure, tested) ────────────────────────────────────────────────────────────────────
export function sma(x: readonly number[], n: number): number | null {
  if (x.length < n) return null;
  let s = 0;
  for (let i = x.length - n; i < x.length; i++) s += x[i];
  return s / n;
}
export function rsi14(closes: readonly number[]): number | null {
  const n = 14;
  if (closes.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; gain = (gain * (n - 1) + Math.max(0, d)) / n; loss = (loss * (n - 1) + Math.max(0, -d)) / n; }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
export function atr(c: readonly Candle[], n = 14): number | null {
  if (c.length <= n) return null;
  const tr: number[] = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  return sma(tr, n);
}
/** Swing highs / lows (a bar higher / lower than `k` bars each side), grouped into levels within `tol` of each other.
 *  Returns levels sorted by price with how many swings touched them and when the last touch was. */
export function swingLevels(c: readonly Candle[], k: number, tol: number): { price: number; touches: number; lastT: number; kind: "high" | "low" | "both" }[] {
  const pts: { p: number; t: number; kind: "high" | "low" }[] = [];
  for (let i = k; i < c.length - k; i++) {
    let hi = true, lo = true;
    for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (c[j].h >= c[i].h) hi = false; if (c[j].l <= c[i].l) lo = false; }
    if (hi) pts.push({ p: c[i].h, t: c[i].t, kind: "high" });
    if (lo) pts.push({ p: c[i].l, t: c[i].t, kind: "low" });
  }
  pts.sort((a, b) => a.p - b.p);
  const out: { price: number; touches: number; lastT: number; kind: "high" | "low" | "both"; sum: number }[] = [];
  for (const x of pts) {
    const last = out[out.length - 1];
    if (last && x.p - last.price <= tol) {
      last.sum += x.p; last.touches++; last.price = last.sum / last.touches; last.lastT = Math.max(last.lastT, x.t);
      if (last.kind !== x.kind) last.kind = "both";
    } else out.push({ price: x.p, touches: 1, lastT: x.t, kind: x.kind, sum: x.p });
  }
  return out.map(({ sum: _s, ...l }) => l);
}
const pctChange = (a: number | null | undefined, b: number | null | undefined) => (a && b ? ((a - b) / b) * 100 : null);
/** Close `days` ago from daily candles (the bar that opened `days` days before the last one). */
function closeAgo(d: readonly Candle[], days: number): number | null {
  if (d.length < 2) return null;
  const target = d[d.length - 1].t - days * 86_400_000;
  for (let i = d.length - 1; i >= 0; i--) if (d[i].t <= target) return d[i].c;
  return null;
}
const sig = (n: number | null | undefined, digits = 6) => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(digits)));
const r2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

// ── DXY from the Dukascopy lake ──────────────────────────────────────────────────────────────────
// ICE formula: 50.14348112 × EURUSD^-0.576 × USDJPY^0.136 × GBPUSD^-0.119 × USDCAD^0.091 × USDSEK^0.042 × USDCHF^0.036
const DXY_W: [string, number][] = [["EURUSD", -0.576], ["USDJPY", 0.136], ["GBPUSD", -0.119], ["USDCAD", 0.091], ["USDSEK", 0.042], ["USDCHF", 0.036]];
export function dxyOf(px: Record<string, number>): number | null {
  let v = 50.14348112;
  for (const [s, w] of DXY_W) { const p = px[s]; if (!(p > 0)) return null; v *= p ** w; }
  return v;
}
/** Daily DXY closes (UTC days where all six pairs have a close), oldest first. */
export async function dxyDaily(days: number): Promise<{ t: number; c: number }[]> {
  const { loadFx, FX_SYMBOLS } = await fxLake(); // ask2049: no FX lake (see fxLake above)
  const to = Date.now(), from = to - (days + 5) * 86_400_000;
  const series = await Promise.all(DXY_W.map(([s]) => loadFx(s, 86_400_000, from, to).catch(() => [])));
  const byDay = new Map<number, Record<string, number>>();
  series.forEach((bars, i) => { const g = FX_SYMBOLS[DXY_W[i][0]]; for (const b of bars) { if (!g || b.c < g.lo || b.c > g.hi) continue; const d = Math.floor(b.t / 86_400_000) * 86_400_000; const row = byDay.get(d) ?? {}; row[DXY_W[i][0]] = b.c; byDay.set(d, row); } });
  const out = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, px]) => ({ t, c: dxyOf(px) })).filter((x): x is { t: number; c: number } => x.c != null);
  // The last day with all six pairs must be recent. While a basket pair is still backfilling (USDSEK, added 2026-09-25)
  // the join ends months ago — shipping that as "DXY now" was a live bug on 2026-09-25 (97.72 from 2025-10-03).
  return out.length && out[out.length - 1].t >= Date.now() - FX_MAX_AGE_MS ? out : [];
}
/** A lake price older than this is not "now" (weekend + a missed day of files). */
export const FX_MAX_AGE_MS = 5 * 86_400_000;

// ── Nasdaq (real stock quote + earnings) ─────────────────────────────────────────────────────────
async function nasdaq<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${NASDAQ}${path}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return ((await r.json()) as { data: T | null }).data ?? null;
  } catch { return null; }
}
const money = (s: string | null | undefined) => { const n = Number(String(s ?? "").replace(/[$,%\s]/g, "")); return Number.isFinite(n) && String(s ?? "").trim() !== "" && !/N\/A/i.test(String(s)) ? n : null; };
export interface StockQuote { symbol: string; name: string | null; last: number | null; change: number | null; changePct: number | null; session: string | null; asOf: string | null }
const quoteCache = new Map<string, { at: number; v: StockQuote | null }>();
export async function stockQuote(sym: string): Promise<StockQuote | null> {
  const s = sym.toUpperCase().replace(/[^A-Z.]/g, "");
  const hit = quoteCache.get(s);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const d = await nasdaq<{ symbol: string; companyName: string; marketStatus?: string; primaryData?: { lastSalePrice: string; netChange: string; percentageChange: string; lastTradeTimestamp: string } }>(`/quote/${encodeURIComponent(s)}/info?assetclass=stocks`);
  const v = d?.primaryData ? { symbol: d.symbol, name: d.companyName?.replace(/\s+Common Stock$/i, "") ?? null, last: money(d.primaryData.lastSalePrice), change: money(d.primaryData.netChange), changePct: money(d.primaryData.percentageChange), session: d.marketStatus ?? null, asOf: d.primaryData.lastTradeTimestamp ?? null } : null;
  quoteCache.set(s, { at: Date.now(), v });
  return v;
}
export interface EarningsRow { date: string; time: string; symbol: string; name: string; marketCapUsd: number | null; epsForecast: number | null; lastYearEps: number | null; estimates: number | null; fiscalQuarter: string }
async function earningsDay(date: string): Promise<EarningsRow[]> {
  const key = `mkt:earnings:${date}`;
  try { const c = await getRedis().get(key); if (c) return JSON.parse(c); } catch { /* cache is optional */ }
  const d = await nasdaq<{ rows: { time: string; symbol: string; name: string; marketCap: string; epsForecast: string; lastYearEPS: string; noOfEsts: string; fiscalQuarterEnding: string }[] | null }>(`/calendar/earnings?date=${date}`);
  if (!d) return [];
  const rows = (d.rows ?? []).map((r) => ({ date, time: r.time === "time-pre-market" ? "before open" : r.time === "time-after-hours" ? "after close" : "not given", symbol: r.symbol, name: r.name, marketCapUsd: money(r.marketCap), epsForecast: money(r.epsForecast), lastYearEps: money(r.lastYearEPS), estimates: money(r.noOfEsts), fiscalQuarter: r.fiscalQuarterEnding }));
  try { await getRedis().set(key, JSON.stringify(rows), "EX", 6 * 3600); } catch { /* */ }
  return rows;
}
/** Earnings over the next `days` weekdays (today included). `symbols` filters; otherwise the largest by market cap. */
export async function earningsCalendar(opts: { days: number; symbols?: string[]; minCapUsd?: number; limit?: number }): Promise<EarningsRow[]> {
  const out: EarningsRow[] = [];
  const dates: string[] = [];
  for (let i = 0; dates.length < opts.days && i < opts.days * 2 + 4; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    dates.push(d.toISOString().slice(0, 10));
  }
  for (const d of dates) out.push(...(await earningsDay(d)));
  const want = opts.symbols?.length ? new Set(opts.symbols.map((s) => s.toUpperCase())) : null;
  const rows = want ? out.filter((r) => want.has(r.symbol.toUpperCase())) : out.filter((r) => (r.marketCapUsd ?? 0) >= (opts.minCapUsd ?? 10e9)).sort((a, b) => (a.date === b.date ? (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0) : a.date.localeCompare(b.date)));
  return rows.slice(0, opts.limit ?? 30);
}

// ── the analysis ─────────────────────────────────────────────────────────────────────────────────
export interface Levels {
  asset: Asset; source: string; price: number | null; asOf: string;
  change: { h24: number | null; d7: number | null; d30: number | null; d90: number | null };
  ma: { ma20: number | null; ma50: number | null; ma200: number | null }; rsi14: number | null; atr14Pct: number | null;
  range: { high52w: number | null; low52w: number | null; high30d: number | null; low30d: number | null };
  trend: string; support: { price: number; touches: number; lastSeen: string; frame: string }[]; resistance: { price: number; touches: number; lastSeen: string; frame: string }[];
  perp: { volume24hUsd: number; openInterestUsd: number; fundingAnnualPct: number } | null; stock: StockQuote | null;
  daily: { t: number; c: number }[];
}
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
export function trendOf(price: number, ma50: number | null, ma200: number | null, d30: number | null): string {
  if (ma50 == null) return d30 == null ? "not enough history" : d30 > 5 ? "rising over 30 days" : d30 < -5 ? "falling over 30 days" : "flat over 30 days";
  if (ma200 == null) return price > ma50 ? "above its 50-day average" : "below its 50-day average";
  if (price > ma50 && ma50 > ma200) return "uptrend (price > MA50 > MA200)";
  if (price < ma50 && ma50 < ma200) return "downtrend (price < MA50 < MA200)";
  if (price > ma200 && price < ma50) return "pullback inside a longer uptrend (below MA50, above MA200)";
  if (price < ma200 && price > ma50) return "bounce inside a longer downtrend (above MA50, below MA200)";
  return "mixed / range";
}
/** Pick up to three levels each side of the price from 4h swings (last 30 days) and daily swings (last year). */
export function pickLevels(price: number, h4: readonly Candle[], d1: readonly Candle[], atrD: number | null) {
  const tol4 = (atrD ?? price * 0.02) * 0.3, tolD = (atrD ?? price * 0.02) * 0.6;
  const lv = [
    ...swingLevels(h4.slice(-180), 3, tol4).map((l) => ({ ...l, frame: "4h" })),
    ...swingLevels(d1.slice(-365), 3, tolD).map((l) => ({ ...l, frame: "1d" })),
  ];
  const fmt = (l: (typeof lv)[number]) => ({ price: sig(l.price)!, touches: l.touches, lastSeen: day(l.lastT), frame: l.frame });
  const near = (a: (typeof lv)[number], b: (typeof lv)[number]) => Math.abs(a.price - b.price) <= tolD;
  const dedupe = (xs: (typeof lv)[number][]) => xs.reduce<(typeof lv)[number][]>((acc, x) => (acc.some((y) => near(x, y)) ? acc : [...acc, x]), []);
  const support = dedupe(lv.filter((l) => l.price < price).sort((a, b) => b.price - a.price)).slice(0, 3).map(fmt);
  const resistance = dedupe(lv.filter((l) => l.price > price).sort((a, b) => a.price - b.price)).slice(0, 3).map(fmt);
  return { support, resistance };
}

export async function marketLevels(asset: Asset): Promise<Levels> {
  let d1: Candle[] = [], h4: Candle[] = [], price: number | null = null, source = "", perp: Levels["perp"] = null, prevDay: number | null = null;
  if (asset.id === "DXY") {
    const s = await dxyDaily(400);
    d1 = s.map((x) => ({ t: x.t, o: x.c, h: x.c, l: x.c, c: x.c, v: 0 }));
    price = d1.length ? d1[d1.length - 1].c : null;
    source = "computed from Dukascopy daily closes of the six ICE basket pairs (last complete UTC day)";
  } else if (asset.hlCoin) {
    const dex = asset.hlCoin.startsWith("xyz:") ? "xyz" : "";
    const [ctx, d, h] = await Promise.all([hlContexts(dex), hlCandles(asset.hlCoin, "1d", 400), hlCandles(asset.hlCoin, "4h", 200)]);
    const c = ctx.find((r) => r.coin === asset.hlCoin);
    d1 = d; h4 = h;
    price = c?.markPx ?? (d.length ? d[d.length - 1].c : null);
    prevDay = c?.prevDayPx || null;
    if (c) perp = { volume24hUsd: Math.round(c.volume24hUsd), openInterestUsd: Math.round(c.openInterestUsd), fundingAnnualPct: r2(c.fundingHourlyPct * 24 * 365)! };
    source = dex ? "Hyperliquid xyz perp (trade.xyz, trades 24/7 — tracks the underlying)" : "Hyperliquid perp";
  } else if (asset.fxSym) {
    const { loadFx } = await fxLake(); // ask2049: no FX lake (see fxLake above)
    const to = Date.now();
    d1 = (await loadFx(asset.fxSym, 86_400_000, to - 400 * 86_400_000, to)).map((b) => ({ ...b }));
    h4 = (await loadFx(asset.fxSym, 14_400_000, to - 35 * 86_400_000, to)).map((b) => ({ ...b }));
    price = d1.length && d1[d1.length - 1].t >= Date.now() - FX_MAX_AGE_MS ? d1[d1.length - 1].c : null;
    source = "Dukascopy BID (last complete UTC day, not live)";
  }
  const closes = d1.map((x) => x.c);
  const last = price ?? closes[closes.length - 1] ?? null;
  const ma20 = sma(closes, 20), ma50 = sma(closes, 50), ma200 = sma(closes, 200);
  const a = atr(d1, 14);
  const d30 = pctChange(last, closeAgo(d1, 30));
  const yr = d1.slice(-365), m1 = d1.slice(-30);
  const lv = last ? pickLevels(last, h4, d1, a) : { support: [], resistance: [] };
  const stock = asset.stock ? await stockQuote(asset.stock) : null;
  return {
    asset, source, price: sig(last), asOf: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    change: { h24: r2(prevDay ? pctChange(last, prevDay) : pctChange(last, closeAgo(d1, 1))), d7: r2(pctChange(last, closeAgo(d1, 7))), d30: r2(d30), d90: r2(pctChange(last, closeAgo(d1, 90))) },
    ma: { ma20: sig(ma20), ma50: sig(ma50), ma200: sig(ma200) }, rsi14: r2(rsi14(closes)), atr14Pct: r2(a && last ? (a / last) * 100 : null),
    range: { high52w: yr.length ? sig(Math.max(...yr.map((x) => x.h))) : null, low52w: yr.length ? sig(Math.min(...yr.map((x) => x.l))) : null, high30d: m1.length ? sig(Math.max(...m1.map((x) => x.h))) : null, low30d: m1.length ? sig(Math.min(...m1.map((x) => x.l))) : null },
    trend: last ? trendOf(last, ma50, ma200, d30) : "no data", support: lv.support, resistance: lv.resistance, perp, stock,
    daily: d1.slice(-365).map((x) => ({ t: x.t, c: x.c })), // the chart pans back a year (2026-09-27); the model never reads it
  };
}

/** One-call dashboard for "how are markets / macro today". */
export const SNAPSHOT_IDS = ["GOLD", "SILVER", "OIL", "COPPER", "EURUSD", "USDJPY", "DXY", "NASDAQ", "BTC", "ETH"];
export async function macroSnapshot(ids: string[] = SNAPSHOT_IDS): Promise<{ id: string; label: string; short: string; cls: AssetClass; hlCoin: string | null; price: number | null; h24: number | null; d7: number | null; d30: number | null; source: string }[]> {
  const out = await Promise.all(ids.map(async (id) => {
    try {
      const a = await resolveAsset(id);
      if (!a) return null;
      const l = await marketLevels(a);
      return { id: a.id, label: a.label, short: a.short, cls: a.cls, hlCoin: a.hlCoin, price: l.price, h24: l.change.h24, d7: l.change.d7, d30: l.change.d30, source: l.source };
    } catch (e) { logger.warn({ id, err: String(e).slice(0, 120) }, "macro snapshot: asset failed"); return null; }
  }));
  // A market whose source did not answer (DXY while a basket pair is still loading) is left out, not shown as "—".
  return out.filter((x): x is NonNullable<typeof x> => !!x && x.price != null);
}
