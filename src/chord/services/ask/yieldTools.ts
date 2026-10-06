// Ask tools for fixed / variable yield and lending (2026-10-03 tool-parity batch, docs/prompts/ask-tool-parity-2026-10.md):
//   pendle_markets · pendle_market · pendle_positions · morpho_vaults · morpho_markets · morpho_positions
// Built from the public docs and live responses of each source (clean room):
//   · Pendle core API (api-v2.pendle.finance/core, keyless, 200 computing units / min per IP, every call here costs 1–4).
//     `/v2/markets/all?isActive=true` is ONE call for every active market on every chain (83 on 2026-10-03, ~480 KB), cached
//     5 min and shared by the screen and the single-market lookup. Implied APY = the fixed rate a PT buyer locks if held to
//     expiry; `ptRoi` = PT return to expiry, so PT price in units of the asset it redeems to = 1 / (1 + ptRoi).
//   · Morpho GraphQL (api.morpho.org/graphql, keyless, bans abusers for days): small queries only, TTL ≥ 5 min, the box
//     budget is 15 calls / min (extHttp). Vaults come in two versions (V1 `vaults`, V2 `vaultV2s` — most new TVL is V2);
//     V2 has no asset-symbol filter, so a symbol is first resolved to addresses (one `assets` call cached 24 h) and both
//     versions + markets filter by address. Positions = one request with one `userByAddress` alias per chain.
// Third-party text (vault / market names, curator names, points programs) is short and trimmed; the tools are `untrusted`
// in the registry so an address inside that text never reaches the answer allowlist — the addresses the tool looked up
// travel in `addresses`. Analysis only: no tool here deposits, borrows or picks a vault for the person.

import type { Citation, Viz } from "../askAgent";
import type { ToolMeta } from "./registry";
import { ExtError, extFailure, extJson, num, qs, usdShort, type ExtToolResult } from "./extHttp";

const PENDLE_API = "https://api-v2.pendle.finance/core";
const MORPHO_API = "https://api.morpho.org/graphql";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DAY_MS = 86_400_000;

// ── chains ────────────────────────────────────────────────────────────────────────────────────────────────────
/** `pendle` / `morpho` = the chain's slug in that app's URLs (read off app.pendle.finance's router config and
 *  app.morpho.org links, 2026-10-03); absent = that protocol is not on the chain. */
export interface YieldChain { id: number; name: string; pendle?: string; morpho?: string }
export const YIELD_CHAINS: YieldChain[] = [
  { id: 1, name: "Ethereum", pendle: "ethereum", morpho: "ethereum" },
  { id: 10, name: "OP Mainnet", pendle: "optimism", morpho: "opmainnet" },
  { id: 56, name: "BNB Chain", pendle: "bnbchain" },
  { id: 130, name: "Unichain", pendle: "unichain", morpho: "unichain" },
  { id: 137, name: "Polygon", morpho: "polygon" },
  { id: 143, name: "Monad", pendle: "monad", morpho: "monad" },
  { id: 146, name: "Sonic", pendle: "sonic" },
  { id: 196, name: "X Layer", pendle: "xlayer" },
  { id: 480, name: "World Chain", morpho: "world-chain" },
  { id: 988, name: "Stable", morpho: "stable" },
  { id: 999, name: "HyperEVM", pendle: "hyperevm", morpho: "hyperevm" },
  { id: 4217, name: "Tempo", pendle: "tempo", morpho: "tempo" },
  { id: 4663, name: "Robinhood Chain", pendle: "robinhood", morpho: "robinhood-chain" },
  { id: 5000, name: "Mantle", pendle: "mantle" },
  { id: 5042, name: "Arc", morpho: "arc" },
  { id: 8453, name: "Base", pendle: "base", morpho: "base" },
  { id: 9745, name: "Plasma", pendle: "plasma" },
  { id: 42161, name: "Arbitrum", pendle: "arbitrum", morpho: "arbitrum" },
  { id: 43114, name: "Avalanche", pendle: "avalanche" },
  { id: 57073, name: "Ink", pendle: "ink" },
  { id: 80094, name: "Berachain", pendle: "bera" },
  { id: 747474, name: "Katana", pendle: "katana", morpho: "katana" },
];
const CHAIN_BY_ID = new Map(YIELD_CHAINS.map((c) => [c.id, c] as const));
const CHAIN_ALIASES: Record<string, number> = {
  eth: 1, ethereum: 1, mainnet: 1, "ethereum mainnet": 1, "eth mainnet": 1,
  op: 10, optimism: 10, "op mainnet": 10, opmainnet: 10,
  bsc: 56, bnb: 56, "bnb chain": 56, "bnb smart chain": 56, "binance smart chain": 56, binance: 56, bnbchain: 56, bep20: 56,
  unichain: 130, polygon: 137, matic: 137, pol: 137, "polygon pos": 137,
  monad: 143, sonic: 146, "x layer": 196, xlayer: 196, okx: 196,
  "world chain": 480, worldchain: 480, "world-chain": 480, stable: 988,
  hyperevm: 999, "hyper evm": 999, hyperliquid: 999, hype: 999,
  tempo: 4217, robinhood: 4663, "robinhood chain": 4663, "robinhood-chain": 4663, rh: 4663,
  mantle: 5000, arc: 5042, base: 8453, plasma: 9745,
  arb: 42161, arbitrum: 42161, "arbitrum one": 42161,
  avalanche: 43114, avax: 43114, "avalanche c-chain": 43114, ink: 57073,
  berachain: 80094, bera: 80094, katana: 747474,
};

/** "eth" / "Arbitrum" / 8453 / "bnb chain" → the chain; null = not a chain this module knows. */
export function parseYieldChain(v: unknown): YieldChain | null {
  const s = String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  if (/^\d+$/.test(s)) return CHAIN_BY_ID.get(Number(s)) ?? null;
  const id = CHAIN_ALIASES[s];
  return id ? CHAIN_BY_ID.get(id) ?? null : null;
}
const chainName = (id: number) => CHAIN_BY_ID.get(id)?.name ?? `Chain ${id}`;
const pendleChains = () => YIELD_CHAINS.filter((c) => c.pendle);
const morphoChains = () => YIELD_CHAINS.filter((c) => c.morpho);

// ── number + text helpers ─────────────────────────────────────────────────────────────────────────────────────
/** A fraction (0.0512) → percent with 2 decimals (5.12). */
export const pctOf = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.round(n * 10_000) / 100; };
/** Dollars: whole above $1k, cents below. */
export const usdOf = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.abs(n) >= 1000 ? Math.round(n) : Math.round(n * 100) / 100; };
const sig = (v: unknown): number | null => { const n = num(v); return n == null ? null : Number(n.toPrecision(5)); };
/** Third-party text: control characters out, one line, capped. */
export const clip = (s: unknown, n = 80): string => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const pctCell = (v: number | null) => (v == null ? null : `${v.toFixed(2)}%`);
const usdCell = (v: number | null) => usdShort(v);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const isoDay = (v: unknown) => (typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : null);
const maxAge = (...a: number[]) => Math.max(0, ...a);
const withAge = <T extends object>(d: T, ageS: number): T & { dataAgeS?: number } => (ageS > 0 ? { ...d, dataAgeS: ageS } : d);
const limitOf = (v: unknown, def: number, max = 25) => Math.max(1, Math.min(max, Math.floor(Number(v) || def)));
const vTable = (title: string, columns: string[], rows: (string | number | null)[][], align?: ("l" | "r")[]): Viz => ({ kind: "table", title, columns, rows, align });
const fail = (error: string, note?: string): ExtToolResult => ({ data: note ? { error, note } : { error }, addresses: [], citations: [] });

// ── Pendle ────────────────────────────────────────────────────────────────────────────────────────────────────
export const pendleMarketUrl = (address: string, chainId: number): string => {
  const slug = CHAIN_BY_ID.get(chainId)?.pendle;
  return `https://app.pendle.finance/trade/markets/${address.toLowerCase()}${slug ? `?chain=${slug}` : ""}`;
};
const pendleListUrl = (chainId?: number) => {
  const slug = chainId ? CHAIN_BY_ID.get(chainId)?.pendle : undefined;
  return `https://app.pendle.finance/trade/markets${slug ? `?chains=${slug}` : ""}`;
};
/** "1-0xabc…" → { chainId: 1, address: "0xabc…" }. */
export const splitPendleId = (id: unknown): { chainId: number; address: string } | null => {
  const m = /^(\d+)-(0x[0-9a-fA-F]{40})$/.exec(String(id ?? ""));
  return m ? { chainId: Number(m[1]), address: m[2].toLowerCase() } : null;
};

export interface PendleRow {
  market: string; protocol: string | null; chain: string; chainId: number; address: string; expiry: string | null; daysLeft: number | null;
  impliedApyPct: number | null; underlyingApyPct: number | null; ptPriceInAsset: number | null; ptDiscountPct: number | null;
  lpApyPct: number | null; lpMaxApyPct: number | null; liquidityUsd: number | null; tvlUsd: number | null; volume24hUsd: number | null;
  points?: string[];
}

