// Internal names out of the answer (UI self-test 2026-09-26: ~10 of 103 answers named tools in prose — "*Nguồn: CoinGecko …
// và news_latest*", "swing clusters (market_levels)" — and one quoted fields: "`navUsd` and `basisPct` come back null").
// The prompt says not to; this makes sure: a parenthesis holding only tool names goes, a tool name left in prose becomes the
// source's name in the answer's language, and a backticked field name becomes words.
import { TOOL_META, type ToolGroup } from "./registry";

type Lang = "en" | "vi";
const GROUP_NAME: Record<ToolGroup, [string, string]> = {
  arc_market: ["Chord's Arc index", "dữ liệu Arc của Chord"], arc_token: ["Chord's Arc index", "dữ liệu Arc của Chord"], arc_wallet: ["Chord's Arc index", "dữ liệu Arc của Chord"],
  rh: ["Chord's Robinhood Chain index", "dữ liệu Robinhood Chain của Chord"], monad: ["Chord's Monad index", "dữ liệu Monad của Chord"],
  chains: ["Chord's index", "dữ liệu của Chord"],
  lp: ["Chord's LP index", "dữ liệu LP của Chord"], hl: ["Hyperliquid", "Hyperliquid"], coingecko: ["CoinMarketCap", "CoinMarketCap"],
  news: ["the news feed", "nguồn tin tức"], x: ["X", "X"], derivs: ["positioning across exchanges", "dữ liệu vị thế các sàn"], coinglass: ["CoinGlass", "CoinGlass"], defillama: ["DefiLlama", "DefiLlama"], web: ["the web", "web"], dex: ["DexScreener", "DexScreener"],
  markets: ["market data", "dữ liệu thị trường"], trade: ["Chord's router", "router của Chord"], media: ["the report tools", "công cụ báo cáo"],
  chord: ["Chord's docs", "tài liệu của Chord"], memory: ["your profile", "hồ sơ của bạn"], journal: ["your journal", "nhật ký lệnh của bạn"],
  alerts: ["your alerts", "cảnh báo của bạn"], clarify: ["", ""],
  dexscan: ["GeckoTerminal", "GeckoTerminal"], safety: ["GoPlus token security", "dữ liệu bảo mật GoPlus"], lighter: ["Lighter", "Lighter"],
  yield: ["the yield data", "dữ liệu lợi suất"], predict: ["prediction markets", "thị trường dự đoán"], launchpad: ["the launchpad", "launchpad"],
  solana: ["Jupiter", "Jupiter"], wallet_any: ["an on-chain read", "dữ liệu on-chain"], util: ["exact math", "phép tính chính xác"],
  social: ["Elfa social data", "dữ liệu mạng xã hội Elfa"], stocks: ["Nasdaq", "Nasdaq"], btc: ["mempool.space", "mempool.space"],
};
const TOOL_NAME: Record<string, [string, string]> = {
  market_levels: ["the price levels", "mức giá"], macro_snapshot: ["the macro board", "bảng vĩ mô"], macro_calendar: ["the economic calendar", "lịch kinh tế"],
  earnings_calendar: ["the earnings calendar", "lịch báo cáo lợi nhuận"], backtest: ["the backtest", "backtest"],
  bridge_quote: ["the bridge quote", "báo giá bridge"], arc_sql: ["a query on Chord's index", "truy vấn dữ liệu Chord"], news_latest: ["the news feed", "nguồn tin tức"],
  news_search: ["the news feed", "nguồn tin tức"], dex_promoted: ["DexScreener", "DexScreener"], token_safety: ["GoPlus token security", "dữ liệu bảo mật GoPlus"],
  pendle_markets: ["Pendle", "Pendle"], pendle_market: ["Pendle", "Pendle"], pendle_positions: ["Pendle", "Pendle"],
  morpho_vaults: ["Morpho", "Morpho"], morpho_markets: ["Morpho", "Morpho"], morpho_positions: ["Morpho", "Morpho"],
  virtuals_agents: ["Virtuals", "Virtuals"], virtuals_agent: ["Virtuals", "Virtuals"], virtuals_launches: ["Virtuals", "Virtuals"], rh_launchpad: ["pools.fun", "pools.fun"],
  sol_lend_rates: ["Jupiter Lend", "Jupiter Lend"], cg_chart: ["the price history", "lịch sử giá"], cg_trending: ["CoinGecko trending", "xu hướng CoinGecko"], token_performance: ["Chord's index", "dữ liệu của Chord"], hl_funding: ["Hyperliquid funding", "funding Hyperliquid"],
};
const nameOf = (tool: string, lang: Lang): string => {
  const i = lang === "vi" ? 1 : 0;
  return TOOL_NAME[tool]?.[i] ?? GROUP_NAME[TOOL_META[tool]?.group]?.[i] ?? tool;
};

// Only snake_case names: "backtest", "remember", "forget" are also plain English words.
const TOOLS = Object.keys(TOOL_META).filter((t) => t.includes("_")).sort((a, b) => b.length - a.length);
const ALT = TOOLS.join("|"); // tool names are [a-z0-9_] — nothing to escape
const PAREN_ONLY_TOOLS = new RegExp(`\\s*\\((?:\\s*\`?(?:${ALT})\`?(?:\\([^)]*\\))?\\s*(?:,|/|\\+|&|and|và|×\\d)?\\s*)+\\)`, "g");
const TOOL_WORD = new RegExp(`\`?\\b(${ALT})\\b\`?(?:\\(\\))?`, "g");
// camelCase data fields the tools return (navUsd, basisPct, change24hPct, openInterestUsd …), backticked or bare with a unit suffix
const FIELD_TICKED = /`([a-z]+(?:[A-Z][a-z0-9]*)+)`/g;
const FIELD_BARE = /\b([a-z]+(?:[A-Z][a-z0-9]*)*(?:Usd|Pct|Ts|Px))\b/g;
const words = (id: string) => id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/ usd$/, " (USD)").replace(/ pct$/, " %").replace(/\bnav\b/, "NAV");

export function humanizeInternals(text: string, lang: Lang = "en"): string {
  return text
    .replace(PAREN_ONLY_TOOLS, "")
    .replace(TOOL_WORD, (_m, t: string) => nameOf(t, lang))
    .replace(FIELD_TICKED, (_m, f: string) => words(f))
    .replace(FIELD_BARE, (_m, f: string) => words(f))
    .replace(/ {2,}/g, " ");
}
