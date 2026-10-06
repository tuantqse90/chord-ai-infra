// Perp derivatives across the big venues for Chord Ask (owner 2026-09-26: "tự lấy open interest, funding và tỷ lệ
// long/short từ API public free của Binance, Bybit, OKX, chỉ dùng CoinGlass cho … ETF và tổng liquidation").
// Four venues read from their public market APIs (no key), normalised per coin:
//   oiUsd       one side, USD. Bybit's `openInterestValue` counts BOTH sides → `singleOpenInterestValue`; Binance's
//               openInterest is in contract units → × raw mark price. OKX / Hyperliquid are one side already.
//   funding     the venue's rate over its own interval → % per 8 h and annualised. Intervals: Binance fundingInfo
//               (8 h when absent), Bybit fundingIntervalHour, OKX fundingTime − prevFundingTime, Hyperliquid 1 h.
//   longPct     share of accounts net long: Binance global account ratio, Bybit buyRatio, OKX ratio r → r / (1 + r).
//   topLongPct  Binance top traders' position long share.
// Symbols like 1000PEPEUSDT, 1MBABYDOGEUSDT, SHIB1000USDT, kPEPE price a bundle of coins — prices are divided back to one.
//
// Lanes:
//   bulk    one call per list for the whole market (Binance premiumIndex + ticker/24hr, Bybit tickers, OKX tickers +
//           open-interest + funding-rate?instId=ANY, Hyperliquid metaAndAssetCtxs), memoised 60 s, single flight. A venue
//           that fails keeps its last good rows for 15 min so one 429 does not blank it.
//   extras  what the bulk lists lack, per coin (Binance OI + 2 ratios, Bybit ratio, OKX ratio) → Redis
//           `derivs:coin:v1:{COIN}` 60 s. derivs_coin answers ANY listed coin live through this lane.
//   board   every DERIVS_POLL_MS (5 min) the top DERIVS_TOP coins by OI with extras → Redis `derivs:board:v1`; every
//           DERIVS_SNAP_MS (15 min) their venue rows → pg `derivs_snap` (OI / funding / long history, DERIVS_RETENTION_DAYS).
// Rate limits (read 2026-09-26; every venue answered 200 from the VPS, no geo block): Binance 2400 weight/min/IP
// (/futures/data ratios: 1000 req / 5 min), Bybit 600 req / 5 s / IP (403 + ban ≥ 10 min), OKX per endpoint (rubik ratios
// 5 req / 2 s → `okxSlot` spaces them 450 ms). A 418/429/403/451 or a venue rate-limit code parks the venue box-wide
// (`derivs:backoff:{venue}`) — Binance escalates bans up to 3 days for callers that keep going. Binance used weight above
// DERIVS_BINANCE_WEIGHT_CAP skips its ratio calls. DERIVS=0 = no board poll (derivs_coin still answers live).
import { getRedis } from "../utils/redis";
import { logger } from "../utils/logger";

export type Venue = "binance" | "bybit" | "okx" | "hyperliquid";
export const VENUES: Venue[] = ["binance", "bybit", "okx", "hyperliquid"];
export const VENUE_LABEL: Record<Venue, string> = { binance: "Binance", bybit: "Bybit", okx: "OKX", hyperliquid: "Hyperliquid" };

export interface VenueRow {
  venue: Venue;
  coin: string;
  /** The venue's own symbol (BTCUSDT, 1000PEPEUSDT, BTC-USDT-SWAP, kPEPE). */
  symbol: string;
  /** Coins one contract unit prices (1000PEPEUSDT = 1000). `price` is already per ONE coin. */
  mult: number;
  price: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  oiUsd: number | null;
  /** Raw rate over `fundingIntervalH` hours (fraction, positive = longs pay shorts). */
  fundingRate: number | null;
  fundingIntervalH: number | null;
  nextFundingTs: number | null;
  longPct: number | null;
  topLongPct: number | null;
}

const envNum = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const POLL_MS = () => envNum("DERIVS_POLL_MS", 300_000);
const SNAP_MS = () => envNum("DERIVS_SNAP_MS", 900_000);
const TOP = () => Math.min(150, envNum("DERIVS_TOP", 60));
// ask2049: snapshots live in memory (snapStore below), so the default keeps 3 days, not Chord's 90 in Postgres
// (60 coins × 4 venues × 96 snapshots a day ≈ 23k rows a day).
const RETENTION_DAYS = () => envNum("DERIVS_RETENTION_DAYS", 3);
const WEIGHT_CAP = () => envNum("DERIVS_BINANCE_WEIGHT_CAP", 1200);
const BOARD_KEY = "derivs:board:v1";
const coinKey = (c: string) => `derivs:coin:v1:${c}`;

