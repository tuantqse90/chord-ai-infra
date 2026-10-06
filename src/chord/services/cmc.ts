// CoinMarketCap for Chord Ask (owner 2026-09-26: "thử coinmarketcap" → "đưa lên luôn"). The primary source behind the cg_*
// tools; services/coingecko stays for what the free CMC plan locks (trending, all-time highs, candles) and as the fallback
// whenever CMC errors, is rate-limited or has spent its month. The functions return the SAME shapes as coingecko.ts so the
// tool cases can try CMC first and fall back without a second code path.
//
// Plan measured 2026-09-26 (Basic, free): 15,000 credits / month, 50 calls / min, "Commercial use" on the pricing page,
// 12 months of history. Works: map (0 credits), listings, quotes, info, categories + category, global metrics, fear & greed,
// altcoin season, quotes/historical (hourly or daily, 1 credit / 100 points). Locked (error_code 1006): trending,
// gainers-losers, OHLCV, market pairs, price-performance stats (ATH), exchanges, content.
//
// Key: CMC_API_KEY. Cache: Redis `cmc:v1:{path}?{qs}` (fresh TTL per call, stale copy ≤ 6 h), the coin map `cmc:map:v1`
// (top 5,000 active coins by rank, 24 h). Budget: `cmc:rl:{minute}` ≤ CMC_RPM (default 40) and `cmc:credits:{YYYY-MM}`
// (credits CMC reports per call) ≤ CMC_MONTHLY_CREDITS (default 14,000) — past either, the call throws and the tool falls
// back to CoinGecko. A 429 / 1008 pauses CMC for 60 s (`cmc:backoff`).
import { getRedis } from "../utils/redis";
import { logger } from "../utils/logger";
import { byRoutedChain, pickCoin, type CgMarketRow, type CgRef } from "./coingecko";

const BASE = "https://pro-api.coinmarketcap.com";
const STALE_S = 6 * 3600;
const rpm = () => { const v = Number(process.env.CMC_RPM); return Number.isFinite(v) && v > 0 ? v : 40; };
const monthlyCap = () => { const v = Number(process.env.CMC_MONTHLY_CREDITS); return Number.isFinite(v) && v > 0 ? v : 14_000; };
const month = () => new Date().toISOString().slice(0, 7);
export const cmcEnabled = (): boolean => !!process.env.CMC_API_KEY;
export const cmcLogo = (id: number) => `https://s2.coinmarketcap.com/static/img/coins/64x64/${id}.png`;

async function budgetOk(): Promise<boolean> {
  try {
    const r = getRedis();
    if (await r.get("cmc:backoff")) return false;
    if ((Number(await r.get(`cmc:credits:${month()}`)) || 0) >= monthlyCap()) return false;
    const k = `cmc:rl:${Math.floor(Date.now() / 60_000)}`;
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, 90);
    return n <= rpm();
  } catch { return true; }
}

/** GET a CMC path → `data`, cached; stale (≤ 6 h) when the budget or CMC says no; throws when nothing is cached. */
export async function cmc<T = any>(path: string, params: Record<string, string | number | undefined>, ttl: number): Promise<{ data: T; ageS: number }> {
  if (!cmcEnabled()) throw new Error("CoinMarketCap is not configured");
  const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).sort().join("&");
  const key = `cmc:v1:${path}?${qs}`;
  const now = Math.floor(Date.now() / 1000);
  let cached: { t: number; d: T } | null = null;
  try { const raw = await getRedis().get(key); if (raw) cached = JSON.parse(raw); } catch { /* fetch */ }
  if (cached && now - cached.t < ttl) return { data: cached.d, ageS: now - cached.t };
  if (!(await budgetOk())) {
    if (cached) return { data: cached.d, ageS: now - cached.t };
    throw new Error("CoinMarketCap budget spent");
  }
  try {
    const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, { headers: { "X-CMC_PRO_API_KEY": process.env.CMC_API_KEY!, Accept: "application/json", "User-Agent": "chord-ask/1.0" }, signal: AbortSignal.timeout(10_000) });
    const j = (await res.json().catch(() => ({}))) as { status?: { error_code?: number | string; error_message?: string; credit_count?: number }; data?: T };
    const code = Number(j.status?.error_code ?? (res.ok ? 0 : res.status));
    if (res.status === 429 || code === 1008 || code === 1009 || code === 1010 || code === 1011) {
      await getRedis().set("cmc:backoff", "1", "EX", 60).catch(() => {});
      throw new Error("CoinMarketCap is rate-limited");
    }
    if (code === 1006) throw Object.assign(new Error("not on the CoinMarketCap plan"), { plan: true });
    if (!res.ok || code !== 0) throw new Error(`CoinMarketCap ${code}: ${String(j.status?.error_message ?? "").slice(0, 80)}`);
    const credits = Number(j.status?.credit_count) || 0;
    if (credits > 0) { const k = `cmc:credits:${month()}`; const r = getRedis(); await r.incrby(k, credits).catch(() => 0); await r.expire(k, 40 * 86_400).catch(() => {}); }
    await getRedis().set(key, JSON.stringify({ t: now, d: j.data }), "EX", STALE_S).catch(() => {});
    return { data: j.data as T, ageS: 0 };
  } catch (e) {
    if ((e as { plan?: boolean }).plan) throw e;
    logger.debug({ err: String(e), path }, "cmc: call failed");
    if (cached) return { data: cached.d, ageS: now - cached.t };
    throw e;
  }
}

