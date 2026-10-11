// Perpl, the order-book perps exchange on Monad (Exchange proxy 0x34B6552d57a35a1D042CcAe1951BD1C370112a6F, collateral AUSD):
// its public market data over REST (https://app.perpl.xyz/api, no auth, ~100 requests / min). Markets and their decimals and
// fees come from /v1/pub/context (cached 5 min); ticker and book are cached 3 s per market so a burst of agents makes one call.
// Prices are integers scaled by 10^price_decimals, sizes by 10^size_decimals; everything leaves here in plain numbers.
// Classic agents use it in PAPER mode only: a fill walks the live book for its notional and pays the taker fee.
export const PERPL_API = "https://app.perpl.xyz/api";
export const PERPL_EXCHANGE = "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F";
export const PERPL_COLLATERAL = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a"; // AUSD, 6 decimals
export const PERPL_APP = "https://app.perpl.xyz";

export interface PerplMarket { id: number; symbol: string; priceDecimals: number; sizeDecimals: number; maxLeverage: number; takerFeeBps: number; makerFeeBps: number; fundingIntervalSec: number | null }
export interface PerplTicker { id: number; mark: number; oracle: number; last: number; bid: number; ask: number; prev24h: number | null; at: number }
export interface PerplBook { bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; at: number }

export class PerplError extends Error {}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchFn: Fetch = (u, i) => fetch(u, i);
export function _setPerplFetch(f: Fetch | null): void { fetchFn = f ?? ((u, i) => fetch(u, i)); }