// ── normalisation (pure) ─────────────────────────────────────────────────────────────────────────────
const BUNDLE = /^(1000000|100000|10000|1000|1M)([A-Z][A-Z0-9]*)$/;
/** Venue symbol → coin + coins per contract unit. null = not a USDT-margined perpetual. */
export function parseSymbol(venue: Venue, s: string): { coin: string; mult: number } | null {
  if (venue === "okx") { const m = /^([A-Z0-9]+)-USDT-SWAP$/.exec(s); return m ? { coin: m[1], mult: 1 } : null; }
  if (venue === "hyperliquid") {
    const k = /^k([A-Z][A-Z0-9]+)$/.exec(s);
    if (k) return { coin: k[1], mult: 1000 };
    return /^[A-Z0-9]+$/.test(s) ? { coin: s, mult: 1 } : null;
  }
  const m = /^([A-Z0-9]+)USDT$/.exec(s);
  if (!m) return null;
  const pre = BUNDLE.exec(m[1]);
  if (pre) return { coin: pre[2], mult: pre[1] === "1M" ? 1_000_000 : Number(pre[1]) };
  const suf = /^([A-Z][A-Z0-9]*?[A-Z])1000$/.exec(m[1]); // Bybit's SHIB1000USDT
  if (suf) return { coin: suf[1], mult: 1000 };
  return { coin: m[1], mult: 1 };
}

/** What a person types ("$pepe", "1000PEPE", "PEPEUSDT", "kPEPE", "PEPE-USDT-SWAP") → the coin key ("PEPE"). */
export function normCoin(q: string): string {
  let s = q.trim().replace(/^\$/, "").replace(/-USDT-SWAP$/i, "");
  if (/^k[A-Z][A-Z0-9]+$/.test(s)) s = s.slice(1);
  s = s.toUpperCase().replace(/(.+?)USDT$/, "$1").replace(/[^A-Z0-9]/g, "");
  const pre = BUNDLE.exec(s);
  return (pre ? pre[2] : s).slice(0, 20);
}

export const funding8hPct = (rate: number, intervalH: number) => (rate * 100 * 8) / intervalH;
export const okxLongPct = (ratio: number) => (ratio / (1 + ratio)) * 100;

export interface CoinAgg {
  coin: string;
  price: number | null;
  change24hPct: number | null;
  oiUsd: number | null;
  volume24hUsd: number | null;
  /** OI-weighted across venues (simple mean when no venue has OI). */
  funding8hPct: number | null;
  fundingAnnualPct: number | null;
  longPct: number | null;
  topLongPct: number | null;
  venues: Venue[];
  /** The coin's Hyperliquid name (BTC, kPEPE) when it lists there — the Ask perp page uses it. */
  hl: string | null;
}

const PRICE_ORDER: Venue[] = ["binance", "bybit", "okx", "hyperliquid"];
const priceOf = <T extends { venue: Venue; price: number | null }>(rows: T[]) => PRICE_ORDER.map((v) => rows.find((r) => r.venue === v && r.price != null)).find(Boolean);

export function aggregate(coin: string, rows: VenueRow[]): CoinAgg {
  const lead = priceOf(rows);
  const withOi = rows.filter((r) => r.oiUsd != null && r.oiUsd > 0);
  const oi = withOi.length ? withOi.reduce((s, r) => s + r.oiUsd!, 0) : null;
  const fr = rows.filter((r) => r.fundingRate != null && r.fundingIntervalH);
  const fw = fr.filter((r) => (r.oiUsd ?? 0) > 0);
  const f8 = fw.length
    ? fw.reduce((s, r) => s + funding8hPct(r.fundingRate!, r.fundingIntervalH!) * r.oiUsd!, 0) / fw.reduce((s, r) => s + r.oiUsd!, 0)
    : fr.length ? fr.reduce((s, r) => s + funding8hPct(r.fundingRate!, r.fundingIntervalH!), 0) / fr.length : null;
  const lp = rows.filter((r) => r.longPct != null);
  const vol = rows.filter((r) => r.volume24hUsd != null);
  return {
    coin,
    price: lead?.price ?? null,
    change24hPct: lead?.change24hPct ?? null,
    oiUsd: oi,
    volume24hUsd: vol.length ? vol.reduce((s, r) => s + r.volume24hUsd!, 0) : null,
    funding8hPct: f8,
    fundingAnnualPct: f8 == null ? null : f8 * 3 * 365,
    longPct: lp.length ? lp.reduce((s, r) => s + r.longPct!, 0) / lp.length : null,
    topLongPct: rows.find((r) => r.venue === "binance")?.topLongPct ?? null,
    venues: rows.map((r) => r.venue),
    hl: rows.find((r) => r.venue === "hyperliquid")?.symbol ?? null,
  };
}

/** The OI × price quadrant over one window. Thresholds: OI ±3 %, price ±1 %. */
export function readFlow(oiChangePct: number | null, priceChangePct: number | null): string | null {
  if (oiChangePct == null || priceChangePct == null) return null;
  const oiUp = oiChangePct >= 3, oiDn = oiChangePct <= -3, pUp = priceChangePct >= 1, pDn = priceChangePct <= -1;
  if (oiUp && pUp) return "new longs: open interest and price both rising — the move is backed by fresh leverage";
  if (oiUp && pDn) return "new shorts: open interest rising while price falls";
  if (oiDn && pUp) return "short covering: price rising while open interest falls";
  if (oiDn && pDn) return "long unwind: open interest and price both falling — longs closing or liquidated";
  if (oiUp) return "leverage building with price flat — a break either way has fuel";
  if (oiDn) return "leverage leaving with price flat";
  return "no clear positioning change";
}

