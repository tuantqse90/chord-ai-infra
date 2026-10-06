// Any-chain DEX scan + token contract safety for Ask (tool-parity batch 2026-10-03, docs/prompts/ask-tool-parity-2026-10.md).
// Eight tools, all keyless public APIs read through services/ask/extHttp (Redis cache + per-source budget + stale fallback):
//   dex_trending · dex_new_pairs · dex_movers · dex_pool · dex_pool_trades · dex_token_pools   ← GeckoTerminal API v2
//   dex_promoted                                                                               ← DexScreener public API
//   token_safety                                                                               ← GoPlus token security
// What `dex_search` (services/dexSearch) does not: market-wide scans of a chain Chord does not index, one pool's full stats +
// chart + trades, where a token's liquidity sits, the paid-promotion feed, and contract-level risk flags.
//
// Budgets (measured 2026-10-03): GeckoTerminal's public API documents ~10 calls/min and answered 429 after a short burst
// from this Mac, so every GT answer is cached hard (trending / new 60–120 s, pools / trades 60 s, token info 10 min,
// network list 1 day) and no tool spends more than 3 GT calls. DexScreener boosts / profiles are 60 req/min, its
// /tokens/v1 enrichment 300. GoPlus is cached 30 min per token.
//
// Honesty rules every answer carries in `note`: token names, descriptions and links are whatever the launcher typed
// (`untrusted` in the registry — addresses the answer may quote travel in `addresses`, not inside the text); thin
// liquidity and new pools are flagged; boosts are paid ads; GoPlus flags are heuristics, never a safety guarantee.
// Movers rank only the top pools by volume, never "every token".
import type { ToolMeta } from "./registry";
import type { AssetChip, Citation, Viz } from "../askAgent";
import { ExtError, extFailure, extJson, num, qs, usdShort, type ExtToolResult } from "./extHttp";
import { chainNameOf } from "../dexSearch";

const GT = "https://api.geckoterminal.com/api/v2";
const GT_HEADERS = { Accept: "application/json;version=20230203" };
const DS = "https://api.dexscreener.com";
const GP = "https://api.gopluslabs.io/api/v1";
const CALL_MS = 9_000;

// ── small formatters (exported for tests) ─────────────────────────────────────────────────────────────────────────────
/** 5 significant digits for prices. */
export const sig = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(5)));
/** 2 decimals for percentages. */
export const p2 = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
/** Whole dollars from $1k up, cents below. */
export const usd = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : Math.abs(n) >= 1000 ? Math.round(n) : Math.round(n * 100) / 100);
const pctCell = (n: number | null | undefined) => (n == null ? "n/a" : `${n > 0 ? "+" : ""}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`);
const usdCell = (n: number | null | undefined) => (n === 0 ? "$0" : usdShort(n ?? null) ?? "n/a");
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
/** Third-party text: control characters and newlines out, whitespace collapsed, cut to `max`. */
export function clean(v: unknown, max = 200): string {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  const t = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
/** "45m" / "13h" / "12d" from hours. */
export function ageLabel(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return "n/a";
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
const vTable = (title: string, columns: string[], rows: (string | number | null)[][], align?: ("l" | "r")[], links?: (string | null)[], linkCol?: number): Viz =>
  ({ kind: "table", title, columns, rows, align, ...(links ? { links, linkCol } : {}) });
const httpsOnly = (u: unknown): string | null => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/i.test(u) && u.length <= 300 ? u : null);
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A contract / pool / mint address on any chain GeckoTerminal covers (EVM, V4 pool ids, Solana, Sui, TON, Tron …) vs a ticker. */
export const isAddressLike = (s: string): boolean => s.length >= 26 && s.length <= 140 && /^[A-Za-z0-9:_\-]+$/.test(s);
/** EVM hex lower-cased (cache hits, comparisons); base58 and others are case-sensitive and kept. */
export const normAddr = (a: string): string => (/^0x[0-9a-fA-F]+$/.test(a) ? a.toLowerCase() : a);
const sameAddr = (a: string, b: string) => normAddr(a) === normAddr(b);
const maxAge = (...xs: number[]) => Math.max(0, ...xs);
const withAge = (ageS: number) => (ageS > 0 ? { dataAgeS: ageS } : {});
const lim = (v: unknown, def: number, max: number) => Math.max(1, Math.min(max, Math.floor(Number(v)) || def));

// ── networks ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Friendly name / chain id → GeckoTerminal network id. Anything else is looked up in GT's /networks list. */
const NET_ALIASES: Record<string, string> = {
  sol: "solana", solana: "solana",
  eth: "eth", ethereum: "eth", "ethereum mainnet": "eth", mainnet: "eth", erc20: "eth", "1": "eth",
  base: "base", "8453": "base",
  bsc: "bsc", bnb: "bsc", "bnb chain": "bsc", "bnb smart chain": "bsc", binance: "bsc", "binance smart chain": "bsc", bep20: "bsc", "56": "bsc",
  arbitrum: "arbitrum", arb: "arbitrum", "arbitrum one": "arbitrum", "42161": "arbitrum",
  polygon: "polygon_pos", matic: "polygon_pos", pol: "polygon_pos", "polygon pos": "polygon_pos", "137": "polygon_pos",
  avalanche: "avax", avax: "avax", "avalanche c-chain": "avax", "c-chain": "avax", "43114": "avax",
  optimism: "optimism", op: "optimism", "op mainnet": "optimism", "10": "optimism",
  robinhood: "robinhood", "robinhood chain": "robinhood", rh: "robinhood", "4663": "robinhood",
  monad: "monad", "143": "monad", arc: "arc", "5042": "arc",
  hyperevm: "hyperevm", "hyper evm": "hyperevm", "999": "hyperevm", hyperliquid: "hyperliquid",
  sui: "sui-network", ton: "ton", tron: "tron", trx: "tron", aptos: "aptos",
  abstract: "abstract", ink: "ink", unichain: "unichain", sonic: "sonic", berachain: "berachain", bera: "berachain",
  apechain: "apechain", blast: "blast", linea: "linea", scroll: "scroll", zksync: "zksync", "zksync era": "zksync", mantle: "mantle",
  plasma: "plasma", katana: "katana", "world chain": "world-chain", worldchain: "world-chain", soneium: "soneium", celo: "celo",
  cronos: "cro", fantom: "ftm", gnosis: "xdai", sei: "sei-network", starknet: "starknet-alpha", pulsechain: "pulsechain",
  opbnb: "opbnb", "x layer": "x-layer", xlayer: "x-layer", zora: "zora-network", ronin: "ronin", kaia: "kaia",
};
const NET_NAMES: Record<string, string> = {
  eth: "Ethereum", bsc: "BNB Chain", polygon_pos: "Polygon", avax: "Avalanche", arbitrum: "Arbitrum", optimism: "Optimism", base: "Base",
  solana: "Solana", robinhood: "Robinhood Chain", monad: "Monad", arc: "Arc", hyperevm: "HyperEVM", hyperliquid: "Hyperliquid",
  "sui-network": "Sui", ton: "TON", tron: "Tron", aptos: "Aptos", abstract: "Abstract", ink: "Ink", unichain: "Unichain", sonic: "Sonic",
  berachain: "Berachain", apechain: "ApeChain", blast: "Blast", linea: "Linea", scroll: "Scroll", zksync: "zkSync", mantle: "Mantle",
  plasma: "Plasma", katana: "Katana", "world-chain": "World Chain", soneium: "Soneium", celo: "Celo", cro: "Cronos", ftm: "Fantom",
  xdai: "Gnosis", "sei-network": "Sei", "starknet-alpha": "Starknet", pulsechain: "PulseChain", opbnb: "opBNB", "x-layer": "X Layer",
  "zora-network": "Zora", ronin: "Ronin", kaia: "Kaia",
};
const titleCase = (id: string) => id.replace(/[-_]+/g, " ").replace(/\b([a-z])/g, (_m, c: string) => c.toUpperCase());
export const netName = (id: string, fromSource?: string | null): string => NET_NAMES[id] ?? (fromSource ? clean(fromSource, 40) : titleCase(id));
/** "Uniswap V3 (Robinhood)" → "Uniswap V3" when the bracket only repeats the chain; "Raydium (CLMM)" keeps its bracket. */
export function dexLabel(name: string, network: string, chainName: string): string {
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(name);
  if (!m) return name;
  const tag = m[2].toLowerCase().replace(/[-_\s]+/g, " ").trim(), net = network.toLowerCase().replace(/[-_\s]+/g, " "), chain = chainName.toLowerCase();
  return tag === net || (tag.length >= 3 && (chain.includes(tag) || net.startsWith(tag))) || tag.includes(chain) ? m[1] : name;
}
const netKey = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** The alias table only (pure). */
export function aliasNetwork(v: unknown): string | null {
  const s = netKey(v);
  if (!s) return null;
  if (NET_ALIASES[s]) return NET_ALIASES[s];
  const bare = s.replace(/\s+(chain|network|mainnet)$/, "");
  return NET_ALIASES[bare] ?? null;
}
export interface GtNetwork { id: string; name: string; platform: string | null }
/** A name against GeckoTerminal's /networks rows: id, id with spaces, display name or CoinGecko platform id (pure). */
export function matchNetwork(v: unknown, rows: GtNetwork[]): GtNetwork | null {
  const s = netKey(v).replace(/\s+(chain|network|mainnet)$/, "");
  if (!s) return null;
  const flat = (x: string) => x.toLowerCase().replace(/[-_\s]+/g, " ").trim();
  return rows.find((r) => r.id === s) ?? rows.find((r) => flat(r.id) === flat(s) || flat(r.name) === flat(s) || (r.platform && flat(r.platform) === flat(s)))
    ?? rows.find((r) => flat(r.name).replace(/ (chain|network|mainnet)$/, "") === flat(s)) ?? null;
}
const networkRows = (j: any): GtNetwork[] => (Array.isArray(j?.data) ? j.data : []).map((x: any) => ({ id: String(x?.id ?? ""), name: String(x?.attributes?.name ?? ""), platform: x?.attributes?.coingecko_asset_platform_id ?? null })).filter((x: GtNetwork) => x.id);

/** Friendly network → GT id + display name. Unknown names walk GT's /networks pages (cached 1 day). null = no such network. */
async function resolveNetwork(v: unknown): Promise<{ id: string; name: string } | null> {
  const hit = aliasNetwork(v);
  if (hit) return { id: hit, name: netName(hit) };
  if (!netKey(v)) return null;
  for (let page = 1; page <= 10; page++) {
    const { data } = await extJson<any>("geckoterminal", `${GT}/networks${qs({ page })}`, { ttlS: 86_400, staleS: 7 * 86_400, headers: GT_HEADERS, timeoutMs: CALL_MS });
    const m = matchNetwork(v, networkRows(data));
    if (m) return { id: m.id, name: netName(m.id, m.name) };
    if (!data?.links?.next) break;
  }
  return null;
}
const unknownNetwork = (v: unknown) => ({ error: `Unknown network "${clean(v, 40)}".`, note: "Use a chain name such as solana, eth, base, bsc, arbitrum, polygon, avalanche, robinhood, monad, hyperevm, sui, ton or tron." });

// ── GeckoTerminal pools ───────────────────────────────────────────────────────────────────────────────────────────────
export interface GtToken { address: string; symbol: string; name: string; image: string | null }
export interface GtPool {
  network: string; chainName: string; address: string; pair: string; dex: string; base: GtToken; quote: GtToken;
  priceUsd: number | null; quotePriceUsd: number | null;
  change: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  volume: { h1: number | null; h6: number | null; h24: number | null };
  liquidityUsd: number | null; fdvUsd: number | null; marketCapUsd: number | null;
  tx1h: { buys: number; sells: number }; tx24h: { buys: number; sells: number; buyers: number | null; sellers: number | null };
  createdMs: number | null; lockedLiquidityPct: number | null; url: string;
}
export const gtPoolUrl = (network: string, address: string) => `https://www.geckoterminal.com/${encodeURIComponent(network)}/pools/${encodeURIComponent(address)}`;

/** GeckoTerminal pool list / single pool JSON (with `include=base_token,quote_token,dex[,network]`) → typed rows (pure). */
export function gtPools(json: any, fallbackNet?: string | null): GtPool[] {
  const inc = new Map<string, any>();
  for (const i of Array.isArray(json?.included) ? json.included : []) if (i?.id) inc.set(`${i.type}:${i.id}`, i);
  const list = Array.isArray(json?.data) ? json.data : json?.data ? [json.data] : [];
  const out: GtPool[] = [];
  for (const p of list) {
    const a = p?.attributes ?? {};
    const rel = p?.relationships ?? {};
    const address = String(a.address ?? "");
    if (!address) continue;
    const id = String(p.id ?? "");
    const network = rel.network?.data?.id ?? fallbackNet ?? (id.endsWith(`_${address}`) ? id.slice(0, id.length - address.length - 1) : "");
    const [nameBase = "", nameQuote = ""] = String(a.name ?? "").split(" / ");
    const tok = (relKey: "base_token" | "quote_token", fallbackSym: string): GtToken => {
      const tid = String(rel[relKey]?.data?.id ?? "");
      const t = inc.get(`token:${tid}`)?.attributes ?? {};
      const addr = String(t.address ?? (network && tid.startsWith(`${network}_`) ? tid.slice(network.length + 1) : ""));
      const img = httpsOnly(t.image_url);
      return { address: normAddr(addr), symbol: clean(t.symbol ?? fallbackSym.split(" ")[0], 24), name: clean(t.name ?? "", 60), image: img && !/missing/i.test(img) ? img : null };
    };
    const dexId = String(rel.dex?.data?.id ?? "");
    const pc = a.price_change_percentage ?? {}, vol = a.volume_usd ?? {}, tx = a.transactions ?? {};
    const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
    const chainName = netName(network, inc.get(`network:${network}`)?.attributes?.name);
    out.push({
      network, chainName, address: normAddr(address),
      pair: clean(a.name ?? "", 60), dex: dexLabel(clean(inc.get(`dex:${dexId}`)?.attributes?.name ?? dexId, 40), network, chainName),
      base: tok("base_token", nameBase), quote: tok("quote_token", nameQuote),
      priceUsd: num(a.base_token_price_usd), quotePriceUsd: num(a.quote_token_price_usd),
      change: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
      volume: { h1: num(vol.h1), h6: num(vol.h6), h24: num(vol.h24) },
      liquidityUsd: num(a.reserve_in_usd), fdvUsd: num(a.fdv_usd), marketCapUsd: num(a.market_cap_usd),
      tx1h: { buys: num(tx.h1?.buys) ?? 0, sells: num(tx.h1?.sells) ?? 0 },
      tx24h: { buys: num(tx.h24?.buys) ?? 0, sells: num(tx.h24?.sells) ?? 0, buyers: num(tx.h24?.buyers), sellers: num(tx.h24?.sellers) },
      createdMs: Number.isFinite(created) ? created : null, lockedLiquidityPct: p2(num(a.locked_liquidity_percentage)),
      url: gtPoolUrl(network, normAddr(address)),
    });
  }
  return out;
}
const ageHoursOf = (p: GtPool, now: number) => (p.createdMs == null ? null : Math.max(0, (now - p.createdMs) / 3_600_000));

/** The compact row the model reads for a pool in a list. */
export function poolRow(p: GtPool, now = Date.now(), withChain = true) {
  const h = ageHoursOf(p, now);
  return {
    ...(withChain ? { chain: p.chainName } : {}), dex: p.dex, pair: p.pair, symbol: p.base.symbol, token: p.base.address,
    priceUsd: sig(p.priceUsd), change5mPct: p2(p.change.m5), change1hPct: p2(p.change.h1), change6hPct: p2(p.change.h6), change24hPct: p2(p.change.h24),
    volume24hUsd: usd(p.volume.h24), liquidityUsd: usd(p.liquidityUsd), fdvUsd: usd(p.fdvUsd), ...(p.marketCapUsd ? { marketCapUsd: usd(p.marketCapUsd) } : {}),
    buys24h: p.tx24h.buys, sells24h: p.tx24h.sells, ageHours: h == null ? null : Math.round(h * 10) / 10, pool: p.address,
  };
}
/** Asset chip for the pool's base token; only pools with a real market (like dex_search) become candidates. */
export function gtChip(p: GtPool): AssetChip | null {
  if (!p.base.symbol || p.base.symbol.length > 16 || !p.base.address || p.priceUsd == null) return null;
  return {
    id: `gt:${p.network}:${p.base.address}`, symbol: p.base.symbol, label: p.base.name || p.base.symbol, price: sig(p.priceUsd),
    // A Solana token opens Ask's own Solana view (board #113; base58 mint, case kept); every other network keeps GeckoTerminal.
    change24hPct: p.change.h24 == null || Math.abs(p.change.h24) > 1e5 ? null : p2(p.change.h24), hl: null,
    href: p.network === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.base.address) ? `/ask/trade/${p.base.address}?chain=solana` : p.url,
    ...(p.base.image ? { logo: p.base.image } : {}), liquidityUsd: usd(p.liquidityUsd), volume24hUsd: usd(p.volume.h24), fdvUsd: usd(p.fdvUsd),
    ...(p.marketCapUsd ? { marketCapUsd: usd(p.marketCapUsd) } : {}), kind: "crypto", chainName: p.chainName,
  };
}
const chipWorthyPool = (p: GtPool) => (p.liquidityUsd ?? 0) >= 10_000 && (p.volume.h24 ?? 0) >= 1_000 && p.tx24h.buys + p.tx24h.sells >= 10;
const chipsOf = (pools: GtPool[]): AssetChip[] => pools.filter(chipWorthyPool).map(gtChip).filter((c): c is AssetChip => !!c);
const poolsTable = (title: string, pools: GtPool[], now: number, withChain: boolean, window: "h1" | "h6" | "h24" = "h24"): Viz => {
  const keys: ("h1" | "h6" | "h24")[] = window === "h6" ? ["h1", "h6", "h24"] : ["h1", "h24"];
  return vTable(title,
    ["Token", ...(withChain ? ["Chain"] : []), "DEX", "Price", ...keys.map((k) => `${k.slice(1)}h`), "Volume 24h", "Liquidity", "Age"],
    pools.map((p) => [p.base.symbol, ...(withChain ? [p.chainName] : []), p.dex, sig(p.priceUsd), ...keys.map((k) => pctCell(p.change[k])), usdCell(p.volume.h24), usdCell(p.liquidityUsd), ageLabel(ageHoursOf(p, now))]),
    ["l", ...(withChain ? ["l" as const] : []), "l", "r", ...keys.map(() => "r" as const), "r", "r", "r"], pools.map((p) => p.url), 0);
};
const riskCounts = (pools: GtPool[], now: number) => ({
  thin: pools.filter((p) => (p.liquidityUsd ?? 0) < 50_000).length,
  young: pools.filter((p) => { const h = ageHoursOf(p, now); return h != null && h < 24; }).length,
});
const are = (n: number, one = "is", many = "are") => `${n} ${n === 1 ? one : many}`;
const UNTRUSTED_NAMES = "Token names and tickers are whatever the launcher typed; copycats share them, so give chain + address.";

