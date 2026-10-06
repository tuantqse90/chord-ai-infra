// Market-data tools for Ask, moved out of Chord's askAgent.ts `runTool` switch (ask2049 port, 2026-10-06). Same contract as
// the other families in services/ask/extTools (schemas, registry rows, a runner), one file for the groups that read public or
// keyed market APIs rather than Chord's own index:
//   coingecko  cg_coin · cg_markets · cg_trending · cg_global · cg_categories · cg_chart   ← services/cmc first (CMC_API_KEY),
//                                                                                          services/coingecko as the fallback
//   coinglass  cgl_liquidations · cgl_etf_flows · cgl_options · cgl_exchange_reserves · cgl_market_pulse · cgl_positioning
//                                                                                        ← services/coinglass (COINGLASS_API_KEY)
//   defillama  llama_protocol · llama_rankings · llama_chains · llama_stablecoins · llama_yields   ← services/askLlama
//   markets    macro_snapshot · market_levels · earnings_calendar                         ← services/marketData
//   hl         hl_markets · hl_market · hl_funding · hl_wallet                            ← Hyperliquid info API (helpers below)
//   derivs     derivs_coin · derivs_board                                                 ← services/derivs
//   dex        dex_search                                                                 ← services/dexSearch
// The case bodies are Chord's, line for line (output fields, notes, citations, addresses, viz, chips): the model prompts and
// skills read those notes. Only the import paths moved (./x → ../x). Chord's `backtest` and `arc_fx` stay behind (they need
// Chord's data lake / Arc index). Where a case needed Chord-only infra the change is marked `// ask2049:`.
import type { ToolMeta } from "./registry";
import type { Citation, Viz } from "../askAgent";
import type { ExtToolResult } from "./extHttp";
import type { BoardSort, VenueRow as DerivsRow } from "../derivs";
import { logger } from "../../utils/logger";

// ── helpers copied from Chord's askAgent.ts (module-level there) ──────────────────────────────────────────────────────

/** The first platform of a CoinGecko / CoinMarketCap coin on a chain Chord indexes (CG keys "monad", CMC names "Monad"). */
export function liveFeedOf(platforms: { chain: string; address: string }[] | undefined): { chain: number; address: string } | null {
  for (const p of platforms ?? []) {
    const n = String(p.chain).toLowerCase();
    const chain = n.startsWith("monad") ? 143 : n.includes("robinhood") ? 4663 : /^arc(\b|-|$)/.test(n) ? 5042 : null;
    if (chain && /^0x[0-9a-fA-F]{40}$/.test(p.address)) return { chain, address: p.address.toLowerCase() };
  }
  return null;
}
/** Where a CoinGecko / CMC coin trades inside Ask (board #62, owner 2026-10-02: the card's button opens the trade frame beside
 *  the chat): the Hyperliquid perp when it trades there with real volume, else its token on a chain Chord routes (Robinhood
 *  Chain, Arc, Avalanche, Base, BNB Chain), else null (the card keeps "Analyze"). Monad has no trade frame inside Ask. */