/** Crowding heuristics. Baseline funding on the big venues is 0.01 % per 8 h. */
export function crowdFlags(a: Pick<CoinAgg, "funding8hPct" | "longPct" | "topLongPct">): string[] {
  const out: string[] = [];
  const f = a.funding8hPct;
  if (f != null && f >= 0.03) out.push(`longs pay ${f.toFixed(4)}% per 8 h (≈${Math.round(f * 3 * 365)}%/yr, 3× the 0.01% baseline or more) — crowded long`);
  if (f != null && f <= -0.01) out.push(`shorts pay ${Math.abs(f).toFixed(4)}% per 8 h — crowded short, squeeze risk`);
  if (a.longPct != null && a.longPct >= 70) out.push(`${Math.round(a.longPct)}% of accounts are long — the crowd leans long`);
  if (a.longPct != null && a.longPct <= 35) out.push(`only ${Math.round(a.longPct)}% of accounts are long — the crowd leans short`);
  if (a.longPct != null && a.topLongPct != null && Math.abs(a.longPct - a.topLongPct) >= 15)
    out.push(`Binance top traders are ${Math.round(a.topLongPct)}% long by position vs ${Math.round(a.longPct)}% of all accounts — big accounts lean the other way`);
  return out;
}

// ── HTTP with per-venue parking ──────────────────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (compatible; ChordDerivs/1.0; +https://getchord.xyz)";
const parkedUntil: Record<Venue, number> = { binance: 0, bybit: 0, okx: 0, hyperliquid: 0 };
let binanceWeight = 0;
export const isParked = (v: Venue) => Date.now() < parkedUntil[v];

async function park(venue: Venue, ms: number, why: string): Promise<void> {
  const until = Date.now() + ms;
  if (until <= parkedUntil[venue]) return;
  parkedUntil[venue] = until;
  try { await getRedis().set(`derivs:backoff:${venue}`, String(until), "PX", ms); } catch { /* memory still holds it */ }
  logger.warn({ venue, ms, why }, "derivs: venue parked");
}
async function syncParked(): Promise<void> {
  for (const v of VENUES) {
    try { const x = Number(await getRedis().get(`derivs:backoff:${v}`)); if (x > parkedUntil[v]) parkedUntil[v] = x; } catch { /* keep memory */ }
  }
}

async function getJson<T>(venue: Venue, url: string, post?: unknown): Promise<T> {
  if (isParked(venue)) throw new Error(`${venue} parked`);
  const res = await fetch(url, {
    method: post === undefined ? "GET" : "POST",
    headers: { Accept: "application/json", "User-Agent": UA, ...(post === undefined ? {} : { "Content-Type": "application/json" }) },
    body: post === undefined ? undefined : JSON.stringify(post),
    signal: AbortSignal.timeout(10_000),
  });
  if (venue === "binance") { const w = Number(res.headers.get("x-mbx-used-weight-1m")); if (w > 0) binanceWeight = w; }
  if (res.status === 418) { await park(venue, 30 * 60_000, "418 ip ban"); throw new Error(`${venue} 418`); }
  if (res.status === 429) { const ra = Number(res.headers.get("retry-after")) * 1000; await park(venue, Math.max(120_000, ra || 0), "429"); throw new Error(`${venue} 429`); }
  if (res.status === 403 || res.status === 451) { await park(venue, 15 * 60_000, String(res.status)); throw new Error(`${venue} ${res.status}`); }
  if (!res.ok) throw new Error(`${venue} ${res.status}`);
  const j = (await res.json()) as any;
  if (venue === "bybit" && j?.retCode !== 0) {
    if (j?.retCode === 10006 || j?.retCode === 10018) await park(venue, 120_000, `retCode ${j.retCode}`);
    throw new Error(`bybit retCode ${j?.retCode}`);
  }
  if (venue === "okx" && j?.code !== "0") {
    if (j?.code === "50011" || j?.code === "50061") await park(venue, 60_000, `code ${j.code}`);
    throw new Error(`okx code ${j?.code}`);
  }
  return j as T;
}

// OKX rubik ratios allow 5 requests / 2 s — one every 450 ms for the whole process. The board poll queues ~27 s of
// slots; a person's question does not wait behind it (`maxWaitMs`) — it answers without the OKX ratio instead.
let okxNext = 0;
async function okxSlot(maxWaitMs = Infinity): Promise<boolean> {
  const now = Date.now();
  const at = Math.max(now, okxNext);
  if (at - now > maxWaitMs) return false;
  okxNext = at + 450;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
  return true;
}

const num = (x: unknown): number | null => { if (x == null || x === "") return null; const v = Number(x); return Number.isFinite(v) ? v : null; };
const row = (venue: Venue, coin: string, symbol: string, mult: number, o: Partial<VenueRow>): VenueRow => ({
  venue, coin, symbol, mult, price: null, change24hPct: null, volume24hUsd: null, oiUsd: null, fundingRate: null, fundingIntervalH: null, nextFundingTs: null, longPct: null, topLongPct: null, ...o,
});

