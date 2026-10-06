// DefiLlama for Chord Ask (owner 2026-09-26: "cho defi llama vào harness luôn"). Separate from services/defillama.ts, which
// feeds the Monad DeFi board. Free public API, no key: TVL per protocol and chain, fees / revenue / DEX volume rankings,
// stablecoin supply, and DeFi yields across chains — what CoinMarketCap and CoinGecko do not answer ("does X make real money",
// "where is TVL moving", "best stable yield on Arbitrum").
//
// The per-protocol endpoint (/protocol/{slug}) is 10 MB with the full TVL history, and the pool list is 12 MB, so tools never
// call them per question: whole lists are fetched at most every 30 minutes by ONE in-flight request (single-flight), slimmed,
// and kept in Redis (`llama:v2:{name}`, stale copy ≤ 12 h served when DefiLlama is slow or down). Measured 2026-09-26:
// protocols 8.4k (9 MB), fees 2.8k / revenue 2.4k / dexs 1.4k protocols (2–4.5 MB), 17k pools (2.8k with TVL ≥ $1M),
// 427 stablecoins, 467 chains.
import { getRedis } from "../utils/redis";
import { logger } from "../utils/logger";

const FRESH_S = 30 * 60;
const STALE_S = 12 * 3600;
const r2 = (v: unknown) => { const x = Number(v); return v == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100; };
const usd = (v: unknown) => { const x = Number(v); return v == null || !Number.isFinite(x) ? null : Math.round(x); };

const inflight = new Map<string, Promise<unknown>>();
// The parsed list stays in memory too (protocols is ~2 MB of JSON in Redis — not re-parsed per question).
const mem = new Map<string, { t: number; d: unknown }>();
/** A slimmed list, cached: fresh ≤ 30 min, stale ≤ 12 h if the refetch fails; one fetch at a time per list. */
async function cachedList<T>(name: string, url: string, slim: (raw: any) => T): Promise<{ data: T; ageS: number }> {
  const key = `llama:v2:${name}`;
  const now = Math.floor(Date.now() / 1000);
  let cached = (mem.get(key) as { t: number; d: T } | undefined) ?? null;
  if (!cached || now - cached.t >= FRESH_S) {
    try { const raw = await getRedis().get(key); if (raw) { cached = JSON.parse(raw); mem.set(key, cached!); } } catch { /* fetch */ }
  }
  if (cached && now - cached.t < FRESH_S) return { data: cached.d, ageS: now - cached.t };
  const run = (inflight.get(key) as Promise<T> | undefined) ?? (async () => {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "chord-ask/1.0" }, signal: AbortSignal.timeout(25_000) });
      if (!res.ok) throw new Error(`DefiLlama ${res.status}`);
      const d = slim(await res.json());
      const row = { t: Math.floor(Date.now() / 1000), d };
      mem.set(key, row);
      await getRedis().set(key, JSON.stringify(row), "EX", STALE_S).catch(() => {});
      return d;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, run);
  try { return { data: await run, ageS: 0 }; } catch (e) {
    logger.debug({ err: String(e), name }, "askLlama: fetch failed");
    if (cached) return { data: cached.d, ageS: now - cached.t };
    throw new Error("DefiLlama is not answering right now");
  }
}

// ── protocols (TVL) ─────────────────────────────────────────────────────────────────────────────────────
export interface AskLlamaProtocol { name: string; slug: string; symbol: string | null; category: string | null; tvl: number | null; change1d: number | null; change7d: number | null; mcap: number | null; chains: { chain: string; tvl: number }[]; parent: string | null }
const SKIP_CHAIN = /-|^(borrowed|staking|pool2|vesting|treasury|offers|doublecounted|liquidstaking|dcandlsoverlap|ownTokens)$/i;
export function slimProtocols(raw: any[]): AskLlamaProtocol[] {
  return (raw ?? []).map((p) => ({
    name: String(p.name ?? ""), slug: String(p.slug ?? ""), symbol: p.symbol && p.symbol !== "-" ? String(p.symbol) : null, category: p.category ?? null,
    tvl: usd(p.tvl), change1d: r2(p.change_1d), change7d: r2(p.change_7d), mcap: usd(p.mcap), parent: p.parentProtocol ?? null,
    chains: Object.entries((p.chainTvls ?? {}) as Record<string, number>).filter(([k, v]) => !SKIP_CHAIN.test(k) && Number(v) > 0).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([chain, v]) => ({ chain, tvl: Math.round(v) })),
  })).filter((p) => p.name);
}
export const protocols = () => cachedList("protocols", "https://api.llama.fi/protocols", slimProtocols);