// ── coin lookup: the top 5,000 active coins, kept a day (the map costs 0 credits) ─────────────────────────
type MapRow = [number, string, string, string, number | null]; // id, symbol, name, slug, rank
let mapMem: { at: number; rows: MapRow[] } | null = null;
async function coinMap(): Promise<MapRow[]> {
  if (mapMem && Date.now() - mapMem.at < 3600_000) return mapMem.rows;
  try { const raw = await getRedis().get("cmc:map:v1"); if (raw) { const rows = JSON.parse(raw) as MapRow[]; mapMem = { at: Date.now(), rows }; return rows; } } catch { /* fetch */ }
  const { data } = await cmc<any[]>("/v1/cryptocurrency/map", { listing_status: "active", limit: 5000, sort: "cmc_rank" }, 86_400);
  const rows: MapRow[] = (data ?? []).map((x) => [Number(x.id), String(x.symbol ?? "").toUpperCase(), String(x.name ?? ""), String(x.slug ?? ""), x.rank ?? null]);
  await getRedis().set("cmc:map:v1", JSON.stringify(rows), "EX", 86_400).catch(() => {});
  mapMem = { at: Date.now(), rows };
  return rows;
}
export interface CmcRef extends CgRef { cmcId: number }
/** Ticker, slug or exact name → the coin people mean, with coingecko.pickCoin's rule (ranked first; an unranked coin only
 *  on an exact match; nothing partial). Beyond the top 5,000 or no exact hit → null (the tool falls back to CoinGecko). */
export function pickFromMap(query: string, rows: MapRow[]): CmcRef | null {
  const q = query.trim().replace(/^\$/, "");
  if (!q) return null;
  const up = q.toUpperCase(), low = q.toLowerCase(), slug = low.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const hits = rows.filter((r) => r[1] === up || r[3] === slug || r[2].toLowerCase() === low);
  const ref = pickCoin(q, hits.map((r) => ({ id: r[3], symbol: r[1], name: r[2], rank: r[4], thumb: cmcLogo(r[0]) })));
  if (!ref) return null;
  const row = hits.find((r) => r[3] === ref.id)!;
  return { ...ref, cmcId: row[0] };
}
export async function resolveCmc(query: string): Promise<CmcRef | null> { return pickFromMap(query, await coinMap()); }

const r2 = (v: unknown) => { const x = Number(v); return v == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100; };
const num = (v: unknown) => { const x = Number(v); return v == null || !Number.isFinite(x) ? null : x; };