// ── bulk readers ─────────────────────────────────────────────────────────────────────────────────────
const BN = "https://fapi.binance.com";
const BY = "https://api.bybit.com";
const OKX = "https://www.okx.com/api/v5";
const HL = "https://api.hyperliquid.xyz/info";

let bnIntervals: { at: number; m: Map<string, number> } | null = null;
async function binanceBulk(): Promise<VenueRow[]> {
  if (!bnIntervals || Date.now() - bnIntervals.at > 6 * 3_600_000) {
    try {
      const fi = await getJson<{ symbol: string; fundingIntervalHours: number }[]>("binance", `${BN}/fapi/v1/fundingInfo`);
      bnIntervals = { at: Date.now(), m: new Map(fi.map((x) => [x.symbol, Number(x.fundingIntervalHours) || 8])) };
    } catch (e) {
      bnIntervals = { at: Date.now() - 5.5 * 3_600_000, m: bnIntervals?.m ?? new Map() }; // retry in 30 min
      logger.debug({ err: String(e) }, "derivs: binance fundingInfo failed");
    }
  }
  const [pi, tk] = await Promise.all([
    getJson<{ symbol: string; markPrice: string; lastFundingRate: string; nextFundingTime: number }[]>("binance", `${BN}/fapi/v1/premiumIndex`),
    getJson<{ symbol: string; priceChangePercent: string; quoteVolume: string }[]>("binance", `${BN}/fapi/v1/ticker/24hr`),
  ]);
  const t24 = new Map(tk.map((t) => [t.symbol, t]));
  const out: VenueRow[] = [];
  for (const p of pi) {
    const s = parseSymbol("binance", p.symbol);
    const t = t24.get(p.symbol);
    const raw = num(p.markPrice);
    if (!s || !t || !raw) continue; // no 24h ticker = settling / delisted
    out.push(row("binance", s.coin, p.symbol, s.mult, {
      price: raw / s.mult, change24hPct: num(t.priceChangePercent), volume24hUsd: num(t.quoteVolume),
      fundingRate: num(p.lastFundingRate), fundingIntervalH: bnIntervals.m.get(p.symbol) ?? 8, nextFundingTs: num(p.nextFundingTime),
    }));
  }
  return out;
}

async function bybitBulk(): Promise<VenueRow[]> {
  const j = await getJson<{ result: { list: Record<string, string>[] } }>("bybit", `${BY}/v5/market/tickers?category=linear`);
  const out: VenueRow[] = [];
  for (const t of j.result?.list ?? []) {
    const s = parseSymbol("bybit", t.symbol);
    const raw = num(t.markPrice) ?? num(t.lastPrice);
    if (!s || !raw) continue;
    const both = num(t.openInterestValue);
    const ch = num(t.price24hPcnt);
    out.push(row("bybit", s.coin, t.symbol, s.mult, {
      price: raw / s.mult, change24hPct: ch == null ? null : ch * 100, volume24hUsd: num(t.turnover24h),
      oiUsd: num(t.singleOpenInterestValue) ?? (both == null ? null : both / 2),
      fundingRate: num(t.fundingRate), fundingIntervalH: num(t.fundingIntervalHour) ?? 8, nextFundingTs: num(t.nextFundingTime),
    }));
  }
  return out;
}

async function okxBulk(): Promise<VenueRow[]> {
  type D = { data: Record<string, string>[] };
  const [tk, oi, fr] = await Promise.all([
    getJson<D>("okx", `${OKX}/market/tickers?instType=SWAP`),
    getJson<D>("okx", `${OKX}/public/open-interest?instType=SWAP`),
    getJson<D>("okx", `${OKX}/public/funding-rate?instId=ANY`),
  ]);
  const oiM = new Map(oi.data.map((x) => [x.instId, num(x.oiUsd)]));
  const frM = new Map(fr.data.map((x) => [x.instId, x]));
  const out: VenueRow[] = [];
  for (const t of tk.data) {
    const s = parseSymbol("okx", t.instId);
    const last = num(t.last);
    if (!s || !last) continue;
    const open = num(t.open24h), volCcy = num(t.volCcy24h);
    const f = frM.get(t.instId);
    const ft = num(f?.fundingTime), pft = num(f?.prevFundingTime);
    const iv = ft && pft && ft > pft ? Math.round((ft - pft) / 3_600_000) : 0;
    out.push(row("okx", s.coin, t.instId, 1, {
      price: last, change24hPct: open ? ((last - open) / open) * 100 : null, volume24hUsd: volCcy == null ? null : volCcy * last, // SWAP volCcy24h = base coin
      oiUsd: oiM.get(t.instId) ?? null, fundingRate: num(f?.fundingRate), fundingIntervalH: iv || 8, nextFundingTs: ft,
    }));
  }
  return out;
}