// ── fees / revenue / DEX volume ─────────────────────────────────────────────────────────────────────────
export type FlowKind = "fees" | "revenue" | "dex_volume";
export interface LlamaFlow { name: string; slug: string; category: string | null; d24: number | null; d7: number | null; d30: number | null; change1d: number | null; change7d: number | null; chains: string[]; parent: string | null }
export function slimFlows(raw: any): LlamaFlow[] {
  return ((raw?.protocols ?? []) as any[]).map((p) => ({
    name: String(p.displayName ?? p.name ?? ""), slug: String(p.slug ?? p.module ?? ""), category: p.category ?? null, d24: usd(p.total24h), d7: usd(p.total7d), d30: usd(p.total30d),
    change1d: r2(p.change_1d), change7d: r2(p.change_7d), chains: ((p.chains ?? []) as string[]).slice(0, 6), parent: p.parentProtocol ?? null,
  })).filter((p) => p.name);
}
const FLOW_URL: Record<FlowKind, string> = {
  fees: "https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true",
  revenue: "https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyRevenue",
  dex_volume: "https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true",
};
export const flows = (kind: FlowKind) => cachedList(`flows:${kind}`, FLOW_URL[kind], slimFlows);

// ── chains, stablecoins, yields ─────────────────────────────────────────────────────────────────────────
export const chains = () => cachedList("chains", "https://api.llama.fi/v2/chains", (raw: any[]) => (raw ?? []).map((c) => ({ name: String(c.name), tvl: usd(c.tvl), token: c.tokenSymbol ?? null })).filter((c) => (c.tvl ?? 0) > 0).sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0)));
export async function chainTvlChange(chain: string): Promise<{ d7: number | null; d30: number | null } | null> {
  const safe = chain.replace(/[^A-Za-z0-9 .-]/g, "").slice(0, 40);
  if (!safe) return null;
  const { data } = await cachedList(`chainhist:${safe.toLowerCase()}`, `https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(safe)}`, (raw: any[]) => (raw ?? []).slice(-31).map((p) => [Number(p.date), Number(p.tvl)] as [number, number]));
  if (data.length < 2) return null;
  const last = data[data.length - 1][1];
  const at = (n: number) => (data.length > n ? data[data.length - 1 - n][1] : null);
  const pct = (v: number | null) => (v && v > 0 ? r2((last / v - 1) * 100) : null);
  return { d7: pct(at(7)), d30: pct(at(30)) };
}

export interface LlamaStable { name: string; symbol: string; peg: string; mechanism: string | null; supply: number; d1: number | null; d7: number | null; d30: number | null; price: number | null }
export function slimStables(raw: any): LlamaStable[] {
  const v = (o: any, peg: string) => (o && typeof o === "object" ? Number(o[peg]) || 0 : 0);
  return ((raw?.peggedAssets ?? []) as any[]).map((s) => {
    const peg = String(s.pegType ?? "peggedUSD"), now = v(s.circulating, peg);
    const ch = (prev: number) => (prev > 0 ? r2((now / prev - 1) * 100) : null);
    return { name: String(s.name), symbol: String(s.symbol), peg: peg.replace(/^pegged/, ""), mechanism: s.pegMechanism ?? null, supply: Math.round(now), d1: ch(v(s.circulatingPrevDay, peg)), d7: ch(v(s.circulatingPrevWeek, peg)), d30: ch(v(s.circulatingPrevMonth, peg)), price: s.price == null ? null : Number(s.price) };
  }).filter((s) => s.supply > 0).sort((a, b) => b.supply - a.supply);
}
export const stablecoins = () => cachedList("stables", "https://stablecoins.llama.fi/stablecoins?includePrices=true", slimStables);

export interface LlamaPool { chain: string; project: string; symbol: string; tvl: number; apy: number | null; apyBase: number | null; apyReward: number | null; apy30d: number | null; stable: boolean; il: string | null; exposure: string | null; meta: string | null }
export function slimPools(raw: any): LlamaPool[] {
  return ((raw?.data ?? []) as any[]).filter((p) => Number(p.tvlUsd) >= 1_000_000).map((p) => ({
    chain: String(p.chain), project: String(p.project), symbol: String(p.symbol), tvl: Math.round(Number(p.tvlUsd)), apy: r2(p.apy), apyBase: r2(p.apyBase), apyReward: r2(p.apyReward),
    apy30d: r2(p.apyMean30d), stable: !!p.stablecoin, il: p.ilRisk ?? null, exposure: p.exposure ?? null, meta: p.poolMeta ?? null,
  }));
}
export const pools = () => cachedList("pools", "https://yields.llama.fi/pools", slimPools);