/** PT price in units of the asset it redeems to at expiry: Pendle's own `ptRoi` when it has one, else from the implied APY. */
export function ptPriceInAsset(details: { ptRoi?: unknown; impliedApy?: unknown }, daysLeft: number | null): number | null {
  if (daysLeft != null && daysLeft <= 0) return 1;
  const roi = num(details.ptRoi);
  if (roi != null && roi > -1) return 1 / (1 + roi);
  const implied = num(details.impliedApy);
  if (implied == null || daysLeft == null || implied <= -1) return null;
  return 1 / Math.pow(1 + implied, daysLeft / 365);
}

/** One market from `/v2/markets/all` → the compact row the model reads (pure, tested). */
export function pendleRow(m: any, now = Date.now()): PendleRow | null {
  const address = String(m?.address ?? "").toLowerCase();
  const chainId = num(m?.chainId);
  if (!ADDR.test(address) || chainId == null) return null;
  const d = m.details ?? {};
  const expMs = Date.parse(String(m.expiry ?? ""));
  const daysLeft = Number.isFinite(expMs) ? Math.max(0, Math.round((expMs - now) / DAY_MS)) : null;
  const pt = ptPriceInAsset(d, daysLeft);
  const points = Array.isArray(m.points) ? [...new Set((m.points as any[]).map((p) => clip(p?.key, 50)).filter(Boolean))].slice(0, 2) : [];
  return {
    market: clip(m.name, 60), protocol: clip(m.protocol, 40) || null, chain: chainName(chainId), chainId, address,
    expiry: isoDay(m.expiry), daysLeft,
    impliedApyPct: pctOf(d.impliedApy), underlyingApyPct: pctOf(d.underlyingApy),
    ptPriceInAsset: pt == null ? null : Number(pt.toFixed(5)), ptDiscountPct: pt == null ? null : Math.round((1 - pt) * 10_000) / 100,
    lpApyPct: pctOf(d.aggregatedApy), lpMaxApyPct: pctOf(d.maxBoostedApy),
    liquidityUsd: usdOf(d.liquidity), tvlUsd: usdOf(d.totalTvl ?? d.liquidity), volume24hUsd: usdOf(d.tradingVolume),
    ...(points.length ? { points } : {}),
  };
}

export type PendleSort = "implied_apy" | "underlying_apy" | "tvl" | "expiry";
const CATEGORY_WORDS: Record<string, string> = { stable: "stables", stables: "stables", stablecoin: "stables", stablecoins: "stables", usd: "stables", eth: "eth", btc: "btc", rwa: "rwa", points: "points", hype: "hype", stocks: "stocks" };
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Filter + sort the active list (pure, tested). `asset` matches the market name / protocol (substring) or a Pendle category. */
export function screenPendle(markets: any[], o: { chainId?: number; asset?: string; sort: PendleSort; minLiquidityUsd: number; limit: number }, now = Date.now()): { rows: PendleRow[]; matched: number } {
  const q = normName(o.asset ?? "");
  const cat = CATEGORY_WORDS[(o.asset ?? "").trim().toLowerCase()];
  const rows: PendleRow[] = [];
  for (const m of markets ?? []) {
    if (o.chainId && Number(m?.chainId) !== o.chainId) continue;
    // Protocol names only from 4 letters: "eth" must not pull in every Ethena market.
    if (q && !(normName(String(m?.name ?? "")).includes(q) || (q.length >= 4 && normName(String(m?.protocol ?? "")).includes(q)) || (cat && (m?.categoryIds ?? []).includes(cat)))) continue;
    const r = pendleRow(m, now);
    if (!r || r.daysLeft === 0) continue;
    if ((r.liquidityUsd ?? 0) < o.minLiquidityUsd) continue;
    rows.push(r);
  }
  const key: Record<PendleSort, (r: PendleRow) => number> = {
    implied_apy: (r) => -(r.impliedApyPct ?? -Infinity), underlying_apy: (r) => -(r.underlyingApyPct ?? -Infinity),
    tvl: (r) => -(r.tvlUsd ?? 0), expiry: (r) => r.daysLeft ?? Infinity,
  };
  rows.sort((a, b) => key[o.sort](a) - key[o.sort](b));
  return { rows: rows.slice(0, o.limit), matched: rows.length };
}

/** "PT-sUSDe-26NOV2026" / "yt weeth dec 2026" / "sUSDe 2026-11" → the name to match + an expiry prefix (YYYY-MM[-DD]). */
export function parsePendleQuery(q: string): { name: string; expiry: string | null } {
  const MON: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  let s = q.trim().replace(/^\$/, "").replace(/^(?:pt|yt|lp|sy)[-\s_]+/i, "");
  let expiry: string | null = null;
  let m = /[-\s_]+(\d{1,2})([a-z]{3})(\d{4})$/i.exec(s);
  if (m && MON[m[2].toLowerCase()]) { expiry = `${m[3]}-${MON[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}`; s = s.slice(0, m.index); }
  else if ((m = /[-\s_]+([a-z]{3})[a-z]*\.?\s*(\d{4})$/i.exec(s)) && MON[m[1].toLowerCase()]) { expiry = `${m[2]}-${MON[m[1].toLowerCase()]}`; s = s.slice(0, m.index); }
  else if ((m = /[-\s_]+(\d{4}-\d{2}(?:-\d{2})?)$/.exec(s))) { expiry = m[1]; s = s.slice(0, m.index); }
  return { name: s.trim(), expiry };
}

/** One market by address or name (+ chain, + expiry hint) from the active list; the rest of the matches are alternatives. */
export function pickPendleMarket(markets: any[], query: string, chainId?: number): { pick: any; alternatives: any[] } | null {
  const raw = query.trim();
  const inChain = (m: any) => !chainId || Number(m?.chainId) === chainId;
  if (ADDR.test(raw)) {
    const hit = (markets ?? []).filter((m) => String(m?.address ?? "").toLowerCase() === raw.toLowerCase() && inChain(m));
    return hit.length ? { pick: hit[0], alternatives: [] } : null;
  }
  const { name, expiry } = parsePendleQuery(raw);
  const n = normName(name);
  if (!n) return null;
  const pool = (markets ?? []).filter((m) => inChain(m) && (!expiry || String(m?.expiry ?? "").startsWith(expiry)));
  let hits = pool.filter((m) => normName(String(m?.name ?? "")) === n);
  if (!hits.length) hits = pool.filter((m) => normName(String(m?.name ?? "")).includes(n));
  if (!hits.length && n.length >= 4) hits = pool.filter((m) => normName(String(m?.protocol ?? "")).includes(n));
  if (!hits.length) return null;
  const tvl = (m: any) => num(m?.details?.totalTvl) ?? num(m?.details?.liquidity) ?? 0;
  hits.sort((a, b) => tvl(b) - tvl(a));
  return { pick: hits[0], alternatives: hits.slice(1, 7) };
}

/** `/v3/…/historical-data` results → a daily line of implied vs underlying APY (pure, tested). */
export function pendleHistory(results: any[]): { x: string[]; implied: (number | null)[]; underlying: (number | null)[]; tvl: (number | null)[] } {
  const pts = (results ?? []).filter((p) => typeof p?.timestamp === "string").sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return {
    x: pts.map((p) => String(p.timestamp).slice(5, 10)),
    implied: pts.map((p) => pctOf(p.impliedApy)),
    underlying: pts.map((p) => pctOf(p.underlyingApy)),
    tvl: pts.map((p) => usdOf(p.tvl)),
  };
}

async function pendleActive(): Promise<{ markets: any[]; ageS: number }> {
  const first = await extJson<any>("pendle", `${PENDLE_API}/v2/markets/all${qs({ isActive: true, limit: 100 })}`, { ttlS: 300 });
  const total = num(first.data?.total) ?? 0;
  let markets: any[] = Array.isArray(first.data?.results) ? first.data.results : [];
  if (total > markets.length && markets.length === 100) {
    const pages = await Promise.all([100, 200].filter((s) => s < total).map((skip) =>
      extJson<any>("pendle", `${PENDLE_API}/v2/markets/all${qs({ isActive: true, limit: 100, skip })}`, { ttlS: 300 }).catch(() => null)));
    for (const p of pages) if (Array.isArray(p?.data?.results)) markets = markets.concat(p!.data.results);
  }
  return { markets, ageS: first.ageS };
}

const PENDLE_NOTE = "Implied APY is the fixed rate a PT buyer locks ONLY if the PT is held to expiry (selling earlier is at the market price, which moves). Underlying APY is the current variable rate and moves daily. ptPriceInAsset = what 1 PT costs now in units of the asset it redeems 1:1 for at expiry. LP APY = swap fees + PT fixed yield + underlying yield + PENDLE incentives, without boost (incentives change weekly; lpMaxApyPct needs vePENDLE boost). YT = leveraged exposure to the variable yield and is worth zero at expiry. Points programs are the issuer's, not Pendle's. Say the APYs move.";

