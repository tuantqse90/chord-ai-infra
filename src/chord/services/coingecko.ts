// CoinGecko for Chord Ask (owner 2026-09-25: "Minara còn tích hợp CoinGecko APIs, mình cũng tích hợp luôn").
// Covers what our own index and Hyperliquid do not: ANY listed coin (price, market cap, rank, FDV, supply,
// ATH/ATL, categories, links, 7-day sparkline), the top-N board by market cap or category, 24h gainers and
// losers, CoinGecko trending, global market cap / dominance / DeFi, sector ranking, and price history.
//
// Key: COINGECKO_API_KEY + COINGECKO_PLAN (demo | pro). No key = the public API (~10–30 calls/min per IP,
// shared by the whole box) — every call is cached in Redis (`cg:v1:*`, fresh TTL per endpoint) and a stale
// copy up to 6 h old is served when the per-minute budget (COINGECKO_RPM) is spent or CoinGecko answers
// 429 (then `cg:backoff` pauses calls for 60 s). CoinGecko's terms want attribution: every tool cites it.
import { getRedis } from "../utils/redis";
import { logger } from "../utils/logger";

const plan = () => (process.env.COINGECKO_PLAN === "pro" ? "pro" : process.env.COINGECKO_API_KEY ? "demo" : "public");
const base = () => (plan() === "pro" ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3");
const rpm = () => { const v = Number(process.env.COINGECKO_RPM); return Number.isFinite(v) && v > 0 ? v : plan() === "pro" ? 400 : plan() === "demo" ? 28 : 12; };
const STALE_S = 6 * 3600;

async function budgetOk(): Promise<boolean> {
  try {
    const r = getRedis();
    if (await r.get("cg:backoff")) return false;
    const k = `cg:rl:${Math.floor(Date.now() / 60_000)}`;
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, 90);
    return n <= rpm();
  } catch { return true; }
}

