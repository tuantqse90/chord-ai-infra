// Ask tool registry (docs/ask-harness-plan.md, phase 2). One row per tool the model can call: what the page shows while it
// runs, which family it belongs to, and the policy flags the loop applies. The hand-kept sets that used to sit in
// askAgent.ts (status labels, market-wide tools, DYOR tools, untrusted-text tools) are derived from here, and
// registry.test.ts fails when a schema has no row or a row no schema. Credit prices stay in askCredits.TOOL_COST (by name).
//
//   market    — reads the whole market, not one token: a token panel picked up on the way is a side lookup (artifactIntent)
//   dyor      — output is a trade signal (levels, a plan, a size, a route, picks): the answer carries the DYOR warning
//   untrusted — returns third-party text (X posts, news): an address inside it is NOT added to the answer's allowlist
//   timeoutMs — the tool's own deadline (default TOOL_TIMEOUT_MS); a slow tool answers {error} instead of holding the turn

import { EXT_TOOL_META } from "./extTools";

export type ToolGroup =
  | "chord" | "memory" | "journal" | "alerts" | "clarify" | "arc_market" | "arc_token" | "arc_wallet" | "trade" | "media"
  | "lp" | "rh" | "monad" | "chains" | "hl" | "derivs" | "coinglass" | "markets" | "coingecko" | "defillama" | "news" | "x" | "web" | "dex"
  // 2026-10-03 tool-parity batch (docs/prompts/ask-tool-parity-2026-10.md): any-chain DEX scan + token safety, Lighter perps,
  // Pendle / Morpho yield, prediction markets, agent / launchpad tokens, Solana, any-wallet balances + tx + exact math.
  | "dexscan" | "safety" | "lighter" | "yield" | "predict" | "launchpad" | "solana" | "wallet_any" | "util"
  // Minara + Elfa batches (docs/prompts/ask-minara-skills-2026-10.md, ask-elfa-skills-2026-10.md): social attention (Elfa),
  // US stock movers + Bitcoin network (Nasdaq, mempool.space).
  | "social" | "stocks" | "btc";
export interface ToolMeta { group: ToolGroup; label: string; market?: boolean; dyor?: boolean; untrusted?: boolean; timeoutMs?: number; maxCalls?: number; outputBudget?: number }

// 15 s default. Measured 2026-09-25 (telemetry): wallet PnL / profile tools compute cold in 8–24 s (the portfolio SWR fills
// on the first read, so a retry is fast), X search can wait up to 20 s on its shared rate gate before a 15 s fetch.
export const TOOL_TIMEOUT_MS = 15_000;