async function pendleMarkets(args: Record<string, any>): Promise<ExtToolResult> {
  const chain = args.chain == null || args.chain === "" ? null : parseYieldChain(args.chain);
  if (args.chain != null && args.chain !== "" && (!chain || !chain.pendle)) return fail(`Pendle is not on "${clip(args.chain, 30)}". Pendle chains: ${pendleChains().map((c) => c.name).join(", ")}.`);
  const sort = (["implied_apy", "underlying_apy", "tvl", "expiry"] as const).find((s) => s === args.sort) ?? "implied_apy";
  const minLiquidityUsd = Math.max(0, num(args.min_liquidity) ?? 100_000);
  const limit = limitOf(args.limit, 12);
  const asset = clip(args.asset, 30);
  const { markets, ageS } = await pendleActive();
  const { rows, matched } = screenPendle(markets, { chainId: chain?.id, asset, sort, minLiquidityUsd, limit });
  const scope = `Pendle ${asset ? `${asset} ` : ""}markets${chain ? ` on ${chain.name}` : ""}`;
  if (!rows.length) return { data: withAge({ source: "Pendle", found: false, activeMarkets: markets.length, note: `No active ${scope} with liquidity ≥ $${minLiquidityUsd.toLocaleString("en-US")}. Say so; a lower min_liquidity or another asset name may match.` }, ageS), addresses: [], citations: [{ label: "Pendle markets", href: pendleListUrl(chain?.id) }] };
  const extreme = rows.some((r) => (r.impliedApyPct ?? 0) > 100);
  return {
    data: withAge({
      source: "Pendle", sort, minLiquidityUsd, activeMarkets: markets.length, matched, rows,
      note: [PENDLE_NOTE, extreme ? "Implied APY above 100% = a tiny, new or points-driven market; say how thin it is." : null, rows.some((r) => (r.liquidityUsd ?? 0) < 500_000) ? "Markets under $500k liquidity move a lot on one trade." : null].filter(Boolean).join(" "),
    }, ageS),
    addresses: rows.map((r) => r.address),
    citations: [{ label: chain ? `Pendle markets on ${chain.name}` : "Pendle markets", href: pendleListUrl(chain?.id) }, ...rows.slice(0, 2).map((r) => ({ label: `Pendle ${r.market} ${r.expiry ?? ""}`.trim(), href: pendleMarketUrl(r.address, r.chainId) }))],
    viz: [vTable(`${scope} · by ${sort.replace("_", " ")}`, ["Market", "Chain", "Expiry", "Fixed APY", "Underlying APY", "LP APY", "TVL"],
      rows.map((r) => [r.market, r.chain, r.expiry, pctCell(r.impliedApyPct), pctCell(r.underlyingApyPct), pctCell(r.lpApyPct), usdCell(r.tvlUsd)]), ["l", "l", "l", "r", "r", "r", "r"])],
  };
}

async function pendleMarket(args: Record<string, any>): Promise<ExtToolResult> {
  const q = clip(args.market ?? args.address ?? args.name, 80);
  if (!q) return fail("market must be a Pendle market address or a name like 'sUSDe' or 'PT-sUSDe-26NOV2026'.");
  const chain = args.chain == null || args.chain === "" ? null : parseYieldChain(args.chain);
  if (args.chain != null && args.chain !== "" && (!chain || !chain.pendle)) return fail(`Pendle is not on "${clip(args.chain, 30)}".`);
  const { markets, ageS } = await pendleActive();
  let hit = pickPendleMarket(markets, q, chain?.id);
  let age = ageS;
  if (!hit && ADDR.test(q)) {
    // Expired / delisted market: look the address up on every Pendle chain at once (ids ≤ 20 per call).
    const ids = (chain ? [chain] : pendleChains()).map((c) => `${c.id}-${q.toLowerCase()}`).slice(0, 20).join(",");
    const r = await extJson<any>("pendle", `${PENDLE_API}/v2/markets/all${qs({ ids, limit: 20 })}`, { ttlS: 3600 });
    const m = (r.data?.results ?? [])[0];
    if (m) { hit = { pick: m, alternatives: [] }; age = r.ageS; }
  }
  if (!hit) return { data: { source: "Pendle", found: false, note: `No Pendle market matches "${q}"${chain ? ` on ${chain.name}` : ""}. Say so; do not guess an address. pendle_markets lists the active ones.` }, addresses: [], citations: [] };
  const m = hit.pick;
  const row = pendleRow(m);
  if (!row) return fail("Pendle returned a market without an address or chain; say the data is unavailable.");
  const d = m.details ?? {};
  const tokenIds = [m.pt, m.yt, m.sy, m.underlyingAsset, m.accountingAsset, `${row.chainId}-${row.address}`].filter((x): x is string => typeof x === "string" && !!splitPendleId(x));
  const start = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS - 90 * DAY_MS).toISOString();
  const [prices, hist] = await Promise.all([
    extJson<any>("pendle", `${PENDLE_API}/v1/prices/assets${qs({ ids: [...new Set(tokenIds)].join(",") })}`, { ttlS: 120 }).catch(() => null),
    extJson<any>("pendle", `${PENDLE_API}/v3/${row.chainId}/markets/${row.address}/historical-data${qs({ time_frame: "day", timestamp_start: start, fields: "timestamp,impliedApy,underlyingApy,tvl" })}`, { ttlS: 3600 }).catch(() => null),
  ]);
  const px = (id: unknown) => (typeof id === "string" ? sig(prices?.data?.prices?.[id]) : null);
  const h = pendleHistory(hist?.data?.results ?? []);
  const at = (arr: (number | null)[], back: number) => (arr.length > back ? arr[arr.length - 1 - back] : null);
  const mean = (arr: (number | null)[]) => { const v = arr.filter((x): x is number => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };
  const range = d.yieldRange ?? {};
  const alternatives = hit.alternatives.map((a) => pendleRow(a)).filter((r): r is PendleRow => !!r).map((r) => ({ market: r.market, chain: r.chain, expiry: r.expiry, impliedApyPct: r.impliedApyPct, tvlUsd: r.tvlUsd, address: r.address }));
  const matured = row.daysLeft === 0;
  return {
    data: withAge({
      source: "Pendle", found: true,
      market: { name: row.market, protocol: row.protocol, chain: row.chain, chainId: row.chainId, address: row.address, expiry: row.expiry, daysLeft: row.daysLeft, matured, categories: (m.categoryIds ?? []).filter((c: unknown) => typeof c === "string" && !c.startsWith("_")).slice(0, 6), ...(row.points ? { points: row.points } : {}) },
      fixed: { impliedApyPct: row.impliedApyPct, ptPriceInAsset: row.ptPriceInAsset, ptDiscountPct: row.ptDiscountPct, ptReturnToExpiryPct: pctOf(d.ptRoi), impliedApyRangePct: { min: pctOf(range.min), max: pctOf(range.max) } },
      variable: { underlyingApyPct: row.underlyingApyPct, ytFloatingApyPct: pctOf(d.ytFloatingApy), ytReturnIfRatesHoldPct: pctOf(d.ytRoi) },
      lp: { lpApyPct: row.lpApyPct, lpMaxApyPct: row.lpMaxApyPct, swapFeeApyPct: pctOf(d.swapFeeApy), pendleIncentiveApyPct: pctOf(d.pendleApy) },
      pricesUsd: { pt: px(m.pt), yt: px(m.yt), lp: px(`${row.chainId}-${row.address}`), sy: px(m.sy), underlying: px(m.underlyingAsset), accountingAsset: px(m.accountingAsset) },
      liquidityUsd: row.liquidityUsd, tvlUsd: row.tvlUsd, volume24hUsd: row.volume24hUsd, swapFeeRatePct: pctOf(d.feeRate),
      history: h.x.length ? { days: h.x.length, impliedApyNowPct: at(h.implied, 0), impliedApy30dAgoPct: at(h.implied, 30), impliedApyFirstPct: h.implied[0] ?? null, underlyingApyAvg30dPct: mean(h.underlying.slice(-30)), underlyingApyAvgAllPct: mean(h.underlying) } : null,
      ...(alternatives.length ? { alternatives } : {}),
      note: [matured ? "This market has matured: PT redeems 1:1 for the asset, YT no longer earns." : null, PENDLE_NOTE, "ytReturnIfRatesHoldPct is Pendle's estimate if the underlying APY stayed where it is until expiry; it rarely does.", alternatives.length ? "Other markets matched the name (alternatives: other expiries / chains); say which one you used." : null, hist ? null : "The history did not load; do not describe a trend."].filter(Boolean).join(" "),
    }, maxAge(age, prices?.ageS ?? 0, hist?.ageS ?? 0)),
    addresses: [row.address, ...[m.pt, m.yt, m.sy].map((x) => splitPendleId(x)?.address).filter((x): x is string => !!x), ...alternatives.map((a) => a.address)],
    citations: [{ label: `Pendle ${row.market} ${row.expiry ?? ""} (${row.chain})`.trim(), href: pendleMarketUrl(row.address, row.chainId) }],
    viz: h.x.length > 2 ? [{ kind: "line", title: `Pendle ${row.market} ${row.expiry ?? ""} · implied vs underlying APY`.replace(/\s+·/, " ·"), x: h.x, series: [{ name: "Implied (fixed) APY", values: h.implied }, { name: "Underlying APY", values: h.underlying }], unit: "pct" }] : [],
  };
}