async function hlBulk(): Promise<VenueRow[]> {
  const [meta, ctxs] = await getJson<[{ universe: { name: string; isDelisted?: boolean }[] }, Record<string, string | null>[]]>("hyperliquid", HL, { type: "metaAndAssetCtxs" });
  const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const out: VenueRow[] = [];
  meta.universe.forEach((u, i) => {
    const s = parseSymbol("hyperliquid", u.name);
    const c = ctxs[i];
    const mark = num(c?.markPx), prev = num(c?.prevDayPx), oi = num(c?.openInterest);
    if (u.isDelisted || !s || !mark) return;
    out.push(row("hyperliquid", s.coin, u.name, s.mult, {
      price: mark / s.mult, change24hPct: prev ? ((mark - prev) / prev) * 100 : null, volume24hUsd: num(c?.dayNtlVlm),
      oiUsd: oi == null ? null : oi * mark, fundingRate: num(c?.funding), fundingIntervalH: 1, nextFundingTs: nextHour,
    }));
  });
  return out;
}

export interface VenueStatus { ok: boolean; rows: number; error?: string; staleS?: number }
interface Bulk { at: number; byCoin: Map<string, VenueRow[]>; status: Record<Venue, VenueStatus> }
const READERS: Record<Venue, () => Promise<VenueRow[]>> = { binance: binanceBulk, bybit: bybitBulk, okx: okxBulk, hyperliquid: hlBulk };
const lastGood: Partial<Record<Venue, { at: number; rows: VenueRow[] }>> = {};
let bulkMemo: Bulk | null = null;
let bulkFlight: Promise<Bulk> | null = null;

/** Every venue's whole board, memoised `maxAgeMs`, one fetch in flight at a time. */
export function loadBulk(maxAgeMs = 60_000): Promise<Bulk> {
  if (bulkMemo && Date.now() - bulkMemo.at < maxAgeMs) return Promise.resolve(bulkMemo);
  if (bulkFlight) return bulkFlight;
  bulkFlight = (async () => {
    await syncParked();
    const res = await Promise.allSettled(VENUES.map((v) => READERS[v]()));
    const byCoin = new Map<string, VenueRow[]>();
    const status = {} as Record<Venue, VenueStatus>;
    VENUES.forEach((v, i) => {
      const r = res[i];
      let rows: VenueRow[] = [];
      if (r.status === "fulfilled" && r.value.length) {
        rows = r.value;
        lastGood[v] = { at: Date.now(), rows };
        status[v] = { ok: true, rows: rows.length };
      } else {
        const error = r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason).slice(0, 120) : "empty";
        const lg = lastGood[v];
        if (lg && Date.now() - lg.at < 15 * 60_000) rows = lg.rows;
        status[v] = { ok: false, rows: rows.length, error, ...(lg && rows.length ? { staleS: Math.round((Date.now() - lg.at) / 1000) } : {}) };
      }
      for (const x of rows) {
        const list = byCoin.get(x.coin) ?? [];
        const same = list.findIndex((y) => y.venue === x.venue); // PEPEUSDT and 1000PEPEUSDT on one venue: keep the busier
        if (same < 0) list.push(x);
        else if ((x.volume24hUsd ?? 0) > (list[same].volume24hUsd ?? 0)) list[same] = x;
        byCoin.set(x.coin, list);
      }
    });
    bulkMemo = { at: Date.now(), byCoin, status };
    return bulkMemo;
  })().finally(() => { bulkFlight = null; });
  return bulkFlight;
}

// ── per-coin extras ──────────────────────────────────────────────────────────────────────────────────
async function extras(rows: VenueRow[], okxMaxWaitMs = Infinity): Promise<VenueRow[]> {
  const out = rows.map((r) => ({ ...r }));
  const bn = out.find((r) => r.venue === "binance"), by = out.find((r) => r.venue === "bybit"), ok = out.find((r) => r.venue === "okx");
  const jobs: Promise<void>[] = [];
  const quiet = (p: Promise<void>) => jobs.push(p.catch((e) => { logger.debug({ err: String(e) }, "derivs: extra failed"); }));
  if (bn) {
    const sym = encodeURIComponent(bn.symbol);
    quiet(getJson<{ openInterest: string }>("binance", `${BN}/fapi/v1/openInterest?symbol=${sym}`).then((j) => {
      const q = num(j.openInterest);
      if (q != null && bn.price != null) bn.oiUsd = q * bn.price * bn.mult;
    }));
    if (binanceWeight < WEIGHT_CAP()) {
      quiet(getJson<{ longAccount: string }[]>("binance", `${BN}/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=1`).then((j) => {
        const v = num(j?.[0]?.longAccount); if (v != null) bn.longPct = v * 100;
      }));
      quiet(getJson<{ longAccount: string }[]>("binance", `${BN}/futures/data/topLongShortPositionRatio?symbol=${sym}&period=5m&limit=1`).then((j) => {
        const v = num(j?.[0]?.longAccount); if (v != null) bn.topLongPct = v * 100;
      }));
    }
  }
  if (by) quiet(getJson<{ result: { list: { buyRatio: string }[] } }>("bybit", `${BY}/v5/market/account-ratio?category=linear&symbol=${encodeURIComponent(by.symbol)}&period=5min&limit=1`).then((j) => {
    const v = num(j.result?.list?.[0]?.buyRatio); if (v != null) by.longPct = v * 100;
  }));
  if (ok) quiet(okxSlot(okxMaxWaitMs).then(async (go) => {
    if (!go) return;
    const j = await getJson<{ data: [string, string][] }>("okx", `${OKX}/rubik/stat/contracts/long-short-account-ratio-contract?instId=${encodeURIComponent(ok.symbol)}&period=5m&limit=1`);
    const r = num(j.data?.[0]?.[1]); if (r != null && r >= 0) ok.longPct = okxLongPct(r);
  }));
  await Promise.all(jobs);
  return out;
}