async function gt<T = any>(path: string, ttlS: number): Promise<{ data: T; ageS: number }> {
  return extJson<T>("geckoterminal", `${GT}${path}`, { ttlS, headers: GT_HEADERS, timeoutMs: CALL_MS });
}
const POOL_INCLUDE = "base_token,quote_token,dex";

// ── OHLCV + trades + movers + token pools (pure parts, exported for tests) ───────────────────────────────────────────
export interface Candle { ts: number; open: number; high: number; low: number; close: number; volumeUsd: number }
/** GT ohlcv_list (newest first, [ts, o, h, l, c, v]) → oldest-first candles. */
export function ohlcvCandles(json: any): Candle[] {
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  return list.map((r: any[]) => ({ ts: Number(r?.[0]), open: Number(r?.[1]), high: Number(r?.[2]), low: Number(r?.[3]), close: Number(r?.[4]), volumeUsd: Number(r?.[5]) }))
    .filter((c: Candle) => Number.isFinite(c.ts) && Number.isFinite(c.close) && c.close > 0).sort((a: Candle, b: Candle) => a.ts - b.ts);
}
export function chartSummary(c: Candle[]) {
  if (!c.length) return null;
  const first = c[0].open > 0 ? c[0].open : c[0].close, last = c[c.length - 1].close;
  return { points: c.length, fromIso: new Date(c[0].ts * 1000).toISOString().slice(0, 16), firstUsd: sig(first), lastUsd: sig(last), changePct: p2((last / first - 1) * 100), highUsd: sig(Math.max(...c.map((x) => x.high))), lowUsd: sig(Math.min(...c.map((x) => x.low))), volumeUsd: usd(c.reduce((s, x) => s + (Number.isFinite(x.volumeUsd) ? x.volumeUsd : 0), 0)) };
}

export interface Trade { side: "buy" | "sell"; usd: number; tokens: number | null; priceUsd: number | null; wallet: string; ts: number; tx: string }
/** GT /trades rows → trades from the point of view of the pool's base token (or the `token` the request inverted to). */
export function gtTrades(json: any): Trade[] {
  const out: Trade[] = [];
  for (const t of Array.isArray(json?.data) ? json.data : []) {
    const a = t?.attributes ?? {};
    const side = a.kind === "buy" ? "buy" : a.kind === "sell" ? "sell" : null;
    const v = num(a.volume_in_usd);
    const ts = Date.parse(a.block_timestamp ?? "");
    if (!side || v == null || !Number.isFinite(ts)) continue;
    out.push({
      side, usd: v, tokens: num(side === "buy" ? a.to_token_amount : a.from_token_amount), priceUsd: num(side === "buy" ? a.price_to_in_usd : a.price_from_in_usd),
      wallet: normAddr(String(a.tx_from_address ?? "")), ts, tx: String(a.tx_hash ?? ""),
    });
  }
  return out.sort((x, y) => y.ts - x.ts);
}
export function summarizeTrades(trades: Trade[], now = Date.now(), largest = 10) {
  const buys = trades.filter((t) => t.side === "buy"), sells = trades.filter((t) => t.side === "sell");
  const buyUsd = buys.reduce((s, t) => s + t.usd, 0), sellUsd = sells.reduce((s, t) => s + t.usd, 0);
  const byWallet = new Map<string, { wallet: string; boughtUsd: number; soldUsd: number; trades: number }>();
  for (const t of trades) {
    if (!t.wallet) continue;
    const w = byWallet.get(t.wallet) ?? { wallet: t.wallet, boughtUsd: 0, soldUsd: 0, trades: 0 };
    if (t.side === "buy") w.boughtUsd += t.usd; else w.soldUsd += t.usd;
    w.trades++;
    byWallet.set(t.wallet, w);
  }
  const ws = [...byWallet.values()];
  const wOut = (w: (typeof ws)[number]) => ({ wallet: w.wallet, boughtUsd: usd(w.boughtUsd), soldUsd: usd(w.soldUsd), netUsd: usd(w.boughtUsd - w.soldUsd), trades: w.trades });
  const newest = trades.length ? Math.max(...trades.map((t) => t.ts)) : null, oldest = trades.length ? Math.min(...trades.map((t) => t.ts)) : null;
  return {
    trades: trades.length, buys: buys.length, sells: sells.length, buyUsd: usd(buyUsd), sellUsd: usd(sellUsd), netBuyUsd: usd(buyUsd - sellUsd),
    buySharePct: buyUsd + sellUsd > 0 ? p2((buyUsd / (buyUsd + sellUsd)) * 100) : null, uniqueWallets: byWallet.size,
    windowMinutes: newest != null && oldest != null ? Math.round((newest - oldest) / 60_000) : null,
    newestMinutesAgo: newest != null ? Math.max(0, Math.round((now - newest) / 60_000)) : null,
    largest: [...trades].sort((x, y) => y.usd - x.usd).slice(0, largest).map((t) => ({ side: t.side, usd: usd(t.usd), priceUsd: sig(t.priceUsd), tokens: sig(t.tokens), wallet: t.wallet, minutesAgo: Math.max(0, Math.round((now - t.ts) / 60_000)), tx: t.tx })),
    topBuyers: ws.filter((w) => w.boughtUsd > 0).sort((x, y) => y.boughtUsd - x.boughtUsd).slice(0, 5).map(wOut),
    topSellers: ws.filter((w) => w.soldUsd > 0).sort((x, y) => y.soldUsd - x.soldUsd).slice(0, 5).map(wOut),
  };
}

