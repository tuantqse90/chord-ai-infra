// Candles and funding for the classic strategies, from four public market-data APIs (owner 11/10: Binance, OKX and
// Hyperliquid for this feature, plus Perpl, the perps venue on Monad itself; Monad tokens still come from Chord). No keys, no account endpoints. One shape for all:
// Candle { t: open time ms, o, h, l, c, v } oldest first, Funding { t: ms, rate per funding print }. A symbol a source does
// not list is an error that says so (never a stand-in). Pages are cached per (source, symbol, timeframe) and extended.
import * as perpl from "../perpl/client";

export type Source = "binance" | "okx" | "hyperliquid" | "perpl";
export const SOURCES: readonly Source[] = ["binance", "okx", "hyperliquid", "perpl"];
export const SOURCE_NAMES: Record<Source, string> = { binance: "Binance", okx: "OKX", hyperliquid: "Hyperliquid", perpl: "Perpl" };
export type Tf = "15m" | "1h" | "4h" | "1d";
export const TFS: readonly Tf[] = ["15m", "1h", "4h", "1d"];
export const TF_MS: Record<Tf, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
export interface Funding { t: number; rate: number }
/** funding prints per year: Binance and OKX every 8 h, Hyperliquid every hour, Perpl every 8571 blocks (~43 min) */
export const FUNDING_PER_YEAR: Record<Source, number> = { binance: 1095, okx: 1095, hyperliquid: 8760, perpl: Math.round((365 * 86_400) / 2580) };
/** Hyperliquid answers about 5000 candles back from now */
export const HL_MAX_CANDLES = 5000;

export class NotListedError extends Error { constructor(readonly source: Source, readonly symbol: string) { super(`${symbol} is not listed on ${SOURCE_NAMES[source]}`); } }
export class SourceError extends Error { constructor(readonly source: Source, message: string) { super(`${SOURCE_NAMES[source]}: ${message}`); } }

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchFn: Fetch = (u, i) => fetch(u, i);
export function _setFetch(f: Fetch | null): void { fetchFn = f ?? ((u, i) => fetch(u, i)); }
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One request; a 429 waits and tries again, twice (Hyperliquid weighs candle reads; OKX allows 20 history calls / 2 s). */
async function getJson(source: Source, url: string, init?: RequestInit): Promise<any> {
  let r: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try { r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(10_000) }); }
    catch (e) { throw new SourceError(source, `unreachable (${String((e as Error)?.message ?? e).slice(0, 60)})`); }
    if (r.status !== 429 || attempt >= 2) break;
    await pause(1_500 * (attempt + 1));
  }
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* below */ }
  if (!r.ok) {
    // Binance: {"code":-1121,"msg":"Invalid symbol."}; OKX answers 200 with code 51001 (below)
    if (j && (j.code === -1121 || /invalid symbol/i.test(String(j.msg ?? "")))) return { notListed: true };
    throw new SourceError(source, `HTTP ${r.status}${j?.msg ? ` ${String(j.msg).slice(0, 80)}` : ""}`);
  }
  if (j == null) throw new SourceError(source, "not JSON");
  return j;
}

// ── symbols ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const sym = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
export const marketId = (source: Source, symbol: string) => source === "binance" ? `${sym(symbol)}USDT` : source === "okx" ? `${sym(symbol)}-USDT-SWAP` : sym(symbol);
async function perplMarket(symbol: string): Promise<perpl.PerplMarket> {
  let m: perpl.PerplMarket | null;
  try { m = await perpl.market(symbol); } catch (e) { throw new SourceError("perpl", (e as Error).message); }
  if (!m) throw new NotListedError("perpl", symbol);
  return m;
}

// ── per-source page readers (each returns oldest-first, deduplicated by t) ───────────────────────────────────────────
const BINANCE_TF: Record<Tf, string> = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const OKX_TF: Record<Tf, string> = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc" };