/** Same shape as coingecko.coinDetail — the ATH / ATL / sparkline fields are null here (not on the free plan). */
export function shapeCoin(ref: CmcRef, q: any, info: any, ageS: number) {
  const u = q?.quote?.USD ?? {};
  const desc = String(info?.description ?? "").replace(/\s+/g, " ").trim();
  const urls = info?.urls ?? {};
  return {
    id: ref.id, cmcId: ref.cmcId, symbol: String(q?.symbol ?? ref.symbol).toUpperCase(), name: String(q?.name ?? ref.name), rank: q?.cmc_rank ?? ref.rank ?? null,
    image: cmcLogo(ref.cmcId), categories: ((info?.["tag-names"] ?? info?.tags ?? []) as string[]).filter(Boolean).slice(0, 6),
    priceUsd: num(u.price), marketCapUsd: num(u.market_cap), fdvUsd: num(u.fully_diluted_market_cap), volume24hUsd: num(u.volume_24h),
    change: { h1: r2(u.percent_change_1h), h24: r2(u.percent_change_24h), d7: r2(u.percent_change_7d), d30: r2(u.percent_change_30d), y1: null as number | null },
    high24h: null as number | null, low24h: null as number | null,
    ath: null as number | null, athDate: null as string | null, fromAthPct: null as number | null, atl: null as number | null, atlDate: null as string | null,
    supply: { circulating: num(q?.circulating_supply), total: num(q?.total_supply), max: num(q?.max_supply) },
    links: { homepage: (urls.website ?? [])[0] ?? null, twitter: (urls.twitter ?? [])[0] ?? null },
    platforms: byRoutedChain(((info?.contract_address ?? []) as any[]).map((c) => ({ chain: String(c.platform?.name ?? c.platform?.coin?.slug ?? ""), address: String(c.contract_address ?? "") })).filter((p) => p.chain && p.address)).slice(0, 6),
    genesisDate: (info?.date_launched ?? info?.date_added ?? null)?.slice?.(0, 10) ?? null,
    description: desc ? (desc.length > 500 ? `${desc.slice(0, 497)}…` : desc) : null,
    sparkline7d: [] as number[],
    change60d: r2(u.percent_change_60d), change90d: r2(u.percent_change_90d), marketCapDominancePct: r2(u.market_cap_dominance),
    cexVolume24hUsd: num(u.cex_volume_24h), dexVolume24hUsd: num(u.dex_volume_24h),
    lastUpdated: u.last_updated ?? null, ageS,
  };
}
export async function coinDetailCmc(ref: CmcRef) {
  const [q, info] = await Promise.all([
    cmc<any>("/v2/cryptocurrency/quotes/latest", { id: ref.cmcId }, 90),
    cmc<any>("/v2/cryptocurrency/info", { id: ref.cmcId }, 86_400).catch(() => null),
  ]);
  return shapeCoin(ref, q.data?.[String(ref.cmcId)], info?.data?.[String(ref.cmcId)], q.ageS);
}

/** A listings / category row → coingecko's market row (rank from the row, else the map). */
export function shapeRow(c: any, rankOf?: (id: number) => number | null): CgMarketRow {
  const u = c?.quote?.USD ?? {};
  return {
    id: String(c.slug ?? c.id), symbol: String(c.symbol ?? "").toUpperCase(), name: String(c.name ?? ""), image: cmcLogo(Number(c.id)),
    rank: c.cmc_rank ?? rankOf?.(Number(c.id)) ?? null, priceUsd: num(u.price), marketCapUsd: num(u.market_cap), volume24hUsd: num(u.volume_24h),
    h1: r2(u.percent_change_1h), h24: r2(u.percent_change_24h), d7: r2(u.percent_change_7d), d30: r2(u.percent_change_30d), fromAthPct: null,
  };
}

export interface CmcCategory { id: string; name: string; marketCapUsd: number; h24: number | null; volume24hUsd: number | null; top: string[]; tokens: number | null }
export async function categoriesCmc(): Promise<CmcCategory[]> {
  const { data } = await cmc<any[]>("/v1/cryptocurrency/categories", { limit: 400 }, 600);
  return (data ?? []).filter((c) => Number(c.market_cap) > 0).map((c) => ({
    id: String(c.id), name: String(c.title ?? c.name), marketCapUsd: Number(c.market_cap), h24: r2(c.market_cap_change), volume24hUsd: num(c.volume),
    top: [`${c.num_tokens ?? "?"} tokens`], tokens: num(c.num_tokens),
  }));
}
/** A CMC category id, or a name / CoinGecko-style id ("meme-token", "artificial-intelligence") → the CMC category. */
export function matchCategory(q: string, cats: CmcCategory[]): CmcCategory | null {
  const norm = (s: string) => s.toLowerCase().replace(/-?(token|tokens|coins?)$/, "").replace(/[^a-z0-9]+/g, "");
  const n = norm(q);
  if (!n) return null;
  return cats.find((c) => c.id === q)
    ?? cats.find((c) => norm(c.name) === n)
    ?? (n === "ai" || n === "artificialintelligence" ? cats.find((c) => /^ai & big data$/i.test(c.name)) : undefined)
    ?? cats.filter((c) => norm(c.name).startsWith(n) || n.startsWith(norm(c.name))).sort((a, b) => b.marketCapUsd - a.marketCapUsd)[0]
    ?? null;
}