export interface CoinRows { coin: string; at: number; rows: VenueRow[]; status: Record<Venue, VenueStatus> }
/** One coin on every venue that lists it, live (60 s cache). null = no USDT perp anywhere. */
export async function coinRows(q: string): Promise<CoinRows | null> {
  const coin = normCoin(q);
  if (!coin) return null;
  try { const raw = await getRedis().get(coinKey(coin)); if (raw) return JSON.parse(raw) as CoinRows; } catch { /* fetch */ }
  const bulk = await loadBulk();
  const base = bulk.byCoin.get(coin);
  if (!base?.length) return null;
  const v: CoinRows = { coin, at: Date.now(), rows: await extras(base, 2_000), status: bulk.status };
  try { await getRedis().set(coinKey(coin), JSON.stringify(v), "EX", 60); } catch { /* next call refetches */ }
  return v;
}

// ── history (pg derivs_snap) ─────────────────────────────────────────────────────────────────────────
export interface Snap { ts: number; price: number | null; oiByVenue: Partial<Record<Venue, number>>; oiUsd: number; funding8hPct: number | null; longPct: number | null }
type SnapRow = { ts: string | number; coin: string; venue: Venue; price: number | null; oi_usd: number | null; funding_8h_pct: number | null; long_pct: number | null };