async function binanceCandles(symbol: string, tf: Tf, from: number, to: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let start = from;
  for (let page = 0; page < 40 && start < to; page++) {
    const j = await getJson("binance", `https://fapi.binance.com/fapi/v1/klines?symbol=${marketId("binance", symbol)}&interval=${BINANCE_TF[tf]}&startTime=${start}&endTime=${to}&limit=1500`);
    if (j?.notListed) throw new NotListedError("binance", symbol);
    if (!Array.isArray(j) || !j.length) break;
    for (const k of j) out.push({ t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    const last = Number(j[j.length - 1][0]);
    if (j.length < 1500) break;
    start = last + TF_MS[tf];
  }
  return out;
}
async function binanceFunding(symbol: string, from: number, to: number): Promise<Funding[]> {
  const out: Funding[] = [];
  let start = from;
  for (let page = 0; page < 20 && start < to; page++) {
    const j = await getJson("binance", `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${marketId("binance", symbol)}&startTime=${start}&endTime=${to}&limit=1000`);
    if (j?.notListed) throw new NotListedError("binance", symbol);
    if (!Array.isArray(j) || !j.length) break;
    for (const f of j) out.push({ t: Number(f.fundingTime), rate: Number(f.fundingRate) });
    if (j.length < 1000) break;
    start = Number(j[j.length - 1].fundingTime) + 1;
  }
  return out;
}
async function okxPages(path: string, symbol: string, from: number, pageSize: number, map: (row: any) => { t: number } | null): Promise<any[]> {
  const out: any[] = [];
  let after = "";
  for (let page = 0; page < 400; page++) {
    const j = await getJson("okx", `https://www.okx.com${path}${after ? `&after=${after}` : ""}`);
    if (j?.code === "51001" || j?.code === "51000" && /instId/i.test(String(j?.msg ?? ""))) throw new NotListedError("okx", symbol);
    if (j?.code !== "0") throw new SourceError("okx", `code ${j?.code} ${String(j?.msg ?? "").slice(0, 80)}`);
    const rows = (j.data ?? []).map(map).filter(Boolean) as { t: number }[];
    if (!rows.length) break;
    out.push(...rows);
    const oldest = Math.min(...rows.map((r) => r.t));
    if (oldest <= from || rows.length < pageSize) break;
    after = String(oldest);
    await pause(110); // OKX: 20 requests / 2 s on the history routes
  }
  return out;
}
const okxCandles = async (symbol: string, tf: Tf, from: number) =>
  (await okxPages(`/api/v5/market/history-candles?instId=${marketId("okx", symbol)}&bar=${OKX_TF[tf]}&limit=300`, symbol, from, 300,
    (k) => ({ t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))) as Candle[];
const okxFunding = async (symbol: string, from: number) =>
  (await okxPages(`/api/v5/public/funding-rate-history?instId=${marketId("okx", symbol)}&limit=400`, symbol, from, 400,
    (f) => ({ t: Number(f.fundingTime), rate: Number(f.realizedRate ?? f.fundingRate) }))) as Funding[];

async function hlPost(body: object): Promise<any> {
  return getJson("hyperliquid", "https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function hlCandles(symbol: string, tf: Tf, from: number, to: number): Promise<Candle[]> {
  const j = await hlPost({ type: "candleSnapshot", req: { coin: marketId("hyperliquid", symbol), interval: tf, startTime: from, endTime: to } });
  if (!Array.isArray(j)) throw new SourceError("hyperliquid", "unexpected answer");
  if (!j.length) throw new NotListedError("hyperliquid", symbol);
  return j.map((k: any) => ({ t: Number(k.t), o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }));
}
async function hlFunding(symbol: string, from: number, to: number): Promise<Funding[]> {
  const out: Funding[] = [];
  let start = from;
  for (let page = 0; page < 40 && start < to; page++) {
    const j = await hlPost({ type: "fundingHistory", coin: marketId("hyperliquid", symbol), startTime: start, endTime: to });
    if (!Array.isArray(j) || !j.length) break;
    for (const f of j) out.push({ t: Number(f.time), rate: Number(f.fundingRate) });
    if (j.length < 500) break;
    start = Number(j[j.length - 1].time) + 1;
  }
  return out;
}

async function perplCandles(symbol: string, tf: Tf, from: number, to: number): Promise<Candle[]> {
  const m = await perplMarket(symbol);
  try { return await perpl.candles(m, TF_MS[tf] / 1000, from, to); } catch (e) { throw new SourceError("perpl", (e as Error).message); }
}
async function perplFunding(symbol: string, from: number, to: number): Promise<Funding[]> {
  const m = await perplMarket(symbol);
  try { return await perpl.fundingHistory(m, from, to); } catch (e) { throw new SourceError("perpl", (e as Error).message); }
}

const clean = <T extends { t: number }>(rows: T[]): T[] => {
  const by = new Map<number, T>();
  for (const r of rows) if (Number.isFinite(r.t)) by.set(r.t, r);
  return [...by.values()].sort((a, b) => a.t - b.t);
};

// ── cached readers ───────────────────────────────────────────────────────────────────────────────────────────────────
type Entry<T> = { from: number; rows: T[]; at: number };
const candleCache = new Map<string, Entry<Candle>>();
const fundingCache = new Map<string, Entry<Funding>>();
export function _resetData(): void { candleCache.clear(); fundingCache.clear(); }

/** Candles from `from` to now, closed bars only (the bar still forming is dropped). */
export async function candles(source: Source, symbol: string, tf: Tf, from: number, now = Date.now()): Promise<Candle[]> {
  const key = `${source}:${sym(symbol)}:${tf}`, hit = candleCache.get(key);
  const lastClosedOpen = Math.floor(now / TF_MS[tf]) * TF_MS[tf] - TF_MS[tf];
  let rows: Candle[];
  if (hit && hit.from <= from && hit.rows.length && hit.rows[hit.rows.length - 1].t >= lastClosedOpen) rows = hit.rows;
  else {
    const start = hit && hit.from <= from && hit.rows.length ? hit.rows[hit.rows.length - 1].t + TF_MS[tf] : from;
    const fresh = source === "binance" ? await binanceCandles(symbol, tf, start, now)
      : source === "okx" ? await okxCandles(symbol, tf, start)
        : source === "perpl" ? await perplCandles(symbol, tf, start, now)
          : await hlCandles(symbol, tf, start, now);
    rows = clean([...(hit && hit.from <= from ? hit.rows : []), ...fresh]);
    candleCache.set(key, { from: Math.min(from, hit && hit.from <= from ? hit.from : from), rows, at: now });
  }
  return rows.filter((c) => c.t >= from && c.t <= lastClosedOpen);
}
export async function funding(source: Source, symbol: string, from: number, now = Date.now()): Promise<Funding[]> {
  const key = `${source}:${sym(symbol)}`, hit = fundingCache.get(key);
  if (hit && hit.from <= from && now - hit.at < 600_000) return hit.rows.filter((f) => f.t >= from);
  const rows = clean(source === "binance" ? await binanceFunding(symbol, from, now) : source === "okx" ? await okxFunding(symbol, from)
    : source === "perpl" ? await perplFunding(symbol, from, now) : await hlFunding(symbol, from, now));
  fundingCache.set(key, { from, rows, at: now });
  return rows.filter((f) => f.t >= from);
}