/** GET a CoinGecko path, cached: fresh within `ttl` seconds, stale (≤ 6 h) when the budget or CoinGecko says no. */
export async function cg<T = any>(path: string, params: Record<string, string | number | boolean | undefined>, ttl: number): Promise<{ data: T; ageS: number }> {
  const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).sort().join("&");
  const key = `cg:v1:${path}?${qs}`;
  const now = Math.floor(Date.now() / 1000);
  let cached: { t: number; d: T } | null = null;
  try { const raw = await getRedis().get(key); if (raw) cached = JSON.parse(raw); } catch { /* fetch */ }
  if (cached && now - cached.t < ttl) return { data: cached.d, ageS: now - cached.t };
  if (!(await budgetOk())) {
    if (cached) return { data: cached.d, ageS: now - cached.t };
    throw new Error("CoinGecko is rate-limited right now");
  }
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "chord-ask/1.0" };
  const k = process.env.COINGECKO_API_KEY;
  if (k) headers[plan() === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = k;
  try {
    const res = await fetch(`${base()}${path}${qs ? `?${qs}` : ""}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 429) { await getRedis().set("cg:backoff", "1", "EX", 60).catch(() => {}); throw new Error("CoinGecko 429"); }
    if (res.status === 404) throw Object.assign(new Error("not found"), { notFound: true });
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const d = (await res.json()) as T;
    await getRedis().set(key, JSON.stringify({ t: now, d }), "EX", STALE_S).catch(() => {});
    return { data: d, ageS: 0 };
  } catch (e) {
    if ((e as { notFound?: boolean }).notFound) throw e;
    logger.debug({ err: String(e), path }, "coingecko: call failed");
    if (cached) return { data: cached.d, ageS: now - cached.t };
    throw e;
  }
}

export interface CgRef { id: string; symbol: string; name: string; rank: number | null; thumb: string | null }
/** "sui", "SUI", "render", "pepe", a CoinGecko id → the coin people mean: exact symbol with the best market-cap
 *  rank, else exact name, else the search's first hit. Ranked coins win over unranked impostors of a symbol. */
export async function resolveCoin(q: string): Promise<CgRef | null> {
  const query = q.trim().replace(/^\$/, "").slice(0, 60);
  if (!query) return null;
  const { data } = await cg<{ coins: { id: string; symbol: string; name: string; market_cap_rank: number | null; thumb?: string }[] }>("/search", { query }, 86_400);
  return pickCoin(query, (data.coins ?? []).map((c) => ({ id: c.id, symbol: c.symbol, name: c.name, rank: c.market_cap_rank ?? null, thumb: c.thumb ?? null })));
}
/** The choice itself (pure — tested). Ranked coins first; an unranked coin only on an exact ticker / id / name match —
 *  a partial hit on an unranked coin is not an answer (self-test 2026-09-26: "fetch" resolved to a $20k "Fetchr" instead of
 *  Fetch.ai, whose ticker FET resolves fine), so null lets the model retry with the ticker. */
export function pickCoin(query: string, coins: CgRef[]): CgRef | null {
  if (!coins.length) return null;
  const lq = query.trim().replace(/^\$/, "").toLowerCase();
  const byRank = (a: CgRef, b: CgRef) => (a.rank ?? 1e9) - (b.rank ?? 1e9);
  const ranked = coins.filter((c) => c.rank != null);
  const sym = (c: CgRef) => c.symbol.toLowerCase() === lq, nm = (c: CgRef) => c.name.toLowerCase() === lq;
  return ranked.filter(sym).sort(byRank)[0]
    ?? coins.find((c) => c.id === lq)
    ?? ranked.filter(nm).sort(byRank)[0]
    ?? coins.filter(sym).sort(byRank)[0]
    ?? coins.filter(nm).sort(byRank)[0]
    ?? (coins[0].rank != null ? coins[0] : null);
}

const usd = (o: any): number | null => (o && typeof o.usd === "number" ? o.usd : null);
const r2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

export async function coinDetail(id: string) {
  const { data: d, ageS } = await cg<any>(`/coins/${encodeURIComponent(id)}`, { localization: false, tickers: false, community_data: false, developer_data: false, sparkline: true }, 120);
  const m = d.market_data ?? {};
  const desc = String(d.description?.en ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return {
    id: d.id as string, symbol: String(d.symbol ?? "").toUpperCase(), name: d.name as string, rank: d.market_cap_rank ?? null,
    image: d.image?.small ?? null, categories: (d.categories ?? []).filter(Boolean).slice(0, 6) as string[],
    priceUsd: usd(m.current_price), marketCapUsd: usd(m.market_cap), fdvUsd: usd(m.fully_diluted_valuation), volume24hUsd: usd(m.total_volume),
    change: { h1: r2(m.price_change_percentage_1h_in_currency?.usd), h24: r2(m.price_change_percentage_24h), d7: r2(m.price_change_percentage_7d), d30: r2(m.price_change_percentage_30d), y1: r2(m.price_change_percentage_1y) },
    high24h: usd(m.high_24h), low24h: usd(m.low_24h),
    ath: usd(m.ath), athDate: (m.ath_date?.usd ?? "").slice(0, 10) || null, fromAthPct: r2(m.ath_change_percentage?.usd),
    atl: usd(m.atl), atlDate: (m.atl_date?.usd ?? "").slice(0, 10) || null,
    supply: { circulating: m.circulating_supply ?? null, total: m.total_supply ?? null, max: m.max_supply ?? null },
    links: { homepage: (d.links?.homepage ?? []).find(Boolean) ?? null, twitter: d.links?.twitter_screen_name ? `https://x.com/${d.links.twitter_screen_name}` : null },
    platforms: byRoutedChain(Object.entries(d.platforms ?? {}).filter(([k, v]) => k && v).map(([chain, address]) => ({ chain, address: String(address) }))).slice(0, 6),
    genesisDate: d.genesis_date ?? null,
    description: desc ? (desc.length > 500 ? `${desc.slice(0, 497)}…` : desc) : null,
    sparkline7d: (m.sparkline_7d?.price ?? []) as number[],
    lastUpdated: d.last_updated ?? null, ageS,
  };
}

export interface CgMarketRow { id: string; symbol: string; name: string; image: string | null; rank: number | null; priceUsd: number | null; marketCapUsd: number | null; volume24hUsd: number | null; h1: number | null; h24: number | null; d7: number | null; d30: number | null; fromAthPct: number | null }
export async function markets(opts: { category?: string; order?: "market_cap_desc" | "volume_desc"; perPage?: number; page?: number; ids?: string[] } = {}): Promise<CgMarketRow[]> {
  const { data } = await cg<any[]>("/coins/markets", {
    vs_currency: "usd", order: opts.order ?? "market_cap_desc", per_page: Math.min(250, Math.max(1, opts.perPage ?? 50)), page: opts.page ?? 1,
    price_change_percentage: "1h,24h,7d,30d", category: opts.category, ids: opts.ids?.join(","),
  }, 90);
  return (Array.isArray(data) ? data : []).map((c) => ({
    id: c.id, symbol: String(c.symbol ?? "").toUpperCase(), name: c.name, image: c.image ?? null, rank: c.market_cap_rank ?? null,
    priceUsd: c.current_price ?? null, marketCapUsd: c.market_cap ?? null, volume24hUsd: c.total_volume ?? null,
    h1: r2(c.price_change_percentage_1h_in_currency), h24: r2(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
    d7: r2(c.price_change_percentage_7d_in_currency), d30: r2(c.price_change_percentage_30d_in_currency), fromAthPct: r2(c.ath_change_percentage),
  }));
}

/** "$20,262,656" (trending returns strings) or a number → number. */
const money = (v: unknown): number | null => { if (typeof v === "number") return v; const n = Number(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null; };
export async function trending() {
  const { data } = await cg<any>("/search/trending", {}, 300);
  const coins = (data.coins ?? []).slice(0, 15).map((x: any) => {
    const c = x.item ?? {};
    return { id: c.id, symbol: String(c.symbol ?? "").toUpperCase(), name: c.name, rank: c.market_cap_rank ?? null, image: c.small ?? c.thumb ?? null,
      priceUsd: money(c.data?.price), h24: r2(c.data?.price_change_percentage_24h?.usd), marketCapUsd: money(c.data?.market_cap), volume24hUsd: money(c.data?.total_volume) };
  });
  const categories = (data.categories ?? []).slice(0, 6).map((c: any) => ({ name: c.name, h24: r2(c.data?.market_cap_change_percentage_24h?.usd), marketCapUsd: money(c.data?.market_cap), coins: c.coins_count ?? null }));
  return { coins, categories };
}

export async function globalStats() {
  const [{ data: g }, defi] = await Promise.all([
    cg<any>("/global", {}, 180),
    cg<any>("/global/decentralized_finance_defi", {}, 600).catch(() => null),
  ]);
  const d = g.data ?? {};
  const dom = d.market_cap_percentage ?? {};
  return {
    totalMarketCapUsd: d.total_market_cap?.usd ?? null, totalVolume24hUsd: d.total_volume?.usd ?? null,
    marketCapChange24hPct: r2(d.market_cap_change_percentage_24h_usd), activeCoins: d.active_cryptocurrencies ?? null,
    dominance: Object.entries(dom).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 6).map(([k, v]) => ({ symbol: k.toUpperCase(), pct: r2(Number(v)) })),
    defi: defi ? { marketCapUsd: Number(defi.data.data?.defi_market_cap) || null, dominancePct: r2(Number(defi.data.data?.defi_dominance)), topCoin: defi.data.data?.top_coin_name ?? null } : null,
  };
}

export async function categories() {
  const { data } = await cg<any[]>("/coins/categories", {}, 600);
  return (Array.isArray(data) ? data : []).filter((c) => c.market_cap > 0).map((c) => ({
    id: c.id as string, name: c.name as string, marketCapUsd: c.market_cap as number, h24: r2(c.market_cap_change_24h), volume24hUsd: c.volume_24h ?? null,
    top: (c.top_3_coins_id ?? []).slice(0, 3) as string[],
  }));
}

export async function priceHistory(id: string, days: number) {
  const { data } = await cg<any>(`/coins/${encodeURIComponent(id)}/market_chart`, { vs_currency: "usd", days: Math.min(365, Math.max(1, Math.round(days))) }, days <= 1 ? 120 : 600);
  const pts = ((data.prices ?? []) as [number, number][]).filter((p) => Number.isFinite(p[1]));
  return pts;
}

/** Range facts from a price series (pure — tested): change over the window, high/low, where price sits. */
export function rangeStats(pts: [number, number][]) {
  if (pts.length < 2) return null;
  const first = pts[0][1], last = pts[pts.length - 1][1];
  let hi = -Infinity, lo = Infinity, hiT = 0, loT = 0, peak = -Infinity, maxDd = 0;
  for (const [t, p] of pts) {
    if (p > hi) { hi = p; hiT = t; }
    if (p < lo) { lo = p; loT = t; }
    peak = Math.max(peak, p);
    maxDd = Math.min(maxDd, p / peak - 1);
  }
  return {
    changePct: r2((last / first - 1) * 100), high: hi, highDate: new Date(hiT).toISOString().slice(0, 10), low: lo, lowDate: new Date(loT).toISOString().slice(0, 10),
    fromHighPct: r2((last / hi - 1) * 100), fromLowPct: r2((last / lo - 1) * 100), positionInRangePct: hi > lo ? r2(((last - lo) / (hi - lo)) * 100) : null,
    maxDrawdownPct: r2(maxDd * 100),
  };
}

/** CoinGecko asset-platform ids of the chain-keyed chains (board #75). */
export const CG_PLATFORM: Record<number, string> = { 43114: "avalanche", 8453: "base", 56: "binance-smart-chain" };
/** A token's CoinGecko price by contract (cached 2 min, stale ≤ 6 h like every cg call). Null = CoinGecko does not list it. Board #75:
 *  the Ask trade panel for a token Chord's index has not seen trade (AAVE.e on Avalanche) showed "—". */
export async function tokenPriceByContract(chain: number, address: string): Promise<{ priceUsd: number; change24hPct: number | null; ageS: number } | null> {
  const platform = CG_PLATFORM[chain];
  if (!platform || !/^0x[0-9a-f]{40}$/.test(address)) return null;
  const { data, ageS } = await cg<Record<string, { usd?: number; usd_24h_change?: number }>>(`/simple/token_price/${platform}`, { contract_addresses: address, vs_currencies: "usd", include_24hr_change: true }, 120);
  const row = data?.[address] ?? data?.[address.toLowerCase()];
  if (!row || typeof row.usd !== "number" || !(row.usd > 0)) return null;
  return { priceUsd: row.usd, change24hPct: typeof row.usd_24h_change === "number" ? +row.usd_24h_change.toFixed(2) : null, ageS };
}

/** Platforms on a chain Chord trades or indexes first (Robinhood Chain, Arc, Avalanche, Base, BNB Chain, Monad), so the six kept
 *  include them — AAVE lists Avalanche after a dozen others. CoinGecko keys and CoinMarketCap names ("Avalanche C-Chain"). */
export function byRoutedChain<T extends { chain: string }>(ps: T[]): T[] {
  const routed = (c: string) => /robinhood|^arc\b|avalanche|^base\b|binance|^bnb|^bsc|monad/i.test(c);
  return [...ps.filter((p) => routed(p.chain)), ...ps.filter((p) => !routed(p.chain))];
}