// ── picking (pure, tested) ──────────────────────────────────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** Name / slug / ticker → the protocol, biggest TVL first among exact hits. */
export function findProtocol(q: string, list: AskLlamaProtocol[]): AskLlamaProtocol | null {
  const n = norm(q.replace(/^\$/, ""));
  if (!n) return null;
  const byTvl = (a: AskLlamaProtocol, b: AskLlamaProtocol) => (b.tvl ?? 0) - (a.tvl ?? 0);
  return list.filter((p) => norm(p.slug) === n || norm(p.name) === n).sort(byTvl)[0]
    ?? list.filter((p) => p.symbol && norm(p.symbol) === n).sort(byTvl)[0]
    ?? list.filter((p) => norm(p.name).startsWith(n) && n.length >= 3).sort(byTvl)[0]
    ?? null;
}
export function findFlow(p: { name: string; slug: string }, list: LlamaFlow[]): LlamaFlow | null {
  const a = norm(p.slug), b = norm(p.name);
  return list.find((f) => norm(f.slug) === a) ?? list.find((f) => norm(f.name) === b) ?? list.filter((f) => norm(f.name).startsWith(b) && b.length >= 3).sort((x, y) => (y.d24 ?? 0) - (x.d24 ?? 0))[0] ?? null;
}
export function rankFlows(list: LlamaFlow[], opts: { category?: string; chain?: string; limit?: number }): LlamaFlow[] {
  const cat = opts.category ? norm(opts.category) : null, ch = opts.chain ? norm(opts.chain) : null;
  // L1 gas-fee rows ("Chain") sit in the same list; they rank only when that category is asked for.
  return list.filter((f) => (f.d24 ?? 0) > 0 && (cat ? norm(f.category ?? "").includes(cat) : f.category !== "Chain") && (!ch || f.chains.some((c) => norm(c) === ch)))
    .sort((a, b) => (b.d24 ?? 0) - (a.d24 ?? 0)).slice(0, Math.max(1, Math.min(30, opts.limit ?? 12)));
}
export function rankTvl(list: AskLlamaProtocol[], opts: { category?: string; chain?: string; limit?: number }): AskLlamaProtocol[] {
  const cat = opts.category ? norm(opts.category) : null, ch = opts.chain ? norm(opts.chain) : null;
  const onChain = (p: AskLlamaProtocol) => p.chains.find((c) => norm(c.chain) === ch)?.tvl ?? 0;
  return list.filter((p) => (p.tvl ?? 0) > 0 && p.category !== "CEX" && (!cat || norm(p.category ?? "").includes(cat)) && (!ch || onChain(p) > 0))
    .sort((a, b) => (ch ? onChain(b) - onChain(a) : (b.tvl ?? 0) - (a.tvl ?? 0)))
    .slice(0, Math.max(1, Math.min(30, opts.limit ?? 12)));
}
/** Yields that are real: TVL floor, no absurd APY (> 1,000 %), the reward share visible, sorted by APY. */
export function pickPools(list: LlamaPool[], o: { token?: string; chain?: string; project?: string; stableOnly?: boolean; minTvl?: number; limit?: number }): LlamaPool[] {
  const tok = o.token ? o.token.toUpperCase().replace(/^\$/, "") : null, ch = o.chain ? norm(o.chain) : null, pr = o.project ? norm(o.project) : null;
  const minTvl = Math.max(1_000_000, o.minTvl ?? 5_000_000);
  return list.filter((p) => p.tvl >= minTvl && p.apy != null && p.apy > 0 && p.apy < 1000
      && (!tok || p.symbol.toUpperCase().split(/[-_/ ]+/).includes(tok)) && (!ch || norm(p.chain) === ch) && (!pr || norm(p.project).startsWith(pr)) && (!o.stableOnly || p.stable))
    .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0)).slice(0, Math.max(1, Math.min(25, o.limit ?? 12)));
}

/** A protocol, or a family ("uniswap" = Uniswap V1–V4, "hyperliquid" = Bridge + HLP + Spot …) summed, as DefiLlama's
 *  parent page does. A family needs ≥ 2 members and no protocol of that exact name. */