/** Raw wei string → human number with the token's decimals (display precision). */
export const fromWei = (raw: unknown, decimals: number | null | undefined): number | null => {
  if (decimals == null || !/^\d+$/.test(String(raw ?? ""))) return null;
  const n = Number(String(raw)) / 10 ** decimals;
  return Number.isFinite(n) ? Number(n.toPrecision(6)) : null;
};

export interface PendleOpenPosition { marketId: string; chainId: number; address: string; ptUsd: number; ytUsd: number; lpUsd: number; totalUsd: number; balances: { pt: string; yt: string; lp: string }; claims: { token: string; amount: string }[] }
/** `/v1/dashboard/positions/database/{user}` → open market positions + SY holdings (pure, tested). Valuations are Pendle's. */
export function pendleOpenPositions(raw: any): { open: PendleOpenPosition[]; sy: { id: string; chainId: number; balance: string; claims: { token: string; amount: string }[] }[]; chainsSeen: number[] } {
  const open: PendleOpenPosition[] = [];
  const sy: { id: string; chainId: number; balance: string; claims: { token: string; amount: string }[] }[] = [];
  const chainsSeen: number[] = [];
  const claimsOf = (x: any) => (Array.isArray(x?.claimTokenAmounts) ? x.claimTokenAmounts : []).filter((c: any) => splitPendleId(c?.token) && /^\d+$/.test(String(c?.amount ?? "")) && String(c.amount) !== "0").map((c: any) => ({ token: String(c.token), amount: String(c.amount) }));
  for (const c of raw?.positions ?? []) {
    const chainId = num(c?.chainId);
    if (chainId == null) continue;
    chainsSeen.push(chainId);
    for (const p of c.openPositions ?? []) {
      const id = splitPendleId(p?.marketId);
      if (!id) continue;
      const ptUsd = num(p.pt?.valuation) ?? 0, ytUsd = num(p.yt?.valuation) ?? 0, lpUsd = num(p.lp?.valuation) ?? 0;
      const claims = [...claimsOf(p.pt), ...claimsOf(p.yt), ...claimsOf(p.lp)];
      const balances = { pt: String(p.pt?.balance ?? "0"), yt: String(p.yt?.balance ?? "0"), lp: String(p.lp?.balance ?? "0") };
      if (ptUsd + ytUsd + lpUsd <= 0 && !claims.length && balances.pt === "0" && balances.yt === "0" && balances.lp === "0") continue;
      open.push({ marketId: String(p.marketId), chainId: id.chainId, address: id.address, ptUsd, ytUsd, lpUsd, totalUsd: ptUsd + ytUsd + lpUsd, balances, claims });
    }
    for (const s of c.syPositions ?? []) {
      const id = splitPendleId(s?.syId);
      if (!id || !/^\d+$/.test(String(s.balance ?? "")) || String(s.balance) === "0") continue;
      sy.push({ id: String(s.syId), chainId: id.chainId, balance: String(s.balance), claims: claimsOf(s) });
    }
  }
  open.sort((a, b) => b.totalUsd - a.totalUsd);
  return { open, sy, chainsSeen: [...new Set(chainsSeen)] };
}