export type MoverWindow = "h1" | "h6" | "h24";
/** Stablecoins never "move" (a quiet hour's losers list was USDT −0.03 %, EURC −0.02 %). */
export const STABLE_SYMBOL = /^(?:[a-z]{0,6}usd[a-z0-9₮]{0,4}|usd[a-z0-9₮]{0,6}|eur[a-z]?|dai|frax|gho|xaut0?)$/i;
const MIN_MOVE_PCT = 0.5;
/** Top-volume pools → gainers / losers: liquidity + volume floors, one pool per token (the deepest), stables and moves under
 *  0.5 % out, sign-filtered (pure). */
export function rankMovers(pools: GtPool[], o: { window: MoverWindow; direction: "gainers" | "losers"; minLiquidityUsd: number; minVolumeUsd: number }) {
  const passed = pools.filter((p) => p.liquidityUsd != null && p.liquidityUsd >= o.minLiquidityUsd && (p.volume.h24 ?? 0) >= o.minVolumeUsd && p.change[o.window] != null);
  const best = new Map<string, GtPool>();
  for (const p of passed) {
    const k = p.base.address || p.address;
    const cur = best.get(k);
    if (!cur || (p.liquidityUsd ?? 0) > (cur.liquidityUsd ?? 0)) best.set(k, p);
  }
  const sign = o.direction === "gainers" ? 1 : -1;
  const ranked = [...best.values()].filter((p) => sign * (p.change[o.window] as number) >= MIN_MOVE_PCT && !STABLE_SYMBOL.test(p.base.symbol)).sort((a, b) => sign * ((b.change[o.window] as number) - (a.change[o.window] as number)));
  return { passed: passed.length, tokens: best.size, ranked };
}

/** A token's side in a pool: base / quote / none. */
const sideIn = (p: GtPool, token: string): "base" | "quote" | null => (sameAddr(p.base.address, token) ? "base" : sameAddr(p.quote.address, token) ? "quote" : null);
/** The token's USD price in the pool, whichever side it sits on. */
const tokenPriceIn = (p: GtPool, token: string) => { const s = sideIn(p, token); return s === "base" ? p.priceUsd : s === "quote" ? p.quotePriceUsd : null; };
/** The deepest pool that holds the token, preferring pools where it is the base token on near-equal depth (pure). */
export function deepestPoolFor(pools: GtPool[], token: string): GtPool | null {
  const mine = pools.filter((p) => sideIn(p, token));
  if (!mine.length) return null;
  return mine.sort((a, b) => (b.liquidityUsd ?? 0) * (sideIn(b, token) === "base" ? 1.2 : 1) - (a.liquidityUsd ?? 0) * (sideIn(a, token) === "base" ? 1.2 : 1))[0];
}
/** Every pool of one token → shares of liquidity / volume, the token's price per pool and the spread between deep pools (pure). */
export function tokenPoolsSummary(pools: GtPool[], token: string) {
  const mine = pools.filter((p) => sideIn(p, token)).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  const liq = mine.reduce((s, p) => s + (p.liquidityUsd ?? 0), 0), vol = mine.reduce((s, p) => s + (p.volume.h24 ?? 0), 0);
  const deepPrices = mine.filter((p) => (p.liquidityUsd ?? 0) >= 10_000).map((p) => tokenPriceIn(p, token)).filter((x): x is number => x != null && x > 0);
  const rows = mine.map((p) => {
    const side = sideIn(p, token)!;
    return {
      dex: p.dex, pair: p.pair, pool: p.address, side, priceUsd: sig(tokenPriceIn(p, token)), liquidityUsd: usd(p.liquidityUsd),
      liquiditySharePct: liq > 0 ? p2(((p.liquidityUsd ?? 0) / liq) * 100) : null, volume24hUsd: usd(p.volume.h24),
      volumeSharePct: vol > 0 ? p2(((p.volume.h24 ?? 0) / vol) * 100) : null, txns24h: p.tx24h.buys + p.tx24h.sells,
      ...(side === "base" ? { change24hPct: p2(p.change.h24) } : {}),
      ...((p.liquidityUsd ?? 0) >= 1_000 && (p.volume.h24 ?? 0) === 0 ? { idle: true } : {}),
    };
  });
  return {
    pools: rows, totalLiquidityUsd: usd(liq), totalVolume24hUsd: usd(vol),
    priceSpreadPct: deepPrices.length >= 2 ? p2((Math.max(...deepPrices) / Math.min(...deepPrices) - 1) * 100) : null,
    idlePools: rows.filter((r) => "idle" in r).length,
  };
}

/** GT /tokens/{a}/info or one row of /pools/{a}/info → the facts the model may quote (links are the project's claims). */
export function tokenInfo(attrs: any) {
  if (!attrs || typeof attrs !== "object") return null;
  const h = attrs.holders ?? null;
  const dist = h?.distribution_percentage ?? null;
  const socials = [
    attrs.twitter_handle ? `x.com/${clean(attrs.twitter_handle, 30)}` : null,
    attrs.telegram_handle ? `t.me/${clean(attrs.telegram_handle, 40)}` : null,
    attrs.discord_url ? clean(attrs.discord_url, 80) : null,
  ].filter((x): x is string => !!x);
  return {
    gtScore: attrs.gt_score == null ? null : Math.round(Number(attrs.gt_score)), gtVerified: attrs.gt_verified === true,
    holders: num(h?.count), top10HoldersPct: p2(num(dist?.top_10)),
    isHoneypot: typeof attrs.is_honeypot === "boolean" ? attrs.is_honeypot : null,
    mintAuthority: attrs.mint_authority == null ? null : clean(attrs.mint_authority, 60), freezeAuthority: attrs.freeze_authority == null ? null : clean(attrs.freeze_authority, 60),
    developerHoldingPct: p2(num(attrs.developer_holding_percentage)),
    categories: (Array.isArray(attrs.categories) ? attrs.categories : []).slice(0, 4).map((c: unknown) => clean(c, 30)),
    websites: (Array.isArray(attrs.websites) ? attrs.websites : []).map(httpsOnly).filter(Boolean).slice(0, 3),
    socials, description: clean(attrs.description, 200) || null,
  };
}

// ── token resolution on one network (GT) ─────────────────────────────────────────────────────────────────────────────
interface TokenHit { address: string; symbol: string; lookAlikes: { symbol: string; name: string; address: string; liquidityUsd: number | null }[]; pools: GtPool[] | null; ageS: number }
/** Search-result pools → the token whose symbol is the query (most liquidity wins) + the look-alikes (pure). */
export function pickBySymbol(pools: GtPool[], q: string): { address: string; symbol: string; lookAlikes: TokenHit["lookAlikes"] } | null {
  const s = q.trim().replace(/^\$/, "").toLowerCase();
  const byTok = new Map<string, { t: GtToken; liq: number }>();
  for (const p of pools) for (const t of [p.base, p.quote]) {
    if (!t.address || t.symbol.toLowerCase() !== s) continue;
    const cur = byTok.get(t.address) ?? { t, liq: 0 };
    cur.liq += p.liquidityUsd ?? 0;
    byTok.set(t.address, cur);
  }
  const ranked = [...byTok.values()].sort((a, b) => b.liq - a.liq);
  if (!ranked.length) return null;
  return { address: ranked[0].t.address, symbol: ranked[0].t.symbol, lookAlikes: ranked.slice(1, 6).map((x) => ({ symbol: x.t.symbol, name: x.t.name, address: x.t.address, liquidityUsd: usd(x.liq) })) };
}
async function resolveToken(net: string, q: string): Promise<TokenHit | null> {
  const s = q.trim().replace(/^\$/, "");
  if (isAddressLike(s)) return { address: normAddr(s), symbol: "", lookAlikes: [], pools: null, ageS: 0 };
  if (!/^[A-Za-z0-9._\-]{1,20}$/.test(s)) return null;
  const { data, ageS } = await gt(`/search/pools${qs({ query: s, network: net, include: POOL_INCLUDE })}`, 300);
  const pools = gtPools(data, net);
  const hit = pickBySymbol(pools, s);
  return hit ? { ...hit, pools, ageS } : null;
}
/** Pool for a pool address, or the token's deepest pool (token address / ticker). */
async function poolFor(net: string, args: Record<string, any>): Promise<{ pool: GtPool; focus: string; side: "base" | "quote"; lookAlikes: TokenHit["lookAlikes"]; ageS: number } | { error: string; note: string }> {
  const poolArg = String(args.pool ?? "").trim(), tokArg = String(args.token ?? "").trim();
  if (poolArg) {
    if (!isAddressLike(poolArg)) return { error: "pool must be a pool address (or pass token instead).", note: "Ask for the pool address or the token's contract address." };
    const { data, ageS } = await gt(`/networks/${net}/pools/${encodeURIComponent(normAddr(poolArg))}${qs({ include: POOL_INCLUDE })}`, 60);
    const p = gtPools(data, net)[0];
    if (!p) return { error: "GeckoTerminal returned no pool.", note: "Say the pool was not found on that network." };
    return { pool: p, focus: p.base.address, side: "base", lookAlikes: [], ageS };
  }
  if (!tokArg) return { error: "pass pool (a pool address) or token (a token address or ticker).", note: "Ask which token or pool." };
  const hit = await resolveToken(net, tokArg);
  if (!hit) return { error: `No token called "${clean(tokArg, 30)}" in GeckoTerminal's search on this network.`, note: "Say so; dex_search looks across every chain. Do not guess an address." };
  let pools = hit.pools, ageS = hit.ageS;
  if (!pools) {
    const r = await gt(`/networks/${net}/tokens/${encodeURIComponent(hit.address)}/pools${qs({ include: POOL_INCLUDE })}`, 60);
    pools = gtPools(r.data, net); ageS = maxAge(ageS, r.ageS);
  }
  const p = deepestPoolFor(pools, hit.address);
  if (!p) return { error: "GeckoTerminal lists no pool for that token on this network.", note: "Say it has no DEX pool there (or the network is wrong). Do not guess." };
  return { pool: p, focus: hit.address, side: sideIn(p, hit.address) ?? "base", lookAlikes: hit.lookAlikes, ageS };
}
const notFound = (what: string, where = "GeckoTerminal") => ({ error: `${what} was not found on ${where}.`, note: "Say it was not found on that network (check the network and the address); do not guess numbers." });