/** One GET; a 429 (Perpl's public limit is ~100 requests a minute) waits and tries again, twice. */
async function get(path: string, timeoutMs = 4_000): Promise<any> {
  let r: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try { r = await fetchFn(`${PERPL_API}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } }); }
    catch (e) { throw new PerplError(`Perpl unreachable (${String((e as Error)?.message ?? e).slice(0, 60)})`); }
    if (r.status !== 429 || attempt >= 2) break;
    await new Promise((res) => setTimeout(res, 1_500 * (attempt + 1)));
  }
  if (!r.ok) throw new PerplError(`Perpl HTTP ${r.status} on ${path.split("?")[0]}`);
  try { return await r.json(); } catch { throw new PerplError("Perpl answered with something that is not JSON"); }
}

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}
export function _resetPerpl(): void { cache.clear(); }

/** Every live market (from the context; retired ids are not in it). */
export async function markets(): Promise<PerplMarket[]> {
  return cached("context", 300_000, async () => {
    const j = await get("/v1/pub/context", 6_000);
    const list = Array.isArray(j?.markets) ? j.markets : [];
    const out: PerplMarket[] = [];
    for (const m of list) {
      const c = m?.config ?? {};
      const id = Number(m?.id), symbol = String(m?.name ?? "").toUpperCase();
      if (!Number.isInteger(id) || !symbol) continue;
      const im = Number(c.initial_margin);
      out.push({
        id, symbol, priceDecimals: Number(c.price_decimals ?? 0), sizeDecimals: Number(c.size_decimals ?? 0),
        maxLeverage: im > 0 ? Math.round(im / 100) : 1, takerFeeBps: Number(c.taker_fee ?? 0) / 100, makerFeeBps: Number(c.maker_fee ?? 0) / 100,
        fundingIntervalSec: Number.isFinite(Number(m?.funding_interval_sec)) ? Number(m.funding_interval_sec) : null,
      });
    }
    if (!out.length) throw new PerplError("Perpl context has no markets");
    return out;
  });
}
export async function market(symbol: string): Promise<PerplMarket | null> {
  const s = symbol.trim().toUpperCase();
  return (await markets()).find((m) => m.symbol === s) ?? null;
}

export async function ticker(m: PerplMarket): Promise<PerplTicker> {
  return cached(`ticker:${m.id}`, 3_000, async () => {
    const j = await get(`/v1/market-data/${m.id}/ticker`);
    const d = j?.d?.[String(m.id)] ?? j?.d ?? j;
    const k = 10 ** m.priceDecimals, n = (x: unknown) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) / k : NaN);
    const t: PerplTicker = { id: m.id, mark: n(d?.mrk), oracle: n(d?.orl), last: n(d?.lst), bid: n(d?.bid), ask: n(d?.ask), prev24h: Number.isFinite(n(d?.prv)) ? n(d?.prv) : null, at: Number(d?.at?.t ?? j?.at?.t ?? Date.now()) };
    if (!(t.mark > 0)) throw new PerplError(`Perpl has no mark price for ${m.symbol}`);
    return t;
  });
}

export async function book(m: PerplMarket, levels = 100): Promise<PerplBook> {
  return cached(`book:${m.id}`, 3_000, async () => {
    const j = await get(`/v1/market-data/${m.id}/book?levels=${Math.max(1, Math.min(100, levels))}`);
    const kp = 10 ** m.priceDecimals, ks = 10 ** m.sizeDecimals;
    const side = (a: unknown) => (Array.isArray(a) ? a : []).map((l: any) => ({ price: Number(l?.p) / kp, size: Number(l?.s) / ks })).filter((l) => l.price > 0 && l.size > 0);
    return { bids: side(j?.bid).sort((a, b) => b.price - a.price), asks: side(j?.ask).sort((a, b) => a.price - b.price), at: Number(j?.at?.t ?? Date.now()) };
  });
}

/** What a market order of `notionalUsd` would pay walking the book: VWAP, the size it fills, and the impact against the mid. */
export function walkBook(b: PerplBook, side: "buy" | "sell", notionalUsd: number): { vwap: number; size: number; filledUsd: number; impactPct: number; complete: boolean } | null {
  const levels = side === "buy" ? b.asks : b.bids;
  if (!levels.length || !(notionalUsd > 0)) return null;
  const mid = b.bids.length && b.asks.length ? (b.bids[0].price + b.asks[0].price) / 2 : levels[0].price;
  let left = notionalUsd, size = 0, cost = 0;
  for (const l of levels) {
    const usd = Math.min(left, l.price * l.size);
    size += usd / l.price; cost += usd; left -= usd;
    if (left <= 1e-9) break;
  }
  if (!(size > 0)) return null;
  const vwap = cost / size;
  return { vwap, size, filledUsd: cost, impactPct: Math.round(Math.abs(vwap / mid - 1) * 1e6) / 1e4, complete: left <= 1e-6 };
}

export const PERPL_RES: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800, "12h": 43200, "1d": 86400 };
/** Candles of a market between two times (≤ 1024 per call), oldest first, all-zero rows dropped. Read backwards from `to`
 *  and stopped at the first empty page: a window that starts before the market was listed costs no empty calls. */
export async function candles(m: PerplMarket, resSec: number, from: number, to: number): Promise<{ t: number; o: number; h: number; l: number; c: number; v: number }[]> {
  const k = 10 ** m.priceDecimals, step = resSec * 1000, out = new Map<number, { t: number; o: number; h: number; l: number; c: number; v: number }>();
  for (let end = to, page = 0; end > from && page < 60; page++) {
    const start = Math.max(from, end - step * 1000);
    const j = await get(`/v1/market-data/${m.id}/candles/${resSec}/${start}-${end}`, 8_000);
    let n = 0;
    for (const c of Array.isArray(j?.d) ? j.d : []) {
      const o = Number(c.o) / k, h = Number(c.h) / k, l = Number(c.l) / k, cl = Number(c.c) / k;
      if (!(o > 0 && h > 0 && l > 0 && cl > 0)) continue;
      out.set(Number(c.t), { t: Number(c.t), o, h, l, c: cl, v: Number(c.v ?? 0) / 1e6 });
      n++;
    }
    if (!n) break; // before the listing
    end = start;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
/** Funding events (final value per interval), rate as a fraction per interval (micros / 1e6). Perpl answers 400 for a range
 *  wider than 1024 intervals (~30 days at ~43 min), so it is read in 25-day windows. */
export async function fundingHistory(m: PerplMarket, from: number, to: number): Promise<{ t: number; rate: number }[]> {
  const out = new Map<number, { t: number; rate: number }>(), WINDOW = 25 * 86_400_000;
  for (let start = from, page = 0; start < to && page < 40; page++) {
    const end = Math.min(to, start + WINDOW);
    const j = await get(`/v1/market-data/${m.id}/funding/${start}-${end}`, 8_000);
    for (const f of Array.isArray(j?.d) ? j.d : []) {
      const t = Number(f?.at?.t), feb = Number(f?.feb ?? t);
      if (!Number.isFinite(t)) continue;
      out.set(feb, { t, rate: Number(f.rate) / 1e6 }); // an estimate and the final value share `feb`: the later one wins
    }
    start = end;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