async function pendlePositions(args: Record<string, any>): Promise<ExtToolResult> {
  const wallet = String(args.wallet ?? args.address ?? "").trim();
  if (!ADDR.test(wallet)) return fail("wallet must be a 0x address (Pendle runs on EVM chains).");
  const pos = await extJson<any>("pendle", `${PENDLE_API}/v1/dashboard/positions/database/${wallet.toLowerCase()}${qs({ filterUsd: 1 })}`, { ttlS: 180 });
  const { open, sy } = pendleOpenPositions(pos.data);
  if (!open.length && !sy.length) return { data: withAge({ source: "Pendle", wallet, found: false, note: "Pendle shows no open PT / YT / LP / SY position worth ≥ $1 for this wallet on any chain. Say so." }, pos.ageS), addresses: [wallet], citations: [] };
  const top = open.slice(0, 20);
  const claimIds = [...new Set([...top.flatMap((p) => p.claims.map((c) => c.token)), ...sy.flatMap((s) => s.claims.map((c) => c.token))])];
  const syIds = sy.map((s) => s.id);
  const metaIds = [...new Set([...syIds, ...claimIds])].slice(0, 20);
  const [mk, assets, prices] = await Promise.all([
    top.length ? extJson<any>("pendle", `${PENDLE_API}/v2/markets/all${qs({ ids: top.map((p) => p.marketId).join(","), limit: 20 })}`, { ttlS: 3600 }).catch(() => null) : null,
    metaIds.length ? extJson<any>("pendle", `${PENDLE_API}/v1/assets/all${qs({ ids: metaIds.join(",") })}`, { ttlS: 86_400 }).catch(() => null) : null,
    metaIds.length ? extJson<any>("pendle", `${PENDLE_API}/v1/prices/assets${qs({ ids: metaIds.join(",") })}`, { ttlS: 300 }).catch(() => null) : null,
  ]);
  const marketMeta = new Map<string, any>((mk?.data?.results ?? []).map((m: any) => [`${m.chainId}-${String(m.address).toLowerCase()}`, m] as const));
  const assetMeta = new Map<string, any>((assets?.data?.assets ?? []).map((a: any) => [`${a.chainId}-${String(a.address).toLowerCase()}`, a] as const));
  const priceOf = (id: string) => num(prices?.data?.prices?.[id]);
  const now = Date.now();
  let unconverted = 0;
  const claimRows = (claims: { token: string; amount: string }[]) => claims.map((c) => {
    const a = assetMeta.get(c.token.toLowerCase());
    const amount = fromWei(c.amount, num(a?.decimals));
    if (amount == null) { unconverted++; return null; }
    const p = priceOf(c.token);
    return { token: clip(a?.symbol, 30), amount, usd: p == null ? null : usdOf(amount * p) };
  }).filter((x): x is { token: string; amount: number; usd: number | null } => !!x);
  const positions = top.map((p) => {
    const m = marketMeta.get(`${p.chainId}-${p.address}`);
    const expMs = Date.parse(String(m?.expiry ?? ""));
    const daysLeft = Number.isFinite(expMs) ? Math.max(0, Math.round((expMs - now) / DAY_MS)) : null;
    return {
      market: m ? clip(m.name, 60) : short(p.address), chain: chainName(p.chainId), chainId: p.chainId, expiry: isoDay(m?.expiry), daysLeft, matured: daysLeft === 0,
      ptUsd: usdOf(p.ptUsd), ytUsd: usdOf(p.ytUsd), lpUsd: usdOf(p.lpUsd), totalUsd: usdOf(p.totalUsd),
      impliedApyNowPct: m && daysLeft !== 0 ? pctOf(m.details?.impliedApy) : null, claimable: claimRows(p.claims), address: p.address,
    };
  });
  const syRows = sy.slice(0, 15).map((s) => {
    const a = assetMeta.get(s.id.toLowerCase());
    const amount = fromWei(s.balance, num(a?.decimals));
    const p = priceOf(s.id);
    return { token: a ? clip(a.symbol, 30) : short(splitPendleId(s.id)!.address), chain: chainName(s.chainId), amount, usd: amount != null && p != null ? usdOf(amount * p) : null, claimable: claimRows(s.claims) };
  });
  const totalUsd = usdOf(open.reduce((a, p) => a + p.totalUsd, 0) + syRows.reduce((a, s) => a + (s.usd ?? 0), 0));
  const byChain = new Map<string, number>();
  for (const p of open) byChain.set(chainName(p.chainId), (byChain.get(chainName(p.chainId)) ?? 0) + p.totalUsd);
  for (const s of syRows) if (s.usd) byChain.set(s.chain, (byChain.get(s.chain) ?? 0) + s.usd);
  return {
    data: withAge({
      source: "Pendle", wallet, found: true, totalUsd, openMarkets: open.length,
      byChain: [...byChain.entries()].sort((a, b) => b[1] - a[1]).map(([chain, v]) => ({ chain, usd: usdOf(v) })),
      positions, ...(syRows.length ? { sy: syRows } : {}),
      ...(open.length > top.length ? { moreMarketsNotShown: open.length - top.length } : {}),
      note: ["USD values are Pendle's own valuations. Claimable interest / rewards are cached by Pendle for up to 24 h and are NOT in totalUsd.", unconverted ? `${unconverted} reward claim(s) are in tokens whose decimals Pendle did not return; they are not converted, so say there are other unclaimed rewards without naming an amount.` : null, positions.some((p) => p.matured) ? "Matured markets: PT redeems 1:1 for the asset, YT has stopped earning." : null, "Fixed APY on a PT holds only to expiry."].filter(Boolean).join(" "),
    }, maxAge(pos.ageS, mk?.ageS ?? 0)),
    addresses: [wallet, ...positions.map((p) => p.address)],
    citations: positions.slice(0, 3).map((p) => ({ label: `Pendle ${p.market} ${p.expiry ?? ""} (${p.chain})`.replace(/\s+\(/, " ("), href: pendleMarketUrl(p.address, p.chainId) })),
    viz: positions.length ? [vTable(`${short(wallet)} · Pendle positions`, ["Market", "Chain", "Expiry", "PT", "YT", "LP", "Total"], positions.map((p) => [p.market, p.chain, p.expiry, usdCell(p.ptUsd || null), usdCell(p.ytUsd || null), usdCell(p.lpUsd || null), usdCell(p.totalUsd)]), ["l", "l", "l", "r", "r", "r", "r"])] : [],
  };
}

// ── Morpho ────────────────────────────────────────────────────────────────────────────────────────────────────
export const morphoVaultUrl = (chainId: number, address: string): string => {
  const slug = CHAIN_BY_ID.get(chainId)?.morpho;
  return slug ? `https://app.morpho.org/${slug}/vault/${address}` : "https://app.morpho.org";
};
export const morphoMarketUrl = (chainId: number, marketId: string): string => {
  const slug = CHAIN_BY_ID.get(chainId)?.morpho;
  return slug ? `https://app.morpho.org/${slug}/market/${marketId}` : "https://app.morpho.org";
};

async function morphoGql<T = any>(query: string, variables: Record<string, unknown>, ttlS: number): Promise<{ data: T; ageS: number }> {
  const r = await extJson<any>("morpho", MORPHO_API, { ttlS: Math.max(300, ttlS), body: { query, variables }, timeoutMs: 12_000 });
  if (!r.data?.data) throw new ExtError(`morpho ${clip(r.data?.errors?.[0]?.message ?? "query failed", 120)}`);
  return { data: r.data.data as T, ageS: r.ageS };
}

/** A symbol the person typed → the exact symbols to look for ("eth" also means WETH, "btc" the wrapped BTCs). */
export function assetTargets(sym: string): string[] {
  const s = sym.trim().replace(/^\$/, "");
  if (!s) return [];
  const extra: Record<string, string[]> = { eth: ["WETH"], btc: ["WBTC", "cbBTC", "tBTC", "LBTC"], usd: ["USDC", "USDT"] };
  return [...new Set([s, ...(extra[s.toLowerCase()] ?? [])])];
}
const ASSETS_Q = (n: number) => `query A(${Array.from({ length: n }, (_, i) => `$s${i}: [String!], $q${i}: String`).join(", ")}) { ${Array.from({ length: n }, (_, i) => `e${i}: assets(first: 100, where: { symbol_in: $s${i} }) { items { symbol address chain { id } } } f${i}: assets(first: 100, where: { search: $q${i} }) { items { symbol address chain { id } } }`).join(" ")} }`;

/** The `assets` answer → addresses whose symbol equals one of the targets (case-insensitive), on the chain if given (pure, tested). */
export function matchAssets(resp: Record<string, any>, idx: number, targets: string[], chainId?: number): string[] {
  const want = new Set(targets.map((t) => t.toLowerCase()));
  const out = new Set<string>();
  for (const k of [`e${idx}`, `f${idx}`]) for (const a of resp?.[k]?.items ?? []) {
    if (!want.has(String(a?.symbol ?? "").toLowerCase()) || !ADDR.test(String(a?.address ?? ""))) continue;
    if (chainId && Number(a?.chain?.id) !== chainId) continue;
    out.add(String(a.address).toLowerCase());
  }
  return [...out];
}

/** Symbols → address lists (one call for every symbol, cached a day: token addresses do not move). */
async function morphoAssets(symbols: string[], chainId?: number): Promise<{ lists: string[][]; ageS: number }> {
  const targets = symbols.map(assetTargets);
  const vars: Record<string, unknown> = {};
  targets.forEach((t, i) => { vars[`s${i}`] = [...new Set(t.flatMap((x) => [x, x.toUpperCase(), x.toLowerCase()]))]; vars[`q${i}`] = symbols[i].trim().replace(/^\$/, ""); });
  const r = await morphoGql<Record<string, any>>(ASSETS_Q(symbols.length), vars, 86_400);
  return { lists: targets.map((t, i) => matchAssets(r.data, i, t, chainId)), ageS: r.ageS };
}

const warn = (w: any[]): string[] => (Array.isArray(w) ? w : []).map((x) => `${clip(String(x?.type ?? "").replace(/_/g, " "), 40)}${x?.level ? ` (${String(x.level).toLowerCase()})` : ""}`).filter((s) => s.trim()).slice(0, 4);
const rewardsOf = (rs: any[], side: "supplyApr" | "borrowApr" = "supplyApr") => (Array.isArray(rs) ? rs : []).filter((r) => (num(r?.[side]) ?? 0) > 0).map((r) => ({ token: clip(r?.asset?.symbol, 20), aprPct: pctOf(r[side]) })).slice(0, 4);

export interface MorphoVaultRow {
  name: string; version: "V1" | "V2"; curator: string | null; chain: string; chainId: number; asset: string;
  netApyPct: number | null; apyPct: number | null; rewards: { token: string; aprPct: number | null }[]; tvlUsd: number | null; liquidityUsd: number | null;
  performanceFeePct: number | null; managementFeePct?: number | null; warnings: string[]; address: string;
}
/** A V1 (`vaults`) or V2 (`vaultV2s`) item → one row (pure, tested). */
export function morphoVaultRow(v: any, version: "V1" | "V2"): MorphoVaultRow | null {
  const address = String(v?.address ?? "");
  const chainId = num(v?.chain?.id);
  if (!ADDR.test(address) || chainId == null) return null;
  const s = version === "V1" ? v.state ?? {} : v;
  const curators = version === "V1" ? (v.state?.curators ?? []) : (v.curators?.items ?? []);
  const curator = clip((curators as any[]).map((c) => c?.name).filter(Boolean).join(" + "), 60) || null;
  return {
    name: clip(v.name, 70), version, curator, chain: chainName(chainId), chainId, asset: clip(v.asset?.symbol, 20),
    netApyPct: pctOf(s.netApy), apyPct: pctOf(s.apy),
    rewards: rewardsOf(version === "V1" ? v.state?.allRewards : v.rewards),
    tvlUsd: usdOf(s.totalAssetsUsd), liquidityUsd: usdOf(version === "V1" ? v.liquidity?.usd : v.liquidityUsd),
    performanceFeePct: pctOf(version === "V1" ? v.state?.fee : v.performanceFee),
    ...(version === "V2" ? { managementFeePct: pctOf(v.managementFee) } : {}),
    warnings: warn(v.warnings), address,
  };
}

const VAULTS_Q = `query V($v1: VaultFilters, $v2: VaultV2sFilters, $n: Int, $o1: VaultOrderBy, $o2: VaultV2OrderBy) {
 v1: vaults(first: $n, orderBy: $o1, orderDirection: Desc, where: $v1) { items { address name chain { id } asset { symbol } state { totalAssetsUsd apy netApy fee curators { name } allRewards { asset { symbol } supplyApr } } liquidity { usd } warnings { type level } } }
 v2: vaultV2s(first: $n, orderBy: $o2, orderDirection: Desc, where: $v2) { items { address name chain { id } asset { symbol } totalAssetsUsd liquidityUsd apy netApy performanceFee managementFee curators { items { name } } rewards { asset { symbol } supplyApr } warnings { type level } } }
}`;

/** Both vault versions → one list sorted the way asked (pure, tested). */
export function mergeVaults(resp: any, sort: "apy" | "tvl", limit: number): MorphoVaultRow[] {
  const rows = [
    ...(resp?.v1?.items ?? []).map((v: any) => morphoVaultRow(v, "V1")),
    ...(resp?.v2?.items ?? []).map((v: any) => morphoVaultRow(v, "V2")),
  ].filter((r): r is MorphoVaultRow => !!r);
  rows.sort(sort === "apy" ? (a, b) => (b.netApyPct ?? -Infinity) - (a.netApyPct ?? -Infinity) : (a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  return rows.slice(0, limit);
}

type ChainArg = { chain: YieldChain | null } | { error: ExtToolResult };
function morphoChainArg(v: unknown): ChainArg {
  if (v == null || v === "") return { chain: null };
  const c = parseYieldChain(v);
  if (!c || !c.morpho) return { error: fail(`Morpho is not on "${clip(v, 30)}". Morpho chains: ${morphoChains().map((x) => x.name).join(", ")}.`) };
  return { chain: c };
}

const MORPHO_VAULT_NOTE = "Net APY is after the curator's performance fee and INCLUDES reward tokens where rewards are listed (rewards can stop any time). A vault's APY comes from the Morpho markets its curator chooses to lend into, so it moves with borrow demand and with the curator's decisions; the curator, not Morpho, takes the risk calls. Listed vaults only (shown in the Morpho app). Warnings are Morpho's own flags. Say the APYs move.";

async function morphoVaults(args: Record<string, any>): Promise<ExtToolResult> {
  const c = morphoChainArg(args.chain);
  if ("error" in c) return c.error;
  const chain = c.chain;
  const sort = args.sort === "tvl" ? "tvl" : "apy";
  const minTvl = Math.max(0, num(args.min_tvl) ?? 1_000_000);
  const limit = limitOf(args.limit, 12);
  const asset = clip(args.asset, 20);
  const v1: Record<string, unknown> = { listed: true, totalAssetsUsd_gte: minTvl };
  const v2: Record<string, unknown> = { listed: true, totalAssetsUsd_gte: minTvl };
  if (chain) { v1.chainId_in = [chain.id]; v2.chainId_in = [chain.id]; }
  let ageA = 0;
  if (asset) {
    const a = await morphoAssets([asset], chain?.id);
    ageA = a.ageS;
    if (!a.lists[0].length) return { data: { source: "Morpho", found: false, note: `Morpho lists no asset with the symbol ${asset}${chain ? ` on ${chain.name}` : ""}. Say so.` }, addresses: [], citations: [] };
    v1.assetAddress_in = a.lists[0]; v2.assetAddress_in = a.lists[0];
  }
  const r = await morphoGql(VAULTS_Q, { v1, v2, n: limit, o1: sort === "apy" ? "NetApy" : "TotalAssetsUsd", o2: sort === "apy" ? "NetApy" : "TotalAssetsUsd" }, 600);
  const rows = mergeVaults(r.data, sort, limit);
  const scope = `Morpho ${asset ? `${asset} ` : ""}vaults${chain ? ` on ${chain.name}` : ""}`;
  const chainHref = chain ? `https://app.morpho.org/${chain.morpho}/earn` : "https://app.morpho.org";
  if (!rows.length) return { data: withAge({ source: "Morpho", found: false, note: `No listed ${scope} with TVL ≥ $${minTvl.toLocaleString("en-US")}. Say so.` }, maxAge(r.ageS, ageA)), addresses: [], citations: [{ label: "Morpho vaults", href: chainHref }] };
  return {
    data: withAge({
      source: "Morpho", sort, minTvlUsd: minTvl, rows,
      note: [MORPHO_VAULT_NOTE, rows.some((x) => (x.netApyPct ?? 0) > 15) ? "Net APY above 15% on a lending vault usually means reward tokens, a young vault or riskier collateral; say which." : null, rows.some((x) => x.warnings.length) ? "Some rows carry Morpho warnings; repeat them." : null].filter(Boolean).join(" "),
    }, maxAge(r.ageS, ageA)),
    addresses: rows.map((x) => x.address),
    citations: [{ label: chain ? `Morpho vaults on ${chain.name}` : "Morpho app", href: chainHref }, ...rows.slice(0, 2).map((x) => ({ label: `Morpho ${x.name} (${x.chain})`, href: morphoVaultUrl(x.chainId, x.address) }))],
    viz: [vTable(`${scope} · by ${sort === "apy" ? "net APY" : "TVL"}`, ["Vault", "Curator", "Chain", "Asset", "Net APY", "TVL", "Perf. fee"],
      rows.map((x) => [x.name, x.curator, x.chain, x.asset, pctCell(x.netApyPct), usdCell(x.tvlUsd), pctCell(x.performanceFeePct)]), ["l", "l", "l", "l", "r", "r", "r"])],
  };
}

export interface MorphoMarketRow {
  pair: string; collateral: string | null; loan: string; chain: string; chainId: number; lltvPct: number | null;
  supplyApyPct: number | null; borrowApyPct: number | null; netSupplyApyPct?: number | null; netBorrowApyPct?: number | null;
  utilizationPct: number | null; suppliedUsd: number | null; borrowedUsd: number | null; liquidityUsd: number | null; collateralUsd: number | null;
  rewards?: { token: string; aprPct: number | null }[]; warnings: string[]; marketId: string;
}
const lltvPct = (v: unknown): number | null => { const s = String(v ?? ""); return /^\d+$/.test(s) ? Math.round(Number(BigInt(s) / 10n ** 14n)) / 100 : null; };
/** A `markets` item → one row (pure, tested). LLTV is an 18-decimal fraction on chain. */
export function morphoMarketRow(m: any): MorphoMarketRow | null {
  const marketId = String(m?.marketId ?? "");
  const chainId = num(m?.chain?.id);
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketId) || chainId == null) return null;
  const s = m.state ?? {};
  const loan = clip(m.loanAsset?.symbol, 20);
  const collateral = m.collateralAsset ? clip(m.collateralAsset.symbol, 20) : null;
  const sup = pctOf(s.supplyApy), bor = pctOf(s.borrowApy), nsup = pctOf(s.netSupplyApy), nbor = pctOf(s.netBorrowApy);
  const rewards = [...rewardsOf(s.rewards, "supplyApr"), ...rewardsOf(s.rewards, "borrowApr").map((r) => ({ ...r, token: `${r.token} (borrow)` }))];
  return {
    pair: `${collateral ?? "none"}/${loan}`, collateral, loan, chain: chainName(chainId), chainId, lltvPct: lltvPct(m.lltv),
    supplyApyPct: sup, borrowApyPct: bor,
    ...(nsup != null && nsup !== sup ? { netSupplyApyPct: nsup } : {}), ...(nbor != null && nbor !== bor ? { netBorrowApyPct: nbor } : {}),
    utilizationPct: pctOf(s.utilization), suppliedUsd: usdOf(s.supplyAssetsUsd), borrowedUsd: usdOf(s.borrowAssetsUsd),
    liquidityUsd: usdOf(s.liquidityAssetsUsd), collateralUsd: usdOf(s.collateralAssetsUsd),
    ...(rewards.length ? { rewards } : {}), warnings: warn(m.warnings), marketId,
  };
}

const MARKETS_Q = `query M($w: MarketFilters, $n: Int, $o: MarketOrderBy, $d: OrderDirection) { markets(first: $n, orderBy: $o, orderDirection: $d, where: $w) { items { marketId lltv chain { id } loanAsset { symbol } collateralAsset { symbol } state { supplyApy borrowApy netSupplyApy netBorrowApy utilization supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd collateralAssetsUsd rewards { asset { symbol } supplyApr borrowApr } } warnings { type level } } } }`;
export type MorphoMarketSort = "supply_apy" | "borrow_apy" | "tvl" | "utilization";
export const MORPHO_MARKET_ORDER: Record<MorphoMarketSort, { o: string; d: "Asc" | "Desc" }> = {
  supply_apy: { o: "SupplyApy", d: "Desc" }, borrow_apy: { o: "BorrowApy", d: "Asc" }, tvl: { o: "SupplyAssetsUsd", d: "Desc" }, utilization: { o: "Utilization", d: "Desc" },
};

async function morphoMarkets(args: Record<string, any>): Promise<ExtToolResult> {
  const c = morphoChainArg(args.chain);
  if ("error" in c) return c.error;
  const chain = c.chain;
  const sort = (Object.keys(MORPHO_MARKET_ORDER) as MorphoMarketSort[]).find((s) => s === args.sort) ?? "tvl";
  const minSupply = Math.max(0, num(args.min_supply) ?? 1_000_000);
  const limit = limitOf(args.limit, 12);
  const loan = clip(args.loan_asset, 20), coll = clip(args.collateral_asset, 20);
  const w: Record<string, unknown> = { listed: true, isIdle: false, supplyAssetsUsd_gte: minSupply };
  if (chain) w.chainId_in = [chain.id];
  let ageA = 0;
  const syms = [loan, coll].filter(Boolean);
  if (syms.length) {
    const a = await morphoAssets(syms, chain?.id);
    ageA = a.ageS;
    const [l, k] = loan ? [a.lists[0], coll ? a.lists[1] : null] : [null, a.lists[0]];
    const missing = [loan && !l?.length ? loan : null, coll && !k?.length ? coll : null].filter(Boolean);
    if (missing.length) return { data: { source: "Morpho", found: false, note: `Morpho lists no asset with the symbol ${missing.join(" / ")}${chain ? ` on ${chain.name}` : ""}. Say so.` }, addresses: [], citations: [] };
    if (l) w.loanAssetAddress_in = l;
    if (k) w.collateralAssetAddress_in = k;
  }
  const ord = MORPHO_MARKET_ORDER[sort];
  const r = await morphoGql<{ markets?: { items?: any[] } }>(MARKETS_Q, { w, n: limit, o: ord.o, d: ord.d }, 600);
  const rows = (r.data?.markets?.items ?? []).map(morphoMarketRow).filter((x): x is MorphoMarketRow => !!x);
  const scope = `Morpho markets${coll ? ` ${coll}` : ""}${loan ? `${coll ? "/" : " lending "}${loan}` : ""}${chain ? ` on ${chain.name}` : ""}`;
  const chainHref = chain ? `https://app.morpho.org/${chain.morpho}/borrow` : "https://app.morpho.org";
  if (!rows.length) return { data: withAge({ source: "Morpho", found: false, note: `No listed ${scope} with ≥ $${minSupply.toLocaleString("en-US")} supplied. Say so.` }, maxAge(r.ageS, ageA)), addresses: [], citations: [{ label: "Morpho markets", href: chainHref }] };
  return {
    data: withAge({
      source: "Morpho", sort, sortOrder: ord.d === "Asc" ? "lowest first" : "highest first", minSupplyUsd: minSupply, rows,
      note: ["Supply APY = what lenders earn now, borrow APY = what borrowers pay now; both float with utilization (the rate curve jumps above ~90%). netSupply / netBorrow include reward tokens where listed. LLTV = the loan-to-value at which a borrower is liquidated. High utilization = little liquidity left to withdraw. Say the rates move.", rows.some((x) => x.warnings.length) ? "Some markets carry Morpho warnings; repeat them." : null].filter(Boolean).join(" "),
    }, maxAge(r.ageS, ageA)),
    addresses: [],
    citations: [{ label: chain ? `Morpho markets on ${chain.name}` : "Morpho app", href: chainHref }, ...rows.slice(0, 2).map((x) => ({ label: `Morpho ${x.pair} market (${x.chain})`, href: morphoMarketUrl(x.chainId, x.marketId) }))],
    viz: [vTable(`${scope} · by ${sort.replace("_", " ")}`, ["Pair", "Chain", "LLTV", "Supply APY", "Borrow APY", "Utilization", "Supplied", "Liquidity"],
      rows.map((x) => [x.pair, x.chain, pctCell(x.lltvPct), pctCell(x.supplyApyPct), pctCell(x.borrowApyPct), pctCell(x.utilizationPct), usdCell(x.suppliedUsd), usdCell(x.liquidityUsd)]), ["l", "l", "r", "r", "r", "r", "r", "r"])],
  };
}

const POS_FRAGMENT = `fragment U on User { marketPositions { healthFactor priceVariationToLiquidationPrice market { marketId lltv loanAsset { symbol } collateralAsset { symbol } state { borrowApy supplyApy } } state { collateralUsd borrowAssetsUsd supplyAssetsUsd } } vaultPositions { vault { address name asset { symbol } state { netApy } } state { assetsUsd } } vaultV2Positions { vault { address name asset { symbol } netApy } assetsUsd } }`;
export const morphoPositionsQuery = (chainIds: number[]) => `query U($a: String!) { ${chainIds.map((id) => `c${id}: userByAddress(address: $a, chainId: ${id}) { ...U }`).join(" ")} } ${POS_FRAGMENT}`;

/** The positions answer (one alias per chain) → market + vault rows, dust (< $1) dropped (pure, tested). */
export function morphoPositionRows(resp: Record<string, any>) {
  const markets: { chain: string; chainId: number; pair: string; lltvPct: number | null; collateralUsd: number | null; borrowedUsd: number | null; suppliedUsd: number | null; healthFactor: number | null; priceDropToLiquidationPct: number | null; borrowApyPct: number | null; supplyApyPct: number | null; nearLiquidation: boolean; marketId: string }[] = [];
  const vaults: { chain: string; chainId: number; vault: string; version: "V1" | "V2"; asset: string; usd: number | null; netApyPct: number | null; address: string }[] = [];
  for (const [k, u] of Object.entries(resp ?? {})) {
    const chainId = Number(k.replace(/^c/, ""));
    if (!u || !Number.isFinite(chainId)) continue;
    for (const p of u.marketPositions ?? []) {
      const s = p?.state ?? {};
      const col = num(s.collateralUsd) ?? 0, bor = num(s.borrowAssetsUsd) ?? 0, sup = num(s.supplyAssetsUsd) ?? 0;
      if (col + bor + sup < 1) continue;
      const m = p.market ?? {};
      const hf = bor > 0 ? num(p.healthFactor) : null;
      const drop = bor > 0 ? num(p.priceVariationToLiquidationPrice) : null;
      markets.push({
        chain: chainName(chainId), chainId, pair: `${m.collateralAsset ? clip(m.collateralAsset.symbol, 20) : "none"}/${clip(m.loanAsset?.symbol, 20)}`, lltvPct: lltvPct(m.lltv),
        collateralUsd: usdOf(col), borrowedUsd: usdOf(bor), suppliedUsd: usdOf(sup), healthFactor: hf == null ? null : Math.round(hf * 1000) / 1000,
        priceDropToLiquidationPct: drop == null ? null : Math.round(Math.abs(drop) * 10_000) / 100,
        borrowApyPct: pctOf(m.state?.borrowApy), supplyApyPct: pctOf(m.state?.supplyApy), nearLiquidation: hf != null && hf < 1.1, marketId: String(m.marketId ?? ""),
      });
    }
    for (const p of u.vaultPositions ?? []) {
      const usdV = num(p?.state?.assetsUsd) ?? 0;
      if (usdV < 1 || !ADDR.test(String(p?.vault?.address ?? ""))) continue;
      vaults.push({ chain: chainName(chainId), chainId, vault: clip(p.vault.name, 70), version: "V1", asset: clip(p.vault.asset?.symbol, 20), usd: usdOf(usdV), netApyPct: pctOf(p.vault.state?.netApy), address: String(p.vault.address) });
    }
    for (const p of u.vaultV2Positions ?? []) {
      const usdV = num(p?.assetsUsd) ?? 0;
      if (usdV < 1 || !ADDR.test(String(p?.vault?.address ?? ""))) continue;
      vaults.push({ chain: chainName(chainId), chainId, vault: clip(p.vault.name, 70), version: "V2", asset: clip(p.vault.asset?.symbol, 20), usd: usdOf(usdV), netApyPct: pctOf(p.vault.netApy), address: String(p.vault.address) });
    }
  }
  markets.sort((a, b) => (b.borrowedUsd ?? 0) + (b.collateralUsd ?? 0) + (b.suppliedUsd ?? 0) - ((a.borrowedUsd ?? 0) + (a.collateralUsd ?? 0) + (a.suppliedUsd ?? 0)));
  vaults.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  return { markets, vaults };
}

async function morphoPositions(args: Record<string, any>): Promise<ExtToolResult> {
  const wallet = String(args.wallet ?? args.address ?? "").trim();
  if (!ADDR.test(wallet)) return fail("wallet must be a 0x address.");
  const c = morphoChainArg(args.chain);
  if ("error" in c) return c.error;
  const chains = c.chain ? [c.chain] : morphoChains();
  const r = await morphoGql<Record<string, any>>(morphoPositionsQuery(chains.map((x) => x.id)), { a: wallet.toLowerCase() }, 300);
  const { markets, vaults } = morphoPositionRows(r.data);
  const where = c.chain ? c.chain.name : `${chains.length} Morpho chains`;
  if (!markets.length && !vaults.length) return { data: withAge({ source: "Morpho", wallet, found: false, chainsChecked: chains.map((x) => x.name), note: `No Morpho market or vault position worth ≥ $1 for this wallet on ${where}. Say so.` }, r.ageS), addresses: [wallet], citations: [{ label: `Morpho portfolio ${short(wallet)}`, href: `https://app.morpho.org/portfolio/${wallet}` }] };
  const sum = (f: (x: (typeof markets)[number]) => number | null) => usdOf(markets.reduce((a, x) => a + (f(x) ?? 0), 0));
  const near = markets.filter((m) => m.nearLiquidation);
  const minHf = markets.reduce<number | null>((a, m) => (m.healthFactor != null && (a == null || m.healthFactor < a) ? m.healthFactor : a), null);
  return {
    data: withAge({
      source: "Morpho", wallet, found: true, chainsChecked: chains.length,
      totals: { collateralUsd: sum((m) => m.collateralUsd), borrowedUsd: sum((m) => m.borrowedUsd), suppliedUsd: sum((m) => m.suppliedUsd), vaultUsd: usdOf(vaults.reduce((a, v) => a + (v.usd ?? 0), 0)) },
      lowestHealthFactor: minHf,
      markets: markets.slice(0, 20), vaults: vaults.slice(0, 20),
      ...(near.length ? { flags: near.map((m) => `${m.pair} on ${m.chain}: health factor ${m.healthFactor} (liquidation below 1.0; collateral ${m.priceDropToLiquidationPct ?? "?"}% away from its liquidation price)`) } : {}),
      note: ["Health factor = collateral value × LLTV ÷ debt; below 1.0 the position can be liquidated. Under 1.1 is flagged as close. priceDropToLiquidationPct = how far the collateral price can fall before that. Vault netApyPct is the vault's current net rate (after fee, rewards included where listed) and moves with the curator's allocation. Figures are Morpho's indexer, a few minutes behind the chain.", near.length ? "At least one position is close to liquidation: state it plainly first, without telling the person what to do." : null].filter(Boolean).join(" "),
    }, r.ageS),
    addresses: [wallet, ...vaults.map((v) => v.address)],
    citations: [{ label: `Morpho portfolio ${short(wallet)}`, href: `https://app.morpho.org/portfolio/${wallet}` }],
    viz: [
      ...(markets.length ? [vTable(`${short(wallet)} · Morpho borrow / supply`, ["Market", "Chain", "Collateral", "Borrowed", "Health", "To liq.", "Borrow APY"], markets.slice(0, 15).map((m) => [m.pair, m.chain, usdCell(m.collateralUsd), usdCell(m.borrowedUsd || m.suppliedUsd), m.healthFactor == null ? null : m.healthFactor.toFixed(2), m.priceDropToLiquidationPct == null ? null : `${m.priceDropToLiquidationPct.toFixed(1)}%`, pctCell(m.borrowApyPct)]), ["l", "l", "r", "r", "r", "r", "r"])] : []),
      ...(vaults.length ? [vTable(`${short(wallet)} · Morpho vault deposits`, ["Vault", "Chain", "Asset", "Deposit", "Net APY"], vaults.slice(0, 15).map((v) => [v.vault, v.chain, v.asset, usdCell(v.usd), pctCell(v.netApyPct)]), ["l", "l", "l", "r", "r"])] : []),
    ],
  };
}

// ── schemas, registry rows, dispatcher ────────────────────────────────────────────────────────────────────────
const CHAIN_DESC = "Chain name or id (ethereum, arbitrum, base, bnb, monad, robinhood, hyperevm, plasma, sonic, mantle, berachain, polygon, unichain, katana …). Omit for every chain.";
export const YIELD_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "pendle_markets",
      description: "Screen active Pendle markets (fixed and variable yield: PT / YT / LP) on every Pendle chain: market, chain, expiry + days left, implied APY (the fixed rate a PT locks if held to expiry), underlying APY, PT discount / price in the asset, LP APY, liquidity, TVL, 24h volume, address. Filter by chain and asset (name substring like 'sUSDe', 'USDC', 'ETH', or 'stables'). Use for 'best fixed yield', 'Pendle PT rates on USDe', 'highest Pendle LP APY on Arbitrum', 'which Pendle markets expire soon'.",
      parameters: {
        type: "object",
        properties: {
          chain: { type: "string", description: CHAIN_DESC },
          asset: { type: "string", description: "Underlying name substring (sUSDe, wstETH, USDC, HYPE…) or a category: stables, eth, btc, rwa, points" },
          sort: { type: "string", enum: ["implied_apy", "underlying_apy", "tvl", "expiry"], description: "default implied_apy (highest first); expiry = soonest first" },
          min_liquidity: { type: "number", description: "Minimum pool liquidity in USD, default 100000" },
          limit: { type: "number", description: "1..25, default 12" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "pendle_market",
      description: "One Pendle market in depth by address or name (+ optional chain / expiry, e.g. 'PT-sUSDe-26NOV2026'): implied (fixed) APY, underlying APY, PT discount and return to expiry, YT floating APY, LP APY split (fees / PENDLE incentives), PT / YT / LP / SY prices in USD, liquidity, TVL, 24h volume, and a 90-day line of implied vs underlying APY. Use for 'tell me about PT sUSDe', 'is the Pendle fixed rate on X good', 'how has the implied APY moved'.",
      parameters: {
        type: "object",
        properties: {
          market: { type: "string", description: "Market address, or a name like 'sUSDe', 'PT-weETH-25DEC2026', 'USDai 2027-02'" },
          chain: { type: "string", description: "Optional chain to pick among same-name markets" },
        },
        required: ["market"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "pendle_positions",
      description: "A wallet's open Pendle positions on every chain: PT / YT / LP value per market with expiry, SY balances, claimable interest and rewards, total in USD. Use for 'my Pendle positions', 'what does 0x… hold on Pendle', 'when do my PTs mature'.",
      parameters: { type: "object", properties: { wallet: { type: "string", description: "0x address" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "morpho_vaults",
      description: "Screen listed Morpho vaults (V1 and V2, curated lending vaults) by chain and deposit asset: name, curator, chain, asset, net APY after fee (reward tokens shown separately), TVL, available liquidity, performance / management fee, Morpho warnings, address. Use for 'best USDC vault on Morpho', 'Morpho ETH vaults on Base', 'largest Morpho vaults', 'Steakhouse / Gauntlet vault APY'.",
      parameters: {
        type: "object",
        properties: {
          chain: { type: "string", description: "Chain name or id (ethereum, base, arbitrum, polygon, unichain, katana, hyperevm, monad, robinhood, arc, world chain, op mainnet …). Omit for every chain." },
          asset: { type: "string", description: "Deposit asset symbol: USDC, USDT, WETH, cbBTC, EURC… ('eth' adds WETH, 'btc' the wrapped BTCs)" },
          sort: { type: "string", enum: ["apy", "tvl"], description: "default apy (net, highest first)" },
          min_tvl: { type: "number", description: "Minimum TVL in USD, default 1000000" },
          limit: { type: "number", description: "1..25, default 12" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "morpho_markets",
      description: "Screen Morpho Blue lending markets by chain, loan asset and collateral asset: pair (collateral/loan), LLTV, supply APY, borrow APY, utilization, total supplied, borrowed, available liquidity, collateral, rewards, warnings, market id. Use for 'cheapest place to borrow USDC against cbBTC', 'Morpho supply rates for USDC', 'most utilized Morpho markets', 'wstETH collateral markets on Base'.",
      parameters: {
        type: "object",
        properties: {
          chain: { type: "string", description: "Chain name or id. Omit for every chain." },
          loan_asset: { type: "string", description: "Symbol of the asset lent / borrowed (USDC, WETH…)" },
          collateral_asset: { type: "string", description: "Symbol of the collateral (cbBTC, wstETH, WBTC…)" },
          sort: { type: "string", enum: ["supply_apy", "borrow_apy", "tvl", "utilization"], description: "default tvl; borrow_apy = cheapest first, the others highest first" },
          min_supply: { type: "number", description: "Minimum USD supplied, default 1000000" },
          limit: { type: "number", description: "1..25, default 12" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "morpho_positions",
      description: "A wallet's Morpho footprint on one chain or every Morpho chain: borrow / supply positions (collateral USD, borrowed USD, health factor, how far the collateral can fall before liquidation, LLTV, rates) and vault deposits (vault, USD, net APY); positions with health factor < 1.1 are flagged. Use for 'my Morpho positions', 'is my Morpho loan safe', 'what is 0x… doing on Morpho'.",
      parameters: { type: "object", properties: { wallet: { type: "string", description: "0x address" }, chain: { type: "string", description: "Optional; omit for every Morpho chain" } }, required: ["wallet"] },
    },
  },
];

export const YIELD_TOOL_META: Record<string, ToolMeta> = {
  pendle_markets: { group: "yield", label: "Screening Pendle markets", market: true, dyor: true, untrusted: true },
  pendle_market: { group: "yield", label: "Reading the Pendle market", dyor: true, untrusted: true },
  pendle_positions: { group: "yield", label: "Reading the wallet's Pendle positions", untrusted: true, timeoutMs: 20_000 },
  morpho_vaults: { group: "yield", label: "Screening Morpho vaults", market: true, dyor: true, untrusted: true, timeoutMs: 20_000 },
  morpho_markets: { group: "yield", label: "Screening Morpho lending markets", market: true, dyor: true, untrusted: true, timeoutMs: 20_000 },
  morpho_positions: { group: "yield", label: "Reading the wallet's Morpho positions", untrusted: true, timeoutMs: 20_000 },
};

export const YIELD_TOOL_NAMES = ["pendle_markets", "pendle_market", "pendle_positions", "morpho_vaults", "morpho_markets", "morpho_positions"] as const;
export const isYieldTool = (name: string): boolean => (YIELD_TOOL_NAMES as readonly string[]).includes(name);

/** Runs one yield tool. Never throws: bad input → {error}, a source failure → extFailure (the model says it is unavailable). */
export async function runYieldTool(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  const a = args ?? {};
  const source = name.startsWith("pendle") ? "Pendle" : "Morpho";
  try {
    switch (name) {
      case "pendle_markets": return await pendleMarkets(a);
      case "pendle_market": return await pendleMarket(a);
      case "pendle_positions": return await pendlePositions(a);
      case "morpho_vaults": return await morphoVaults(a);
      case "morpho_markets": return await morphoMarkets(a);
      case "morpho_positions": return await morphoPositions(a);
      default: return fail(`unknown tool ${name}`);
    }
  } catch (e) {
    return { data: extFailure(source, e), addresses: [], citations: [] as Citation[] };
  }
}