// ── DexScreener promotion feeds ───────────────────────────────────────────────────────────────────────────────────────
const DS_ALIASES: Record<string, string> = {
  sol: "solana", solana: "solana", eth: "ethereum", ethereum: "ethereum", bnb: "bsc", bsc: "bsc", "bnb chain": "bsc", binance: "bsc",
  avax: "avalanche", avalanche: "avalanche", matic: "polygon", polygon: "polygon", arb: "arbitrum", arbitrum: "arbitrum", op: "optimism",
  optimism: "optimism", base: "base", rh: "robinhood", robinhood: "robinhood", "robinhood chain": "robinhood", hyperevm: "hyperevm",
  "hyper evm": "hyperevm", sui: "sui", ton: "ton", tron: "tron", monad: "monad", arc: "arc", abstract: "abstract", sonic: "sonic",
  berachain: "berachain", unichain: "unichain", ink: "ink", "world chain": "worldchain", pulsechain: "pulsechain",
};
/** Friendly chain → DexScreener chainId (unknown names pass through, spaces removed). */
export const dsChainId = (v: unknown): string | null => { const s = netKey(v); return s ? DS_ALIASES[s] ?? DS_ALIASES[s.replace(/\s+(chain|network|mainnet)$/, "")] ?? s.replace(/\s+/g, "") : null; };
export type PromoFeed = "top_boosts" | "latest_boosts" | "profiles";
const FEED_PATH: Record<PromoFeed, string> = { top_boosts: "/token-boosts/top/v1", latest_boosts: "/token-boosts/latest/v1", profiles: "/token-profiles/latest/v1" };
export interface PromoRow { chainId: string; address: string; url: string; boostTotal: number | null; boostAdded: number | null; cto: boolean | null; description: string; links: string[] }
/** A boosts / profiles feed → one row per token (largest boost kept), optional chain filter (pure). */
export function promoRows(feed: any, chain: string | null): PromoRow[] {
  const seen = new Map<string, PromoRow>();
  for (const x of Array.isArray(feed) ? feed : []) {
    const chainId = String(x?.chainId ?? ""), address = String(x?.tokenAddress ?? "");
    if (!chainId || !address || (chain && chainId !== chain)) continue;
    const k = `${chainId}:${normAddr(address)}`;
    const row: PromoRow = {
      chainId, address, url: httpsOnly(x.url) ?? `https://dexscreener.com/${chainId}/${address}`, boostTotal: num(x.totalAmount), boostAdded: num(x.amount),
      cto: typeof x.cto === "boolean" ? x.cto : null, description: clean(x.description, 140),
      links: [...new Set((Array.isArray(x.links) ? x.links : []).map((l: any) => clean(l?.type ?? l?.label ?? "", 20).toLowerCase()).filter(Boolean))].slice(0, 5) as string[],
    };
    const cur = seen.get(k);
    if (!cur || (row.boostTotal ?? 0) > (cur.boostTotal ?? 0)) seen.set(k, row);
  }
  return [...seen.values()];
}
export interface DsMarket { symbol: string; name: string; priceUsd: number | null; change24hPct: number | null; liquidityUsd: number | null; volume24hUsd: number | null; marketCapUsd: number | null; fdvUsd: number | null; createdMs: number | null; txns24h: number; image: string | null; pairUrl: string | null }
/** DexScreener /tokens/v1 pairs → the deepest pair per base token (pure). Key = normalised address. */
export function dsMarkets(pairs: any): Map<string, DsMarket> {
  const out = new Map<string, DsMarket & { liq: number }>();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const b = p?.baseToken ?? {};
    const a = String(b.address ?? "");
    if (!a) continue;
    const liq = num(p.liquidity?.usd) ?? 0;
    const k = normAddr(a);
    const cur = out.get(k);
    if (cur && cur.liq >= liq) continue;
    const img = httpsOnly(p.info?.imageUrl);
    out.set(k, {
      liq, symbol: clean(b.symbol, 24), name: clean(b.name, 60), priceUsd: num(p.priceUsd), change24hPct: num(p.priceChange?.h24), liquidityUsd: num(p.liquidity?.usd),
      volume24hUsd: num(p.volume?.h24), marketCapUsd: num(p.marketCap), fdvUsd: num(p.fdv), createdMs: num(p.pairCreatedAt), txns24h: (num(p.txns?.h24?.buys) ?? 0) + (num(p.txns?.h24?.sells) ?? 0),
      image: img, pairUrl: httpsOnly(p.url),
    });
  }
  return out as Map<string, DsMarket>;
}

// ── GoPlus token security ─────────────────────────────────────────────────────────────────────────────────────────────
/** Friendly chain → GoPlus chain id ("solana" for Solana). GoPlus's /supported_chains list decides the rest. */
const GP_ALIASES: Record<string, string> = {
  eth: "1", ethereum: "1", erc20: "1", mainnet: "1", bsc: "56", bnb: "56", "bnb chain": "56", binance: "56", bep20: "56", base: "8453",
  arbitrum: "42161", arb: "42161", optimism: "10", op: "10", polygon: "137", matic: "137", pol: "137", avalanche: "43114", avax: "43114",
  sol: "solana", solana: "solana", tron: "tron", trx: "tron", robinhood: "4663", "robinhood chain": "4663", rh: "4663", monad: "143", arc: "5042",
  linea: "59144", zksync: "324", "zksync era": "324", mantle: "5000", unichain: "130", scroll: "534352", sonic: "146", berachain: "80094",
  bera: "80094", abstract: "2741", "world chain": "480", worldchain: "480", blast: "81457", opbnb: "204", cronos: "25", gnosis: "100",
  soneium: "1868", plasma: "9745", "x layer": "196", xlayer: "196", story: "1514", "manta pacific": "169", manta: "169", merlin: "4200", morph: "2818",
};
export interface GpChain { id: string; name: string }
const GP_NAMES: Record<string, string> = {
  "1": "Ethereum", "56": "BNB Chain", "8453": "Base", "42161": "Arbitrum", "10": "Optimism", "137": "Polygon", "43114": "Avalanche",
  solana: "Solana", tron: "Tron", "4663": "Robinhood Chain", "143": "Monad", "5042": "Arc",
};
/** Chain argument (name or chain id) → GoPlus id, checked against GoPlus's supported list when we have it (pure). */
export function goplusChainId(v: unknown, supported: GpChain[] | null): { id: string; name: string } | null {
  const raw = netKey(v);
  if (!raw) return null;
  const bare = raw.replace(/\s+(chain|network|mainnet)$/, "");
  const alias = GP_ALIASES[raw] ?? GP_ALIASES[bare] ?? (/^\d+$/.test(raw) ? raw : null);
  const flat = (x: string) => x.toLowerCase().replace(/[-_\s]+/g, " ").replace(/ (mainnet|chain|network)$/, "").trim();
  const named = (id: string, listName?: string) => ({ id, name: GP_NAMES[id] ?? (listName ? clean(listName, 40) : titleCase(bare)) });
  if (!supported) return alias ? named(alias) : null;
  const hit = supported.find((c) => c.id === (alias ?? raw)) ?? supported.find((c) => flat(c.name) === flat(bare));
  return hit ? named(hit.id, hit.name) : null;
}
const bit = (v: unknown): boolean | null => (v === "1" || v === 1 ? true : v === "0" || v === 0 ? false : null);
const frac = (v: unknown): number | null => { const n = num(v); return n == null ? null : p2(n * 100); };
const BURN = /^(0x0{40}|0x0{39}1|0x0{36}dead|0xdead0{36}|1nc1nerator11111111111111111111111111111111)$/i;
type Lvl = 3 | 2 | 1;
interface Flag { lvl: Lvl; text: string }
const LVL_NAME: Record<0 | Lvl, "none" | "low" | "medium" | "high"> = { 0: "none", 1: "low", 2: "medium", 3: "high" };

function holderStats(holders: any[]) {
  const top = (Array.isArray(holders) ? holders : []).slice(0, 10);
  const pctOf = (h: any) => (num(h?.percent) ?? 0) * 100;
  const addrOf = (h: any) => String(h?.address ?? h?.account ?? "");
  const lockedOrBurn = (h: any) => h?.is_locked === 1 || h?.is_locked === "1" || BURN.test(addrOf(h));
  return {
    top10Pct: top.length ? p2(top.reduce((s, h) => s + pctOf(h), 0)) : null,
    top10ExLockedPct: top.length ? p2(top.filter((h) => !lockedOrBurn(h)).reduce((s, h) => s + pctOf(h), 0)) : null,
    top: top.slice(0, 5).map((h) => ({ address: addrOf(h), pct: p2(pctOf(h)), ...(h?.is_contract === 1 ? { contract: true } : {}), ...(lockedOrBurn(h) ? { lockedOrBurned: true } : {}), ...(h?.tag ? { tag: clean(h.tag, 30) } : {}) })),
  };
}
const finish = (flags: Flag[], ok: string[], unknown: string[]) => {
  const sorted = [...flags].sort((a, b) => b.lvl - a.lvl);
  const worst = (sorted[0]?.lvl ?? 0) as 0 | Lvl;
  return { worstFlag: LVL_NAME[worst], risks: sorted.map((f) => `${LVL_NAME[f.lvl]}: ${f.text}`), ok, unknown };
};

/** GoPlus EVM token_security row → normalised flags + risks (worst first) / ok / unknown lists (pure). */
export function goplusEvm(r: any) {
  const flags: Flag[] = [], ok: string[] = [], unknown: string[] = [];
  const buy = frac(r.buy_tax), sell = frac(r.sell_tax), transfer = frac(r.transfer_tax);
  const honeypot = bit(r.is_honeypot), cannotSellAll = bit(r.cannot_sell_all), cannotBuy = bit(r.cannot_buy);
  // owner_address "" = no owner; the key missing altogether = GoPlus could not read it (partial scans of proxies): unknown.
  const owner = String(r.owner_address ?? "");
  const renounced: boolean | null = r.owner_address === undefined || r.owner_address === null ? null : !owner || BURN.test(owner);
  const h = holderStats(r.holders);
  const lp = Array.isArray(r.lp_holders) ? r.lp_holders : [];
  const lpLocked = lp.length ? p2(lp.reduce((s: number, x: any) => s + ((x?.is_locked === 1 || BURN.test(String(x?.address ?? ""))) ? (num(x?.percent) ?? 0) * 100 : 0), 0)) : null;
  const add = (cond: boolean | null, lvl: Lvl, text: string) => { if (cond) flags.push({ lvl, text }); };
  add(honeypot, 3, "Honeypot: GoPlus's simulated sell failed, holders may not be able to sell.");
  add(bit(r.honeypot_with_same_creator), 3, "The creator's wallet has deployed honeypots before.");
  add(r.fake_token?.value === 1 || r.fake_token?.value === "1", 3, "GoPlus flags it as a fake copy of a known token.");
  add(bit(r.is_airdrop_scam), 3, "Flagged as an airdrop scam token.");
  add(cannotSellAll, 3, "Holders cannot sell their whole balance.");
  add(bit(r.owner_change_balance), 3, "The owner can change any holder's balance.");
  add(bit(r.hidden_owner), 3, "Hidden owner: someone keeps control even if ownership looks renounced.");
  add(bit(r.can_take_back_ownership), 3, "Ownership can be taken back after it was renounced.");
  add(bit(r.selfdestruct), 3, "The contract can self-destruct.");
  add(bit(r.transfer_pausable), 3, "The owner can pause all transfers, selling included.");
  for (const [n, v] of [["Sell", sell], ["Buy", buy], ["Transfer", transfer]] as const) {
    if (v == null || v <= 0) continue;
    add(true, v >= 50 ? 3 : v >= 10 ? 2 : 1, `${n} tax ${v}% (simulated).`);
  }
  add(cannotBuy, 2, "It cannot be bought directly (cannot_buy).");
  add(bit(r.slippage_modifiable), 2, "The owner can change the buy / sell tax.");
  add(bit(r.personal_slippage_modifiable), 2, "The owner can set a different tax for specific wallets.");
  add(bit(r.is_blacklisted), 2, "Has a blacklist: the owner can block wallets from trading.");
  add(bit(r.is_mintable), 2, "The supply can be minted further.");
  add(bit(r.is_proxy), 2, "Upgradeable proxy: the contract code can be swapped.");
  add(bit(r.is_open_source) === false, 2, "Source code is not verified, the contract cannot be read.");
  add(bit(r.is_whitelisted), 2, "Has a whitelist: trading can be limited to approved wallets.");
  add(bit(r.anti_whale_modifiable), 2, "The owner can change max-transaction / max-wallet limits.");
  add(bit(r.trading_cooldown), 2, "Trading cooldown between trades.");
  if (h.top10ExLockedPct != null && h.top10ExLockedPct > 50) flags.push({ lvl: 2, text: `Top 10 holders (excluding locked / burn addresses) hold ${h.top10ExLockedPct}% of supply (pools and exchanges count as holders).` });
  const creatorPct = frac(r.creator_percent), ownerPct = frac(r.owner_percent);
  if (creatorPct != null && creatorPct > 5) flags.push({ lvl: 2, text: `The creator wallet holds ${creatorPct}% of supply.` });
  if (renounced === false && ownerPct != null && ownerPct > 5) flags.push({ lvl: 2, text: `The owner wallet holds ${ownerPct}% of supply.` });
  if (lpLocked != null && lpLocked < 50) flags.push({ lvl: 2, text: `Only ${lpLocked}% of the main pool's LP is locked or burned, liquidity can be pulled.` });
  add(bit(r.is_anti_whale), 1, "Max transaction / wallet limits (anti-whale).");
  add(bit(r.external_call), 1, "Calls external contracts during transfers.");
  add(bit(r.is_in_dex) === false, 1, "GoPlus found no DEX pool for it.");
  const other = clean(r.other_potential_risks, 160);
  if (other) flags.push({ lvl: 1, text: `GoPlus note: ${other}` });
  if (honeypot === false) ok.push("Simulated sell passed (not a honeypot by GoPlus's test).");
  if (buy === 0 && sell === 0) ok.push("No buy or sell tax.");
  if (bit(r.is_open_source)) ok.push("Source code verified.");
  if (bit(r.is_mintable) === false) ok.push("Not mintable.");
  if (renounced === true && !bit(r.hidden_owner)) ok.push("No owner (ownership renounced).");
  if (bit(r.is_proxy) === false) ok.push("Not an upgradeable proxy.");
  if (bit(r.is_blacklisted) === false) ok.push("No blacklist.");
  if (bit(r.transfer_pausable) === false) ok.push("Transfers cannot be paused.");
  if (lpLocked != null && lpLocked >= 90) ok.push(`${lpLocked}% of the main pool's LP is locked or burned.`);
  if (bit(r.trust_list)) ok.push("On GoPlus's trusted-token list.");
  const cex = r.is_in_cex;
  if (cex && (cex.listed === "1" || cex.listed === 1)) ok.push(`Listed on centralized exchanges${Array.isArray(cex.cex_list) && cex.cex_list.length ? ` (${cex.cex_list.slice(0, 4).map((x: unknown) => clean(x, 20)).join(", ")})` : ""}.`);
  if (buy == null || sell == null) unknown.push("Buy / sell tax could not be simulated.");
  if (honeypot == null) unknown.push("No honeypot simulation result.");
  if (renounced == null) unknown.push("The owner could not be read.");
  return {
    flags: {
      honeypot, buyTaxPct: buy, sellTaxPct: sell, transferTaxPct: transfer, cannotSellAll, cannotBuy, mintable: bit(r.is_mintable),
      ownerCanChangeBalance: bit(r.owner_change_balance), hiddenOwner: bit(r.hidden_owner), canTakeBackOwnership: bit(r.can_take_back_ownership),
      proxy: bit(r.is_proxy), blacklist: bit(r.is_blacklisted), whitelist: bit(r.is_whitelisted), pausable: bit(r.transfer_pausable),
      cooldown: bit(r.trading_cooldown), taxModifiable: bit(r.slippage_modifiable), openSource: bit(r.is_open_source), selfDestruct: bit(r.selfdestruct),
      ownerRenounced: renounced, listedOnDex: bit(r.is_in_dex), trustList: bit(r.trust_list),
    },
    token: { symbol: clean(r.token_symbol, 24), name: clean(r.token_name, 60) },
    holders: { count: num(r.holder_count), top10Pct: h.top10Pct, top10ExLockedPct: h.top10ExLockedPct, creatorPct, ownerPct: renounced === false ? ownerPct : null, top: h.top },
    lp: { holders: num(r.lp_holder_count), lockedOrBurnedPct: lpLocked, dexPools: Array.isArray(r.dex) ? r.dex.length : 0 },
    owner: renounced === false ? normAddr(owner) : null, creator: r.creator_address ? normAddr(String(r.creator_address)) : null,
    ...finish(flags, ok, unknown),
  };
}