const KEYED_TRADE: [RegExp, number][] = [[/avalanche/, 43114], [/^base$/, 8453], [/binance-smart-chain|^bnb|^bsc/, 56]];
export function coinTradeHrefFromPlatforms(platforms: { chain: string; address: string }[] | undefined): string | null {
  for (const p of platforms ?? []) {
    const n = String(p.chain).toLowerCase();
    const addr = String(p.address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
    if (n.includes("robinhood")) return `/ask/trade/${addr}`;
    if (/^arc(\b|-|$)/.test(n)) return `/arc/token/${addr}`;
    const keyed = KEYED_TRADE.find(([re]) => re.test(n));
    if (keyed) return `/ask/trade/${addr}?chain=${keyed[1]}`;
  }
  return null;
}
/** Both ways a coin trades inside Ask (owner 2026-10-02: "trade perp và trade trên dex phải rõ ràng"): the card names each. */
async function coinTradeLinks(symbol: string, platforms: { chain: string; address: string }[] | undefined): Promise<{ href: string | null; spotHref?: string }> {
  const sym = String(symbol || "").toUpperCase();
  const rows = sym ? await import("../marketData").then((M) => M.hlContexts("")).catch(() => [] as { coin: string; volume24hUsd: number }[]) : [];
  const hit = rows.find((r) => (r.coin === sym || r.coin === `k${sym}`) && r.volume24hUsd >= 1_000_000);
  const perp = hit ? `/ask/perp/${encodeURIComponent(hit.coin)}` : null, spot = await coinSpotHref(platforms);
  return perp && spot ? { href: perp, spotHref: spot } : { href: perp ?? spot };
}
/** Spot link volume floor on Avalanche / Base / BNB Chain (USD, last 24 h in Chord's index). */
const SPOT_LINK_MIN_VOL_USD = 1_000;
/** The first platform address a coin really trades at. On Avalanche / Base / BNB Chain a listing's address can be a dead
 *  variant (2026-10-02: CoinMarketCap's Avalanche AAVE is 0x8ce2dee5…, no trades in the index, quoted ~20 % over the market;
 *  the liquid AAVE.e 0x63a72806… is CoinGecko's): it must show ≥ $1k of 24h volume in the chain's rollup, else the next
 *  platform, else no spot link. Robinhood Chain / Arc addresses go as before. */
export async function coinSpotHref(platforms: { chain: string; address: string }[] | undefined, volOf: (chain: number, address: string) => Promise<number | null> = indexedVolume24h): Promise<string | null> {
  for (const p of platforms ?? []) {
    const href = coinTradeHrefFromPlatforms([p]);
    if (!href) continue;
    const keyed = /[?&]chain=(\d+)/.exec(href);
    if (!keyed) return href;
    const vol = await volOf(Number(keyed[1]), String(p.address).toLowerCase()).catch(() => null);
    if (vol != null && vol >= SPOT_LINK_MIN_VOL_USD) return href;
  }
  return null;
}
// ask2049: Chord read the 24h volume from its own chain rollup (services/chainRollup, Postgres). No index here, so the volume
// is unknown and an Avalanche / Base / BNB Chain platform never becomes a spot link (Robinhood Chain / Arc links still do).
async function indexedVolume24h(_chain: number, _address: string): Promise<number | null> {
  return null;
}

const vTable = (title: string, columns: string[], rows: (string | number | null)[][], align?: ("l" | "r")[]): Viz => ({ kind: "table", title, columns, rows, align });

// ── Hyperliquid (perps, /ask/perp) — public info API, no key ──────────────────────────────────────────────
const HL_INFO = "https://api.hyperliquid.xyz/info";
async function hlInfo<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch(HL_INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return (await r.json()) as T;
}
interface HlCtx { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; premium: string | null; oraclePx: string; markPx: string; midPx: string | null }
interface HlMeta { universe: { name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean; isDelisted?: boolean }[] }
let hlMarketsCache: { at: number; rows: HlMarketRow[] } | null = null;
interface HlMarketRow { coin: string; markPx: number; change24hPct: number | null; volume24hUsd: number; openInterestUsd: number; fundingHourlyPct: number; fundingAnnualPct: number; maxLeverage: number; premiumPct: number | null }
async function hlMarkets(): Promise<HlMarketRow[]> {
  if (hlMarketsCache && Date.now() - hlMarketsCache.at < 10_000) return hlMarketsCache.rows;
  const [meta, ctxs] = await hlInfo<[HlMeta, HlCtx[]]>({ type: "metaAndAssetCtxs" });
  const rows: HlMarketRow[] = meta.universe.map((u, i) => {
    const c = ctxs[i];
    const mark = Number(c?.markPx ?? 0), prev = Number(c?.prevDayPx ?? 0), f = Number(c?.funding ?? 0);
    return { coin: u.name, markPx: mark, change24hPct: prev > 0 ? ((mark - prev) / prev) * 100 : null, volume24hUsd: Number(c?.dayNtlVlm ?? 0), openInterestUsd: Number(c?.openInterest ?? 0) * mark, fundingHourlyPct: f * 100, fundingAnnualPct: f * 24 * 365 * 100, maxLeverage: u.maxLeverage, premiumPct: c?.premium != null ? Number(c.premium) * 100 : null };
  }).filter((r, i) => !meta.universe[i].isDelisted && r.markPx > 0);
  hlMarketsCache = { at: Date.now(), rows };
  return rows;
}
const hlCite = (coin: string): Citation => ({ label: `${coin} perp on Hyperliquid`, href: `/ask/perp/${encodeURIComponent(coin)}` });
const derivsCite = (r: DerivsRow): Citation =>
  r.venue === "binance" ? { label: `${r.symbol} on Binance`, href: `https://www.binance.com/en/futures/${encodeURIComponent(r.symbol)}` }
  : r.venue === "bybit" ? { label: `${r.symbol} on Bybit`, href: `https://www.bybit.com/trade/usdt/${encodeURIComponent(r.symbol)}` }
  : r.venue === "okx" ? { label: `${r.symbol} on OKX`, href: `https://www.okx.com/trade-swap/${encodeURIComponent(r.symbol.toLowerCase())}` }
  : hlCite(r.symbol);
const r2 = (n: number) => Math.round(n * 100) / 100;
const pr2 = (n: number | null | undefined) => (n == null ? null : r2(n));
const rnd = (n: number | null | undefined) => (n == null ? null : Math.round(n));
const usdShort = (n: number | null) => (n == null ? "—" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`);
const sig = (x: number) => Number(x.toPrecision(5));
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// ── schemas (Chord services/ask/schemas.ts, these tools' entries verbatim) ─────────────────────────────────────────────
export const MARKET_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "cg_coin",
      description: "Profile of ANY listed coin (not only our chains) from CoinMarketCap, with CoinGecko filling the all-time high: price, market cap + rank, FDV, 24h volume, 1h/24h/7d/30d/1y change, 24h high/low, ATH and ATL with dates and distance, circulating / total / max supply, categories, homepage + X, contract addresses per chain, a short description and a 7-day chart. Use for 'what is X', 'X market cap / supply / unlock size / ATH', any coin that is not an Arc / Robinhood Chain / Monad token or a Hyperliquid perp (SUI, TAO, ONDO, a Solana meme…), and for rank or FDV of majors. For support / resistance on a Hyperliquid-listed coin use market_levels; for coins it does not list, cg_chart.",
      parameters: { type: "object", properties: { coin: { type: "string", description: "name, ticker or slug: sui, TAO, render, pepe, ondo-finance" } }, required: ["coin"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cg_markets",
      description: "Crypto-wide board (CoinMarketCap, CoinGecko as fallback): top coins by market cap (default) or 24h volume, optionally inside one category (e.g. artificial-intelligence, meme-token, real-world-assets-rwa, layer-1, decentralized-finance-defi, solana-ecosystem, base-ecosystem — or a name from cg_categories), or the day's biggest gainers / losers among the top 250 (volume ≥ $1M). Price, market cap, volume, 1h/24h/7d/30d, distance from ATH. Use for 'top 20 coins', 'best AI coins', 'what pumped today across crypto'.",
      parameters: { type: "object", properties: { sort: { type: "string", enum: ["market_cap", "volume", "gainers", "losers"] }, category: { type: "string" }, limit: { type: "number", description: "rows, default 15, max 50" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cg_trending",
      description: "What people are searching on CoinGecko right now (top coins and categories of the last 24h) with price, 24h change, market cap. Use for 'what is trending / hot / everyone talking about' across crypto (for Arc on-chain momentum use arc_trending).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cg_global",
      description: "Whole crypto market (CoinMarketCap, CoinGecko as fallback): total market cap and 24h change, 24h volume, BTC / ETH / stablecoin dominance, number of coins, DeFi market cap, plus the CoinMarketCap fear & greed index and altcoin season index (0–100, ≥75 = altcoin season). Use for 'total market cap', 'BTC dominance', 'is money leaving crypto', altseason questions.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cg_categories",
      description: "Crypto sectors ranked by 24h market-cap change or size (AI, memes, RWA, DePIN, L1, L2, gaming, ecosystems…): market cap, 24h change, volume, top coins. Use for 'which sector / narrative is running', rotation questions; then cg_markets(category) for the coins inside one.",
      parameters: { type: "object", properties: { sort: { type: "string", enum: ["change", "market_cap"] }, limit: { type: "number", description: "rows, default 12, max 30" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cg_chart",
      description: "Price history of any coin over 1–365 days (CoinMarketCap, hourly up to 7 days; CoinGecko as fallback): the line plus change over the window, high and low with dates, distance from each, position in the range and max drawdown. Use for coins Hyperliquid does not list, or 90d / 1y questions ('how far is X from its yearly high').",
      parameters: { type: "object", properties: { coin: { type: "string" }, days: { type: "number", description: "1–365, default 30" } }, required: ["coin"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cgl_liquidations",
      description: "Liquidations across ~20 exchanges (CoinGlass). With a coin: its liquidations over 1h / 4h / 12h / 24h split longs vs shorts, per exchange over 24h and the last 24h in 4-hour steps. Without a coin: the most-liquidated coins over the window plus the whole market's total and long share. Use for 'liquidations', 'who got rekt', 'long / short squeeze', 'thanh lý', 'cháy'.",
      parameters: { type: "object", properties: { coin: { type: "string", description: "BTC, ETH, SOL … (omit for the market board)" }, window: { type: "string", enum: ["1h", "4h", "12h", "24h"], description: "board window, default 24h" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cgl_etf_flows",
      description: "US spot ETF net flows per day (CoinGlass) for bitcoin, ether or solana: the last N days, the total, the current in/outflow streak and the latest day's biggest funds (IBIT, FBTC …). Use for 'ETF flows', 'are institutions buying', 'dòng tiền ETF'.",
      parameters: { type: "object", properties: { asset: { type: "string", enum: ["btc", "eth", "sol"] }, days: { type: "integer", description: "default 10, max 60" } }, required: ["asset"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cgl_options",
      description: "Options on BTC or ETH (CoinGlass): total open interest and 24h change, OI by venue (Deribit, OKX, Binance …) and the next expiries with max-pain price, call / put notional and put/call ratio. Use for 'max pain', 'options expiry', 'quyền chọn', 'put/call'.",
      parameters: { type: "object", properties: { asset: { type: "string", enum: ["BTC", "ETH"] } }, required: ["asset"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cgl_exchange_reserves",
      description: "Coins held on centralized exchanges (CoinGlass, on-chain balances): the total across tracked exchanges, its change over 1 / 7 / 30 days and the biggest exchanges. Falling reserves = coins leaving exchanges. Use for 'exchange reserves / outflows', 'số dư trên sàn'.",
      parameters: { type: "object", properties: { asset: { type: "string", description: "BTC, ETH, USDT …" } }, required: ["asset"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cgl_market_pulse",
      description: "Crypto sentiment boards (CoinGlass): the fear & greed index now vs yesterday / a week / a month ago, the Coinbase premium (US spot demand) for the last 3 days, and how many of ~30 bull-market-peak indicators have triggered (with the closest ones). Use for 'fear and greed', 'is the market euphoric / scared', 'are we near a top', 'Coinbase premium'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cgl_positioning",
      description: "One coin's perp positioning across ~20 exchanges (CoinGlass): total open interest with its change over 1h / 4h / 24h, the biggest venues, OI-weighted funding over the last day (4-hour steps), taker buy vs sell volume over 24h and Binance's long-account shares. Complements derivs_coin (live funding / long-short at Binance, Bybit, OKX, Hyperliquid) with the whole market's OI trend and taker flow.",
      parameters: { type: "object", properties: { coin: { type: "string", description: "BTC, ETH, SOL …" } }, required: ["coin"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "llama_protocol",
      description: "One DeFi protocol from DefiLlama: TVL now and 1d / 7d change, TVL by chain, category, market cap and mcap/TVL, plus its fees, revenue (what the protocol keeps) and DEX volume over 24h / 7d / 30d with annualised revenue and price-to-sales when it has a token. Use for 'TVL of Aave', 'does Hyperliquid make real money', 'Uniswap fees vs revenue', 'is X cheap vs its revenue'.",
      parameters: { type: "object", properties: { protocol: { type: "string", description: "name, slug or ticker: aave, uniswap, hyperliquid, pendle, ENA" } }, required: ["protocol"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "llama_rankings",
      description: "DefiLlama leaderboard of DeFi protocols by TVL, 24h fees, 24h revenue or 24h DEX volume, optionally inside one category (Lending, Dexs, Derivatives, Liquid Staking, Yield, CDP, Bridge, RWA …) or one chain (Ethereum, Solana, Base, Arbitrum, Hyperliquid L1 …), with 7-day and 30-day totals and change. Use for 'top DeFi by TVL', 'which protocols earn the most fees', 'biggest DEXes on Solana', 'top lending on Base'.",
      parameters: { type: "object", properties: {
        kind: { type: "string", enum: ["tvl", "fees", "revenue", "dex_volume"], description: "default tvl" },
        category: { type: "string", description: "optional DefiLlama category, e.g. Lending, Dexs, Derivatives, Liquid Staking" },
        chain: { type: "string", description: "optional chain name, e.g. Ethereum, Solana, Base, Arbitrum" },
        limit: { type: "number", description: "rows, default 12, max 30" },
      } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "llama_chains",
      description: "DeFi TVL by chain from DefiLlama: the top chains with their share of all DeFi, or one chain with its TVL, rank, 7-day and 30-day change and its biggest protocols. Use for 'where is TVL moving', 'Solana vs Base TVL', 'how big is DeFi on Arbitrum'.",
      parameters: { type: "object", properties: { chain: { type: "string", description: "optional: one chain, e.g. Ethereum, Solana, Base, Hyperliquid L1" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "llama_stablecoins",
      description: "Stablecoin supply from DefiLlama: total supply of all USD stablecoins, the biggest issuers (USDT, USDC, USDe, DAI/USDS …) with 1d / 7d / 30d supply change, price and peg mechanism. Stablecoin growth = new dollars entering crypto. Use for 'is money coming into crypto', 'USDT mint', 'USDe supply', 'stablecoin market cap'.",
      parameters: { type: "object", properties: { symbol: { type: "string", description: "optional: focus one stablecoin, e.g. USDe" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "llama_yields",
      description: "DeFi yields across chains from DefiLlama: pools with TVL ≥ $5M by default, sorted by APY, split into base APY (fees / interest) and reward APY (token emissions), 30-day average APY, impermanent-loss risk and single vs multi-asset exposure. Filter by token, chain, project or stablecoins only. Use for 'best USDC yield', 'where to farm ETH on Arbitrum', 'safe stable yield', 'Pendle / Aave rates'. Warn that reward APY and small pools are fragile.",
      parameters: { type: "object", properties: {
        token: { type: "string", description: "optional: a token symbol in the pool, e.g. USDC, ETH, SOL" },
        chain: { type: "string", description: "optional chain, e.g. Ethereum, Arbitrum, Base, Solana" },
        project: { type: "string", description: "optional project, e.g. aave-v3, pendle, morpho" },
        stable_only: { type: "boolean", description: "only stablecoin pools" },
        min_tvl_usd: { type: "number", description: "TVL floor, default 5,000,000 (never below 1,000,000)" },
        limit: { type: "number", description: "rows, default 12, max 25" },
      } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "macro_snapshot",
      description: "One-call cross-market dashboard: gold, silver, WTI oil, copper, EUR/USD, USD/JPY, DXY, Nasdaq-100, BTC, ETH — price and 24h / 7d / 30d change each. Use first for 'how are markets today', 'risk-on or risk-off', 'macro overview', or any question about several of these at once; then market_levels for the one or two the person cares about.",
      parameters: { type: "object", properties: { assets: { type: "array", items: { type: "string" }, description: "optional subset or additions (same names as market_levels), max 12" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "market_levels",
      description: "Price structure of ONE asset that is not an on-chain token: crypto majors and memes (BTC, ETH, SOL, HYPE, DOGE, PEPE, BONK, WIF … from Hyperliquid), gold, silver, oil (WTI), copper, natural gas, EUR/USD, USD/JPY, GBP/USD and other FX majors, the dollar index DXY, the Nasdaq-100, and US stocks (NVDA, TSLA, AAPL … real-market price from trade.xyz + the Nasdaq quote). Returns price, 24h / 7d / 30d / 90d change, MA20/50/200 (daily), RSI14, ATR%, 30-day and 52-week range, trend label, and up to three support and three resistance levels (4h and daily swing clusters with touch counts). Use for 'analyze BTC', 'support and resistance on gold', 'is EUR/USD in a downtrend', 'NVDA this week' (together with rh_* for the on-chain stock token). One call per asset.",
      parameters: { type: "object", properties: { asset: { type: "string", description: "ticker or name: BTC, PEPE, gold, XAU/USD, silver, oil, EUR/USD, USD/JPY, DXY, Nasdaq, NVDA …" } }, required: ["asset"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "earnings_calendar",
      description: "US company earnings dates (Nasdaq calendar): date, before open / after close, EPS consensus, last year's EPS, market cap. With symbols = when those companies report in the window; without = the largest companies reporting. Use for 'when does NVDA report', 'earnings this week', 'what to watch for TSLA'.",
      parameters: { type: "object", properties: { symbols: { type: "array", items: { type: "string" }, description: "tickers, optional" }, days: { type: "integer", description: "weekdays ahead incl. today, default 10, max 21" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "hl_markets",
      description: "Hyperliquid perpetuals: mark price, 24h change, 24h volume, open interest, hourly and annualized funding, max leverage. Use for 'what is moving on Hyperliquid', 'highest funding', 'biggest open interest', 'which perps are crowded'.",
      parameters: { type: "object", properties: { sort: { type: "string", enum: ["volume", "oi", "funding", "change", "-funding", "-change"], description: "default volume; a leading - sorts ascending (e.g. most negative funding)" }, limit: { type: "integer", description: "default 15, max 50" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "hl_market",
      description: "One Hyperliquid perp (BTC, ETH, SOL, HYPE …): mark, oracle, premium, 24h change and volume, open interest, funding now and its 24h average / annualized, best bid and ask with the spread. Use for any question about a specific perp.",
      parameters: { type: "object", properties: { coin: { type: "string", description: "coin name as listed, e.g. BTC" } }, required: ["coin"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "hl_funding",
      description: "Funding history of a Hyperliquid perp over the last N hours: each hourly rate, average, min, max, annualized, and who pays whom. Use for 'is BTC funding high', 'funding trend on ETH'.",
      parameters: { type: "object", properties: { coin: { type: "string" }, hours: { type: "integer", description: "default 24, max 168" } }, required: ["coin"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "hl_wallet",
      description: "A wallet's Hyperliquid account: equity, withdrawable, margin used, every open position (coin, side, size, entry, mark, unrealized PnL, ROE, leverage, liquidation price) and open order count. Use for 'my Hyperliquid positions', 'am I close to liquidation', 'what is wallet W long' — the person's Ask wallet address is their Hyperliquid account.",
      parameters: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "derivs_coin",
      description: "Perp positioning of one coin across Binance, Bybit, OKX and Hyperliquid: price, open interest per venue and total (USD), funding per venue normalised to % per 8 h and annualised (positive = longs pay shorts), share of accounts net long per venue, Binance top traders' long share, open-interest change over 1h / 4h / 24h with the OI-vs-price read (new longs, new shorts, short covering, long unwind), crowding flags, and an OI history line. Use for 'BTC funding across exchanges', 'is ETH crowded long', 'long/short ratio of SOL', 'is open interest rising on X', 'are shorts getting squeezed'. Liquidation totals are NOT in this data.",
      parameters: { type: "object", properties: { coin: { type: "string", description: "ticker, e.g. BTC, ETH, PEPE" }, hours: { type: "integer", description: "history window for the OI line, default 24, max 720" } }, required: ["coin"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "derivs_board",
      description: "Cross-venue perp board (Binance + Bybit + OKX + Hyperliquid), the top coins by open interest: total OI, OI change 1h/4h/24h, OI-weighted funding per 8 h and per year, share of accounts long, 24h price change. Sort to find the most crowded longs (funding / long), crowded shorts (-funding / -long), where leverage is piling in (oi_change) or leaving (-oi_change). Use for 'which coins are overleveraged', 'highest funding across exchanges', 'where is OI rising', 'short squeeze candidates'.",
      parameters: { type: "object", properties: { sort: { type: "string", enum: ["oi", "oi_change", "-oi_change", "funding", "-funding", "long", "-long", "volume", "change", "-change"], description: "default oi; a leading - sorts ascending" }, limit: { type: "integer", description: "default 15, max 40" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "dex_search",
      description: "Find ANY token on ANY chain by ticker, name or contract address (DexScreener — Solana, Base, BNB Chain, Ethereum, Arbitrum, Abstract, Robinhood Chain … every DEX): every token that answers to the name with chain, address, price, 24h change, market cap, liquidity, 24h volume, age, website / X. Use for a memecoin or small token that cg_coin does not know or that may have several look-alikes ('there's a $PEARL token', 'what is $XYZ on Solana', a pasted Solana / EVM address not on our chains).",
      parameters: { type: "object", properties: { query: { type: "string", description: "ticker, name or contract address" }, chain: { type: "string", description: "optional: keep one chain, e.g. solana, base, bsc" } }, required: ["query"] },
    },
  },
];

// ── registry rows (Chord services/ask/registry.ts TOOL_META, these tools' rows verbatim) ──────────────────────────────
export const MARKET_TOOL_META: Record<string, ToolMeta> = {
  cg_coin: { group: "coingecko", label: "Reading the coin's profile" },
  cg_markets: { group: "coingecko", label: "Reading the crypto board", market: true, timeoutMs: 15_000 },
  cg_trending: { group: "coingecko", label: "Reading what is trending on CoinGecko", market: true },
  cg_global: { group: "coingecko", label: "Reading the whole crypto market", market: true },
  cg_categories: { group: "coingecko", label: "Ranking crypto sectors", market: true },
  cg_chart: { group: "coingecko", label: "Reading price history", timeoutMs: 15_000 },
  cgl_liquidations: { group: "coinglass", label: "Reading liquidations across exchanges", market: true, timeoutMs: 20_000 },
  cgl_etf_flows: { group: "coinglass", label: "Reading spot ETF flows", market: true, timeoutMs: 20_000 },
  cgl_options: { group: "coinglass", label: "Reading options open interest and max pain", timeoutMs: 20_000 },
  cgl_exchange_reserves: { group: "coinglass", label: "Reading exchange reserves", timeoutMs: 20_000 },
  cgl_market_pulse: { group: "coinglass", label: "Reading fear & greed and cycle indicators", market: true, timeoutMs: 20_000 },
  cgl_positioning: { group: "coinglass", label: "Reading positioning across exchanges", dyor: false, timeoutMs: 25_000 },
  llama_protocol: { group: "defillama", label: "Reading the protocol on DefiLlama", timeoutMs: 25_000 },
  llama_rankings: { group: "defillama", label: "Ranking protocols on DefiLlama", market: true, timeoutMs: 25_000 },
  llama_chains: { group: "defillama", label: "Reading chain TVL on DefiLlama", market: true, timeoutMs: 20_000 },
  llama_stablecoins: { group: "defillama", label: "Reading stablecoin supply", market: true, timeoutMs: 20_000 },
  llama_yields: { group: "defillama", label: "Scanning yields on DefiLlama", market: true, dyor: true, timeoutMs: 25_000 },
  macro_snapshot: { group: "markets", label: "Reading gold, FX, oil, indices and crypto", market: true },
  market_levels: { group: "markets", label: "Reading the price structure", market: true, dyor: true },
  earnings_calendar: { group: "news", label: "Reading the earnings calendar", market: true },
  hl_markets: { group: "hl", label: "Reading Hyperliquid markets", market: true },
  hl_market: { group: "hl", label: "Reading the perp" },
  hl_funding: { group: "hl", label: "Reading funding history" },
  hl_wallet: { group: "hl", label: "Reading the Hyperliquid account", timeoutMs: 20_000 },
  derivs_coin: { group: "derivs", label: "Reading funding and open interest across exchanges", timeoutMs: 20_000 },
  derivs_board: { group: "derivs", label: "Scanning perp positioning across exchanges", market: true, timeoutMs: 20_000 },
  dex_search: { group: "dex", label: "Searching every DEX for the token", timeoutMs: 15_000 },
};

export const MARKET_TOOL_NAMES: string[] = MARKET_TOOL_SCHEMAS.map((t) => t.function.name);
const NAMES = new Set(MARKET_TOOL_NAMES);
export const isMarketTool = (name: string): boolean => NAMES.has(name);

/** Whether the model may be offered the tool. Every tool here works keyless (CoinGecko public API, DefiLlama, Hyperliquid,
 *  Binance / Bybit / OKX, Nasdaq, DexScreener; CMC_API_KEY only upgrades the cg_* tools) except CoinGlass: Chord ships the
 *  cgl_* tools dark — a key (COINGLASS_API_KEY) AND COINGLASS_ASK=1, because the Hobbyist key is licensed for personal use. */
export function marketToolOffered(name: string): boolean {
  if (!isMarketTool(name)) return false;
  if (name.startsWith("cgl_")) return !!process.env.COINGLASS_API_KEY && process.env.COINGLASS_ASK === "1";
  return true;
}

/** Runs one tool of this module; a thrown error becomes an answer the model can repeat instead of a broken turn (as runExtTool). */
export async function runMarketTool(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  if (!isMarketTool(name)) return { data: { error: `unknown tool ${name}` }, addresses: [], citations: [] };
  try {
    return await runCase(name, args ?? {});
  } catch (e) {
    return { data: { error: String((e as Error)?.message ?? e).slice(0, 160), note: "The source did not answer just now. Say the data is unavailable; do not guess numbers." }, addresses: [], citations: [] };
  }
}

async function runCase(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  const none: ExtToolResult = { data: null, addresses: [], citations: [] };
  switch (name) {
    case "cg_coin": {
      // CoinMarketCap first (services/cmc: commercial licence, richer quote), CoinGecko for what CMC's free plan locks (ATH /
      // ATL / the 7-day line) and as the whole fallback when CMC errors or has spent its month.
      const [CG, CMC] = await Promise.all([import("../coingecko"), import("../cmc")]);
      const q = String(args.coin ?? "");
      let c: any = null;
      let source = "CoinMarketCap";
      let cite: Citation | null = null;
      // Trade-link candidates: the source's platforms, then CoinGecko's when it confirmed the same coin — CoinMarketCap's Avalanche
      // AAVE is a dead variant, CoinGecko's the liquid AAVE.e (coinSpotHref picks the one the index sees trading).
      let tradePlatforms: { chain: string; address: string }[] | null = null;
      const ref = CMC.cmcEnabled() ? await CMC.resolveCmc(q).catch(() => null) : null;
      if (ref) c = await CMC.coinDetailCmc(ref).catch((e) => { logger.info({ err: String(e), coin: q }, "cg_coin: CoinMarketCap failed, falling back to CoinGecko"); return null; });
      if (c) {
        cite = { label: `${c.name} on CoinMarketCap`, href: `https://coinmarketcap.com/currencies/${c.id}/` };
        const extra = await Promise.race([CG.resolveCoin(q).then((r) => (r ? CG.coinDetail(r.id) : null)).catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), 4000))]);
        if (extra && extra.symbol === c.symbol && (extra.name.toLowerCase() === String(c.name).toLowerCase() || (extra.rank != null && c.rank != null && Math.abs(extra.rank - c.rank) <= Math.max(10, c.rank * 0.3)))) {
          Object.assign(c, { ath: extra.ath, athDate: extra.athDate, fromAthPct: extra.fromAthPct, atl: extra.atl, atlDate: extra.atlDate, high24h: extra.high24h, low24h: extra.low24h, sparkline7d: extra.sparkline7d });
          tradePlatforms = [...(c.platforms ?? []), ...(extra.platforms ?? [])];
          c.change.y1 = extra.change.y1;
          source = "CoinMarketCap (all-time high and 7-day line from CoinGecko)";
        }
      } else {
        const cgRef = await CG.resolveCoin(q);
        if (!cgRef) return { ...none, data: { found: false, note: `No coin called "${q.slice(0, 40)}" on CoinMarketCap or CoinGecko. Say so.` } };
        c = await CG.coinDetail(cgRef.id);
        source = "CoinGecko (aggregated across exchanges)";
        cite = { label: `${c.name} on CoinGecko`, href: `https://www.coingecko.com/en/coins/${c.id}` };
      }
      const sp = (c.sparkline7d as number[]).filter((_, i, a) => i % 4 === 0 || i === a.length - 1);
      return { ...none, data: { found: true, ...c, sparkline7d: undefined, source, note: `${c.ageS > 300 ? `Data is ${Math.round(c.ageS / 60)} minutes old (rate limit) — say so. ` : ""}Supply numbers are the source's; unlock schedules are not in this data. Contract addresses are the source's listing — do not present them as verified by Chord.${c.fromAthPct == null ? " The all-time high is not available right now — do not guess it." : ""}` },
        addresses: (c.platforms as { address: string }[]).map((p) => p.address).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)), citations: [cite!],
        assets: [{ id: `coin:${c.id}`, symbol: c.symbol, label: c.name, price: c.priceUsd, change24hPct: c.change.h24, hl: null, ...(await coinTradeLinks(c.symbol, tradePlatforms ?? c.platforms).catch(() => ({ href: null }))), ...(liveFeedOf(c.platforms) ? { feed: liveFeedOf(c.platforms)! } : {}), ...(c.image ? { logo: c.image } : {}), marketCapUsd: c.marketCapUsd, volume24hUsd: c.volume24hUsd, fdvUsd: c.fdvUsd ?? null, kind: "crypto", ...(sp.length > 5 ? { spark: sp.slice(-40) } : {}) }],
        viz: [
          vTable(`${c.name} · ${source.split(" (")[0]}`, ["Rank", "Price", "Mkt cap", "FDV", "Volume 24h", "24h", "7d", "30d", "From ATH"], [[c.rank == null ? "—" : `#${c.rank}`, c.priceUsd, c.marketCapUsd, c.fdvUsd, c.volume24hUsd, c.change.h24, c.change.d7, c.change.d30, c.fromAthPct]], ["r", "r", "r", "r", "r", "r", "r", "r", "r"]),
          ...(sp.length > 10 ? [{ kind: "line", title: `${c.symbol} · 7 days`, x: sp.map((_, i) => `${Math.round((i / (sp.length - 1)) * 7 * 10) / 10}d`), series: [{ name: "Price", values: sp }], unit: "price" } as Viz] : []),
        ] };
    }
    case "cg_markets": {
      const CG = await import("../coingecko");
      const sort = (["market_cap", "volume", "gainers", "losers"] as const).find((x) => x === args.sort) ?? "market_cap";
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
      const category = typeof args.category === "string" && /^[\w &.-]{2,80}$/.test(args.category) ? args.category : undefined;
      const want = { category, order: (sort === "volume" ? "volume_desc" : "market_cap_desc") as "volume_desc" | "market_cap_desc", perPage: sort === "gainers" || sort === "losers" ? 250 : limit };
      // CoinMarketCap first (services/cmc); CoinGecko when CMC fails, is out of credits, or doesn't know the category.
      const CMC = await import("../cmc");
      const viaCmc = CMC.cmcEnabled() ? await CMC.marketsCmc(want).catch(() => null) : null;
      const src = viaCmc ? "CoinMarketCap" : "CoinGecko";
      let rows = viaCmc ?? await CG.markets({ ...want, category: category && /^[a-z0-9-]{2,80}$/.test(category) ? category : undefined });
      if (sort === "gainers" || sort === "losers") rows = rows.filter((r) => (r.volume24hUsd ?? 0) >= 1_000_000 && r.h24 != null).sort((a, b) => (sort === "gainers" ? b.h24! - a.h24! : a.h24! - b.h24!));
      rows = rows.slice(0, limit);
      // The model often passes CMC's hex category id from cg_categories — show the category's name, not the id.
      const catName = viaCmc && category ? (CMC.matchCategory(category, await CMC.categoriesCmc().catch(() => [])))?.name ?? category : category;
      const title = `${catName ? `${catName} · ` : ""}${sort === "gainers" ? "24h gainers (top 250, vol ≥ $1M)" : sort === "losers" ? "24h losers (top 250, vol ≥ $1M)" : sort === "volume" ? "by 24h volume" : "by market cap"}`;
      return { ...none, data: { sort, category: catName ?? null, rows, note: rows.length ? `${src}, aggregated across exchanges.` : `No coins${category ? ` in category "${category}" — check the id with cg_categories` : ""}.` },
        citations: [src === "CoinMarketCap" ? { label: "CoinMarketCap", href: "https://coinmarketcap.com/" } : { label: "CoinGecko", href: category ? `https://www.coingecko.com/en/categories/${category}` : "https://www.coingecko.com/" }],
        chipCandidates: rows.map((r) => ({ id: `coin:${r.id}`, symbol: r.symbol, label: r.name, price: r.priceUsd, change24hPct: r.h24, hl: null, href: null, ...(r.image ? { logo: r.image } : {}), marketCapUsd: r.marketCapUsd, volume24hUsd: r.volume24hUsd, kind: "crypto" as const })),
        viz: rows.length ? [vTable(`${src} · ${title}`, ["#", "Coin", "Price", "Mkt cap", "Volume", "1h", "24h", "7d"], rows.map((r) => [r.rank == null ? "—" : r.rank, r.symbol, r.priceUsd, r.marketCapUsd, r.volume24hUsd, r.h1, r.h24, r.d7]), ["r", "l", "r", "r", "r", "r", "r", "r"])] : [] };
    }
    case "cg_trending": {
      const CG = await import("../coingecko");
      const t = await CG.trending();
      return { ...none, data: { ...t, note: "CoinGecko search trends (last 24h) — attention, not performance." },
        citations: [{ label: "CoinGecko trending", href: "https://www.coingecko.com/en/highlights/trending-crypto" }],
        chipCandidates: t.coins.map((c: any) => ({ id: `cg:${c.id}`, symbol: c.symbol, label: c.name, price: c.priceUsd, change24hPct: c.h24, hl: null, href: null, ...(c.image ? { logo: c.image } : {}) })),
        viz: [vTable("Trending on CoinGecko", ["Coin", "Rank", "Price", "24h", "Mkt cap"], t.coins.map((c: any) => [c.symbol, c.rank == null ? "—" : `#${c.rank}`, c.priceUsd, c.h24, c.marketCapUsd]), ["l", "r", "r", "r", "r"])] };
    }
    case "cg_global": {
      const [CG, CMC] = await Promise.all([import("../coingecko"), import("../cmc")]);
      const viaCmc = CMC.cmcEnabled() ? await CMC.globalCmc().catch(() => null) : null;
      const g: any = viaCmc ?? await CG.globalStats();
      const src = viaCmc ? "CoinMarketCap" : "CoinGecko";
      const other = Math.max(0, 100 - (g.dominance as { pct: number | null }[]).reduce((s2, d) => s2 + (d.pct ?? 0), 0));
      return { ...none, data: { ...g, note: `${src} global figures.${viaCmc ? " fearGreed is CoinMarketCap's index (0–100); altcoinSeason ≥ 75 = altcoin season, ≤ 25 = bitcoin season." : ""}` },
        citations: [viaCmc ? { label: "CoinMarketCap global", href: "https://coinmarketcap.com/charts/" } : { label: "CoinGecko global", href: "https://www.coingecko.com/en/global-charts" }],
        viz: [{ kind: "donut", title: "Market cap dominance", slices: [...(g.dominance as { symbol: string; pct: number | null }[]).map((d) => ({ name: d.symbol, value: d.pct ?? 0 })), { name: "Other", value: Math.round(other * 100) / 100 }], unit: "pct" } as Viz] };
    }
    case "cg_categories": {
      const CG = await import("../coingecko");
      const sort = args.sort === "market_cap" ? "market_cap" : "change";
      const limit = Math.max(1, Math.min(30, Number(args.limit) || 12));
      const CMC = await import("../cmc");
      const viaCmc = CMC.cmcEnabled() ? await CMC.categoriesCmc().catch(() => null) : null;
      const all: { id: string; name: string; marketCapUsd: number; h24: number | null; volume24hUsd: number | null; top: string[] }[] = viaCmc ?? await CG.categories();
      const rows = (sort === "change" ? all.filter((c) => c.marketCapUsd >= 100_000_000 && c.h24 != null).sort((a, b) => b.h24! - a.h24!) : all.sort((a, b) => b.marketCapUsd - a.marketCapUsd)).slice(0, limit);
      return { ...none, data: { sort, rows, note: sort === "change" ? "Sectors with ≥ $100M market cap, ranked by 24h market-cap change. Pass a row's id to cg_markets(category)." : "Largest sectors. Pass a row's id to cg_markets(category)." },
        citations: [viaCmc ? { label: "CoinMarketCap categories", href: "https://coinmarketcap.com/cryptocurrency-category/" } : { label: "CoinGecko categories", href: "https://www.coingecko.com/en/categories" }],
        viz: [vTable(`Crypto sectors · ${sort === "change" ? "24h change" : "market cap"}`, ["Sector", "Mkt cap", "24h", "Volume", viaCmc ? "Tokens" : "Top coins"], rows.map((r) => [r.name, r.marketCapUsd, r.h24, r.volume24hUsd, r.top.join(", ")]), ["l", "r", "r", "r", "l"])] };
    }
    case "cg_chart": {
      const CG = await import("../coingecko");
      const CMC = await import("../cmc");
      const days = Math.max(1, Math.min(365, Number(args.days) || 30));
      const q = String(args.coin ?? "");
      // CoinMarketCap first (≤ 12 months on the free plan, hourly up to 7 days); CoinGecko otherwise.
      const cmcRef = CMC.cmcEnabled() ? await CMC.resolveCmc(q).catch(() => null) : null;
      const cmcPts = cmcRef ? await CMC.historyCmc(cmcRef, days).catch(() => null) : null;
      const ref = cmcPts && cmcPts.length > 1 ? cmcRef! : await CG.resolveCoin(q);
      if (!ref) return { ...none, data: { found: false, note: `No coin called "${q.slice(0, 40)}" on CoinMarketCap or CoinGecko.` } };
      const src = cmcPts && cmcPts.length > 1 ? "CoinMarketCap" : "CoinGecko";
      const pts = src === "CoinMarketCap" ? cmcPts! : await CG.priceHistory(ref.id, days);
      const st = CG.rangeStats(pts);
      if (!st) return { ...none, data: { found: false, note: "No price history returned." } };
      const step = Math.max(1, Math.ceil(pts.length / 400)); // the page pans through the whole series (2026-09-27)
      const thin = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
      return { ...none, data: { found: true, coin: { id: ref.id, symbol: ref.symbol.toUpperCase(), name: ref.name }, days, last: pts[pts.length - 1][1], ...st, note: `${src} price history; highs/lows are sampled closes, not intraday wicks.` },
        citations: [src === "CoinMarketCap" ? { label: `${ref.name} on CoinMarketCap`, href: `https://coinmarketcap.com/currencies/${ref.id}/` } : { label: `${ref.name} on CoinGecko`, href: `https://www.coingecko.com/en/coins/${ref.id}` }],
        viz: [
          { kind: "line", title: `${ref.symbol.toUpperCase()} · ${days}d`, x: thin.map(([t]) => new Date(t).toISOString().slice(days <= 2 ? 11 : 5, days <= 2 ? 16 : 10)), series: [{ name: "Price", values: thin.map(([, p]) => p) }], unit: "price" } as Viz,
          vTable(`${ref.symbol.toUpperCase()} · ${days}d range`, ["Change", "High", "Low", "From high", "From low", "Max drawdown"], [[st.changePct, st.high, st.low, st.fromHighPct, st.fromLowPct, st.maxDrawdownPct]], ["r", "r", "r", "r", "r", "r"]),
        ] };
    }
    case "cgl_liquidations": {
      const C = await import("../coinglass");
      const window = (["1h", "4h", "12h", "24h"] as const).includes(args.window) ? args.window as "1h" | "4h" | "12h" | "24h" : "24h";
      const coin = args.coin ? C.COIN(args.coin) : "";
      const { data: rows, ageS } = await C.cgl<any[]>("/api/futures/liquidation/coin-list", {}, 120);
      const cite = [{ label: "CoinGlass liquidations", href: "https://www.coinglass.com/LiquidationData" }];
      if (!coin) {
        const b = C.liqBoard(rows ?? [], window);
        return { ...none, data: { ...b, source: "CoinGlass (~20 exchanges)", dataAgeMin: Math.round(ageS / 60) }, citations: cite,
          viz: [vTable(`Liquidations · ${window}`, ["Coin", "Total", "Longs", "Shorts", "Long share"], b.coins.map((c) => [c.coin, usdShort(c.totalUsd), usdShort(c.longsUsd), usdShort(c.shortsUsd), c.longSharePct == null ? "—" : `${c.longSharePct}%`]), ["l", "r", "r", "r", "r"])] };
      }
      const row = (rows ?? []).find((r) => String(r.symbol).toUpperCase() === coin);
      if (!row) return { ...none, data: { found: false, note: `CoinGlass has no liquidation data for ${coin}. Say so.` } };
      const [ex, hist] = await Promise.all([
        C.cgl<any[]>("/api/futures/liquidation/exchange-list", { symbol: coin, range: "24h" }, 300).then((x) => x.data).catch(() => null),
        C.cgl<any[]>("/api/futures/liquidation/aggregated-history", { symbol: coin, interval: "4h", limit: 6, exchange_list: "Binance,OKX,Bybit,Hyperliquid,Bitget,Gate" }, 300).then((x) => x.data).catch(() => null),
      ]);
      const w = C.liqWindows(row);
      return { ...none, citations: cite,
        data: { coin, source: "CoinGlass (~20 exchanges)", dataAgeMin: Math.round(ageS / 60), windows: w,
          byExchange24h: (ex ?? []).filter((r) => r.exchange !== "All").slice(0, 8).map((r) => ({ exchange: r.exchange, totalUsd: Math.round(Number(r.liquidation_usd) || 0), longsUsd: Math.round(Number(r.longLiquidation_usd) || 0), shortsUsd: Math.round(Number(r.shortLiquidation_usd) || 0) })),
          last24hBy4h: (hist ?? []).map((r) => ({ time: new Date(Number(r.time)).toISOString().slice(5, 16).replace("T", " "), longsUsd: Math.round(Number(r.aggregated_long_liquidation_usd) || 0), shortsUsd: Math.round(Number(r.aggregated_short_liquidation_usd) || 0) })),
          note: "USD liquidated. Longs liquidated = forced sells (price fell into them); shorts liquidated = forced buys. The 4-hour steps cover Binance, OKX, Bybit, Hyperliquid, Bitget and Gate." },
        viz: [vTable(`${coin} liquidations`, ["Window", "Total", "Longs", "Shorts", "Long share"], ([["1h", w.h1], ["4h", w.h4], ["12h", w.h12], ["24h", w.h24]] as const).map(([k, v]) => [k, usdShort(v.totalUsd), usdShort(v.longsUsd), usdShort(v.shortsUsd), v.longSharePct == null ? "—" : `${v.longSharePct}%`]), ["l", "r", "r", "r", "r"])] };
    }
    case "cgl_etf_flows": {
      const C = await import("../coinglass");
      const asset = args.asset === "eth" ? "ethereum" : args.asset === "sol" ? "solana" : "bitcoin";
      const { data, ageS } = await C.cgl<any[]>(`/api/etf/${asset}/flow-history`, {}, 1800);
      const f = C.etfFlows(data ?? [], Math.max(1, Math.min(60, Number(args.days) || 10)));
      return { ...none, data: { asset, source: "CoinGlass (US spot ETFs)", dataAgeMin: Math.round(ageS / 60), ...f, note: "Net USD flow per trading day; the latest day can be partial until US close." },
        citations: [{ label: `CoinGlass ${asset} ETF flows`, href: `https://www.coinglass.com/${asset === "bitcoin" ? "bitcoin-etf" : asset === "ethereum" ? "eth-etf" : "etf"}` }],
        viz: [{ kind: "bar", title: `${asset} ETF net flow · last ${f.days.length} days`, x: f.days.map((d) => d.date.slice(5)), series: [{ name: "Net flow", values: f.days.map((d) => d.netFlowUsd) }], unit: "usd" }] };
    }
    case "cgl_options": {
      const C = await import("../coinglass");
      const asset = args.asset === "ETH" || String(args.asset).toUpperCase() === "ETH" ? "ETH" : "BTC";
      const [info, mp] = await Promise.all([C.cgl<any[]>("/api/option/info", { symbol: asset }, 600), C.cgl<any[]>("/api/option/max-pain", { symbol: asset, exchange: "Deribit" }, 600)]);
      const o = C.optionsView(info.data ?? [], mp.data ?? []);
      return { ...none, data: { asset, source: "CoinGlass (max pain from Deribit)", ...o, note: "Max pain = the expiry price at which option buyers lose the most; it is a magnet only near expiry and on large expiries." },
        citations: [{ label: "CoinGlass options", href: "https://www.coinglass.com/options" }],
        viz: [vTable(`${asset} options · next expiries`, ["Expiry", "Max pain", "Calls OI", "Puts OI", "Put/Call"], o.expiries.map((e) => [e.expiry, e.maxPainPrice, usdShort(e.callOiUsd), usdShort(e.putOiUsd), e.putCallRatio]), ["l", "r", "r", "r", "r"])] };
    }
    case "cgl_exchange_reserves": {
      const C = await import("../coinglass");
      const asset = C.COIN(args.asset) || "BTC";
      const { data, ageS } = await C.cgl<any[]>("/api/exchange/balance/list", { symbol: asset }, 1800);
      if (!data?.length) return { ...none, data: { found: false, note: `CoinGlass tracks no exchange balances for ${asset}. Say so.` } };
      const r = C.reservesView(data);
      return { ...none, data: { asset, source: "CoinGlass (on-chain exchange balances)", dataAgeMin: Math.round(ageS / 60), unit: asset, ...r, note: `Balances in ${asset}. A falling total = coins leaving exchanges (often read as holders moving to self-custody); a rising one = coins arriving, often to sell.` },
        citations: [{ label: "CoinGlass exchange balances", href: "https://www.coinglass.com/Balance" }],
        viz: [vTable(`${asset} on exchanges`, ["Exchange", "Balance", "7d", "30d"], r.top.map((x) => [x.exchange, x.balance, x.change7dPct == null ? "—" : `${x.change7dPct}%`, x.change30dPct == null ? "—" : `${x.change30dPct}%`]), ["l", "r", "r", "r"])] };
    }
    case "cgl_market_pulse": {
      const C = await import("../coinglass");
      const [fg, prem, peak] = await Promise.all([
        C.cgl<any>("/api/index/fear-greed-history", {}, 3600).then((x) => (Array.isArray(x.data) ? x.data[0] : x.data)).catch(() => null),
        C.cgl<any[]>("/api/coinbase-premium-index", { interval: "1d", limit: 3 }, 1800).then((x) => x.data).catch(() => null),
        C.cgl<any[]>("/api/bull-market-peak-indicator", {}, 3600).then((x) => x.data).catch(() => null),
      ]);
      if (!fg && !prem && !peak) return { ...none, data: { error: "CoinGlass did not answer — say the sentiment boards are unavailable right now." } };
      const p = C.pulseView(fg, prem, peak);
      return { ...none, data: { source: "CoinGlass", ...p, note: "Fear & greed 0–100 (≤24 extreme fear, ≥76 extreme greed). Coinbase premium > 0 = US spot buyers paying up. Bull-peak indicators are cycle-top heuristics, not timing signals." },
        citations: [{ label: "CoinGlass fear & greed", href: "https://www.coinglass.com/pro/i/FearGreedIndex" }, { label: "CoinGlass bull-market peak indicators", href: "https://www.coinglass.com/bull-market-peak-signals" }] };
    }
    case "cgl_positioning": {
      const C = await import("../coinglass");
      const coin = C.COIN(args.coin);
      if (!coin) return { ...none, data: { error: "coin required" } };
      const [oi, fund, taker, lsG, lsT] = await Promise.all([
        C.cgl<any[]>("/api/futures/open-interest/exchange-list", { symbol: coin }, 120).then((x) => x.data).catch(() => null),
        C.cgl<any[]>("/api/futures/funding-rate/oi-weight-history", { symbol: coin, interval: "4h", limit: 6 }, 300).then((x) => x.data).catch(() => null),
        C.cgl<any>("/api/futures/taker-buy-sell-volume/exchange-list", { symbol: coin, range: "24h" }, 300).then((x) => x.data).catch(() => null),
        C.cgl<any[]>("/api/futures/global-long-short-account-ratio/history", { exchange: "Binance", symbol: `${coin}USDT`, interval: "4h", limit: 1 }, 900).then((x) => x.data).catch(() => null),
        C.cgl<any[]>("/api/futures/top-long-short-account-ratio/history", { exchange: "Binance", symbol: `${coin}USDT`, interval: "4h", limit: 1 }, 900).then((x) => x.data).catch(() => null),
      ]);
      if (!oi?.length) return { ...none, data: { found: false, note: `CoinGlass has no futures open interest for ${coin}. Say so.` } };
      const v = C.positioningView(oi, fund ?? [], taker, lsG, lsT);
      return { ...none, data: { coin, source: "CoinGlass (~20 exchanges)", ...v, note: "OI in USD across exchanges; funding is OI-weighted in % per 8 h (0.01 % is the usual baseline; positive = longs pay). Taker buy % > 50 = aggressive buyers dominated the last 24 h." },
        citations: [{ label: `CoinGlass ${coin} open interest`, href: `https://www.coinglass.com/currencies/${coin}` }],
        viz: [vTable(`${coin} open interest by venue`, ["Venue", "OI", "Share", "24h"], v.venues.map((x) => [x.venue, usdShort(x.oiUsd), x.sharePct == null ? "—" : `${x.sharePct}%`, x.change24hPct == null ? "—" : `${x.change24hPct}%`]), ["l", "r", "r", "r"])] };
    }
    case "llama_protocol": {
      const L = await import("../askLlama");
      const q = String(args.protocol ?? "").trim().slice(0, 60);
      if (!q) return { ...none, data: { error: "protocol required" } };
      const { data: list, ageS } = await L.protocols();
      const [fees, rev, vol] = await Promise.all((["fees", "revenue", "dex_volume"] as const).map((k) => L.flows(k).then((x) => x.data).catch(() => null)));
      let v = L.resolveProtocol(q, list);
      if (!v) {
        // Protocols without TVL (perp venues, launchpads …) are only in the fee lists.
        const f = fees ? L.findFlow({ name: q, slug: q }, fees) : null;
        if (!f) return { ...none, data: { found: false, note: `DefiLlama has no protocol called "${q.slice(0, 40)}". Say so.` } };
        v = { name: f.name, slug: f.slug, symbol: null, category: f.category, tvl: null, change1d: null, change7d: null, mcap: null, chains: [], parent: f.parent, family: false, members: [] };
      }
      const F = fees ? L.flowOf(v, fees) : null, R = rev ? L.flowOf(v, rev) : null, V = vol ? L.flowOf(v, vol) : null;
      let mcap = v.mcap, mcapSource: string | null = mcap != null ? "DefiLlama" : null;
      if (mcap == null && v.symbol) {
        const CMC = await import("../cmc");
        const ref = CMC.cmcEnabled() ? await CMC.resolveCmc(v.symbol).catch(() => null) : null;
        if (ref && ref.symbol.toUpperCase() === v.symbol.toUpperCase()) {
          const c = await Promise.race([CMC.coinDetailCmc(ref).catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), 4000))]);
          if (c?.marketCapUsd) { mcap = Math.round(c.marketCapUsd); mcapSource = "CoinMarketCap"; }
        }
      }
      const annual = (x: { d30: number | null } | null) => (x?.d30 ? Math.round((x.d30 * 365) / 30) : null);
      const annRev = annual(R), annFees = annual(F);
      const money = (x: typeof F) => (x ? { last24hUsd: x.d24, last7dUsd: x.d7, last30dUsd: x.d30, change1dPct: x.change1d } : null);
      return { ...none,
        data: { found: true, protocol: v.name, slug: v.slug, family: v.family, members: v.family ? v.members : undefined, category: v.category, token: v.symbol,
          tvlUsd: v.tvl, tvlChange1dPct: v.change1d, tvlChange7dPct: v.change7d, tvlByChain: v.chains,
          fees: money(F), revenue: money(R), dexVolume: money(V), annualisedFeesUsd: annFees, annualisedRevenueUsd: annRev,
          marketCapUsd: mcap, marketCapSource: mcapSource, mcapToTvl: mcap && v.tvl ? +(mcap / v.tvl).toFixed(2) : null,
          priceToSales: mcap && annRev ? +(mcap / annRev).toFixed(1) : null, priceToFees: mcap && annFees ? +(mcap / annFees).toFixed(1) : null,
          source: "DefiLlama", dataAgeMin: Math.round(ageS / 60),
          note: `${v.family ? `"${v.name}" sums its versions / products (${v.members.map((m) => m.name).join(", ")}). ` : ""}Fees = what users paid; revenue = what the protocol and token holders keep after paying LPs / suppliers. Annualised = last 30 days × 365/30. Price-to-sales = market cap ÷ annualised revenue (lower = cheaper vs earnings). TVL excludes borrowed and staked-token double counting. null = DefiLlama does not track it — say so, never fill it in.` },
        citations: [{ label: `${v.name} on DefiLlama`, href: `https://defillama.com/protocol/${v.slug}` }],
        viz: [
          ...(F || R || V ? [vTable(`${v.name} · fees, revenue, volume`, ["", "24h", "7d", "30d", "Annualised"], ([["Fees", F, annFees], ["Revenue", R, annRev], ["DEX volume", V, annual(V)]] as const).filter(([, x]) => x).map(([k, x, a]) => [k, usdShort(x!.d24), usdShort(x!.d7), usdShort(x!.d30), usdShort(a)]), ["l", "r", "r", "r", "r"])] : []),
          ...(v.chains.length > 1 ? [{ kind: "donut", title: `${v.name} · TVL by chain`, slices: v.chains.map((c) => ({ name: c.chain, value: c.tvl })), unit: "usd" } as Viz] : []),
        ] };
    }
    case "llama_rankings": {
      const L = await import("../askLlama");
      const kind = (["fees", "revenue", "dex_volume"] as const).find((k) => k === args.kind) ?? "tvl";
      const category = typeof args.category === "string" && args.category.trim() ? args.category.trim().slice(0, 40) : undefined;
      const chainQ = typeof args.chain === "string" && args.chain.trim() ? args.chain.trim().slice(0, 40) : undefined;
      const chain = chainQ ? L.findChain(chainQ, (await L.chains()).data)?.name ?? chainQ : undefined;
      const limit = Math.max(1, Math.min(30, Number(args.limit) || 12));
      const where = `${category ? ` · ${category}` : ""}${chain ? ` on ${chain}` : ""}`;
      const cite = [{ label: "DefiLlama", href: kind === "tvl" ? (chain ? `https://defillama.com/chain/${encodeURIComponent(chain)}` : "https://defillama.com/") : kind === "dex_volume" ? "https://defillama.com/dexs" : kind === "revenue" ? "https://defillama.com/revenue" : "https://defillama.com/fees" }];
      if (kind === "tvl") {
        const { data, ageS } = await L.protocols();
        const rows = L.rankTvl(data, { category, chain, limit });
        if (!rows.length) return { ...none, data: { found: false, note: `No protocol matches${where}. Category and chain names are DefiLlama's (Lending, Dexs, Derivatives, Liquid Staking …).` } };
        const onChain = (p: (typeof rows)[number]) => (chain ? p.chains.find((c) => c.chain.toLowerCase() === chain.toLowerCase())?.tvl ?? null : p.tvl);
        return { ...none, citations: cite,
          data: { kind, category: category ?? null, chain: chain ?? null, source: "DefiLlama", dataAgeMin: Math.round(ageS / 60), rows: rows.map((p, i) => ({ rank: i + 1, protocol: p.name, slug: p.slug, category: p.category, tvlUsd: onChain(p), totalTvlUsd: chain ? p.tvl : undefined, change1dPct: p.change1d, change7dPct: p.change7d, token: p.symbol })),
            note: `TVL in USD${chain ? ` on ${chain} (totalTvlUsd = all chains)` : ""}; CEX reserves excluded. Versions count separately (Aave V3 and Aave V2 are two rows).` },
          viz: [vTable(`DeFi by TVL${where}`, ["#", "Protocol", "Category", "TVL", "1d", "7d"], rows.map((p, i) => [i + 1, p.name, p.category ?? "—", usdShort(onChain(p)), p.change1d == null ? "—" : `${p.change1d}%`, p.change7d == null ? "—" : `${p.change7d}%`]), ["r", "l", "l", "r", "r", "r"])] };
      }
      const { data, ageS } = await L.flows(kind);
      const rows = L.rankFlows(data, { category, chain, limit });
      const label = kind === "fees" ? "Fees" : kind === "revenue" ? "Revenue" : "DEX volume";
      if (!rows.length) return { ...none, data: { found: false, note: `No protocol with ${label.toLowerCase()} matches${where}.` } };
      return { ...none, citations: cite,
        data: { kind, category: category ?? null, chain: chain ?? null, source: "DefiLlama", dataAgeMin: Math.round(ageS / 60), rows: rows.map((f, i) => ({ rank: i + 1, protocol: f.name, slug: f.slug, category: f.category, last24hUsd: f.d24, last7dUsd: f.d7, last30dUsd: f.d30, change1dPct: f.change1d, change7dPct: f.change7d })),
          note: `${label} in USD across all the chains a protocol runs on${chain ? ` (filtered to protocols live on ${chain})` : ""}. ${kind === "revenue" ? "Revenue = what the protocol keeps after paying LPs / suppliers. " : kind === "fees" ? "Fees = everything users paid (stablecoin issuers count their treasury yield). " : ""}Versions count separately.` },
        viz: [vTable(`${label}${where} · 24h`, ["#", "Protocol", "Category", "24h", "7d", "30d", "1d"], rows.map((f, i) => [i + 1, f.name, f.category ?? "—", usdShort(f.d24), usdShort(f.d7), usdShort(f.d30), f.change1d == null ? "—" : `${f.change1d}%`]), ["r", "l", "l", "r", "r", "r", "r"])] };
    }
    case "llama_chains": {
      const L = await import("../askLlama");
      const { data: cs, ageS } = await L.chains();
      const total = cs.reduce((a, c) => a + (c.tvl ?? 0), 0);
      const share = (v: number | null) => (v && total ? +((v / total) * 100).toFixed(2) : null);
      if (typeof args.chain === "string" && args.chain.trim()) {
        const c = L.findChain(args.chain.trim().slice(0, 40), cs);
        if (!c) return { ...none, data: { found: false, note: `DefiLlama has no chain called "${String(args.chain).slice(0, 40)}". Say so.` } };
        const [chg, top] = await Promise.all([L.chainTvlChange(c.name).catch(() => null), L.protocols().then((x) => L.rankTvl(x.data, { chain: c.name, limit: 10 })).catch(() => [])]);
        const onChain = (p: (typeof top)[number]) => p.chains.find((x) => x.chain === c.name)?.tvl ?? null;
        return { ...none, citations: [{ label: `${c.name} on DefiLlama`, href: `https://defillama.com/chain/${encodeURIComponent(c.name)}` }],
          data: { chain: c.name, token: c.token, tvlUsd: c.tvl, rank: cs.indexOf(c) + 1, shareOfDefiPct: share(c.tvl), change7dPct: chg?.d7 ?? null, change30dPct: chg?.d30 ?? null,
            topProtocols: top.map((p) => ({ protocol: p.name, category: p.category, tvlOnChainUsd: onChain(p) })), source: "DefiLlama", dataAgeMin: Math.round(ageS / 60) },
          viz: [vTable(`${c.name} · biggest protocols by TVL`, ["Protocol", "Category", "TVL here"], top.map((p) => [p.name, p.category ?? "—", usdShort(onChain(p))]), ["l", "l", "r"])] };
      }
      const top = cs.slice(0, 15);
      return { ...none, citations: [{ label: "DefiLlama chains", href: "https://defillama.com/chains" }],
        data: { totalDefiTvlUsd: Math.round(total), chains: top.map((c, i) => ({ rank: i + 1, chain: c.name, tvlUsd: c.tvl, sharePct: share(c.tvl), token: c.token })), source: "DefiLlama", dataAgeMin: Math.round(ageS / 60), note: "Current TVL only; pass a chain for its 7d / 30d change and biggest protocols." },
        viz: [{ kind: "donut", title: "DeFi TVL by chain", slices: [...cs.slice(0, 8).map((c) => ({ name: c.name, value: c.tvl ?? 0 })), { name: "Other", value: Math.max(0, total - cs.slice(0, 8).reduce((a, c) => a + (c.tvl ?? 0), 0)) }], unit: "usd" }] };
    }
    case "llama_stablecoins": {
      const L = await import("../askLlama");
      const { data: st, ageS } = await L.stablecoins();
      const usdS = st.filter((x) => x.peg === "USD");
      const total = usdS.reduce((a, x) => a + x.supply, 0);
      const chg = (pick: (x: (typeof usdS)[number]) => number | null) => {
        let prev = 0, now = 0;
        for (const x of usdS) { const c = pick(x); if (c != null && c > -100) { now += x.supply; prev += x.supply / (1 + c / 100); } }
        return prev > 0 ? +((now / prev - 1) * 100).toFixed(2) : null;
      };
      const sym = typeof args.symbol === "string" ? args.symbol.trim().toUpperCase().replace(/^\$/, "") : "";
      const focus = sym ? st.find((x) => x.symbol.toUpperCase() === sym) ?? null : null;
      const top = usdS.slice(0, 12);
      const row = (x: (typeof st)[number]) => ({ symbol: x.symbol, name: x.name, supplyUsd: x.supply, sharePct: x.peg === "USD" && total ? +((x.supply / total) * 100).toFixed(2) : null, change1dPct: x.d1, change7dPct: x.d7, change30dPct: x.d30, price: x.price, mechanism: x.mechanism, peg: x.peg });
      return { ...none, citations: [{ label: "DefiLlama stablecoins", href: "https://defillama.com/stablecoins" }],
        data: { totalUsdStablecoinsUsd: Math.round(total), change1dPct: chg((x) => x.d1), change7dPct: chg((x) => x.d7), change30dPct: chg((x) => x.d30), top: top.map(row),
          focus: sym ? (focus ? row(focus) : { found: false, note: `No stablecoin with symbol ${sym} on DefiLlama.` }) : undefined, source: "DefiLlama", dataAgeMin: Math.round(ageS / 60),
          note: "Circulating supply of USD-pegged stablecoins. Supply growth = new dollars minted into crypto (dry powder); shrinking = redemptions. A price far from 1.00 is a depeg — flag it." },
        viz: [vTable("USD stablecoins by supply", ["Coin", "Supply", "Share", "7d", "30d", "Price"], top.map((x) => [x.symbol, usdShort(x.supply), total ? `${((x.supply / total) * 100).toFixed(1)}%` : "—", x.d7 == null ? "—" : `${x.d7}%`, x.d30 == null ? "—" : `${x.d30}%`, x.price == null ? "—" : x.price.toFixed(4)]), ["l", "r", "r", "r", "r", "r"])] };
    }
    case "llama_yields": {
      const L = await import("../askLlama");
      const { data: ps, ageS } = await L.pools();
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : undefined);
      const chainQ = str(args.chain);
      const chainNames = [...new Map(ps.map((p) => [p.chain, 0])).keys()].map((name) => ({ name, tvl: ps.filter((p) => p.chain === name).reduce((a, p) => a + p.tvl, 0) })).sort((a, b) => b.tvl - a.tvl);
      const chain = chainQ ? L.findChain(chainQ, chainNames)?.name ?? chainQ : undefined;
      const opts = { token: str(args.token), chain, project: str(args.project), stableOnly: args.stable_only === true, minTvl: Number(args.min_tvl_usd) || undefined, limit: Number(args.limit) || 12 };
      const rows = L.pickPools(ps, opts);
      const what = [opts.stableOnly ? "stablecoin" : null, opts.token, opts.project, chain ? `on ${chain}` : null].filter(Boolean).join(" ");
      if (!rows.length) return { ...none, data: { found: false, note: `No pool ≥ $${((opts.minTvl ?? 5e6) / 1e6).toFixed(0)}M TVL matches ${what || "that"}. Try a lower min_tvl_usd or no chain filter.` } };
      return { ...none, citations: [{ label: "DefiLlama yields", href: "https://defillama.com/yields" }],
        data: { filters: { ...opts, minTvl: Math.max(1_000_000, opts.minTvl ?? 5_000_000) }, source: "DefiLlama", dataAgeMin: Math.round(ageS / 60),
          pools: rows.map((p) => ({ project: p.project, chain: p.chain, pool: p.symbol, detail: p.meta, tvlUsd: p.tvl, apyPct: p.apy, baseApyPct: p.apyBase, rewardApyPct: p.apyReward, apy30dAvgPct: p.apy30d, stablecoin: p.stable, ilRisk: p.il, exposure: p.exposure })),
          note: "APY is DefiLlama's latest. Base APY = fees / interest (sticky); reward APY = token emissions (can stop, paid in a token that can fall). A 30-day average far below today's APY = a spike. ilRisk yes = impermanent loss on a price move. Say which part is rewards before recommending, and that smart-contract risk is not in the number." },
        viz: [vTable(`Yields${what ? ` · ${what}` : ""}`, ["Pool", "Project", "Chain", "TVL", "APY", "Base", "Reward", "30d avg"], rows.map((p) => [p.symbol, p.project, p.chain, usdShort(p.tvl), p.apy == null ? "—" : `${p.apy}%`, p.apyBase == null ? "—" : `${p.apyBase}%`, p.apyReward == null ? "—" : `${p.apyReward}%`, p.apy30d == null ? "—" : `${p.apy30d}%`]), ["l", "l", "l", "r", "r", "r", "r", "r"])] };
    }
    case "macro_snapshot": {
      const M = await import("../marketData");
      const ids = Array.isArray(args.assets) && args.assets.length ? args.assets.map((x: unknown) => String(x)).slice(0, 12) : M.SNAPSHOT_IDS;
      const rows = await M.macroSnapshot(ids);
      const pc = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
      return { ...none, data: { asOf: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", markets: rows.map(({ hlCoin: _h, short: _s, ...r }) => r), note: `Gold/silver/oil/copper/EUR/JPY/Nasdaq = trade.xyz perps on Hyperliquid (24/7, track the underlying); DXY = computed from Dukascopy daily closes (last complete UTC day); BTC/ETH = Hyperliquid perps.${ids.some((i) => /DXY/i.test(i)) && !rows.some((r) => r.id === "DXY") ? " DXY is not available right now (a basket pair is still loading) — use EUR/USD and USD/JPY for the dollar and say DXY is unavailable in one short clause." : ""}` },
        citations: [], assets: rows.map((r) => ({ id: r.id, symbol: r.short, label: r.label, price: r.price, change24hPct: r.h24, hl: r.hlCoin, href: r.cls === "crypto" ? `/ask/perp/${encodeURIComponent(r.id)}` : null, kind: r.cls })),
        viz: rows.length ? [vTable("Markets now", ["Market", "Price", "24h", "7d", "30d"], rows.map((r) => [r.label, r.price, pc(r.h24), pc(r.d7), pc(r.d30)]), ["l", "r", "r", "r", "r"])] : [] };
    }
    case "market_levels": {
      const M = await import("../marketData");
      const a = await M.resolveAsset(String(args.asset ?? ""));
      if (!a) return { ...none, data: { found: false, note: `No market for "${String(args.asset ?? "").slice(0, 40)}". Covered: crypto perps on Hyperliquid, gold, silver, oil, copper, natural gas, EUR/USD, USD/JPY, GBP/USD, AUD/USD, USD/CAD, USD/CHF, DXY, Nasdaq-100 and US stocks listed on trade.xyz. For on-chain tokens use the arc_* / rh_* / monad_* tools.` } };
      const l = await M.marketLevels(a);
      if (l.price == null) return { ...none, data: { found: false, asset: a.label, note: "The price source did not answer. Say so; do not guess." } };
      const hlId = a.hlCoin && !a.hlCoin.startsWith("xyz:") ? a.hlCoin : null;
      const px = (n: number | null) => (n == null ? "—" : n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : String(n));
      const lvRows = [...l.resistance.slice().reverse().map((x) => ["Resistance", px(x.price), `${x.frame} · ${x.touches}×`, x.lastSeen]), ["Price", px(l.price), l.trend, l.asOf.slice(0, 10)], ...l.support.map((x) => ["Support", px(x.price), `${x.frame} · ${x.touches}×`, x.lastSeen])];
      return { ...none, data: { ...l, daily: undefined, note: `Source: ${l.source}. Levels are swing clusters (touches = how many swing highs/lows sit there), not predictions. ${a.cls === "stock" ? "stock = the Nasdaq quote (regular session) when present; the trade.xyz perp trades 24/7 and can differ off-hours. For the tokenized stock on Robinhood Chain use rh_*." : ""}` },
        citations: hlId ? [hlCite(hlId)] : a.stock ? [{ label: `${a.stock} on Nasdaq`, href: `https://www.nasdaq.com/market-activity/stocks/${a.stock.toLowerCase()}` }] : [],
        assets: [{ id: a.id, symbol: a.short, label: a.label, price: l.price, change24hPct: l.change.h24, hl: a.hlCoin, href: hlId ? `/ask/perp/${encodeURIComponent(hlId)}` : null, kind: a.cls, ...(l.perp ? { volume24hUsd: l.perp.volume24hUsd } : {}), ...(l.daily.length > 5 ? { spark: l.daily.slice(-30).map((d) => d.c) } : {}) }],
        viz: [
          ...(l.daily.length > 10 ? [{ kind: "line", title: `${a.label} · daily close`, x: l.daily.map((d) => new Date(d.t).toISOString().slice(5, 10)), series: [{ name: "Close", values: l.daily.map((d) => d.c) }], unit: a.cls === "fx" ? "n" : "price" } as Viz] : []),
          vTable(`${a.label} · levels`, ["", "Price", "Frame · touches", "Last seen"], lvRows, ["l", "r", "l", "l"]),
        ] };
    }
    case "earnings_calendar": {
      const M = await import("../marketData");
      const symbols = Array.isArray(args.symbols) ? args.symbols.map((x: unknown) => String(x).toUpperCase().replace(/[^A-Z.]/g, "")).filter(Boolean).slice(0, 20) : [];
      const days = Math.max(1, Math.min(21, Number(args.days) || 10));
      const rows = await M.earningsCalendar({ days, symbols, limit: 30 });
      return { ...none, data: { days, symbols, count: rows.length, earnings: rows, note: rows.length ? "Dates from the Nasdaq calendar; EPS = consensus. Say 'before open' / 'after close' as given." : symbols.length ? `None of ${symbols.join(", ")} reports in the next ${days} weekdays on the Nasdaq calendar. Say so.` : "Nothing large on the calendar in that window." },
        citations: [{ label: "Nasdaq earnings calendar", href: "https://www.nasdaq.com/market-activity/earnings" }],
        viz: rows.length ? [vTable("Earnings", ["Date", "When", "Ticker", "Company", "EPS est.", "Last yr", "Mkt cap"], rows.slice(0, 15).map((r) => [r.date.slice(5), r.time, r.symbol, r.name.length > 28 ? `${r.name.slice(0, 27)}…` : r.name, r.epsForecast == null ? "—" : `$${r.epsForecast}`, r.lastYearEps == null ? "—" : `$${r.lastYearEps}`, r.marketCapUsd == null ? "—" : `$${(r.marketCapUsd / 1e9).toFixed(0)}B`]), ["l", "l", "l", "l", "r", "r", "r"])] : [] };
    }
    case "hl_markets": {
      const rows = await hlMarkets();
      const key = String(args.sort ?? "volume");
      const asc = key.startsWith("-");
      const k = key.replace(/^-/, "");
      const val = (r: HlMarketRow) => k === "oi" ? r.openInterestUsd : k === "funding" ? r.fundingHourlyPct : k === "change" ? (r.change24hPct ?? 0) : r.volume24hUsd;
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
      const sorted = [...rows].sort((a, b) => (asc ? -1 : 1) * (val(b) - val(a))) /* ask2049: Chord has the factor flipped (default "volume" listed the least-traded first); the schema says "-" = ascending */.slice(0, limit);
      const data = sorted.map((r) => ({ coin: r.coin, markPx: r.markPx, change24hPct: r.change24hPct == null ? null : r2(r.change24hPct), volume24hUsd: Math.round(r.volume24hUsd), openInterestUsd: Math.round(r.openInterestUsd), fundingHourlyPct: Number(r.fundingHourlyPct.toFixed(4)), fundingAnnualPct: r2(r.fundingAnnualPct), maxLeverage: r.maxLeverage }));
      return { ...none, data: { venue: "Hyperliquid", sort: key, markets: data, note: "Funding is hourly; positive = longs pay shorts. Trade from /ask/perp." }, citations: data.slice(0, 3).map((d) => hlCite(d.coin)),
        viz: [vTable("Hyperliquid perps", ["Coin", "Mark", "24h", "Volume", "OI", "Funding/yr"], data.slice(0, 12).map((d) => [d.coin, `$${d.markPx >= 100 ? d.markPx.toFixed(2) : d.markPx.toPrecision(4)}`, d.change24hPct == null ? "—" : `${d.change24hPct}%`, `$${(d.volume24hUsd / 1e6).toFixed(1)}M`, `$${(d.openInterestUsd / 1e6).toFixed(1)}M`, `${d.fundingAnnualPct}%`]), ["l", "r", "r", "r", "r", "r"])] };
    }
    case "hl_market": {
      const coin = String(args.coin ?? "").trim().toUpperCase();
      const rows = await hlMarkets();
      const r = rows.find((x) => x.coin.toUpperCase() === coin) ?? rows.find((x) => x.coin.toUpperCase() === `K${coin}`);
      if (!r) return { ...none, data: { found: false, note: `No perp named ${coin} on Hyperliquid.` } };
      const since = Date.now() - 24 * 3600_000;
      const [book, fh] = await Promise.all([hlInfo<{ levels: [{ px: string; sz: string }[], { px: string; sz: string }[]] }>({ type: "l2Book", coin: r.coin }).catch(() => null), hlInfo<{ fundingRate: string; time: number }[]>({ type: "fundingHistory", coin: r.coin, startTime: since }).catch(() => [])]);
      const bid = Number(book?.levels?.[0]?.[0]?.px ?? 0), ask = Number(book?.levels?.[1]?.[0]?.px ?? 0);
      const rates = (fh ?? []).map((f) => Number(f.fundingRate) * 100);
      const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
      return { ...none, data: { venue: "Hyperliquid", coin: r.coin, markPx: r.markPx, change24hPct: r.change24hPct == null ? null : r2(r.change24hPct), volume24hUsd: Math.round(r.volume24hUsd), openInterestUsd: Math.round(r.openInterestUsd), premiumPct: r.premiumPct == null ? null : Number(r.premiumPct.toFixed(4)), fundingHourlyPct: Number(r.fundingHourlyPct.toFixed(4)), fundingAnnualPct: r2(r.fundingAnnualPct), funding24hAvgHourlyPct: avg == null ? null : Number(avg.toFixed(4)), funding24hAvgAnnualPct: avg == null ? null : r2(avg * 24 * 365), bestBid: bid || null, bestAsk: ask || null, spreadBps: bid && ask ? r2(((ask - bid) / ((ask + bid) / 2)) * 1e4) : null, maxLeverage: r.maxLeverage }, citations: [hlCite(r.coin)],
        assets: [{ id: r.coin, symbol: r.coin.replace(/^k(?=[A-Z])/, ""), label: r.coin, price: r.markPx, change24hPct: r.change24hPct == null ? null : r2(r.change24hPct), hl: r.coin, href: `/ask/perp/${encodeURIComponent(r.coin)}`, kind: "perp" }] };
    }
    case "hl_funding": {
      const coin = String(args.coin ?? "").trim().toUpperCase();
      const rows = await hlMarkets();
      const r = rows.find((x) => x.coin.toUpperCase() === coin);
      if (!r) return { ...none, data: { found: false, note: `No perp named ${coin} on Hyperliquid.` } };
      const hours = Math.max(1, Math.min(168, Number(args.hours) || 24));
      const fh = await hlInfo<{ fundingRate: string; premium: string; time: number }[]>({ type: "fundingHistory", coin: r.coin, startTime: Date.now() - hours * 3600_000 });
      const pts = fh.map((f) => ({ time: new Date(f.time).toISOString().slice(5, 16).replace("T", " "), hourlyPct: Number((Number(f.fundingRate) * 100).toFixed(4)) }));
      const vals = pts.map((p) => p.hourlyPct);
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      return { ...none, data: { venue: "Hyperliquid", coin: r.coin, hours, points: pts.length, avgHourlyPct: Number(avg.toFixed(4)), avgAnnualPct: r2(avg * 24 * 365), minHourlyPct: vals.length ? Math.min(...vals) : null, maxHourlyPct: vals.length ? Math.max(...vals) : null, nowHourlyPct: Number(r.fundingHourlyPct.toFixed(4)), whoPays: avg > 0 ? "longs pay shorts" : avg < 0 ? "shorts pay longs" : "flat", series: pts.slice(-48) }, citations: [hlCite(r.coin)],
        viz: pts.length > 2 ? [{ kind: "line", title: `${r.coin} funding · hourly %`, x: pts.slice(-48).map((p) => p.time.slice(6)), series: [{ name: "Funding %/h", values: pts.slice(-48).map((p) => p.hourlyPct) }] } as Viz] : [] };
    }
    case "hl_wallet": {
      const w = String(args.wallet ?? "").trim();
      if (!ADDR_RE.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
      const [st, orders] = await Promise.all([hlInfo<any>({ type: "clearinghouseState", user: w }), hlInfo<any[]>({ type: "openOrders", user: w }).catch(() => [])]);
      const positions = ((st?.assetPositions ?? []) as any[]).map((p) => p.position).filter((p) => Number(p?.szi) !== 0).map((p) => ({ coin: p.coin, side: Number(p.szi) > 0 ? "long" : "short", size: Math.abs(Number(p.szi)), entryPx: Number(p.entryPx), positionUsd: Math.round(Number(p.positionValue)), unrealizedPnlUsd: r2(Number(p.unrealizedPnl)), roePct: r2(Number(p.returnOnEquity) * 100), leverage: `${p.leverage?.value}x ${p.leverage?.type}`, liquidationPx: p.liquidationPx == null ? null : Number(p.liquidationPx), marginUsedUsd: r2(Number(p.marginUsed)) }));
      return { ...none, data: { venue: "Hyperliquid", wallet: w, accountValueUsd: r2(Number(st?.marginSummary?.accountValue ?? 0)), withdrawableUsd: r2(Number(st?.withdrawable ?? 0)), marginUsedUsd: r2(Number(st?.marginSummary?.totalMarginUsed ?? 0)), positions, openOrders: Array.isArray(orders) ? orders.length : 0, note: positions.length ? undefined : "No open position — the account may be empty or unfunded." }, addresses: [w], citations: [{ label: "Perps on Hyperliquid", href: "/ask/perp" }],
        viz: positions.length ? [vTable("Hyperliquid positions", ["Coin", "Side", "Size", "Entry", "uPnL", "Lev", "Liq"], positions.map((p) => [p.coin, p.side, `${p.size} ${p.coin}`, `$${p.entryPx}`, `$${p.unrealizedPnlUsd}`, p.leverage, p.liquidationPx == null ? "—" : `$${p.liquidationPx}`]), ["l", "l", "r", "r", "r", "l", "r"])] : [] };
    }
    case "derivs_coin": {
      const D = await import("../derivs");
      const hours = Math.max(1, Math.min(720, Number(args.hours) || 24));
      const v = await D.coinView(String(args.coin ?? ""), hours);
      if (!v) return { ...none, data: { found: false, note: `No USDT perpetual for "${String(args.coin ?? "").slice(0, 20)}" on Binance, Bybit, OKX or Hyperliquid. Say so.` } };
      const a = v.agg;
      const venues = v.rows.map((r) => {
        const f8 = r.fundingRate == null || !r.fundingIntervalH ? null : D.funding8hPct(r.fundingRate, r.fundingIntervalH);
        return { venue: D.VENUE_LABEL[r.venue], symbol: r.symbol, price: r.price == null ? null : sig(r.price), change24hPct: pr2(r.change24hPct), openInterestUsd: rnd(r.oiUsd), volume24hUsd: rnd(r.volume24hUsd),
          funding8hPct: f8 == null ? null : Number(f8.toFixed(4)), fundingAnnualPct: f8 == null ? null : r2(f8 * 3 * 365), fundingEveryHours: r.fundingIntervalH,
          nextFundingInMin: r.nextFundingTs ? Math.max(0, Math.round((r.nextFundingTs - Date.now()) / 60_000)) : null, longAccountsPct: pr2(r.longPct), topTradersLongPct: pr2(r.topLongPct) };
      });
      const down = D.VENUES.filter((x) => !v.status[x]?.ok && !v.rows.some((r) => r.venue === x)).map((x) => D.VENUE_LABEL[x]);
      const stale = D.VENUES.filter((x) => !v.status[x]?.ok && v.rows.some((r) => r.venue === x)).map((x) => `${D.VENUE_LABEL[x]} (${Math.round((v.status[x]?.staleS ?? 0) / 60)} min old)`);
      const ch = (c: { oiPct: number | null; pricePct: number | null } | null) => (c && c.oiPct != null ? { oiPct: pr2(c.oiPct), pricePct: pr2(c.pricePct) } : null);
      // Only the windows that exist (UI self-test 2026-09-26: every analysis said "no OI change for 4h/24h" out loud).
      const oiChange = Object.fromEntries(Object.entries({ h1: ch(v.change.h1), h4: ch(v.change.h4), h24: ch(v.change.h24) }).filter(([, x]) => x != null));
      return { ...none,
        data: { found: true, coin: v.coin, asOf: new Date(v.at).toISOString().slice(0, 16).replace("T", " ") + " UTC",
          total: { price: a.price == null ? null : sig(a.price), change24hPct: pr2(a.change24hPct), openInterestUsd: rnd(a.oiUsd), volume24hUsd: rnd(a.volume24hUsd), funding8hPct: a.funding8hPct == null ? null : Number(a.funding8hPct.toFixed(4)), fundingAnnualPct: pr2(a.fundingAnnualPct), longAccountsPct: pr2(a.longPct), binanceTopTradersLongPct: pr2(a.topLongPct) },
          ...(Object.keys(oiChange).length ? { oiChange } : {}), funding24hAvg8hPct: v.funding24hAvg8hPct == null ? null : Number(v.funding24hAvg8hPct.toFixed(4)), longAccountsPct24hAgo: pr2(v.longPct24hAgo),
          read4h: v.flow4h, read24h: v.flow24h, flags: v.flags, venues,
          note: `OI = one side, in USD. Funding is normalised to % per 8 h from each venue's own interval (Hyperliquid pays hourly); 0.01% per 8 h is the usual baseline; positive = longs pay shorts. longAccountsPct = share of accounts net long (Binance, Bybit, OKX — Hyperliquid publishes none); totals are OI-weighted. read4h / read24h / flags are rule-of-thumb readings of these numbers, not signals. OI change comes from our 15-minute snapshots; a window that is not in oiChange is not tracked yet — leave it out, never guess it, and do not mention that it is missing. Liquidation totals are not in this data.${down.length ? ` ${down.join(", ")} did not answer — the totals exclude it; say so.` : ""}${stale.length ? ` Stale: ${stale.join(", ")}.` : ""}` },
        citations: v.rows.map(derivsCite),
        assets: [{ id: `perp:${v.coin}`, symbol: v.coin, label: `${v.coin} perps`, price: a.price, change24hPct: pr2(a.change24hPct), hl: a.hl, href: a.hl ? `/ask/perp/${encodeURIComponent(a.hl)}` : null, kind: "perp" }],
        viz: [
          vTable(`${v.coin} perps · funding and open interest`, ["Venue", "Price", "OI", "Funding/8h", "Funding/yr", "Long accts", "Next funding"],
            venues.map((x) => [x.venue, x.price == null ? "—" : `$${x.price}`, usdShort(x.openInterestUsd), x.funding8hPct == null ? "—" : `${x.funding8hPct}%`, x.fundingAnnualPct == null ? "—" : `${x.fundingAnnualPct}%`, x.longAccountsPct == null ? "—" : `${x.longAccountsPct}%`, x.nextFundingInMin == null ? "—" : `${x.nextFundingInMin} min`]),
            ["l", "r", "r", "r", "r", "r", "r"]),
          ...(v.series.length > 2 ? [{ kind: "line", title: `${v.coin} open interest · all venues`, x: v.series.map((s) => new Date(s.ts).toISOString().slice(hours <= 48 ? 11 : 5, hours <= 48 ? 16 : 10)), series: [{ name: "OI", values: v.series.map((s) => Math.round(s.oiUsd)) }], unit: "usd" } as Viz] : []),
        ] };
    }
    case "derivs_board": {
      const D = await import("../derivs");
      const sorts: BoardSort[] = ["oi", "oi_change", "-oi_change", "funding", "-funding", "long", "-long", "volume", "change", "-change"];
      const sort = sorts.find((s) => s === args.sort) ?? "oi";
      const limit = Math.max(1, Math.min(40, Number(args.limit) || 15));
      const b = await D.boardView();
      const rows = D.sortBoard(b.rows, sort).slice(0, limit).map((r) => ({ coin: r.coin, price: r.price == null ? null : sig(r.price), change24hPct: pr2(r.change24hPct), openInterestUsd: rnd(r.oiUsd), oiChange1hPct: pr2(r.oiChange1hPct), oiChange4hPct: pr2(r.oiChange4hPct), oiChange24hPct: pr2(r.oiChange24hPct),
        funding8hPct: r.funding8hPct == null ? null : Number(r.funding8hPct.toFixed(4)), fundingAnnualPct: pr2(r.fundingAnnualPct), longAccountsPct: pr2(r.longPct), venues: r.venues.map((x) => D.VENUE_LABEL[x]), read24h: r.flow24h, hl: r.hl }));
      const down = D.VENUES.filter((x) => !b.status[x]?.ok).map((x) => D.VENUE_LABEL[x]);
      return { ...none,
        data: { sort, asOf: new Date(b.at).toISOString().slice(0, 16).replace("T", " ") + " UTC", coins: rows.map(({ hl: _h, ...r }) => r),
          note: `Top coins by open interest on Binance + Bybit + OKX + Hyperliquid. OI one side, USD; funding OI-weighted, % per 8 h (0.01% = baseline, positive = longs pay); longAccountsPct = share of accounts net long. ${b.partial ? "The polled board is not ready yet: Binance OI, account ratios and OI changes are missing in this read — say so." : "OI changes come from 15-minute snapshots (null while history fills)."}${down.length ? ` ${down.join(", ")} did not answer this round.` : ""} Liquidation totals are not in this data.` },
        citations: [{ label: "Binance futures", href: "https://www.binance.com/en/futures/BTCUSDT" }, { label: "Bybit derivatives", href: "https://www.bybit.com/trade/usdt/BTCUSDT" }, { label: "OKX perpetuals", href: "https://www.okx.com/trade-swap/btc-usdt-swap" }],
        chipCandidates: rows.map((r) => ({ id: `perp:${r.coin}`, symbol: r.coin, label: `${r.coin} perps`, price: r.price, change24hPct: r.change24hPct, hl: r.hl, href: r.hl ? `/ask/perp/${encodeURIComponent(r.hl)}` : null })),
        viz: rows.length ? [vTable(`Perps across exchanges · ${sort}`, ["Coin", "OI", "OI 24h", "Funding/8h", "Long accts", "Price 24h"],
          rows.map((r) => [r.coin, usdShort(r.openInterestUsd), r.oiChange24hPct == null ? "—" : `${r.oiChange24hPct}%`, r.funding8hPct == null ? "—" : `${r.funding8hPct}%`, r.longAccountsPct == null ? "—" : `${r.longAccountsPct}%`, r.change24hPct == null ? "—" : `${r.change24hPct}%`]),
          ["l", "r", "r", "r", "r", "r"])] : [] };
    }
    case "dex_search": {
      const D = await import("../dexSearch");
      const q = String(args.query ?? "").trim();
      if (!q) return { ...none, data: { error: "query required" } };
      const { tokens, ageS } = await D.dexSearch(q);
      const rows = typeof args.chain === "string" && args.chain.trim() ? tokens.filter((t) => t.chainName.toLowerCase().includes(String(args.chain).toLowerCase()) || t.chain === String(args.chain).toLowerCase()) : tokens;
      if (!rows.length) return { ...none, data: { found: false, query: q, note: `No DEX pair anywhere has a token called "${q.slice(0, 40)}". Say so.` } };
      const usd = (n: number | null) => (n == null ? "—" : usdShort(n));
      return { ...none,
        data: { query: q, source: "DexScreener (every chain)", dataAgeS: ageS || undefined,
          tokens: rows.map((t) => ({ symbol: t.symbol, name: t.name, chain: t.chainName, address: t.address, priceUsd: t.priceUsd, change24hPct: t.change24hPct, marketCapUsd: t.marketCapUsd, liquidityUsd: t.liquidityUsd, volume24hUsd: t.volume24hUsd, txns24h: t.txns24h, ageDays: t.ageDays, pairs: t.pairs, dex: t.topDex, website: t.website, x: t.x, url: t.url })),
          note: `${rows.length > 1 ? `${rows.length} different tokens answer to this name — never call one "the" token; give chain + address for each and ask which one they mean if it matters. ` : ""}Anyone can launch a token with any name and links: liquidity under $10k = hard to sell, a few days old = no history, 0 trades in 24h = dead. Market cap is DexScreener's (often fully diluted for memes). For a token on Arc, Robinhood Chain or Monad, Chord's own index (arc_token / rh_token / monad_token) has holders and flow.` },
        citations: rows.slice(0, 3).map((t) => ({ label: `${t.symbol} on ${t.chainName} · DexScreener`, href: t.url })),
        // Chips only for tokens with a real market — dead or copycat pairs stay in the table, not the rail.
        chipCandidates: rows.filter((t) => t.liquidityUsd >= 10_000 && t.volume24hUsd >= 1_000 && t.txns24h >= 10).map((t) => ({ id: `dex:${t.chain}:${t.address}`, symbol: t.symbol, label: t.name, price: t.priceUsd, change24hPct: t.change24hPct, hl: null, href: D.chipHref(t), ...(t.image ? { logo: t.image } : {}), marketCapUsd: t.marketCapUsd, volume24hUsd: t.volume24hUsd, liquidityUsd: t.liquidityUsd, fdvUsd: t.fdvUsd, kind: "crypto" as const, chainName: t.chainName })),
        viz: [vTable(`"${q.slice(0, 24)}" across chains`, ["Token", "Chain", "Price", "24h", "Mkt cap", "Liquidity", "Vol 24h", "Age"], rows.slice(0, 10).map((t) => [`${t.symbol} · ${t.name.slice(0, 22)}`, t.chainName, t.priceUsd, t.change24hPct, usd(t.marketCapUsd), usd(t.liquidityUsd), usd(t.volume24hUsd), t.ageDays == null ? "—" : t.ageDays < 1 ? "<1d" : `${Math.round(t.ageDays)}d`]), ["l", "l", "r", "r", "r", "r", "r", "r"])] };
    }
    default:
      return { ...none, data: { error: `unknown tool ${name}` } };
  }
}