/** Snapshot rows (any coins) → per-coin, per-ts aggregates, oldest first. */
export function foldSnaps(rows: SnapRow[]): Map<string, Snap[]> {
  const byKey = new Map<string, SnapRow[]>();
  for (const r of rows) { const k = `${r.coin}|${r.ts}`; const a = byKey.get(k) ?? []; a.push(r); byKey.set(k, a); }
  const out = new Map<string, Snap[]>();
  for (const [k, rs] of byKey) {
    const [coin, ts] = k.split("|");
    const vr = rs.map((r) => ({ venue: r.venue, price: r.price == null ? null : Number(r.price) }));
    const oiByVenue: Partial<Record<Venue, number>> = {};
    let oi = 0, fw = 0, fs = 0, ls = 0, ln = 0;
    for (const r of rs) {
      const o = Number(r.oi_usd ?? 0);
      if (o > 0) { oiByVenue[r.venue] = o; oi += o; if (r.funding_8h_pct != null) { fs += Number(r.funding_8h_pct) * o; fw += o; } }
      if (r.long_pct != null) { ls += Number(r.long_pct); ln++; }
    }
    const s: Snap = { ts: Number(ts), price: priceOf(vr)?.price ?? null, oiByVenue, oiUsd: oi, funding8hPct: fw ? fs / fw : null, longPct: ln ? ls / ln : null };
    const list = out.get(coin) ?? [];
    list.push(s);
    out.set(coin, list);
  }
  for (const l of out.values()) l.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Change from the snapshot nearest `hours` ago (±25 min) to now. OI counts only venues present at both ends. */
export function changeSince(hist: Snap[], now: { price: number | null; rows: Pick<VenueRow, "venue" | "oiUsd">[] }, hours: number, nowTs = Date.now()): { oiPct: number | null; pricePct: number | null } | null {
  const target = nowTs - hours * 3_600_000;
  let best: Snap | null = null;
  for (const s of hist) if (Math.abs(s.ts - target) <= 25 * 60_000 && (!best || Math.abs(s.ts - target) < Math.abs(best.ts - target))) best = s;
  if (!best) return null;
  let a = 0, b = 0;
  for (const r of now.rows) { const then = best.oiByVenue[r.venue]; if (then && r.oiUsd && r.oiUsd > 0) { a += then; b += r.oiUsd; } }
  return {
    oiPct: a > 0 ? ((b - a) / a) * 100 : null,
    pricePct: best.price && now.price ? ((now.price - best.price) / best.price) * 100 : null,
  };
}

// ask2049: no Postgres here — Chord's pg table `derivs_snap` is this in-process map instead: the same rows under the same
// (coin, venue, ts) key, written by the board poll (startDerivs) every DERIVS_SNAP_MS and trimmed by retention(). It starts
// empty at boot, so OI change / the OI line fill in only while the poll runs (1 h change after ~1 h, 24 h after a day).
type SnapStoreRow = SnapRow & { ts: number; volume_24h_usd: number | null; top_long_pct: number | null };
const snapStore = new Map<string, SnapStoreRow>();

async function snapsFor(coins: string[], sinceMs: number): Promise<Map<string, Snap[]>> {
  if (!coins.length) return new Map();
  // ask2049: read the in-memory snapStore (same filter as the pg query: ts >= sinceMs AND coin IN coins).
  const want = new Set(coins);
  const rows: SnapRow[] = [];
  for (const r of snapStore.values()) if (r.ts >= sinceMs && want.has(r.coin)) rows.push(r);
  return foldSnaps(rows);
}

// ── views for the Ask tools ──────────────────────────────────────────────────────────────────────────
export interface CoinView {
  coin: string; at: number; rows: VenueRow[]; status: Record<Venue, VenueStatus>; agg: CoinAgg;
  change: { h1: ReturnType<typeof changeSince>; h4: ReturnType<typeof changeSince>; h24: ReturnType<typeof changeSince> };
  funding24hAvg8hPct: number | null; longPct24hAgo: number | null; flow4h: string | null; flow24h: string | null; flags: string[];
  series: { ts: number; oiUsd: number; funding8hPct: number | null; longPct: number | null; price: number | null }[];
}

export async function coinView(q: string, hours = 24): Promise<CoinView | null> {
  const r = await coinRows(q);
  if (!r) return null;
  const agg = aggregate(r.coin, r.rows);
  let hist: Snap[] = [];
  try { hist = (await snapsFor([r.coin], Date.now() - (Math.max(hours, 24) + 1) * 3_600_000)).get(r.coin) ?? []; }
  catch (e) { logger.debug({ err: String(e) }, "derivs: history read failed"); }
  const now = { price: agg.price, rows: r.rows };
  const change = { h1: changeSince(hist, now, 1), h4: changeSince(hist, now, 4), h24: changeSince(hist, now, 24) };
  const day = hist.filter((s) => s.ts >= Date.now() - 24 * 3_600_000 && s.funding8hPct != null);
  const ago = hist.find((s) => Math.abs(s.ts - (Date.now() - 24 * 3_600_000)) <= 25 * 60_000);
  const win = hist.filter((s) => s.ts >= Date.now() - hours * 3_600_000);
  const step = Math.max(1, Math.ceil(win.length / 96));
  return {
    ...r, agg, change,
    funding24hAvg8hPct: day.length ? day.reduce((s, x) => s + x.funding8hPct!, 0) / day.length : null,
    longPct24hAgo: ago?.longPct ?? null,
    flow4h: readFlow(change.h4?.oiPct ?? null, change.h4?.pricePct ?? null),
    flow24h: readFlow(change.h24?.oiPct ?? null, agg.change24hPct),
    flags: crowdFlags(agg),
    series: win.filter((_, i) => i % step === 0 || i === win.length - 1).map((s) => ({ ts: s.ts, oiUsd: s.oiUsd, funding8hPct: s.funding8hPct, longPct: s.longPct, price: s.price })),
  };
}

export interface BoardRow extends CoinAgg { oiChange1hPct: number | null; oiChange4hPct: number | null; oiChange24hPct: number | null; flow24h: string | null }
export interface Board { at: number; partial?: boolean; status: Record<Venue, VenueStatus>; rows: BoardRow[] }
export type BoardSort = "oi" | "oi_change" | "-oi_change" | "funding" | "-funding" | "long" | "-long" | "volume" | "change" | "-change";

export function sortBoard(rows: BoardRow[], sort: BoardSort): BoardRow[] {
  const desc = !sort.startsWith("-");
  const key = sort.replace(/^-/, "");
  const val = (r: BoardRow): number | null =>
    key === "oi" ? r.oiUsd : key === "oi_change" ? r.oiChange24hPct : key === "funding" ? r.funding8hPct : key === "long" ? r.longPct : key === "volume" ? r.volume24hUsd : r.change24hPct;
  return rows.filter((r) => val(r) != null).sort((a, b) => (desc ? val(b)! - val(a)! : val(a)! - val(b)!));
}

/** The polled board; before the first poll (or with DERIVS=0) the bulk lists alone — no Binance OI, no account ratios. */
export async function boardView(): Promise<Board> {
  try { const raw = await getRedis().get(BOARD_KEY); if (raw) return JSON.parse(raw) as Board; } catch { /* build */ }
  const bulk = await loadBulk();
  const rows = [...bulk.byCoin.entries()]
    .map(([coin, rs]) => ({ ...aggregate(coin, rs), oiChange1hPct: null, oiChange4hPct: null, oiChange24hPct: null, flow24h: null }))
    .sort((a, b) => (b.oiUsd ?? 0) - (a.oiUsd ?? 0))
    .slice(0, TOP());
  return { at: bulk.at, partial: true, status: bulk.status, rows };
}

// ── the poll ─────────────────────────────────────────────────────────────────────────────────────────
async function mapLimit<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

let lastSnap = 0;
let running = false;
let lastCycle: { at: number; ms: number; coins: number; wroteSnap: boolean } | null = null;
export const derivsStatus = () => ({ lastCycle, lastSnap: lastSnap || null, binanceWeight, parked: Object.fromEntries(VENUES.filter(isParked).map((v) => [v, new Date(parkedUntil[v]).toISOString()])) });

async function writeSnap(ts: number, list: { coin: string; rows: VenueRow[] }[]): Promise<void> {
  const payload: SnapStoreRow[] = list.flatMap(({ coin, rows }) => rows.map((r) => ({
    ts, coin, venue: r.venue, price: r.price, oi_usd: r.oiUsd,
    funding_8h_pct: r.fundingRate != null && r.fundingIntervalH ? funding8hPct(r.fundingRate, r.fundingIntervalH) : null,
    volume_24h_usd: r.volume24hUsd, long_pct: r.longPct, top_long_pct: r.topLongPct,
  })));
  // ask2049: into the in-memory snapStore instead of INSERT … ON CONFLICT (coin, venue, ts) DO NOTHING.
  for (const r of payload) { const k = `${r.coin}|${r.venue}|${r.ts}`; if (!snapStore.has(k)) snapStore.set(k, r); }
}

async function cycle(): Promise<void> {
  const t0 = Date.now();
  let lock: string | null = "OK";
  try { lock = await getRedis().set("derivs:lock", String(process.pid), "PX", Math.max(60_000, POLL_MS() - 10_000), "NX"); } catch { /* no redis = single process anyway */ }
  if (lock !== "OK") return;
  const bulk = await loadBulk(0);
  const ranked = [...bulk.byCoin.entries()]
    .map(([coin, rows]) => ({ coin, rows, oi: rows.reduce((s, r) => s + (r.venue === "binance" ? 0 : r.oiUsd ?? 0), 0) })) // Binance OI is not in its bulk list
    .sort((a, b) => b.oi - a.oi)
    .slice(0, TOP());
  const full: { coin: string; rows: VenueRow[] }[] = [];
  await mapLimit(ranked, 4, async (x) => {
    const rows = await extras(x.rows);
    full.push({ coin: x.coin, rows });
    try { await getRedis().set(coinKey(x.coin), JSON.stringify({ coin: x.coin, at: Date.now(), rows, status: bulk.status } satisfies CoinRows), "EX", 60); } catch { /* tool refetches */ }
  });
  let hist = new Map<string, Snap[]>();
  try { hist = await snapsFor(full.map((x) => x.coin), Date.now() - 25 * 3_600_000); }
  catch (e) { logger.debug({ err: String(e) }, "derivs: history read failed"); }
  const rows: BoardRow[] = full.map(({ coin, rows: rs }) => {
    const agg = aggregate(coin, rs);
    const h = hist.get(coin) ?? [];
    const now = { price: agg.price, rows: rs };
    const c1 = changeSince(h, now, 1), c4 = changeSince(h, now, 4), c24 = changeSince(h, now, 24);
    return { ...agg, oiChange1hPct: c1?.oiPct ?? null, oiChange4hPct: c4?.oiPct ?? null, oiChange24hPct: c24?.oiPct ?? null, flow24h: readFlow(c24?.oiPct ?? null, agg.change24hPct) };
  }).sort((a, b) => (b.oiUsd ?? 0) - (a.oiUsd ?? 0));
  const board: Board = { at: Date.now(), status: bulk.status, rows };
  try { await getRedis().set(BOARD_KEY, JSON.stringify(board), "EX", 3_600); } catch { /* boardView falls back to bulk */ }
  let wroteSnap = false;
  if (Date.now() - lastSnap >= SNAP_MS() - 30_000) {
    const ts = Date.now();
    await writeSnap(ts, full);
    lastSnap = ts;
    wroteSnap = true;
  }
  lastCycle = { at: t0, ms: Date.now() - t0, coins: full.length, wroteSnap };
  logger.info({ ...lastCycle, venues: Object.fromEntries(VENUES.map((v) => [v, bulk.status[v].ok ? bulk.status[v].rows : `down: ${bulk.status[v].error}`])), binanceWeight }, "derivs: cycle");
}

async function retention(): Promise<void> {
  // ask2049: trims the in-memory snapStore (was DELETE FROM derivs_snap WHERE ts < cutoff).
  const cutoff = Date.now() - RETENTION_DAYS() * 86_400_000;
  for (const [k, r] of snapStore) if (r.ts < cutoff) snapStore.delete(k);
}

let started = false;
export function startDerivs(): void {
  if (started || process.env.DERIVS === "0") return;
  started = true;
  const run = async () => {
    if (running) return;
    running = true;
    try { await cycle(); } catch (e) { logger.warn({ err: String(e) }, "derivs: cycle failed"); } finally { running = false; }
  };
  void (async () => {
    // ask2049: the snapshot store is in memory and empty at boot (Chord read max(ts) from pg here): first snapshot on the first cycle.
    await run();
  })();
  setInterval(() => void run(), POLL_MS()).unref?.();
  setInterval(() => void retention().catch((e) => logger.debug({ err: String(e) }, "derivs: retention failed")), 6 * 3_600_000).unref?.();
  logger.info({ pollMs: POLL_MS(), snapMs: SNAP_MS(), top: TOP() }, "derivs: started");
}