/** GoPlus Solana token_security row → the same shape for a mint (pure). */
export function goplusSolana(r: any) {
  const flags: Flag[] = [], ok: string[] = [], unknown: string[] = [];
  const st = (o: any): boolean | null => bit(o?.status);
  const auths = (o: any, key = "authority") => (Array.isArray(o?.[key]) ? o[key] : []).map((a: any) => String(a?.address ?? "")).filter(Boolean) as string[];
  const malicious = [r.mintable?.authority, r.freezable?.authority, r.closable?.authority, r.balance_mutable_authority?.authority, r.metadata_mutable?.metadata_upgrade_authority, r.creators, r.transfer_hook]
    .flatMap((x) => (Array.isArray(x) ? x : [])).some((a: any) => a?.malicious_address === 1 || a?.malicious_address === "1");
  const mint = st(r.mintable), freeze = st(r.freezable), closable = st(r.closable), balMut = st(r.balance_mutable_authority), metaMut = st(r.metadata_mutable);
  const feeRate = frac(r.transfer_fee?.current_fee_rate?.fee_rate ?? r.transfer_fee?.fee_rate);
  const hooks = Array.isArray(r.transfer_hook) ? r.transfer_hook.length : 0;
  const h = holderStats(r.holders);
  const add = (cond: boolean | null, lvl: Lvl, text: string) => { if (cond) flags.push({ lvl, text }); };
  add(malicious, 3, "GoPlus flags an authority or creator address of this mint as malicious.");
  add(balMut, 3, "An authority can change holders' balances.");
  add(freeze, 3, "Freeze authority is live: token accounts can be frozen, which blocks selling.");
  add(closable, 3, "An authority can close the token program.");
  add(String(r.default_account_state ?? "") === "2", 3, "New token accounts start frozen.");
  add(bit(r.non_transferable), 3, "The token is non-transferable.");
  if (feeRate != null && feeRate > 0) flags.push({ lvl: feeRate >= 10 ? 3 : 2, text: `Transfer fee ${feeRate}%.` });
  add(mint, 2, "Mint authority is live: supply can be increased.");
  add(hooks > 0, 2, "Has a transfer hook: an external program runs on every transfer and can block trades.");
  add(st(r.transfer_fee_upgradable), 2, "The transfer fee can be changed.");
  add(st(r.transfer_hook_upgradable), 2, "The transfer hook can be changed.");
  add(st(r.default_account_state_upgradable), 2, "The default account state can be changed (new accounts could start frozen).");
  if (h.top10ExLockedPct != null && h.top10ExLockedPct > 50) flags.push({ lvl: 2, text: `Top 10 holders hold ${h.top10ExLockedPct}% of supply (pool vaults and exchanges count as holders).` });
  add(metaMut, 1, "Metadata (name, logo) can still be changed.");
  if (mint === false) ok.push("Mint authority revoked.");
  if (freeze === false) ok.push("Freeze authority revoked.");
  if (balMut === false) ok.push("No authority can change balances.");
  if (closable === false) ok.push("Not closable.");
  if (metaMut === false) ok.push("Metadata is immutable.");
  if (feeRate == null || feeRate === 0) ok.push("No transfer fee.");
  if (hooks === 0) ok.push("No transfer hook.");
  if (bit(r.trusted_token) || r.trusted_token === 1) ok.push("On GoPlus's trusted-token list.");
  if (mint == null && freeze == null) unknown.push("Authorities could not be read.");
  return {
    flags: { mintAuthority: mint, freezeAuthority: freeze, balanceMutable: balMut, closable, metadataMutable: metaMut, transferFeePct: feeRate ?? 0, transferHooks: hooks, nonTransferable: bit(r.non_transferable), defaultAccountState: String(r.default_account_state ?? "") || null, trusted: bit(r.trusted_token) ?? (r.trusted_token === 1 ? true : null) },
    token: { symbol: clean(r.metadata?.symbol, 24), name: clean(r.metadata?.name, 60) },
    authorities: { mint: auths(r.mintable), freeze: auths(r.freezable), metadata: auths(r.metadata_mutable, "metadata_upgrade_authority") },
    holders: { count: num(r.holder_count), top10Pct: h.top10Pct, top10ExLockedPct: h.top10ExLockedPct, top: h.top },
    lp: { dexPools: Array.isArray(r.dex) ? r.dex.length : 0, topPools: (Array.isArray(r.dex) ? r.dex : []).slice().sort((a: any, b: any) => (num(b?.tvl) ?? 0) - (num(a?.tvl) ?? 0)).slice(0, 3).map((d: any) => ({ dex: clean(d?.dex_name, 20), tvlUsd: usd(num(d?.tvl)), pool: String(d?.id ?? "") })) },
    ...finish(flags, ok, unknown),
  };
}
export const goplusPage = (chainId: string, address: string) => `https://gopluslabs.io/token-security/${encodeURIComponent(chainId)}/${encodeURIComponent(address)}`;