export const TOOL_META: Record<string, ToolMeta> = {
  chord_facts: { group: "chord", label: "Reading Chord facts" },
  arc_overview: { group: "arc_market", label: "Reading the Arc index", market: true },
  arc_trending: { group: "arc_market", label: "Scanning trending tokens", market: true },
  arc_tokens: { group: "arc_market", label: "Reading the token board", market: true },
  arc_token: { group: "arc_token", label: "Looking up the token" },
  arc_holders: { group: "arc_token", label: "Reading the holder ledger" },
  arc_quote: { group: "trade", label: "Asking the router for a route", dyor: true, timeoutMs: 15_000 },
  arc_price_analysis: { group: "arc_token", label: "Building the price structure from the tape", dyor: true, timeoutMs: 20_000 },
  arc_token_traders: { group: "arc_token", label: "Ranking traders on the token" },
  arc_wallet_trades: { group: "arc_wallet", label: "Reading the wallet's trades", timeoutMs: 25_000 },
  arc_wallet_pnl: { group: "arc_wallet", label: "Computing the wallet's PnL", timeoutMs: 30_000 },
  arc_wallet_profile: { group: "arc_wallet", label: "Profiling the wallet", timeoutMs: 30_000 },
  arc_token_trades: { group: "arc_token", label: "Reading recent prints" },
  arc_token_flow: { group: "arc_token", label: "Reading order flow" },
  arc_largest_trades: { group: "arc_market", label: "Scanning the largest prints", market: true },
  arc_new_launches: { group: "arc_market", label: "Listing new launches", market: true },
  arc_launchers: { group: "arc_market", label: "Ranking launchpads", market: true },
  arc_venues: { group: "arc_market", label: "Reading venue volume", market: true },
  arc_search: { group: "arc_token", label: "Searching tokens" },
  arc_token_pools: { group: "arc_token", label: "Listing pools" },
  lp_pools: { group: "lp", label: "Ranking pools for LPs", market: true },
  lp_pool: { group: "lp", label: "Reading the pool" },
  lp_suggest_range: { group: "lp", label: "Building range bands", dyor: true, timeoutMs: 20_000 },
  lp_plan: { group: "lp", label: "Backtesting LP vs hold", dyor: true, timeoutMs: 25_000 },
  lp_token_pools: { group: "lp", label: "Scoring the token's pools" },
  lp_overview: { group: "lp", label: "Reading LP activity", market: true, timeoutMs: 20_000 },
  lp_wallet_positions: { group: "lp", label: "Reading the wallet's LP positions", timeoutMs: 25_000 },
  lp_position: { group: "lp", label: "Reading the position" },
  lp_top_wallets: { group: "lp", label: "Ranking LP wallets", market: true },
  lp_flow: { group: "lp", label: "Reading liquidity adds and removals" },
  lp_watch: { group: "alerts", label: "Setting the LP alert" },
  arc_wallet_pnl_calendar: { group: "arc_wallet", label: "Reading the wallet's daily PnL", timeoutMs: 30_000 },
  arc_index_status: { group: "arc_market", label: "Checking data freshness" },
  chord_points: { group: "chord", label: "Reading Chord points" },
  arc_depth: { group: "trade", label: "Probing the book at three sizes", dyor: true, timeoutMs: 15_000 },
  arc_report: { group: "media", label: "Building the report", timeoutMs: 45_000 },
  arc_export_trades: { group: "media", label: "Exporting CSV", timeoutMs: 25_000 },
  arc_cotraders: { group: "arc_wallet", label: "Finding what its buyers also trade", timeoutMs: 25_000 },
  arc_buyer_quality: { group: "arc_token", label: "Classifying the buyers" },
  arc_token_risk: { group: "arc_token", label: "Running risk checks", timeoutMs: 25_000 },
  arc_compare: { group: "arc_market", label: "Comparing tokens", market: true },
  arc_candles: { group: "arc_token", label: "Reading candles" },
  arc_market_breadth: { group: "arc_market", label: "Reading market breadth", market: true },
  arc_holder_trend: { group: "arc_token", label: "Reading holder snapshots" },
  remember: { group: "memory", label: "Saving to your profile" },
  forget: { group: "memory", label: "Updating your profile" },
  arc_sql: { group: "arc_market", label: "Querying the index", market: true, timeoutMs: 20_000 },
  arc_tx: { group: "arc_token", label: "Decoding the transaction" },
  bridge_quote: { group: "trade", label: "Quoting the bridge", timeoutMs: 15_000 },
  arc_execution_plan: { group: "trade", label: "Planning the execution", dyor: true, timeoutMs: 15_000 },
  arc_attention: { group: "arc_market", label: "Reading attention on Chord", market: true },
  journal_open: { group: "journal", label: "Logging the position" },
  journal_list: { group: "journal", label: "Pricing your journal" },
  journal_close: { group: "journal", label: "Closing the position" },
  alert_create: { group: "alerts", label: "Setting the alert" },
  alert_list: { group: "alerts", label: "Reading your alerts" },
  alert_delete: { group: "alerts", label: "Removing the alert" },
  arc_picks: { group: "arc_market", label: "Reading the picks board", market: true, dyor: true },
  arc_top_wallets: { group: "arc_wallet", label: "Ranking wallets", market: true },
  monad_tokens: { group: "monad", label: "Reading Monad markets", market: true },
  rh_stocks: { group: "rh", label: "Reading the stock board", market: true },
  rh_tokens: { group: "rh", label: "Reading Robinhood Chain tokens", market: true },
  rh_token: { group: "rh", label: "Looking up the stock" },
  rh_token_trades: { group: "rh", label: "Reading recent prints", timeoutMs: 25_000 },
  rh_wallet_pnl: { group: "rh", label: "Computing Robinhood Chain PnL", timeoutMs: 30_000 },
  rh_quote: { group: "rh", label: "Asking the router for a route", dyor: true, timeoutMs: 15_000 },
  rh_overview: { group: "rh", label: "Reading the Robinhood Chain index", market: true },
  rh_venues: { group: "rh", label: "Reading venue volume", market: true },
  rh_search: { group: "rh", label: "Searching Robinhood Chain", market: true },
  rh_token_traders: { group: "rh", label: "Ranking traders on the token" },
  rh_token_flow: { group: "rh", label: "Reading order flow" },
  rh_candles: { group: "rh", label: "Reading candles" },
  rh_price_analysis: { group: "rh", label: "Building the price structure from the tape", dyor: true, timeoutMs: 20_000 },
  rh_wallet_trades: { group: "rh", label: "Reading the wallet's trades", timeoutMs: 25_000 },
  rh_wallet_profile: { group: "rh", label: "Profiling the wallet", timeoutMs: 30_000 },
  rh_wallet_pnl_calendar: { group: "rh", label: "Reading the wallet's daily PnL", timeoutMs: 30_000 },
  rh_top_wallets: { group: "rh", label: "Ranking wallets", market: true },
  rh_largest_trades: { group: "rh", label: "Scanning the largest prints", market: true },
  rh_compare: { group: "rh", label: "Comparing tokens", market: true },
  make_clip: { group: "media", label: "Pulling the numbers for the clip", timeoutMs: 30_000 },
  rh_holders: { group: "rh", label: "Reading the holder ledger" },
  rh_tx: { group: "rh", label: "Decoding the transaction" },
  arc_fx: { group: "markets", label: "Reading StableFX settlements on Arc", market: true },
  backtest: { group: "markets", label: "Running the backtest", timeoutMs: 30_000 },
  news_latest: { group: "news", label: "Reading the latest headlines", market: true, untrusted: true },
  news_search: { group: "news", label: "Searching the news", market: true, untrusted: true, timeoutMs: 15_000 },
  macro_calendar: { group: "news", label: "Reading the economic calendar", market: true },
  hl_markets: { group: "hl", label: "Reading Hyperliquid markets", market: true },
  hl_market: { group: "hl", label: "Reading the perp" },
  hl_funding: { group: "hl", label: "Reading funding history" },
  hl_wallet: { group: "hl", label: "Reading the Hyperliquid account", timeoutMs: 20_000 },
  derivs_coin: { group: "derivs", label: "Reading funding and open interest across exchanges", timeoutMs: 20_000 },
  derivs_board: { group: "derivs", label: "Scanning perp positioning across exchanges", market: true, timeoutMs: 20_000 },
  monad_token: { group: "monad", label: "Looking up the Monad token" },
  monad_token_trades: { group: "monad", label: "Reading Monad prints" },
  monad_token_traders: { group: "monad", label: "Ranking Monad traders" },
  monad_wallet_pnl: { group: "monad", label: "Computing Monad PnL", timeoutMs: 30_000 },
  monad_top_wallets: { group: "monad", label: "Ranking Monad wallets", market: true },
  chain_overview: { group: "chains", label: "Reading the chain's index", market: true },
  chain_tokens: { group: "chains", label: "Reading the token board", market: true },
  chain_token: { group: "chains", label: "Looking up the token" },
  chain_token_trades: { group: "chains", label: "Reading recent prints", timeoutMs: 20_000 },
  chain_wallet: { group: "chains", label: "Computing the wallet's PnL", timeoutMs: 25_000 },
  chain_quote: { group: "chains", label: "Asking the router for a route", dyor: true, timeoutMs: 15_000 },
  market_levels: { group: "markets", label: "Reading the price structure", market: true, dyor: true },
  token_performance: { group: "arc_market", label: "Ranking tokens over the week / month", market: true, timeoutMs: 20_000 },
  dex_search: { group: "dex", label: "Searching every DEX for the token", timeoutMs: 15_000 },
  web_read: { group: "web", label: "Reading the page", untrusted: true, timeoutMs: 45_000, outputBudget: 12_000 },
  web_search: { group: "web", label: "Searching the web", untrusted: true, timeoutMs: 15_000 },
  // Attached images (services/ask/vision). Untrusted: an address read off a picture never enters the answer allowlist.
  image_read: { group: "media", label: "Reading your image", untrusted: true, timeoutMs: 35_000 },
  x_search: { group: "x", label: "Searching X", untrusted: true, timeoutMs: 38_000 },
  x_user: { group: "x", label: "Reading the X account", untrusted: true, timeoutMs: 38_000 },
  cg_coin: { group: "coingecko", label: "Reading the coin's profile" },
  cg_markets: { group: "coingecko", label: "Reading the crypto board", market: true, timeoutMs: 15_000 },
  cg_trending: { group: "coingecko", label: "Reading what is trending on CoinGecko", market: true },
  cg_global: { group: "coingecko", label: "Reading the whole crypto market", market: true },
  cg_categories: { group: "coingecko", label: "Ranking crypto sectors", market: true },
  cg_chart: { group: "coingecko", label: "Reading price history", timeoutMs: 15_000 },
  macro_snapshot: { group: "markets", label: "Reading gold, FX, oil, indices and crypto", market: true },
  earnings_calendar: { group: "news", label: "Reading the earnings calendar", market: true },
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
  ask_user: { group: "clarify", label: "Asking you back" },
  more_tools: { group: "clarify", label: "Opening the full toolbox" },
  // 2026-10-03 batches — one row per tool lives next to its runner (services/ask/extTools lists the families).
  ...EXT_TOOL_META,
};

