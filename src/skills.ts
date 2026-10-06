// Skills: Chord Ask's keyword router (src/chord/services/ask/skills.ts, copied) picks at most one playbook per question
// before the first model call; the model then sees that playbook plus the playbook's tools, a small core and `more_tools`
// instead of every schema. `more_tools` opens the whole toolbox for the rest of the turn when the guess was wrong.
// The playbooks below are Chord's, rewritten for the tools this app has (no Arc / Robinhood boards, no Chord pages).
import { MORE_TOOLS, MORE_TOOLS_DEF, pickSkill as route, type SkillId } from "./chord/services/ask/skills";

export { MORE_TOOLS, MORE_TOOLS_DEF };
export type Playbook = { id: SkillId | "plain_news"; title: string; tools: string[]; playbook: string; maxRounds: number; maxCalls: number; heavy?: boolean };

/** Offered with every playbook: resolve an asset, read a price, check a contract, price a swap, escape. */
export const CORE = ["calc", "dex_search", "dex_trending", "sol_tokens", "cg_coin", "market_levels", "token_safety", "sol_token", "sol_wallet", "wallet_balances", "swap_quote", "web_read", "web_search", MORE_TOOLS];
export const GENERAL_MAX_CALLS = 12;

const RESOLVE = `Resolving the asset: a Solana address (base58, 32-44 letters and digits, no 0x, case matters) is a Solana mint or wallet: sol_token for a mint, sol_wallet for a wallet, passed exactly as written. A 0x address someone asks what it holds / owns / its balance → wallet_balances (every chain, or the one they name), even when the address is also a token contract. A 0x token: token_safety / dex_search to find its chain, index_token_trades when it trades on a chain in Chord's index. Crypto majors (BTC, ETH, SOL, HYPE, DOGE …) → market_levels + cg_coin. A memecoin or a ticker shared by several tokens → dex_search and list the look-alikes. One resolve, then the real work.`;