export async function marketsCmc(opts: { category?: string; order?: "market_cap_desc" | "volume_desc"; perPage?: number }): Promise<CgMarketRow[] | null> {
  const limit = Math.min(250, Math.max(1, opts.perPage ?? 50));
  const rows = await coinMap().catch(() => [] as MapRow[]);
  const rankOf = (id: number) => rows.find((r) => r[0] === id)?.[4] ?? null;
  if (opts.category) {
    const cat = matchCategory(opts.category, await categoriesCmc());
    if (!cat) return null; // not a CMC category — let CoinGecko try its own ids
    const { data } = await cmc<any>("/v1/cryptocurrency/category", { id: cat.id, limit: Math.min(200, limit) }, 120);
    const out = ((data?.coins ?? []) as any[]).map((c) => shapeRow(c, rankOf));
    return opts.order === "volume_desc" ? out.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)) : out.sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));
  }
  const { data } = await cmc<any[]>("/v1/cryptocurrency/listings/latest", { limit, sort: opts.order === "volume_desc" ? "volume_24h" : "market_cap" }, 90);
  return (data ?? []).map((c) => shapeRow(c));
}

/** Same shape as coingecko.globalStats, plus the fear & greed index and the altcoin-season index. */
export async function globalCmc() {
  const [{ data: g }, fg, alt] = await Promise.all([
    cmc<any>("/v1/global-metrics/quotes/latest", {}, 180),
    cmc<any>("/v3/fear-and-greed/latest", {}, 1800).then((x) => x.data).catch(() => null),
    cmc<any>("/v1/altcoin-season-index/latest", {}, 1800).then((x) => x.data).catch(() => null),
  ]);
  const u = g?.quote?.USD ?? {};
  const total = num(u.total_market_cap);
  const stable = num(u.stablecoin_market_cap ?? g?.stablecoin_market_cap);
  const dom = [{ symbol: "BTC", pct: r2(g?.btc_dominance) }, { symbol: "ETH", pct: r2(g?.eth_dominance) }, ...(total && stable ? [{ symbol: "Stablecoins", pct: r2((stable / total) * 100) }] : [])];
  return {
    totalMarketCapUsd: total, totalVolume24hUsd: num(u.total_volume_24h), marketCapChange24hPct: r2(u.total_market_cap_yesterday_percentage_change),
    activeCoins: g?.active_cryptocurrencies ?? null, dominance: dom,
    defi: num(u.defi_market_cap) ? { marketCapUsd: num(u.defi_market_cap), dominancePct: total ? r2((num(u.defi_market_cap)! / total) * 100) : null, topCoin: null } : null,
    stablecoinMarketCapUsd: stable, derivativesVolume24hUsd: num(u.derivatives_volume_24h),
    fearGreed: fg ? { value: num(fg.value), label: String(fg.value_classification ?? "") } : null,
    altcoinSeason: alt ? { index: num(alt.altcoin_index), yearlyHigh: num(alt.yearly_high), yearlyLow: num(alt.yearly_low), note: "≥ 75 = altcoin season, ≤ 25 = bitcoin season" } : null,
  };
}

/** Price series [ms, price] over `days` (≤ 365 on this plan): hourly up to 7 days, daily beyond. */
export async function historyCmc(ref: CmcRef, days: number): Promise<[number, number][]> {
  const d = Math.min(365, Math.max(1, Math.round(days)));
  const hourly = d <= 7;
  const { data } = await cmc<any>("/v2/cryptocurrency/quotes/historical", { id: ref.cmcId, interval: hourly ? "hourly" : "daily", count: hourly ? d * 24 : d }, d <= 1 ? 120 : 600);
  const quotes = (data?.quotes ?? data?.[String(ref.cmcId)]?.quotes ?? []) as any[];
  const pts = quotes.map((q) => [Date.parse(q.timestamp), Number(q.quote?.USD?.price)] as [number, number]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0]);
  // Daily points stop at today's 00:00 UTC — without the live quote a coin above its window high reads as "92 % of the range"
  // (live check 2026-09-26, SUI). Same cache key as cg_coin's quote, so usually free.
  const live = await cmc<any>("/v2/cryptocurrency/quotes/latest", { id: ref.cmcId }, 90).then((x) => x.data?.[String(ref.cmcId)]?.quote?.USD).catch(() => null);
  const t = Date.parse(live?.last_updated ?? ""), p = Number(live?.price);
  if (pts.length && Number.isFinite(t) && Number.isFinite(p) && p > 0 && t > pts[pts.length - 1][0]) pts.push([t, p]);
  return pts;
}