const names = (f: (m: ToolMeta) => boolean) => new Set(Object.entries(TOOL_META).filter(([, m]) => f(m)).map(([n]) => n));
export const MARKET_TOOLS = names((m) => !!m.market);
export const DYOR_TOOLS = names((m) => !!m.dyor);
export const UNTRUSTED_ADDR_TOOLS = names((m) => !!m.untrusted);
export const statusLabel = (tool: string): string => TOOL_META[tool]?.label ?? "Looking that up";
export const toolTimeout = (tool: string): number => TOOL_META[tool]?.timeoutMs ?? TOOL_TIMEOUT_MS;
/** Characters of JSON the model reads from one call (shrink.ts). A page's text needs more than a board. */
export const toolOutputBudget = (tool: string): number | undefined => TOOL_META[tool]?.outputBudget;
/** Calls of one tool in one turn (different arguments). Self-test 2026-09-26: derivs_coin ×6, cg_markets ×4, rh_stocks ×4 —
 *  the same board re-read with other sorts. Beyond the cap the call answers "use what you have". */
export const TOOL_MAX_CALLS = 3;
const MANY_CALLS: Record<string, number> = { web_read: 4, arc_sql: 2, market_levels: 4, arc_wallet_trades: 4, rh_wallet_trades: 4, arc_wallet_pnl: 4, rh_wallet_pnl: 4, lp_token_pools: 3 };
export const toolCap = (tool: string): number => TOOL_META[tool]?.maxCalls ?? MANY_CALLS[tool] ?? TOOL_MAX_CALLS;