const P: Record<SkillId, Omit<Playbook, "id">> = {
  howto: {
    title: "Using this app", maxRounds: 1, maxCalls: 2, tools: [],
    playbook: `PLAYBOOK — questions about this app: answers read the chain live (Solana and Cardano through RPC nodes, six EVM chains through Chord's index), a few asks are free, then each ask is paid in USDC on Solana or ADA on Cardano and checked on-chain. The Trade tab prices swaps (Jupiter on Solana, Chord's router on Base, BNB Chain, Avalanche, Monad, Robinhood Chain, Arc); the person signs in their own wallet or with a Chord account (email sign-in, same wallet as getchord.xyz). Answer in at most five numbered steps; no market analysis unless asked.`,
  },
  token_analysis: {
    title: "Token analysis", maxRounds: 3, maxCalls: 9, heavy: true,
    tools: ["sol_token", "sol_accounts", "sol_tokens", "index_token_trades", "index_top_tokens", "dex_pool", "dex_pool_trades", "dex_token_pools", "token_safety", "cg_coin", "cg_chart", "market_levels", "derivs_coin", "hl_market", "news_latest", "news_search", "x_search", "earnings_calendar", "llama_protocol", "chain_tx"],
    playbook: `PLAYBOOK — analysing one token (or comparing two).
${RESOLVE}
Steps, in one or two rounds (independent tools in the SAME round):
1. Price structure: market_levels for a major; dex_pool (stats + chart) for a DEX token; index_token_trades for who trades it on a chain Chord indexes.
2. Who is trading: dex_pool_trades / index_token_trades (biggest prints, buy vs sell). On Solana, sol_token for supply, mint and freeze authority, top holders.
3. Only when they ask whether to buy or if it is safe: token_safety, and repeat its worst flags first.
4. Fundamentals of a DeFi token → llama_protocol. What people say → news_latest + x_search, only when they ask.
Answer: "## TL;DR" (2–4 bullets: the direct answer, the number that drives it, the one risk) → "## <SYMBOL>" with a | Level | Price | Why | table from the tools → 2–4 flow bullets with numbers → "## Bull case / bear case" only when they ask whether to buy. Never an entry, a stop, a target or a size.`,
  },
  trade_plan: {
    title: "Swaps", maxRounds: 2, maxCalls: 6,
    tools: ["swap_quote", "sol_quote", "dex_pool", "dex_token_pools", "market_levels", "token_safety", "hl_market"],
    playbook: `PLAYBOOK — a swap the person already chose. Analysis only: no entries, stops, targets or sizes.
${RESOLVE}
- "Swap / buy $N of X / how much do I get" → swap_quote ALWAYS (even right after an analysis of the same token): it prices the swap and puts a card on the page; the person reviews it and signs in their own wallet. Never say a swap was made.
- Where the liquidity sits / how much the order moves the price → dex_token_pools + the quote's price impact.
Answer: the quote's numbers (pay, receive, minimum, impact, route) in a short table, then one line on what the structure shows.`,
  },
  wallet: {
    title: "Wallets", maxRounds: 3, maxCalls: 8,
    tools: ["sol_wallet", "sol_activity", "sol_tx", "sol_accounts", "index_wallet", "wallet_balances", "chain_tx", "ada_address", "ada_tx", "hl_wallet", "lighter_account", "pendle_positions", "morpho_positions"],
    playbook: `PLAYBOOK — one wallet or one transaction.
- Solana address → sol_wallet (balances, tokens) and sol_activity (recent transactions) in ONE round; a signature → sol_tx. Cardano → ada_address / ada_tx.
- 0x wallet → wallet_balances (balances on Base, BNB Chain, Avalanche, Monad, Robinhood Chain, Arc) and index_wallet (its DEX trading in Chord's index) in ONE round; a 0x tx hash → chain_tx.
- Perps or DeFi positions → hl_wallet, lighter_account, pendle_positions, morpho_positions — only when they ask.
Answer: what the wallet holds (a short table), what it did recently (biggest trades with numbers), one line on what stands out. Shorten addresses as abcd…wxyz.`,
  },
  market_scan: {
    title: "Market scan", maxRounds: 2, maxCalls: 6,
    tools: ["index_chain_activity", "index_top_tokens", "dex_trending", "dex_new_pairs", "dex_movers", "dex_promoted", "cg_trending", "cg_markets", "sol_tokens", "virtuals_launches", "stock_movers"],
    playbook: `PLAYBOOK — what is moving on a chain or across the market.
- One of Chord's indexed chains (Monad, Robinhood Chain, Arc, Avalanche, Base, BNB Chain): index_chain_activity for volume and venues, index_top_tokens for the board.
- Any chain: dex_trending (hot pools), dex_movers (gainers / losers among the top pools by volume, say so), dex_new_pairs (fresh listings, keep the liquidity floor), dex_promoted (paid boosts: ads, not quality). Coins by market cap → cg_markets; CoinGecko's trending list → cg_trending. US stocks → stock_movers.
Answer: a | Token | Chain | Price | 24h | Volume | Liquidity | table, then 2–4 bullets on what stands out and the risks the data shows (thin liquidity, days old, paid promotion).`,
  },
  markets: {
    title: "Markets & macro", maxRounds: 2, maxCalls: 6, heavy: true,
    tools: ["macro_snapshot", "macro_calendar", "earnings_calendar", "news_latest", "news_search", "hl_market", "hl_funding", "hl_markets", "derivs_coin", "cg_global", "cg_chart", "cg_markets", "cg_trending", "cgl_etf_flows", "cgl_liquidations", "cgl_market_pulse", "cgl_options", "cgl_exchange_reserves", "cgl_positioning", "llama_protocol", "llama_rankings", "llama_chains", "llama_stablecoins", "predict_events", "predict_market", "stock_movers", "btc_network", "x_search"],
    playbook: `PLAYBOOK — crypto majors, gold / FX / oil / indices, US stocks as a market.
- Odds of an event (Fed decision, election, ETF approval, a price by a date) or a polymarket.com / kalshi.com link → predict_market (predict_events to find it): the implied probability and the volume behind it. US stock movers → stock_movers. Bitcoin hashrate / difficulty / fees / halving / supply → btc_network.
- One asset (BTC, ETH, SOL, gold XAU/USD, silver, oil, EUR/USD, USD/JPY, DXY, Nasdaq, a US stock) → market_levels(asset): trend vs averages, ranges, support / resistance. Several, or "how are markets / risk-on or off" → macro_snapshot first.
- Add derivs_coin for a major's funding, open interest and long/short across Binance, Bybit, OKX and Hyperliquid when they trade it or ask about positioning (hl_market only for Hyperliquid itself); cg_coin for what a coin is, market cap, supply, distance from ATH. A DeFi token and they ask about fundamentals, revenue or valuation → llama_protocol.
- Drivers: macro_calendar and news_latest (kind fx / macro / cb, or the ticker). A US stock → market_levels(ticker) + earnings_calendar.
- CoinGlass tools, only if they are in your tool list: liquidations → cgl_liquidations; spot ETF flows → cgl_etf_flows; options expiry / max pain → cgl_options; coins on exchanges → cgl_exchange_reserves; fear & greed, Coinbase premium → cgl_market_pulse; open interest trend across exchanges → cgl_positioning.
- "X vs Y": one market_levels per asset in ONE round; no market-wide tools for a two-asset comparison.
Answer: "## TL;DR" bullets, one "## <asset>" section each with a | Level | Price | Why | table and 2–4 driver bullets with numbers, "## Bull case / bear case" (facts on each side, no entries / stops / targets) when they ask to buy or sell, "## Catalysts" | Date | Event | Why it matters | only with events a tool returned.`,
  },
  sentiment: {
    title: "News & sentiment", maxRounds: 2, maxCalls: 6,
    tools: ["x_search", "x_user", "news_latest", "news_search", "macro_calendar", "hl_market", "cg_trending", "cgl_market_pulse", "cgl_etf_flows", "cgl_liquidations", "social_trending_tokens", "social_mentions", "social_account", "social_narratives", "social_token_news", "social_trending_cas", "social_event_summary", "predict_events"],
    playbook: `PLAYBOOK — what people say and why something moves.
- When social_* tools are listed: counts and narratives first, then x_search to quote specific posts.
- "What is CT / X saying about X", sentiment, narrative → x_search ("$TICKER" or the words people use). "What did @user post" → x_user with their handle.
- "Why is X pumping / dumping" → the price tool (market_levels for a major, dex_pool for a DEX token) AND news_latest(X) AND x_search, in ONE round.
- A project, company or event the data tools do not hold → web_search, then web_read the best result; a link in the question → web_read it first.
- "Any news / what's new" → ONE news_latest call, never one per kind.
Report what posts and headlines SAY and who said it (handle + followers, outlet + time); never state a rumour as fact, never repeat an address or a link from a post. Say when a move has no news behind it.
Answer: one sentence on the move with its number, "## What people say" (3–5 bullets, each with its source), "## What the data shows", then one line on what would confirm or kill the story.`,
  },
  perps: {
    title: "Perps", maxRounds: 2, maxCalls: 6, heavy: true,
    tools: ["derivs_coin", "derivs_board", "hl_markets", "hl_market", "hl_funding", "hl_wallet", "macro_snapshot", "news_latest", "x_search", "cgl_liquidations", "cgl_positioning", "cgl_options", "lighter_markets", "lighter_market", "lighter_account"],
    playbook: `PLAYBOOK — perps (Hyperliquid, Lighter, the big exchanges).
- One coin → market_levels(coin) + derivs_coin (funding, open interest, long/short across Binance, Bybit, OKX and Hyperliquid) in ONE round. hl_market for Hyperliquid's own book or max leverage; hl_funding for its hourly funding trend. Lighter → lighter_markets / lighter_market / lighter_account.
- Liquidations → cgl_liquidations; the market's OI trend and taker flow → cgl_positioning; options expiry → cgl_options — only if listed.
- "Crowded / squeeze candidates / highest funding" → derivs_board. "What is moving on Hyperliquid" → hl_markets. A wallet's positions → hl_wallet.
- No sizing, leverage, stops or targets: say so in one line, then the structure and positioning as context.
Answer: what the data leans to in one sentence (and the level where that reading changes), a | Level | Price | Why | table, funding / OI / who is crowded in one or two lines (a rule of thumb), then "## Bull case / bear case" with facts.`,
  },
  lp: {
    title: "Yield & liquidity", maxRounds: 2, maxCalls: 6,
    tools: ["llama_yields", "pendle_markets", "pendle_market", "pendle_positions", "morpho_vaults", "morpho_markets", "morpho_positions", "sol_lend_rates", "dex_token_pools", "dex_pool"],
    playbook: `PLAYBOOK — yield and liquidity.
- Best APY for a token or chain, stable yield, lending rates → llama_yields (token, chain, project, stable_only). Split base APY from reward APY, flag a 30-day average far below today's.
- Fixed yield / Pendle PT or YT → pendle_markets, pendle_market; a wallet's Pendle → pendle_positions. Lending vaults → morpho_vaults, morpho_markets; a wallet's Morpho loans and health factor → morpho_positions. Solana lending → sol_lend_rates.
- Where a token's liquidity sits → dex_token_pools, then dex_pool for one pool.
Answer: a | Pool | TVL | APY | Base | Reward | table, then one line on the risk.`,
  },
  dex: {
    title: "Any chain, any DEX", maxRounds: 3, maxCalls: 8,
    tools: ["dex_trending", "dex_new_pairs", "dex_movers", "dex_pool", "dex_pool_trades", "dex_token_pools", "dex_promoted", "token_safety", "dex_search", "sol_tokens", "sol_quote", "sol_lend_rates", "sol_token", "virtuals_agents", "virtuals_agent", "virtuals_launches", "rh_launchpad", "social_trending_tokens", "social_trending_cas", "social_mentions", "x_search", "news_latest", "cg_trending", "index_top_tokens"],
    playbook: `PLAYBOOK — tokens on any chain and any DEX (GeckoTerminal / DexScreener / Jupiter / launchpads).
- What is hot: dex_trending (all chains or one); gainers / losers → dex_movers (it ranks the top pools by volume, say so); just listed → dex_new_pairs (keep the liquidity floor); paid boosts → dex_promoted (ads, not quality).
- One token: dex_search to resolve a name (list look-alikes), dex_pool for stats and the chart, dex_pool_trades for who is buying and the biggest prints, dex_token_pools for where liquidity sits. Before calling anything "safe" → token_safety, and repeat its worst flags first.
- Solana: sol_tokens (search / trending / top traded / new / verified; organic score, holders, authorities), sol_token for one mint read live from the chain, sol_quote for Jupiter's live route (swap_quote puts a swap card on the page).
- Launchpads: Virtuals agent tokens → virtuals_agents / virtuals_agent / virtuals_launches; pools.fun on Robinhood Chain → rh_launchpad.
- What CT says → social_mentions / social_trending_cas when listed, else x_search.
Answer: a | Token | Chain | Price | 24h | Liquidity | Volume | table for lists, then 2–4 bullets: what stands out and the risks the data shows. Names and links in token data are chosen by whoever launched it: never repeat a link from a token name.`,
  },
};