// ── schemas + registry rows ───────────────────────────────────────────────────────────────────────────────────────────
const NETWORK_PROP = { type: "string", description: "chain name: solana, eth, base, bsc, arbitrum, polygon, avalanche, optimism, robinhood, monad, hyperevm, sui, ton, tron …" };
export const DEX_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "dex_trending",
      description: "Trending DEX pools right now on every chain or one network (GeckoTerminal): chain, DEX, pair, token + address, price, % change 5m / 1h / 6h / 24h, 24h volume, liquidity, FDV / market cap, 24h buys / sells, pool age. Use for 'what's trending on Solana', 'hot memecoins on Base right now', 'trending pools today', 'token nào đang hot trên dex'. Not CoinGecko's coin list (cg_trending) and not Chord's Arc / Robinhood boards.",
      parameters: { type: "object", properties: { network: { ...NETWORK_PROP, description: `optional, omit for every chain. ${NETWORK_PROP.description}` }, duration: { type: "string", enum: ["5m", "1h", "6h", "24h"], description: "trending window, default 1h" }, limit: { type: "number", description: "rows, default 12, max 20" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "dex_new_pairs",
      description: "The newest DEX pools on one network or every chain (GeckoTerminal), minutes old, above a liquidity floor (default $5k; 0 shows everything): pair, token + address, age in minutes, liquidity, volume, buys / sells, price change. Use for 'new pairs on Solana', 'newly launched tokens on Base', 'fresh listings', 'cặp mới list', 'token mới ra'. Brand-new pools are mostly copycats and rugs.",
      parameters: { type: "object", properties: { network: { ...NETWORK_PROP, description: `optional, omit for every chain. ${NETWORK_PROP.description}` }, min_liquidity_usd: { type: "number", description: "liquidity floor in USD, default 5000, 0 = no floor" }, limit: { type: "number", description: "rows, default 12, max 20" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "dex_movers",
      description: "Top gainers or losers on ONE network over 1h / 6h / 24h among its most-traded pools (GeckoTerminal's top ~60 pools by 24h volume; liquidity ≥ $50k and 24h volume ≥ $25k by default; one pool per token). Use for 'biggest gainers on Base today', 'top losers on Solana in the last hour', 'what is pumping on BSC', 'top tăng / giảm trên Solana'.",
      parameters: { type: "object", properties: { network: NETWORK_PROP, window: { type: "string", enum: ["1h", "6h", "24h"], description: "default 24h" }, direction: { type: "string", enum: ["gainers", "losers"], description: "default gainers" }, min_liquidity_usd: { type: "number", description: "default 50000" }, min_volume_usd: { type: "number", description: "24h volume floor, default 25000" }, limit: { type: "number", description: "rows, default 12, max 20" } }, required: ["network"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "dex_pool",
      description: "Full stats for one DEX pool (network + pool address) or one token (network + token address or ticker → its deepest pool) on any chain GeckoTerminal covers: price, % change 5m–24h, volume 1h / 6h / 24h, liquidity, FDV / market cap, buys / sells / unique traders, pool age, locked liquidity, the token's GeckoTerminal score, holder count + top-10 share, mint / freeze authority, links, and a price chart (hourly 48h or daily 60d). Use for 'analyze this Solana token <mint>', 'stats of this pool', 'price chart of X on Base', 'phân tích token này trên Solana'.",
      parameters: { type: "object", properties: { network: NETWORK_PROP, pool: { type: "string", description: "pool address (or use token)" }, token: { type: "string", description: "token address or ticker (its deepest pool is used)" }, tf: { type: "string", enum: ["hour", "day"], description: "chart: hour = last 48 hours (default), day = last 60 days" } }, required: ["network"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "dex_pool_trades",
      description: "Recent trades of one DEX pool (or a token's deepest pool) on any chain (GeckoTerminal, the last ≤300 trades within 24h, optional minimum size): buy vs sell volume and counts, the largest prints, and the wallets that bought / sold the most in the sample. Use for 'who is buying X', 'large trades on this pool', 'whale buys on <token>', 'ví nào đang mua / bán'.",
      parameters: { type: "object", properties: { network: NETWORK_PROP, pool: { type: "string", description: "pool address (or use token)" }, token: { type: "string", description: "token address or ticker (its deepest pool is used)" }, min_usd: { type: "number", description: "only trades at least this size in USD" }, limit: { type: "number", description: "largest prints to list, default 10, max 20" } }, required: ["network"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "dex_token_pools",
      description: "Every pool a token trades in on one network (GeckoTerminal, up to 20): DEX, pair, liquidity and its share, 24h volume and its share, the token's price in each pool, idle pools. Use for 'where is X's liquidity', 'which DEX has the most liquidity for X', 'all pools of this token', 'thanh khoản của token nằm ở đâu'.",
      parameters: { type: "object", properties: { network: NETWORK_PROP, token: { type: "string", description: "token address or ticker" }, limit: { type: "number", description: "rows, default 15, max 20" } }, required: ["network", "token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "dex_promoted",
      description: "DexScreener's paid promotion feeds: top boosted tokens (most boost spend), the latest boosts, or the latest token profiles, optionally one chain; each with chain, token + address, boost amount, price, 24h change, liquidity, 24h volume, market cap, age. Boosts are PAID ads bought by anyone (usually the team), not a quality signal. Use for 'what's boosted on DexScreener', 'DexScreener promoted / trending ads', 'token nào đang chạy boost'.",
      parameters: { type: "object", properties: { feed: { type: "string", enum: ["top_boosts", "latest_boosts", "profiles"], description: "default top_boosts" }, chain: { type: "string", description: "optional: solana, base, bsc, ethereum, robinhood …" }, limit: { type: "number", description: "rows, default 12, max 20" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "token_safety",
      description: "Contract security scan of one token by address (GoPlus): honeypot (simulated sell), buy / sell tax, can't-sell-all, mintable, owner can change balances, hidden owner, take-back ownership, proxy, blacklist / whitelist, pausable, cooldown, verified source, holder count + top-10 share, creator share, LP locked; for Solana mints: mint / freeze authority, balance-mutable, closable, transfer fee / hook, mutable metadata. Ethereum, BNB Chain, Base, Arbitrum, Optimism, Polygon, Avalanche, Solana, Robinhood Chain, Monad, Arc, Tron, Linea, Sonic, Berachain, Abstract and more. Use for 'is this a honeypot', 'rug check', 'token tax', 'can the owner mint', 'kiểm tra scam / rug', 'thuế token'.",
      parameters: { type: "object", properties: { token: { type: "string", description: "token contract address or Solana mint" }, chain: { type: "string", description: "eth, bsc, base, arbitrum, optimism, polygon, avalanche, robinhood, monad, arc, tron … (optional for a Solana mint)" } }, required: ["token"] },
    },
  },
];

export const DEX_TOOL_META: Record<string, ToolMeta> = {
  dex_trending: { group: "dexscan", label: "Reading trending DEX pools", market: true, untrusted: true },
  dex_new_pairs: { group: "dexscan", label: "Listing the newest DEX pools", market: true, untrusted: true, timeoutMs: 20_000 },
  dex_movers: { group: "dexscan", label: "Ranking DEX gainers and losers", market: true, untrusted: true, timeoutMs: 30_000 },
  dex_pool: { group: "dexscan", label: "Reading the pool", untrusted: true, timeoutMs: 25_000 },
  dex_pool_trades: { group: "dexscan", label: "Reading the pool's recent trades", untrusted: true, timeoutMs: 25_000 },
  dex_token_pools: { group: "dexscan", label: "Finding where the token's liquidity is", untrusted: true, timeoutMs: 25_000 },
  dex_promoted: { group: "dexscan", label: "Reading DexScreener's paid promotions", market: true, untrusted: true, timeoutMs: 20_000 },
  token_safety: { group: "safety", label: "Scanning the contract for risks", untrusted: true, timeoutMs: 20_000 },
};

export const DEX_TOOL_NAMES = ["dex_trending", "dex_new_pairs", "dex_movers", "dex_pool", "dex_pool_trades", "dex_token_pools", "dex_promoted", "token_safety"] as const;
export const isDexTool = (name: string): boolean => (DEX_TOOL_NAMES as readonly string[]).includes(name);

const fail = (data: unknown, addresses: string[] = []): ExtToolResult => ({ data, addresses, citations: [] });
const gtCite = (p: GtPool, label?: string): Citation => ({ label: label ?? `${p.base.symbol || short(p.base.address)} · ${p.pair} on GeckoTerminal`, href: p.url });

/** Runs one tool of this module. Never throws: a source failure answers extFailure(...). */
export async function runDexTool(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  const source = name === "token_safety" ? "GoPlus" : name === "dex_promoted" ? "DexScreener" : "GeckoTerminal";
  try {
    switch (name) {
      case "dex_trending": return await dexTrending(args);
      case "dex_new_pairs": return await dexNewPairs(args);
      case "dex_movers": return await dexMovers(args);
      case "dex_pool": return await dexPool(args);
      case "dex_pool_trades": return await dexPoolTrades(args);
      case "dex_token_pools": return await dexTokenPools(args);
      case "dex_promoted": return await dexPromoted(args);
      case "token_safety": return await tokenSafety(args);
      default: return fail({ error: `unknown tool ${name}` });
    }
  } catch (e) {
    if (e instanceof ExtError && e.notFound) return fail(name === "token_safety" ? notFound("The token", "GoPlus") : name === "dex_promoted" ? notFound("The feed", "DexScreener") : notFound("The pool or token"));
    return fail(extFailure(source, e));
  }
}

// ── tools ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function optionalNetwork(v: unknown): Promise<{ id: string; name: string } | null | "bad"> {
  if (v == null || String(v).trim() === "" || /^(all|any|every|all chains)$/i.test(String(v).trim())) return null;
  return (await resolveNetwork(v)) ?? "bad";
}

async function dexTrending(args: Record<string, any>): Promise<ExtToolResult> {
  const net = await optionalNetwork(args.network);
  if (net === "bad") return fail(unknownNetwork(args.network));
  const duration = (["5m", "1h", "6h", "24h"] as const).find((d) => d === args.duration) ?? "1h";
  const limit = lim(args.limit, 12, 20);
  const path = net ? `/networks/${net.id}/trending_pools${qs({ include: POOL_INCLUDE, duration })}` : `/networks/trending_pools${qs({ include: `${POOL_INCLUDE},network`, duration })}`;
  const { data, ageS } = await gt(path, 90);
  const now = Date.now();
  const pools = gtPools(data, net?.id ?? null).slice(0, limit);
  const where = net?.name ?? "every chain";
  if (!pools.length) return fail({ source: "GeckoTerminal", network: where, pools: [], note: "GeckoTerminal returned no trending pools for that network. Say so." });
  const rc = riskCounts(pools, now);
  return {
    data: {
      source: "GeckoTerminal", ...withAge(ageS), network: where, duration, pools: pools.map((p) => poolRow(p, now, !net)),
      note: `GeckoTerminal's trending rank over ${duration} (its own mix of trading activity and page views), not a quality signal. ${rc.thin} of ${pools.length} pools ${rc.thin === 1 ? "has" : "have"} under $50k liquidity (a modest order moves the price) and ${are(rc.young)} under a day old (no history). Volume can be wash-traded. ${UNTRUSTED_NAMES}`,
    },
    addresses: [...new Set(pools.flatMap((p) => [p.base.address, p.address]))],
    citations: pools.slice(0, 3).map((p) => gtCite(p)),
    viz: [poolsTable(`Trending on ${where} · ${duration} (GeckoTerminal)`, pools.slice(0, 15), now, !net)],
    chipCandidates: chipsOf(pools),
  };
}

async function dexNewPairs(args: Record<string, any>): Promise<ExtToolResult> {
  const net = await optionalNetwork(args.network);
  if (net === "bad") return fail(unknownNetwork(args.network));
  const floor = args.min_liquidity_usd == null || args.min_liquidity_usd === "" ? 5_000 : Math.max(0, Number(args.min_liquidity_usd) || 0);
  const limit = lim(args.limit, 12, 20);
  const path = (page: number) => net ? `/networks/${net.id}/new_pools${qs({ include: POOL_INCLUDE, page })}` : `/networks/new_pools${qs({ include: `${POOL_INCLUDE},network`, page })}`;
  const first = await gt(path(1), 60);
  let all = gtPools(first.data, net?.id ?? null), ageS = first.ageS;
  const passes = (p: GtPool) => floor === 0 || (p.liquidityUsd ?? 0) >= floor;
  if (floor > 0 && all.filter(passes).length < limit) {
    try { const second = await gt(path(2), 60); all = [...all, ...gtPools(second.data, net?.id ?? null)]; ageS = maxAge(ageS, second.ageS); } catch { /* page 1 is enough to answer */ }
  }
  const now = Date.now();
  const kept = all.filter(passes).slice(0, limit);
  const where = net?.name ?? "every chain";
  const rows = kept.map((p) => { const { ageHours, ...r } = poolRow(p, now, !net); return { ...r, ageMinutes: ageHours == null ? null : Math.round(ageHours * 60) }; });
  return {
    data: {
      source: "GeckoTerminal", ...withAge(ageS), network: where, scanned: all.length, passed: all.filter(passes).length, minLiquidityUsd: floor, pools: rows,
      note: `The ${all.length} newest pools GeckoTerminal saw on ${where}; ${all.filter(passes).length} passed the ${floor ? `$${floor.toLocaleString("en-US")} liquidity floor` : "no-floor setting"}. Pools minutes old have no history, their liquidity can be pulled at any moment and most are copycats or rugs. This is a listing feed, not picks. ${UNTRUSTED_NAMES}`,
    },
    addresses: [...new Set(kept.flatMap((p) => [p.base.address, p.address]))],
    citations: kept.slice(0, 3).map((p) => gtCite(p)),
    viz: kept.length ? [vTable(`New pools on ${where} (GeckoTerminal)`, ["Token", ...(net ? [] : ["Chain"]), "DEX", "Age", "Liquidity", "Volume", "Buys / sells", "Change"],
      kept.map((p) => [p.base.symbol, ...(net ? [] : [p.chainName]), p.dex, ageLabel(ageHoursOf(p, now)), usdCell(p.liquidityUsd), usdCell(p.volume.h24), `${p.tx24h.buys} / ${p.tx24h.sells}`, pctCell(p.change.h24)]),
      ["l", ...(net ? [] : ["l" as const]), "l", "r", "r", "r", "r", "r"], kept.map((p) => p.url), 0)] : [],
    chipCandidates: chipsOf(kept),
  };
}

async function dexMovers(args: Record<string, any>): Promise<ExtToolResult> {
  if (!args.network) return fail({ error: "network required (movers rank one chain at a time).", note: "Ask which chain, or use dex_trending for every chain." });
  const net = await resolveNetwork(args.network);
  if (!net) return fail(unknownNetwork(args.network));
  const wArg = (["1h", "6h", "24h"] as const).find((w) => w === args.window) ?? "24h";
  const window: MoverWindow = wArg === "1h" ? "h1" : wArg === "6h" ? "h6" : "h24";
  const direction = args.direction === "losers" ? "losers" : "gainers";
  const minLiquidityUsd = args.min_liquidity_usd == null || args.min_liquidity_usd === "" ? 50_000 : Math.max(0, Number(args.min_liquidity_usd) || 0);
  const minVolumeUsd = args.min_volume_usd == null || args.min_volume_usd === "" ? 25_000 : Math.max(0, Number(args.min_volume_usd) || 0);
  const limit = lim(args.limit, 12, 20);
  let pools: GtPool[] = [], ageS = 0;
  for (let page = 1; page <= 3; page++) {
    try {
      const r = await gt(`/networks/${net.id}/pools${qs({ include: POOL_INCLUDE, sort: "h24_volume_usd_desc", page })}`, 120);
      const got = gtPools(r.data, net.id);
      pools = [...pools, ...got]; ageS = maxAge(ageS, r.ageS);
      if (got.length < 20) break;
    } catch (e) { if (page === 1) throw e; break; } // later pages are best-effort: rank what came back
  }
  const { passed, tokens, ranked } = rankMovers(pools, { window, direction, minLiquidityUsd, minVolumeUsd });
  const top = ranked.slice(0, limit);
  const now = Date.now();
  return {
    data: {
      source: "GeckoTerminal", ...withAge(ageS), network: net.name, window: wArg, direction, scannedPools: pools.length, passedFloors: passed, tokens,
      minLiquidityUsd, minVolume24hUsd: minVolumeUsd, movers: top.map((p) => poolRow(p, now, false)),
      note: `Ranking covers only the top ${pools.length} pools by 24h volume on ${net.name} (GeckoTerminal), ${passed} of them with liquidity ≥ $${minLiquidityUsd.toLocaleString("en-US")} and 24h volume ≥ $${minVolumeUsd.toLocaleString("en-US")}; not every token on the chain. One pool per token (the deepest); change = that pool's price change over ${wArg}.${top.length ? "" : ` No pool ${direction === "gainers" ? "rose" : "fell"} over ${wArg} among them, say so.`} A big % move on modest liquidity can be one wallet. ${UNTRUSTED_NAMES}`,
    },
    addresses: [...new Set(top.flatMap((p) => [p.base.address, p.address]))],
    citations: top.slice(0, 3).map((p) => gtCite(p)),
    viz: top.length ? [poolsTable(`${net.name} · top ${direction} · ${wArg} (GeckoTerminal)`, top, now, false, window)] : [],
    chipCandidates: chipsOf(top),
  };
}

async function dexPool(args: Record<string, any>): Promise<ExtToolResult> {
  if (!args.network) return fail({ error: "network required.", note: "Ask which chain the pool or token is on (or use dex_search to find it across chains)." });
  const net = await resolveNetwork(args.network);
  if (!net) return fail(unknownNetwork(args.network));
  const found = await poolFor(net.id, args);
  if ("error" in found) return fail(found);
  const { pool: p, focus, side, lookAlikes } = found;
  const tf = args.tf === "day" ? "day" : "hour";
  const [infoR, ohlcvR] = await Promise.allSettled([
    gt(`/networks/${net.id}/pools/${encodeURIComponent(p.address)}/info`, 600),
    gt(`/networks/${net.id}/pools/${encodeURIComponent(p.address)}/ohlcv/${tf}${qs({ aggregate: 1, limit: tf === "day" ? 60 : 48, currency: "usd", token: focus })}`, tf === "day" ? 900 : 180),
  ]);
  const infoRows: any[] = infoR.status === "fulfilled" && Array.isArray(infoR.value.data?.data) ? infoR.value.data.data : [];
  const info = tokenInfo(infoRows.find((x) => sameAddr(String(x?.attributes?.address ?? ""), focus))?.attributes);
  const candles = ohlcvR.status === "fulfilled" ? ohlcvCandles(ohlcvR.value.data) : [];
  const chart = chartSummary(candles);
  const ageS = maxAge(found.ageS, infoR.status === "fulfilled" ? infoR.value.ageS : 0, ohlcvR.status === "fulfilled" ? ohlcvR.value.ageS : 0);
  const now = Date.now();
  const ageH = ageHoursOf(p, now);
  const tokenSide = side === "base" ? p.base : p.quote, other = side === "base" ? p.quote : p.base;
  const priceUsd = side === "base" ? p.priceUsd : p.quotePriceUsd;
  const warn = [
    (p.liquidityUsd ?? 0) < 50_000 ? `Liquidity is only ${usdCell(p.liquidityUsd)}: a modest order moves the price.` : null,
    ageH != null && ageH < 24 ? "The pool is under a day old: no price history." : null,
    side === "quote" ? `${tokenSide.symbol} is the quote side of its deepest pool: the % changes and buy / sell counts below are the pool's (they describe ${other.symbol}), the chart is ${tokenSide.symbol}'s USD price.` : null,
    lookAlikes.length ? "Other tokens share this ticker on this network (lookAlikes): say which one you used." : null,
    info?.isHoneypot ? "GeckoTerminal marks the token as a honeypot." : null,
  ].filter(Boolean).join(" ");
  const data = {
    source: "GeckoTerminal", ...withAge(ageS), chain: net.name,
    pool: { address: p.address, pair: p.pair, dex: p.dex, ageHours: ageH == null ? null : Math.round(ageH * 10) / 10, lockedLiquidityPct: p.lockedLiquidityPct, url: p.url },
    token: { symbol: tokenSide.symbol, name: tokenSide.name, address: tokenSide.address, side }, pairedWith: { symbol: other.symbol, address: other.address },
    priceUsd: sig(priceUsd), change5mPct: p2(p.change.m5), change1hPct: p2(p.change.h1), change6hPct: p2(p.change.h6), change24hPct: p2(p.change.h24),
    volume1hUsd: usd(p.volume.h1), volume6hUsd: usd(p.volume.h6), volume24hUsd: usd(p.volume.h24), liquidityUsd: usd(p.liquidityUsd), fdvUsd: usd(p.fdvUsd), marketCapUsd: usd(p.marketCapUsd),
    txns1h: p.tx1h, txns24h: p.tx24h,
    tokenInfo: info, chart: chart ? { tf, ...chart } : null,
    ...(lookAlikes.length ? { lookAlikes } : {}),
    note: `${warn ? `${warn} ` : ""}Numbers are GeckoTerminal's for this one pool; the token's other pools can price differently (dex_token_pools lists them). Website, socials and description are the project's own claims. gtScore is GeckoTerminal's heuristic, not an audit: for contract risks use token_safety.${info ? "" : " Token info was unavailable just now."}${chart ? "" : " The price chart was unavailable just now."}`,
  };
  const chip = chipWorthyPool(p) && side === "base" ? gtChip(p) : null;
  return {
    data,
    addresses: [...new Set([p.address, p.base.address, p.quote.address, ...lookAlikes.map((x) => x.address)].filter(Boolean))],
    citations: [gtCite(p)],
    viz: candles.length > 2 ? [{ kind: "line", title: `${tokenSide.symbol} on ${net.name} · ${tf === "day" ? "daily" : "hourly"} close (GeckoTerminal)`, x: candles.map((c) => tf === "day" ? new Date(c.ts * 1000).toISOString().slice(5, 10) : new Date(c.ts * 1000).toISOString().slice(11, 16)), series: [{ name: "Close", values: candles.map((c) => sig(c.close)) }], unit: "price" }] : [],
    ...(chip ? { chipCandidates: [chip] } : {}),
  };
}

async function dexPoolTrades(args: Record<string, any>): Promise<ExtToolResult> {
  if (!args.network) return fail({ error: "network required.", note: "Ask which chain the pool or token is on." });
  const net = await resolveNetwork(args.network);
  if (!net) return fail(unknownNetwork(args.network));
  const found = await poolFor(net.id, args);
  if ("error" in found) return fail(found);
  const { pool: p, focus, side } = found;
  const minUsd = Math.max(0, Number(args.min_usd) || 0);
  const limit = lim(args.limit, 10, 20);
  const { data, ageS } = await gt(`/networks/${net.id}/pools/${encodeURIComponent(p.address)}/trades${qs({ trade_volume_in_usd_greater_than: minUsd || undefined, token: side === "quote" ? focus : undefined })}`, 60);
  const trades = gtTrades(data);
  const now = Date.now();
  const s = summarizeTrades(trades, now, limit);
  const sym = side === "base" ? p.base.symbol : p.quote.symbol;
  const wallets = [...new Set([...s.largest.map((t) => t.wallet), ...s.topBuyers.map((w) => w.wallet), ...s.topSellers.map((w) => w.wallet)].filter(Boolean))];
  const topWallets = [...new Map([...s.topBuyers, ...s.topSellers].map((w) => [w.wallet, w])).values()].sort((a, b) => ((b.boughtUsd ?? 0) + (b.soldUsd ?? 0)) - ((a.boughtUsd ?? 0) + (a.soldUsd ?? 0))).slice(0, 8);
  return {
    data: {
      source: "GeckoTerminal", ...withAge(maxAge(ageS, found.ageS)), chain: net.name, pool: p.address, pair: p.pair, dex: p.dex, token: { symbol: sym, address: focus },
      minUsd: minUsd || undefined, ...s,
      note: `Sample = the last ${s.trades} trades GeckoTerminal returns for this one pool (it returns at most 300, within 24h)${minUsd ? `, trades ≥ $${minUsd.toLocaleString("en-US")} only` : ""}, covering ${s.windowMinutes ?? 0} minutes. Not the token's whole flow: its other pools are not included. Wallet = the transaction sender, often a router, bot or aggregator relayer rather than the final holder. Buy / sell = ${sym} bought / sold.`,
    },
    addresses: [...new Set([p.address, focus, ...wallets])],
    citations: [gtCite(p, `${sym} · ${p.pair} trades on GeckoTerminal`)],
    viz: trades.length ? [
      vTable(`${sym} · largest trades in the sample (GeckoTerminal)`, ["Side", "USD", "Price", "Wallet", "Ago"], s.largest.map((t) => [t.side, usdCell(t.usd), t.priceUsd, short(t.wallet), `${t.minutesAgo}m`]), ["l", "r", "r", "l", "r"]),
      vTable(`${sym} · most active wallets in the sample`, ["Wallet", "Bought", "Sold", "Net", "Trades"], topWallets.map((w) => [short(w.wallet), usdCell(w.boughtUsd), usdCell(w.soldUsd), usdCell(w.netUsd), w.trades]), ["l", "r", "r", "r", "r"]),
    ] : [],
  };
}

async function dexTokenPools(args: Record<string, any>): Promise<ExtToolResult> {
  if (!args.network) return fail({ error: "network required.", note: "Ask which chain the token is on." });
  const net = await resolveNetwork(args.network);
  if (!net) return fail(unknownNetwork(args.network));
  const q = String(args.token ?? "").trim();
  if (!q) return fail({ error: "token required (address or ticker).", note: "Ask which token." });
  const hit = await resolveToken(net.id, q);
  if (!hit) return fail({ error: `No token called "${clean(q, 30)}" in GeckoTerminal's search on ${net.name}.`, note: "Say so; dex_search looks across every chain. Do not guess an address." });
  const r = await gt(`/networks/${net.id}/tokens/${encodeURIComponent(hit.address)}/pools${qs({ include: POOL_INCLUDE })}`, 60);
  const pools = gtPools(r.data, net.id);
  const s = tokenPoolsSummary(pools, hit.address);
  if (!s.pools.length) return fail({ source: "GeckoTerminal", chain: net.name, token: hit.address, pools: [], note: `GeckoTerminal lists no pool for this token on ${net.name}. Say so (or the network may be wrong).` }, [hit.address]);
  const limit = lim(args.limit, 15, 20);
  const deepest = deepestPoolFor(pools, hit.address)!;
  const sym = sideIn(deepest, hit.address) === "base" ? deepest.base.symbol : deepest.quote.symbol;
  const rows = s.pools.slice(0, limit);
  const top6 = rows.slice(0, 6), rest = (s.totalLiquidityUsd ?? 0) - top6.reduce((a, x) => a + (x.liquidityUsd ?? 0), 0);
  const chip = sideIn(deepest, hit.address) === "base" && chipWorthyPool(deepest) ? gtChip(deepest) : null;
  return {
    data: {
      source: "GeckoTerminal", ...withAge(maxAge(hit.ageS, r.ageS)), chain: net.name, token: { symbol: sym, address: hit.address },
      poolCount: s.pools.length, totalLiquidityUsd: s.totalLiquidityUsd, totalVolume24hUsd: s.totalVolume24hUsd, priceSpreadPct: s.priceSpreadPct, idlePools: s.idlePools, pools: rows,
      ...(hit.lookAlikes.length ? { lookAlikes: hit.lookAlikes } : {}),
      note: `GeckoTerminal's top pools for this token on ${net.name} (one page, up to 20; tiny pools beyond it are left out). Liquidity is GeckoTerminal's reserve estimate: hooked Uniswap V4 pools and pools paired with obscure tokens can overstate it; a pool with liquidity but no 24h volume (idle) is not a proven exit. priceSpreadPct compares pools with ≥ $10k liquidity.${hit.lookAlikes.length ? " Other tokens share this ticker (lookAlikes): say which one you used." : ""}`,
    },
    addresses: [...new Set([hit.address, ...rows.map((x) => x.pool), ...hit.lookAlikes.map((x) => x.address)])],
    citations: [gtCite(deepest, `${sym} · deepest pool on GeckoTerminal`)],
    viz: [
      vTable(`${sym} on ${net.name} · pools by liquidity (GeckoTerminal)`, ["Pair", "DEX", "Liquidity", "Share", "Vol 24h", "Price"], rows.map((x) => [x.pair, x.dex, usdCell(x.liquidityUsd), x.liquiditySharePct == null ? "n/a" : `${x.liquiditySharePct}%`, usdCell(x.volume24hUsd), x.priceUsd]), ["l", "l", "r", "r", "r", "r"], rows.map((x) => gtPoolUrl(net.id, x.pool)), 0),
      { kind: "donut", title: `${sym} · liquidity by pool`, slices: [...top6.map((x) => ({ name: `${x.pair} · ${x.dex}`.slice(0, 40), value: x.liquidityUsd ?? 0 })), ...(rest > 1 ? [{ name: "Other pools", value: Math.round(rest) }] : [])], unit: "usd" },
    ],
    ...(chip ? { chipCandidates: [chip] } : {}),
  };
}

async function dexPromoted(args: Record<string, any>): Promise<ExtToolResult> {
  const feed: PromoFeed = (["top_boosts", "latest_boosts", "profiles"] as const).find((f) => f === args.feed) ?? "top_boosts";
  const chain = args.chain == null || String(args.chain).trim() === "" ? null : dsChainId(args.chain);
  const limit = lim(args.limit, 12, 20);
  const { data, ageS } = await extJson<any>("dexscreener", `${DS}${FEED_PATH[feed]}`, { ttlS: 120, timeoutMs: CALL_MS });
  const rows = promoRows(data, chain).slice(0, limit);
  const feedName = feed === "top_boosts" ? "top boosts" : feed === "latest_boosts" ? "latest boosts" : "latest token profiles";
  if (!rows.length) return fail({ source: "DexScreener", feed: feedName, chain, rows: [], note: `Nothing in DexScreener's ${feedName} feed${chain ? ` for ${chainNameOf(chain)}` : ""} right now. Say so.` });
  // Market data per token: /tokens/v1/{chain}/{≤30 addresses}, one call per chain (best-effort).
  const byChain = new Map<string, string[]>();
  for (const r of rows) byChain.set(r.chainId, [...(byChain.get(r.chainId) ?? []), r.address]);
  const markets = new Map<string, DsMarket>();
  let marketAge = 0, marketsFailed = 0;
  await Promise.all([...byChain.entries()].slice(0, 5).map(async ([c, addrs]) => {
    try {
      const r = await extJson<any>("dexscreener", `${DS}/tokens/v1/${encodeURIComponent(c)}/${addrs.slice(0, 30).map(encodeURIComponent).join(",")}`, { ttlS: 60, timeoutMs: CALL_MS });
      for (const [k, v] of dsMarkets(r.data)) markets.set(`${c}:${k}`, v);
      marketAge = maxAge(marketAge, r.ageS);
    } catch { marketsFailed++; }
  }));
  const now = Date.now();
  const out = rows.map((r) => {
    const m = markets.get(`${r.chainId}:${normAddr(r.address)}`);
    const ageH = m?.createdMs ? Math.max(0, (now - m.createdMs) / 3_600_000) : null;
    return {
      chain: chainNameOf(r.chainId), symbol: m?.symbol ?? null, name: m?.name ?? null, address: r.address,
      ...(feed !== "profiles" ? { boostTotal: r.boostTotal } : {}), ...(feed === "latest_boosts" ? { boostAdded: r.boostAdded } : {}), ...(feed === "profiles" && r.cto != null ? { communityTakeover: r.cto } : {}),
      priceUsd: sig(m?.priceUsd), change24hPct: p2(m?.change24hPct), liquidityUsd: usd(m?.liquidityUsd), volume24hUsd: usd(m?.volume24hUsd), marketCapUsd: usd(m?.marketCapUsd ?? m?.fdvUsd),
      ageHours: ageH == null ? null : Math.round(ageH * 10) / 10, description: r.description || null, links: r.links, url: m?.pairUrl ?? r.url,
      _m: m, _c: r.chainId,
    };
  });
  const thin = out.filter((x) => (x.liquidityUsd ?? 0) < 50_000).length, young = out.filter((x) => x.ageHours != null && x.ageHours < 24).length;
  const chips: AssetChip[] = out.filter((x) => x._m && x.symbol && x.symbol.length <= 16 && (x._m.liquidityUsd ?? 0) >= 10_000 && (x._m.volume24hUsd ?? 0) >= 1_000 && x._m.txns24h >= 10 && x._m.priceUsd != null)
    .map((x) => ({ id: `dex:${x._c}:${x.address}`, symbol: x.symbol!, label: x.name || x.symbol!, price: sig(x._m!.priceUsd), change24hPct: p2(x._m!.change24hPct), hl: null, href: x.url, ...(x._m!.image ? { logo: x._m!.image } : {}), marketCapUsd: usd(x._m!.marketCapUsd), volume24hUsd: usd(x._m!.volume24hUsd), liquidityUsd: usd(x._m!.liquidityUsd), fdvUsd: usd(x._m!.fdvUsd), kind: "crypto" as const, chainName: x.chain }));
  const rowsOut = out.map(({ _m, _c, ...x }) => x);
  return {
    data: {
      source: "DexScreener", ...withAge(maxAge(ageS, marketAge)), feed: feedName, chain: chain ? chainNameOf(chain) : "every chain", rows: rowsOut,
      note: `DexScreener boosts and profiles are PAID placements: anyone can buy them (usually the token's own team). It is an ad, not a quality, safety or popularity signal. ${thin} of ${rowsOut.length} promoted tokens ${thin === 1 ? "has" : "have"} under $50k liquidity and ${are(young)} under a day old. Descriptions and links are the advertiser's own words.${marketsFailed ? " Market data was unavailable for some rows (null)." : ""} ${UNTRUSTED_NAMES}`,
    },
    addresses: [...new Set(rowsOut.map((x) => x.address))],
    citations: rowsOut.slice(0, 3).map((x) => ({ label: `${x.symbol ?? short(x.address)} on ${x.chain} · DexScreener`, href: x.url })),
    viz: [vTable(`DexScreener ${feedName}${chain ? ` · ${chainNameOf(chain)}` : ""} (paid)`, ["Token", "Chain", ...(feed !== "profiles" ? ["Boost"] : []), "Price", "24h", "Liquidity", "Vol 24h", "Age"],
      rowsOut.map((x) => [x.symbol ?? short(x.address), x.chain, ...(feed !== "profiles" ? [(x as { boostTotal?: number | null }).boostTotal ?? null] : []), x.priceUsd, pctCell(x.change24hPct), usdCell(x.liquidityUsd), usdCell(x.volume24hUsd), ageLabel(x.ageHours)]),
      ["l", "l", ...(feed !== "profiles" ? ["r" as const] : []), "r", "r", "r", "r", "r"], rowsOut.map((x) => x.url), 0)],
    chipCandidates: chips,
  };
}

async function tokenSafety(args: Record<string, any>): Promise<ExtToolResult> {
  const token = String(args.token ?? "").trim();
  if (!token) return fail({ error: "token address required.", note: "Ask for the token's contract address (or Solana mint)." });
  const isEvm = EVM_ADDR.test(token), isTron = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(token), isSol = !isEvm && !isTron && B58.test(token);
  if (!isEvm && !isTron && !isSol) return fail({ error: "token must be a contract address (0x…), a Solana mint or a Tron address.", note: "Resolve the ticker first (dex_search / dex_token_pools give the address), then scan it." });
  let supported: GpChain[] | null = null;
  try {
    const r = await extJson<any>("goplus", `${GP}/supported_chains`, { ttlS: 86_400, staleS: 7 * 86_400, timeoutMs: CALL_MS });
    supported = (Array.isArray(r.data?.result) ? r.data.result : []).map((c: any) => ({ id: String(c?.id ?? ""), name: String(c?.name ?? "") })).filter((c: GpChain) => c.id);
    if (!supported?.length) supported = null;
  } catch { /* the alias table still answers the common chains */ }
  const chainArg = args.chain == null || String(args.chain).trim() === "" ? (isSol ? "solana" : isTron ? "tron" : null) : args.chain;
  if (chainArg == null) return fail({ error: "chain required for a 0x address (eth, bsc, base, arbitrum, polygon, avalanche, robinhood, monad, arc …).", note: "Ask which chain the token is on; the same address can be different tokens on different chains." });
  const chain = goplusChainId(chainArg, supported);
  if (!chain) {
    return fail({ supported: false, error: `GoPlus does not cover "${clean(chainArg, 30)}".`, note: "Say GoPlus has no security scan for that chain; do not call the token safe or unsafe." });
  }
  if (chain.id === "solana" && !isSol) return fail({ error: "A Solana token must be a base58 mint address.", note: "Ask for the mint address." });
  if (chain.id !== "solana" && isSol) return fail({ error: `That looks like a Solana mint, not a ${chain.name} address.`, note: "Check the chain." });
  const addr = chain.id === "solana" || isTron ? token : token.toLowerCase();
  const url = chain.id === "solana" ? `${GP}/solana/token_security${qs({ contract_addresses: addr })}` : `${GP}/token_security/${encodeURIComponent(chain.id)}${qs({ contract_addresses: addr })}`;
  const { data, ageS } = await extJson<any>("goplus", url, { ttlS: 1800, timeoutMs: 12_000 });
  const res = data?.result && typeof data.result === "object" ? data.result : {};
  const row = res[addr] ?? res[token] ?? Object.values(res)[0];
  const arcHint = chain.id === "5042" ? " For an Arc token, arc_token_risk adds Chord's own tape checks (impostor symbols, hooked pools, sell-back test)." : "";
  if (!row || typeof row !== "object" || !Object.keys(row).length) {
    if (data?.code != null && Number(data.code) !== 1) return fail({ error: `GoPlus: ${clean(data?.message, 80) || "no result"}`, note: "GoPlus did not return a scan. Say the check is unavailable right now; do not call the token safe." }, [addr]);
    return fail({ found: false, chain: chain.name, token: addr, note: `GoPlus has no record of this token on ${chain.name} (wrong chain, not a token contract, or too new to be scanned). That is NOT a clean result: say the scan found nothing to report on.${arcHint}` }, [addr]);
  }
  const n = chain.id === "solana" ? goplusSolana(row) : goplusEvm(row);
  const extraAddrs = [
    ...n.holders.top.map((h) => h.address),
    ...("owner" in n && n.owner ? [n.owner] : []), ...("creator" in n && n.creator ? [n.creator] : []),
    ...("authorities" in n ? [...n.authorities.mint, ...n.authorities.freeze, ...n.authorities.metadata] : []),
  ].filter(Boolean);
  return {
    data: {
      source: "GoPlus", ...withAge(ageS), chain: chain.name, address: addr, ...n,
      note: `GoPlus flags are automated heuristics from the contract code and a simulated trade, not an audit. A clean result is not a guarantee: owners can change taxes or limits later and liquidity can still be pulled. Never call a token safe; name the worst flags first. Holder shares count pools, exchanges and lockers as holders. The token name and symbol come from the contract.${arcHint}`,
    },
    addresses: [...new Set([addr, ...extraAddrs])],
    citations: [{ label: `${n.token.symbol || short(addr)} security scan · GoPlus`, href: goplusPage(chain.id, addr) }],
    viz: [vTable(`${n.token.symbol || short(addr)} on ${chain.name} · GoPlus scan`, ["Check", "Result"],
      [...n.risks.slice(0, 10).map((r) => ["Risk", r] as [string, string]), ...n.ok.slice(0, 6).map((o) => ["OK", o] as [string, string]), ...n.unknown.map((u) => ["Unknown", u] as [string, string])], ["l", "l"])],
  };
}