export interface ProtocolView extends AskLlamaProtocol { family: boolean; members: { name: string; slug: string; category: string | null; tvl: number | null }[] }
const prevOf = (v: number | null, ch: number | null) => (v != null && ch != null && ch > -100 ? v / (1 + ch / 100) : null);
export function resolveProtocol(q: string, list: AskLlamaProtocol[]): ProtocolView | null {
  const n = norm(q.replace(/^\$/, ""));
  if (!n) return null;
  const exact = list.find((p) => norm(p.slug) === n || norm(p.name) === n);
  const kids = list.filter((p) => p.parent && norm(p.parent.replace(/^parent#/, "")) === n).sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  if (exact || kids.length < 2) {
    const p = exact ?? kids[0] ?? findProtocol(q, list);
    return p ? { ...p, family: false, members: [] } : null;
  }
  const tvl = kids.reduce((s, k) => s + (k.tvl ?? 0), 0);
  const change = (pick: (k: AskLlamaProtocol) => number | null) => {
    let now = 0, prev = 0;
    for (const k of kids) { const pv = prevOf(k.tvl, pick(k)); if (pv != null && k.tvl != null) { now += k.tvl; prev += pv; } }
    return prev > 0 ? r2((now / prev - 1) * 100) : null;
  };
  const byChain = new Map<string, number>();
  for (const k of kids) for (const c of k.chains) byChain.set(c.chain, (byChain.get(c.chain) ?? 0) + c.tvl);
  const top = kids[0];
  return {
    name: top.parent!.replace(/^parent#/, "").replace(/(^|-)([a-z])/g, (_m, d, c) => `${d ? " " : ""}${c.toUpperCase()}`), slug: top.parent!.replace(/^parent#/, ""),
    symbol: kids.find((k) => k.symbol)?.symbol ?? null, category: top.category, tvl, change1d: change((k) => k.change1d), change7d: change((k) => k.change7d),
    mcap: kids.reduce<number | null>((m, k) => (k.mcap != null && (m == null || k.mcap > m) ? k.mcap : m), null), parent: null,
    chains: [...byChain].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([chain, v]) => ({ chain, tvl: v })),
    family: true, members: kids.slice(0, 8).map((k) => ({ name: k.name, slug: k.slug, category: k.category, tvl: k.tvl })),
  };
}
/** Fees / revenue / volume of a protocol or a family (members summed by parent id). */
export function flowOf(v: { name: string; slug: string; family: boolean }, list: LlamaFlow[]): { d24: number | null; d7: number | null; d30: number | null; change1d: number | null; members: string[] } | null {
  if (!v.family) {
    const f = findFlow(v, list);
    return f ? { d24: f.d24, d7: f.d7, d30: f.d30, change1d: f.change1d, members: [f.name] } : null;
  }
  const n = norm(v.slug);
  const kids = list.filter((f) => f.parent && norm(f.parent.replace(/^parent#/, "")) === n);
  if (!kids.length) { const f = findFlow(v, list); return f ? { d24: f.d24, d7: f.d7, d30: f.d30, change1d: f.change1d, members: [f.name] } : null; }
  const sum = (pick: (f: LlamaFlow) => number | null) => kids.reduce<number | null>((s, f) => (pick(f) == null ? s : (s ?? 0) + pick(f)!), null);
  let now = 0, prev = 0;
  for (const f of kids) { const pv = prevOf(f.d24, f.change1d); if (pv != null && f.d24 != null) { now += f.d24; prev += pv; } }
  return { d24: sum((f) => f.d24), d7: sum((f) => f.d7), d30: sum((f) => f.d30), change1d: prev > 0 ? r2((now / prev - 1) * 100) : null, members: kids.filter((f) => (f.d30 ?? 0) > 0).map((f) => f.name) };
}

const CHAIN_ALIAS: Record<string, string> = { eth: "ethereum", mainnet: "ethereum", sol: "solana", arb: "arbitrum", op: "optimism", avax: "avalanche", bnb: "bsc", bnbchain: "bsc", binance: "bsc", matic: "polygon", hl: "hyperliquidl1", hype: "hyperliquidl1", hyperevm: "hyperliquidl1" };
/** A chain name as the user writes it → DefiLlama's name ("hyperliquid" → "Hyperliquid L1"); the list is TVL-sorted, so a prefix hit is the biggest. */
export function findChain<T extends { name: string }>(q: string, list: T[]): T | null {
  const raw = norm(q);
  const n = CHAIN_ALIAS[raw] ?? raw;
  if (!n) return null;
  return list.find((c) => norm(c.name) === n) ?? list.find((c) => n.length >= 3 && norm(c.name).startsWith(n)) ?? null;
}