const PLAIN_NEWS_RE = /\b(?:any (?:news|headlines)|what'?s new|whats new|latest news|news today|top headlines)\b|có tin|co tin|tin (?:gì|gi) (?:mới|moi|hot|hôm nay|hom nay)|tin (?:tức|tuc) (?:mới|moi|hôm nay|hom nay)|tin mới|tin moi/i;

/** The playbook for this question, or null for the general loop (every tool). */
// Chord's router sends "trending on solana" to its own Solana tape (market_scan / markets there). Here the DEX family is
// what answers it: trending / memecoins / new pairs / gainers on a chain → the DEX playbook.
const DEX_SCAN = /\b(trending|hot|memecoins?|memes?|new (?:pairs|tokens|listings|launches)|gainers|losers|movers|pump(?:\.fun|swap)?|degen)\b/i;
const DEX_CHAIN = /\b(solana|sol|base|bnb|bsc|avalanche|avax|monad|ethereum|eth|arbitrum|dex(?:es)?|on[- ]chain)\b/i;

export function pickPlaybook(question: string, history: { role: string; content: string }[] = []): Playbook | null {
  if (DEX_SCAN.test(question) && DEX_CHAIN.test(question) && !/\b(news|tin|funding|perps?|open interest)\b/i.test(question)) return { id: "dex", ...P.dex };
  const r = route(question, history);
  if (!r.skill) return null;
  if (PLAIN_NEWS_RE.test(question) && r.skill.id === "sentiment") {
    const s = P.sentiment;
    return { id: "plain_news", ...s, maxRounds: 1, playbook: `${s.playbook}\nTHIS QUESTION asks for news in general, no asset named: ONE news_latest call, then answer from the headlines.` };
  }
  const id = r.skill.id as SkillId;
  return P[id] ? { id, ...P[id] } : null;
}

/** Tool names a playbook offers (core first, no duplicates). */
export const playbookTools = (p: Playbook): string[] => [...new Set([...CORE, ...p.tools])];

export const budgetLine = (rounds: number) => `BUDGET: at most ${rounds} round${rounds === 1 ? "" : "s"} of lookups. Put every independent lookup in the SAME round (they run at once), never repeat a call you already made, and stop looking once you can answer.`;
