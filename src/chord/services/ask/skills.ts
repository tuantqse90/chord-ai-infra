// Ask skills (docs/ask-harness-plan.md, phase 3). A skill is a playbook for one kind of question: the steps to take, the
// tools that do them, the shape of the answer, the traps seen in real traffic. A cheap keyword router picks at most one
// skill per question BEFORE the first model call; the model then sees
//   · the rules + the skill's playbook instead of the 108-row question → tool table (SYS_TOOLBOX),
//   · the skill's tools + a small always-on core + `more_tools` instead of all 108 schemas.
// `more_tools` opens the whole toolbox for the rest of the turn when the playbook was the wrong guess, so a miss costs
// one round, not a wrong answer. No skill matches → the general loop, exactly as before.
//
// Routing is deliberately keyword-based (no extra model call on every question): every rule below comes from a real
// question in scripts/ask-eval/cases.json, and the eval is the judge of any change here.

export interface Skill {
  /** A built-in playbook, or `agent:<id>` for a person-made one. */
  id: SkillId | `agent:${string}`;
  title: string;
  /** Tools this playbook uses (the core set is added to every skill). */
  tools: string[];
  playbook: string;
  /** Tool rounds before the forced answer (default MAX_TOOL_ROUNDS of the loop). */
  maxRounds?: number;
  /** Tool calls in the whole turn (default SKILL_MAX_CALLS). */
  maxCalls?: number;
  /** Deep analysis may run on a stronger model (ASK_MODEL_HEAVY) — phase 6. */
  heavy?: boolean;
}
export type SkillId = "token_analysis" | "trade_plan" | "wallet" | "market_scan" | "markets" | "sentiment" | "perps" | "lp" | "howto" | "dex";

/** Offered with every skill: resolve a name, read a price, ask back, remember, act, escape. */
export const CORE_TOOLS = ["calc", "chord_facts", "arc_search", "rh_search", "arc_token", "rh_token", "chain_token", "market_levels", "cg_coin", "dex_search", "web_read", "web_search", "image_read", "ask_user", "remember", "forget", "alert_create", "journal_open", "more_tools"];

/** Tool calls per turn under a playbook; the general loop gets GENERAL_MAX_CALLS. Self-test 2026-09-26: the failures were
 *  8–9 calls where 4–5 answered it. */
export const SKILL_MAX_CALLS = 7;
export const GENERAL_MAX_CALLS = 12;

export const MORE_TOOLS = "more_tools";
export const MORE_TOOLS_DEF = {
  type: "function" as const,
  function: {
    name: MORE_TOOLS,
    description: "Your tool list is a short one picked for this kind of question. If the question needs a tool you do not have (another chain, a wallet, LP, news, X, backtest, SQL, a clip, a report …), call this once with what you need — every tool is available from the next round on.",
    parameters: { type: "object", properties: { need: { type: "string", description: "what you need to look up" } }, required: ["need"] },
  },
};

const RESOLVE = `Resolving the asset: a Solana address (base58, 32-44 letters and digits, no 0x, case matters — e.g. one ending in "pump") is a Solana mint or wallet, never a 0x asset: when sol_tape_* is in your list use sol_tape_token for a mint (sol_tape_trades for its prints) and sol_tape_wallet for a wallet, and pass the address exactly as written; otherwise sol_tokens / dex_search. A 0x address → arc_token (Arc) — if it is not an Arc token, rh_token (Robinhood Chain), then monad_token (Monad), stop at the first hit. A symbol → arc_search once (rh_search for stocks and Robinhood tokens); pick the listed one with the most volume and say which you used. Crypto majors and coins that live on other chains (BTC, ETH, SOL, NEAR, SUI, HYPE, DOGE …) are NOT Arc tokens: use market_levels + cg_coin. A token on Avalanche, Base or BNB Chain (the question names the chain, or the token lives there: AERO, BRETT, CAKE, JOE …) → chain_token with chain avalanche / base / bnb (Chord indexes and routes those three chains — chain_tokens with query finds one). A memecoin on another chain (Solana …), a ticker cg_coin does not know, or a ticker shared by several tokens → dex_search (every DEX, every chain) and list the look-alikes. Never search every chain "just in case" — one resolve, then the real work. If a symbol is two different assets with different prices, ask_user.`;

export const SKILLS: Record<SkillId, Skill> = {
  howto: {
    id: "howto",
    title: "Using Chord",
    maxRounds: 2,
    maxCalls: 5,
    tools: ["bridge_quote", "arc_quote", "rh_quote", "chain_quote", "rh_stocks", "arc_index_status", "chord_points"],
    playbook: `PLAYBOOK — questions about Chord itself: how to deposit, withdraw, bridge, buy a stock or a token, trade perps, what it costs, plans and credits, custody, gas, whether there is a token.
- chord_facts FIRST, once, with the topic in a few words ("deposit stocks", "fees", "perps", "plans"). Its answer is the product's own wording — use it, never guess.
- Only when they name an amount: bridge_quote for moving USDC between chains, rh_quote / arc_quote for "how much X do I get" (chain_quote on Avalanche, Base or BNB Chain — the person's own wallet signs there and pays gas in AVAX / ETH / BNB).
- Answer as at most six numbered steps, each naming the page to open (/ask/wallet, /ask/trade, /ask/perp, /bridge, /ask/alerts), then one line on cost or gas. No market analysis unless they ask for it.`,
  },
  token_analysis: {
    id: "token_analysis",
    maxRounds: 3,
    maxCalls: 9,
    title: "Token analysis",
    heavy: true,
    tools: ["sol_tape_token", "sol_tape_trades", "arc_price_analysis", "arc_token_flow", "arc_token_trades", "arc_holders", "arc_holder_trend", "arc_token_risk", "arc_buyer_quality", "arc_token_traders", "arc_candles", "arc_token_pools", "arc_depth", "arc_report", "arc_compare", "arc_cotraders", "arc_picks", "arc_tx", "arc_largest_trades",
      "rh_price_analysis", "rh_token_flow", "rh_token_trades", "rh_holders", "rh_candles", "rh_compare", "rh_token_traders", "rh_stocks",
      "monad_token", "chain_token", "chain_token_trades", "chain_tokens", "lp_token_pools", "news_latest", "x_search", "hl_market", "earnings_calendar", "token_performance", "dex_pool", "dex_pool_trades", "token_safety", "chain_tx"],
    playbook: `PLAYBOOK — analysing one token (or comparing two).
- A token off Chord's six chains: dex_pool (stats + chart) and dex_pool_trades (who is buying, biggest prints). "Is it safe / honeypot / tax / can the owner mint" on any chain → token_safety (and arc_token_risk on Arc). A tx hash on Avalanche / Base / BNB / Monad → chain_tx.
${RESOLVE}
Steps, in one or two rounds (call independent tools in the SAME round):
1. Price structure: arc_price_analysis (rh_price_analysis for a stock / Robinhood token; on Avalanche / Base / BNB Chain chain_token — price, 24h / 7d change, range, venues — and chain_token_trades for who is trading) — support / resistance zones, VWAP, range, momentum. For a stock also say the NAV gap and use earnings_calendar when a report is near.
2. Who is trading it: arc_token_flow (accumulation vs distribution, buy share) and, for "selling or churn / what is going on / who is dumping", arc_token_trades (min_usd) and arc_buyer_quality.
3. Only when they ask whether to buy, if it is safe, or the move is extreme: arc_token_risk and arc_holders (concentration, can they exit).
4. A group of tokens over a week or a month ("memes on Robinhood Chain this month") → token_performance first, then the one or two tokens that stand out.
5. "Report / PDF / export / research note" → arc_report after the reads above. "X vs Y" → arc_compare / rh_compare.
Do not call news or X for an on-chain Arc token unless they ask what people say.
Answer: "## TL;DR" (2–4 bullets: direct answer, the number that drives it, the one risk) → "## <SYMBOL>" with a | Level | Price | Why | table from the tool → 2–4 flow bullets with numbers → if they ask whether to buy: "## Bull case / bear case" with the facts on each side. Never an entry, a stop, a target or a size. A "x10 / sure thing" claim from a friend gets the facts, never agreement.`,
  },
  trade_plan: {
    id: "trade_plan",
    maxRounds: 3,
    title: "Trade plan",
    tools: ["arc_price_analysis", "rh_price_analysis", "arc_depth", "arc_execution_plan", "arc_quote", "rh_quote", "chain_quote", "chain_token", "bridge_quote", "hl_market", "arc_token_flow", "arc_holders", "journal_list", "journal_close", "sol_quote", "token_safety"],
    playbook: `PLAYBOOK — executing a trade the person already chose (quotes, depth, splitting an order) — analysis only, never a plan.
${RESOLVE}
- Chord gives no entries, stops, targets, position sizes or leverage (owner rule). "What size / size it / where to put my stop / TP?" → say so in one line, then give the structure as context (arc_price_analysis / rh_price_analysis / market_levels: support / resistance, range, VWAP) and what the order would cost (arc_depth).
- "Buy $N without moving the price" → arc_execution_plan (tranches, spacing) and arc_depth.
- "How much do I get / how many shares / swap / buy $N of X" → arc_quote on Arc, rh_quote for stocks and Robinhood tokens (gasless, never say they need ETH), chain_quote on Avalanche / Base / BNB Chain (their own wallet signs, gas in AVAX / ETH / BNB); the card is how they sign. ALWAYS call the quote tool for these, even right after an analysis of the same token — prices move and without the call there is no card to trade from.
- "I already bought N at price P, how does it look" → the price structure + where their price sits against the levels + the size vs liquidity (arc_depth / arc_holders) — no advice on where to exit.
Answer: the numbers the tools returned (quote, impact, depth, tranches for execution) in a short table, then one line on what the structure shows. No stop, target or size.`,
  },
  wallet: {
    id: "wallet",
    maxRounds: 3,
    title: "Wallets",
    tools: ["sol_tape_wallet", "sol_tape_token", "sol_tape_trades", "sol_tape_market", "arc_wallet_profile", "arc_wallet_pnl", "arc_wallet_trades", "arc_wallet_pnl_calendar", "arc_top_wallets", "arc_token_traders", "arc_cotraders", "arc_buyer_quality", "arc_token_trades", "arc_largest_trades",
      "rh_wallet_profile", "rh_wallet_pnl", "rh_wallet_trades", "rh_wallet_pnl_calendar", "rh_top_wallets", "rh_token_traders",
      "monad_wallet_pnl", "monad_top_wallets", "monad_token_traders", "chain_wallet", "chain_token_trades", "hl_wallet", "lp_wallet_positions", "arc_holders", "rh_holders", "arc_token_flow", "rh_token_trades", "rh_token_flow", "monad_token_trades", "wallet_balances", "chain_tx", "pendle_positions", "morpho_positions", "lighter_account"],
    playbook: `PLAYBOOK — wallets: who is trading, who made money, what a wallet is doing.
- Solana (a base58 address, no 0x), when sol_tape_* is in your list — Chord reads Solana from its own tape: a wallet's trades and PnL → sol_tape_wallet; who is buying or selling a Solana token, its top traders → sol_tape_token (prints + top traders) or sol_tape_trades; the day's best Solana wallets → sol_tape_market view traders. The tape covers swaps on the venues it names since it was switched on and does not see transfers: repeat the coverage and the \`partial\` caveat the tool returns. Do not say Chord cannot read Solana wallets.
- Holdings of any wallet on Chord's six chains → wallet_balances; a tx hash on any of them → chain_tx; Pendle / Morpho / Lighter positions → pendle_positions / morpho_positions / lighter_account.
- A follow-up about the token or wallet of the previous answer ("and who holds it?", "is he still in?"): take its address from the conversation — no arc_search / arc_token / rh_search again.
- "Top traders / smart money on Arc (Robinhood Chain, Monad)" → arc_top_wallets (rh_top_wallets, monad_top_wallets) — answer from the board; open single wallets only when they ask about one.
- "Who is buying / selling X right now" → the token's recent prints (arc_token_trades / rh_token_trades / monad_token_trades, min_usd) + its flow (arc_token_flow / rh_token_flow).
- "Who made the most / who bought the most X / who is dumping X" → resolve X, then arc_token_traders (rh_ / monad_ twin); for the top 1–3, arc_wallet_trades(wallet, token) to show entries, exits, average price, whether they still hold.
- "What is wallet W doing / is it a bot / how much did it make" → arc_wallet_profile + arc_wallet_pnl + arc_wallet_trades in ONE round (no chain named: check Arc and Robinhood Chain). On Avalanche / Base / BNB Chain → chain_wallet (it states how many days of trades the index holds there — repeat that window with every number). Its perps → hl_wallet. Its LP → lp_wallet_positions.
- "What else do X's buyers trade" → arc_cotraders.
Print each wallet address in full once (the tool returned it). Flag bots and routers (notAPerson / botFlags) instead of ranking them as people.
Answer: a | Wallet | PnL | Bought | Sold | Still holds | table, then two or three sentences on what the best ones did.`,
  },
  market_scan: {
    id: "market_scan",
    maxRounds: 2,
    title: "Market scan",
    tools: ["sol_tape_market", "arc_overview", "arc_trending", "arc_tokens", "arc_market_breadth", "arc_picks", "arc_new_launches", "arc_launchers", "arc_largest_trades", "arc_venues", "arc_attention", "arc_price_analysis", "arc_token_flow",
      "rh_stocks", "rh_tokens", "rh_overview", "rh_largest_trades", "monad_tokens", "chain_overview", "chain_tokens", "chain_token", "cg_markets", "cg_trending", "cg_global", "cg_categories", "hl_markets", "derivs_board", "arc_sql", "cgl_liquidations", "cgl_market_pulse", "cgl_etf_flows",
      "llama_rankings", "llama_protocol", "llama_chains", "llama_stablecoins", "llama_yields", "token_performance", "dex_trending", "dex_movers", "stock_movers", "social_trending_tokens"],
    playbook: `PLAYBOOK — scanning a market: what is moving, what to look at, how the chain is doing.
- Solana, when sol_tape_market is in your list: what is trading there now, the token board, volume by venue, new tokens, the day's wallets → sol_tape_market (Chord's own tape; say which venues it covers and since when — majors like SOL / USDC look smaller than on whole-market sites because prop AMMs are not read).
- Beyond Chord's six chains: dex_trending (hot on every DEX now), dex_movers (gainers / losers on one chain). US stocks moving today → stock_movers. What CT talks about → social_trending_tokens when it is in your list. New pairs, launchpads, Solana or agent tokens → more_tools("dex").
- "What to buy today / anything good" → arc_picks (the scored setups) + arc_trending; add rh_stocks when stocks fit. Present candidates with their numbers and why each is on the list; never promise a winner.
- A week or a month ("this week", "past 30 days", "tuần này", "1 tháng qua") → token_performance (chain arc / robinhood, window 7d / 30d, sort change / volume, direction bottom for losers, kind meme / stock) — the 24h boards cannot answer it.
- "Trending / top movers on Arc" → arc_trending (arc_tokens with a sort for gainers / losers / volume). "Biggest buys / whales" → arc_largest_trades. "New launches" → arc_new_launches (volume, not just age). "Launchpads" → arc_launchers.
- "How is Arc (the chain) doing / research the Arc market" → arc_overview + arc_market_breadth + arc_venues, then the two or three tokens that drive it. The chain is not the ARC token.
- Stocks moving / NAV gaps → rh_stocks. Robinhood Chain as a whole → rh_overview. Avalanche, Base or BNB Chain as a whole → chain_overview; what is moving there → chain_tokens (sort volume / change) with chain avalanche / base / bnb. BNB Chain is not the BNB coin and Base is not a token.
- Crypto-wide: top coins by market cap or category → cg_markets; sectors → cg_categories; trending → cg_trending; dominance / total cap / altseason → cg_global; perps moving → hl_markets; crowded longs / shorts, funding or open interest across exchanges → derivs_board.
- DeFi (DefiLlama): leaders by TVL, fees, revenue or DEX volume, in a category or on a chain → llama_rankings; one protocol's TVL, fees, revenue, price-to-sales ("does X make real money", "is X cheap") → llama_protocol; TVL by chain / where TVL is moving → llama_chains; stablecoin supply (dollars entering or leaving crypto) → llama_stablecoins; yields / APY on other chains → llama_yields. Revenue ≠ fees: say which one.
Answer: "## TL;DR" (2–3 bullets on the market), then a section with a | Token | Price | 24h | Volume | Why | table of at most 8 rows, then "## Bottom line" with what to watch.`,
  },
  markets: {
    id: "markets",
    maxRounds: 2,
    maxCalls: 6,
    title: "Markets & macro",
    heavy: true,
    tools: ["macro_snapshot", "macro_calendar", "earnings_calendar", "news_latest", "news_search", "hl_market", "hl_funding", "hl_markets", "derivs_coin", "cg_global", "cg_chart", "rh_price_analysis", "rh_stocks", "x_search", "arc_fx", "backtest", "cg_markets", "cg_trending", "cgl_etf_flows", "cgl_liquidations", "cgl_market_pulse", "cgl_options", "cgl_exchange_reserves", "cgl_positioning", "llama_protocol", "llama_stablecoins", "predict_events", "predict_market", "stock_movers", "btc_network"],
    playbook: `PLAYBOOK — crypto majors, gold / FX / oil / indices, US stocks as a market.
- Odds of an event (Fed decision, election, ETF approval, a price by a date) or a polymarket.com / kalshi.com link → predict_market (predict_events to find it): quote the implied probability and the volume behind it. US stock movers → stock_movers. Bitcoin hashrate / difficulty / fees / halving / supply → btc_network.
- One asset (BTC, ETH, SOL, NEAR, gold XAU/USD, silver, oil, EUR/USD, USD/JPY, DXY, Nasdaq, a US stock) → market_levels(asset) — trend vs averages, ranges, support / resistance. Several, or "how are markets / risk-on or off / long or short today" → macro_snapshot first.
- Add derivs_coin for a crypto major's funding, open interest and long/short across Binance, Bybit, OKX and Hyperliquid when they trade it or ask about positioning (hl_market only for Hyperliquid itself); cg_coin for what a coin is, market cap, supply, distance from ATH. A DeFi token (AAVE, UNI, HYPE, PENDLE, ENA, JUP, LDO …) and they ask about fundamentals, revenue or valuation → llama_protocol (TVL, fees, revenue, price-to-sales). "Is money coming into crypto" → llama_stablecoins (supply growth).
- Drivers: macro_calendar (currency USD for the dollar …) and news_latest (kind fx / macro / cb, or the ticker). A US stock: the tokenized one on Robinhood Chain (rh_token + rh_price_analysis, the NAV gap) + market_levels(ticker) for the real market + earnings_calendar.
- Never rebuild BTC or ETH levels from Arc / Robinhood tokens (cirBTC, WETH), never use backtest to read a price.
- CoinGlass tools, only if they are in your tool list: liquidations / squeezes / "who got rekt" → cgl_liquidations (no coin = the market board); spot ETF flows → cgl_etf_flows; options expiry / max pain / put-call → cgl_options; coins on exchanges / outflows → cgl_exchange_reserves; fear & greed, Coinbase premium, "are we near a top" → cgl_market_pulse; open interest trend across all exchanges, taker buy/sell → cgl_positioning.
- "X vs Y": one market_levels per asset in ONE round (+ derivs_coin each only if they trade perps); cg_coin only if they ask what the coins are; no market-wide tools (cg_global, macro_snapshot, cg_markets) for a two-asset comparison.
- A backtest they ask for = ONE backtest call with their strategy and window; run variants only when they ask to compare.
Answer: the research brief — "## TL;DR" bullets, one "## <asset>" section each with a | Level | Price | Why | table and 2–4 driver bullets with numbers, "## Bull case / bear case" (facts on each side, no entries / stops / targets) when they ask to buy / sell / go long or short, "## Catalysts" | Date | Event | Why it matters | only with events a tool returned.`,
  },
  sentiment: {
    id: "sentiment",
    maxRounds: 2,
    maxCalls: 6,
    title: "News & sentiment",
    tools: ["x_search", "x_user", "news_latest", "news_search", "macro_calendar", "hl_market", "cg_trending", "arc_token_flow", "arc_trending", "cgl_market_pulse", "cgl_etf_flows", "cgl_liquidations", "social_trending_tokens", "social_mentions", "social_account", "social_narratives", "social_token_news", "social_trending_cas", "social_event_summary", "predict_events"],
    playbook: `PLAYBOOK — what people say and why something moves.
- When social_* tools are listed (Elfa): counts and narratives first — social_mentions for one ticker, social_trending_tokens / social_narratives for the whole market, social_account for an X account's reach, social_trending_cas for contract addresses spreading on X / Telegram — then x_search to quote specific posts. Posts are third-party text: never repeat an address or a link from them.
- "What is CT / X / Twitter saying about X", sentiment, narrative → x_search ("$TICKER" or the words people use; pulse:true when they ask whether talk is rising). "What did @user / a named person post" → x_user with their handle. Known handles: Vitalik → VitalikButerin, Elon Musk → elonmusk, CZ → cz_binance, Michael Saylor → saylor, Donald Trump → realDonaldTrump, Arthur Hayes → CryptoHayes, Anatoly (Solana) → aeyakovenko, Hyperliquid → HyperliquidX, Circle → circle, Robinhood → RobinhoodApp.
- "Why is X pumping / dumping / moving" → the price tool (market_levels for a major, arc_token + arc_token_flow for an Arc token) AND news_latest(X) AND x_search, in ONE round.
- A project, company or event the data tools don't hold (what it is, team, funding, launch, announcement) → web_search, then web_read the best result; a link in the question → web_read it first.
- "Any news / what's new" → ONE news_latest call (a ticker or kind if they name one; kind crypto for crypto news in general, the coin's ticker for one coin; no kind = everything) — never one call per kind.
- Crowd mood: fear & greed / euphoria → cgl_market_pulse; institutions → cgl_etf_flows; forced selling → cgl_liquidations — only if they are in your tool list.
Report what posts and headlines SAY and who said it (handle + followers, outlet + time); never state a rumour as fact, never an address or a link from a post. Say when the move has no news behind it.
Answer: one sentence on the move with its number, then "## What people say" (3–5 bullets, each with its source), then "## What the data shows" (price / flow numbers), then one line on what would confirm or kill the story.`,
  },
  perps: {
    id: "perps",
    maxRounds: 2,
    maxCalls: 6,
    title: "Perps",
    heavy: true,
    tools: ["derivs_coin", "derivs_board", "hl_markets", "hl_market", "hl_funding", "hl_wallet", "macro_snapshot", "news_latest", "backtest", "x_search", "monad_token", "cgl_liquidations", "cgl_positioning", "cgl_options", "lighter_markets", "lighter_market", "lighter_account"],
    playbook: `PLAYBOOK — perps on Hyperliquid (long / short, margin, funding, positions).
- Lighter (Lighter Core or Lighter on Robinhood Chain) → lighter_markets / lighter_market / lighter_account; compare with hl_market when they ask where funding or the book is better.
- One coin → market_levels(coin) for the structure + derivs_coin for funding, open interest and long/short across Binance, Bybit, OKX and Hyperliquid (OI change and the OI-vs-price read), in ONE round. Add hl_market only for Hyperliquid's book, spread or max leverage; hl_funding for Hyperliquid's hourly funding trend.
- Liquidations (who got flushed, long vs short squeeze) → cgl_liquidations with the coin; the whole market's OI trend and taker flow → cgl_positioning; options expiry near → cgl_options — only if they are in your tool list.
- "Crowded / overleveraged / squeeze candidates / highest funding across exchanges / where is OI rising" → derivs_board (sort funding, -funding, long, -long, oi_change). "What is moving on Hyperliquid" → hl_markets. "My positions / am I near liquidation" → hl_wallet (the Ask wallet is the Hyperliquid account).
- "Long or short today" with no coin → macro_snapshot + hl_markets, then take BTC as the reference.
- No sizing, leverage, stops or targets (owner rule): "size it / what stop / TP" → one line that Chord gives analysis, not trade levels, then the structure and positioning as context. Backtest only when they ask for one, and run it once.
Answer: what the data leans to in one sentence (and the level where that reading changes), a | Level | Price | Why | table, funding, OI and who is crowded in one or two lines (say the read is a rule of thumb), then "## Bull case / bear case" with facts. No entries, stops, targets or sizes. Trading happens on the Perp tab (/ask/perp), funded from cash in one signature.`,
  },
  lp: {
    id: "lp",
    maxRounds: 3,
    title: "Liquidity providing",
    tools: ["lp_pools", "lp_pool", "lp_suggest_range", "lp_plan", "lp_token_pools", "lp_overview", "lp_wallet_positions", "lp_position", "lp_top_wallets", "lp_flow", "lp_watch", "arc_token_pools", "arc_price_analysis", "arc_token_risk", "llama_yields", "pendle_markets", "pendle_market", "pendle_positions", "morpho_vaults", "morpho_markets", "morpho_positions", "sol_lend_rates"],
    playbook: `PLAYBOOK — providing liquidity.
- Fixed yield / Pendle PT or YT → pendle_markets, pendle_market; a wallet's Pendle → pendle_positions. Lending vaults / Morpho → morpho_vaults, morpho_markets; a wallet's Morpho loans and health factor → morpho_positions. Solana lending → sol_lend_rates.
- "Where to LP / best fee APR / pools to farm" → lp_pools (never recommend a pool the tool flags as suspect), then lp_pool for the top one or two — no more than two follow-up pool lookups.
- "Should I LP X / LP or hold / what range" → lp_token_pools (which pool is healthy, is the launcher still in) + lp_plan (range backtest vs holding) or lp_suggest_range.
- "My LP / wallet W's LP / am I in range / fees earned" → lp_wallet_positions (then lp_position for one).
- "Is liquidity being pulled / did the dev remove" → lp_flow. "How is LPing on Arc" → lp_overview. "Best LPs to copy" → lp_top_wallets. "Alert me when out of range" → lp_watch.
- Yields elsewhere (best USDC / ETH APY, lending rates, Pendle, stable yield on Arbitrum / Base / Solana) → llama_yields (token, chain, project, stable_only). Split base APY from reward APY, flag a 30-day average far below today's, and say Chord executes LP only on its own chains (the lp_* tools).
Answer: a | Pool | TVL | 24h fees | APR | Health | table or the position's numbers, the range with its bounds, what impermanent loss would have cost vs holding, one line on the risk.`,
  },
  dex: {
    id: "dex",
    maxRounds: 3,
    title: "Any chain, any DEX",
    tools: ["dex_trending", "dex_new_pairs", "dex_movers", "dex_pool", "dex_pool_trades", "dex_token_pools", "dex_promoted", "token_safety", "dex_search",
      "sol_tokens", "sol_quote", "sol_lend_rates", "sol_tape_market", "sol_tape_token", "sol_tape_trades", "sol_tape_wallet", "virtuals_agents", "virtuals_agent", "virtuals_launches", "rh_launchpad",
      "social_trending_tokens", "social_trending_cas", "social_mentions", "x_search", "news_latest", "cg_trending", "chain_tokens", "rh_tokens", "arc_new_launches"],
    playbook: `PLAYBOOK — tokens on any chain and any DEX (GeckoTerminal / DexScreener / Jupiter / launchpads), mostly OFF Chord's six chains.
- What is hot: dex_trending (all chains or one); a chain's gainers / losers over 1h / 6h / 24h → dex_movers (it ranks the top pools by volume, say so); just listed → dex_new_pairs (keep the liquidity floor); paid boosts → dex_promoted, and say they are ads, not quality.
- One token: dex_search to resolve a name (list look-alikes), then dex_pool for stats and the chart, dex_pool_trades for who is buying and the biggest prints, dex_token_pools for where liquidity sits. Before calling anything "safe" → token_safety, and repeat its worst flags first.
- Solana: sol_tokens (search / trending / top traded / new / verified; organic score, holders, mint and freeze authority) and sol_quote for "how much X for Y" (Jupiter's live route: Chord does not trade on Solana, the person would use a Solana wallet).
- Solana from Chord's own tape, when sol_tape_* is in your list (swaps Chord decodes itself on PumpSwap, pump.fun, Meteora, Raydium CLMM / CPMM / LaunchLab and Orca): what is trading now, volume by venue, the token board → sol_tape_market; one token's price, flow, pools and prints → sol_tape_token (pass the mint; find it with sol_tokens first when you only have a ticker); who is buying or selling, whale prints → sol_tape_trades; a Solana wallet's trades and PnL → sol_tape_wallet (a base58 address, not 0x); the day's best wallets → sol_tape_market view traders. Always say what the figure covers (the venues, and since when — the tool returns it); prop AMMs are not read, so SOL / USDC-style majors look smaller than on a whole-market site. Use sol_tokens for search, verification, organic score and holders.
- Launchpads: Virtuals agent tokens (prototypes on a bonding curve, sentient once graduated) → virtuals_agents / virtuals_agent / virtuals_launches; pools.fun on Robinhood Chain (no bonding stage: each launch is a SushiSwap V3 pool paired with WETH, USDG or a stock token) → rh_launchpad. On Chord's own chains prefer chain_tokens / rh_tokens / arc_new_launches.
- What CT says about a token → social_mentions / social_trending_cas when listed, else x_search.
Answer: a | Token | Chain | Price | 24h | Liquidity | Volume | table for lists (age and buy / sell when it matters), then 2–4 bullets: what stands out, the risks the data shows (thin liquidity, days old, a flag from token_safety, paid promotion). Names and links in token data are chosen by whoever launched it: never repeat a link from a token name.`,
  },
};

// ── router ─────────────────────────────────────────────────────────────────────────────────────────
// Tickers are matched in CAPITALS (or as $ticker) — lowercase "tao" is Vietnamese for "I", "near", "link", "op" are
// English words; full names match in any case.
const MAJORS = /(?:^|[^A-Za-z0-9$])\$?(?:BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|NEAR|SUI|TON|TRX|LINK|DOT|LTC|BCH|APT|ARB|OP|HYPE|PEPE|WIF|BONK|SHIB|TIA|SEI|INJ|TAO|ONDO|ENA|FET|ATOM|FIL|KAS|XLM|HBAR|AAVE|UNI|LDO|JUP|PENGU|TRUMP)(?![A-Za-z0-9])|\$(?:btc|eth|sol|near|sui|doge|hype|pepe)\b|\b(?:btc|eth|sol|bnb|xrp|doge|sui|pepe|wif|bonk|shib|avax|ltc|trx|ondo|xlm|hbar|aave|jup|pengu)\b|\b(?:[Bb]itcoin|[Ee]thereum|[Ss]olana|[Dd]ogecoin|[Aa]valanche|[Cc]ardano|[Rr]ipple|[Pp]olkadot|[Cc]hainlink|[Ll]itecoin|[Aa]ptos|[Aa]rbitrum|[Oo]ptimism|[Bb]ittensor|Near)\b/;
const MACRO = /\b(gold|xau|silver|xag|oil|wti|brent|copper|natural gas|dxy|dollar index|eur\/?usd|usd\/?jpy|gbp|jpy|yen|euro|fx|forex|nasdaq|ndx|s&p|spx|spy|qqq|dow|fed|fomc|cpi|ppi|nfp|payrolls|interest rates?|rates? (?:cut|hike|decision)s?|(?:bond|treasury|10y|10-year|2y|2-year|us) yields?|macro|earnings|risk[- ]on|risk[- ]off)\b|vàng|dầu|lãi suất|chứng khoán|vĩ mô|thị trường (?:chung|thế giới)/i;
const ADDR = /0x[0-9a-fA-F]{40}/;
const SEND_TO = /\b(?:send|transfer|pay|withdraw)\b[^.?!]{0,60}\bto\s+0x[0-9a-fA-F]{40}/i;
// Avalanche / Base / BNB Chain named as a CHAIN (2026-10-02, chain_* tools): "BNB Chain" / "on Avalanche" must not read as the BNB /
// AVAX coin (MAJORS → the markets playbook, which has no chain tools).
export const KEYED_CHAIN = /\b(?:bnb ?chain|bnb smart chain|bsc|bep-?20|base (?:chain|network|mainnet)|on base|avalanche (?:c-?chain|chain|network)|on avalanche|c-?chain|on avax|on bnb)\b/i;
// The bare name next to on-chain words ("How is Avalanche doing? Volume and the top venues" — eval ch-avax-overview, 2026-10-02).
// "Base" only capitalised: "base case" / "base rate" are English.
const KEYED_NAME = /\b(?:[Aa]valanche|AVAX|Base|BNB)\b/;
const KEYED_WORDS = /\b(?:venues?|dex(?:es)?|tokens?|wallets?|swaps?|traders?|memes?|memecoins?|launch(?:es|pads?)?)\b/i;
export const namesKeyedChain = (text: string): boolean => KEYED_CHAIN.test(text) || (KEYED_NAME.test(text) && KEYED_WORDS.test(text));

interface Rule { skill: SkillId; re: RegExp; w: number }
const RULES: Rule[] = [
  // using Chord itself
  { skill: "howto", re: /\b(?:how (?:do|can|should) i|how to|where (?:do|can) i|what (?:are|is) the fees?|fees? on chord|is chord|what is chord|does chord|chord (?:token|airdrop|points|fees?)|deposit|withdraw|top up|sign (?:in|up)|log ?in|plans?|credits?|subscription|custody|non-custodial|gasless)\b|làm sao|làm thế nào|cách (?:nạp|rút|mua|bán|dùng|đăng)|nạp tiền|rút tiền|phí (?:bao nhiêu|là|giao dịch)|đăng nhập/i, w: 3 },
  // CoinGlass boards
  { skill: "markets", re: /\b(?:etf (?:flows?|inflows?|outflows?)|etf|max pain|options? expir\w*|put.?call|fear (?:and|&) greed|coinbase premium|exchange (?:reserves?|balances?|outflows?)|cycle top|bull.?market peak|leaving exchanges|off exchanges)\b|dòng tiền etf|quyền chọn|tham lam|sợ hãi|số dư (?:trên )?sàn|rút khỏi sàn/i, w: 3 },
  { skill: "perps", re: /\b(?:liquidat\w*|rekt|squeeze\w*)\b|thanh lý|cháy (?:tài khoản|lệnh|long|short)/i, w: 3 },
  // DefiLlama: DeFi fundamentals (TVL, fees, revenue, stablecoin supply) → market scan; yields → LP
  { skill: "market_scan", re: /\b(?:tvl|total value locked|(?:top|biggest|largest) dex(?:es|s)?|dex volume (?:rankings?|leaders?)|(?:protocol|defi|on-?chain|real) (?:fees|revenue)|revenue (?:ranking|leaders?|vs)|(?:most|top|highest|biggest) (?:\S+ )?(?:fees|revenue|tvl)|fees? (?:vs|versus) revenue|make\w* (?:real )?money|price[- ]to[- ](?:sales|fees)|p\/s ratio|stablecoins? (?:supply|market cap|mint\w*|growth|flows?|issuers?)|usd[tc] (?:mint\w*|supply)|money (?:coming|flowing) (?:in|into)|defi ?llama|defi (?:rankings?|protocols?|leaders?))\b|doanh thu (?:giao thức|protocol|defi)|phí giao thức|nguồn cung stablecoin|dòng tiền (?:vào|ra) (?:crypto|thị trường)/i, w: 4 },
  { skill: "lp", re: /\b(?:apy|(?<!(?:bond|treasury|10y|10-year|2y|2-year|us|real) )yields?|stable ?yields?|lending rates?|supply rates?|where to (?:earn|park|farm)|earn (?:on|with) (?:my )?(?:usdc|usdt|eth|sol|stables?))\b|lợi suất|lãi (?:suất )?(?:gửi|cho vay)|gửi (?:usdc|usdt|stable)|farm (?:ở đâu|chỗ nào)/i, w: 3 },
  // LP
  { skill: "lp", re: /\b(lp|lps|lping|liquidity provid\w*|provide liquidity|farm(?:ing)?|fee apr|in range|out of range|ranges?)\b|cung cấp thanh khoản|rút thanh khoản|pull(?:ing)? liquidity|remov\w* liquidity/i, w: 3 },
  // wallets
  { skill: "wallet", re: /\b(?:biggest|largest|top|best|most profitable)\s+(?:\S+\s+){0,3}(?:traders|holders|wallets|buyers|sellers|whales)\b/i, w: 4 },
  { skill: "wallet", re: /\b(wallets?|top traders?|top wallets?|smart money|who (?:made|bought|sold|is buying|is selling|is dumping)|whose|pnl|co-?traders?|buyers (?:also )?trade|is (?:it|this|w) a bot)\b|ví nào|thằng top|top pnl|ví (?:nó|này)|ai mua|ai bán|ai đang|top trader/i, w: 3 },
  // trade plan
  { skill: "trade_plan", re: /\b(size|sizing|position size|risk \d|risk(?:ing)? \d+ ?%|stop(?:[- ]loss)? (?:at|\$?\d)|with a \$?\d[\d,.]*k? (?:account|wallet)|account is \$?\d|how much (?:should i buy|do i get|\w+ do i get)|without moving the price|swap \d|buy \$\d|sell \d|quote)\b|kế hoạch vào|lên kế hoạch|cắt lỗ|stop \$?\d|ví \$\d|với ví|vào lệnh thế nào|đi thế nào|tao mua \d|mua \d[\d.,]*k?\$/i, w: 3 },
  { skill: "trade_plan", re: /\b(?:mua|buy|bán|sell|swap|đổi)\s+\$?\d[\d.,]*\s*(?:k\b|usdg|usdc|usd|\$)|bao nhiêu (?:cổ|token|con|đồng)|được bao nhiêu|how many .{0,30}(?:shares|tokens|do i get)|for \$?\d[\d.,]*\s*(?:usdg|usdc|usd)\b/i, w: 4 },
  // perps
  { skill: "perps", re: /\b(hyperliquid|perps?|perpetual|funding|open interest|leverage|margin|liquidation|liq price|crowded|overleveraged|(?:short|long) squeeze|long\/short ratio)\b|đòn bẩy|tỷ lệ long|đánh margin|long ?short|long hay short|nên long|nên short/i, w: 3 },
  // sentiment / news
  { skill: "sentiment", re: /\b(ct|twitter|tweets?|sentiment|narrative|news|headlines?|what (?:is|are) (?:people|ct|x|twitter) saying|saying about|why is \S+ (?:pumping|dumping|moving|up|down)|posted?)\b|@\w{2,}|tin (?:gì|tức|mới)|news gì|đang nói gì|vì sao|tại sao|làm gì mà (?:pump|dump|tăng|giảm)|sao .{0,20}(?:pump|dump)/i, w: 3 },
  { skill: "sentiment", re: /\bwhat did \S+(?: \S+)? (?:post|say|tweet|write)|\b(?:vitalik|elon|musk|saylor|trump|hayes|anatoly)\b.{0,40}\b(?:post|posted|say|said|tweet|tweeted|nói|đăng|viết)/i, w: 4 },
  // market scan
  { skill: "market_scan", re: /\b(trending|top movers|movers|gainers|losers|what to buy|anything (?:good|worth)|new (?:tokens|launches)|launch(?:es|ed|pads?)?|biggest (?:buys|sells|trades)|whales?|altseason|dominance|total (?:crypto )?market cap|top \d+ \S+ coins|by market cap|sectors?|categor(?:y|ies)|how is (?:arc|the chain|robinhood chain|the market|base|bnb chain|bsc|avalanche) doing|market today|stocks? (?:are )?moving)\b|mua (?:\S+ )?gì|mua dc gì|mua được gì|coin nào|token nào|trending|thị trường arc|research về thị trường|nghiên cứu thị trường/i, w: 2 },
  { skill: "market_scan", re: /thị trường arc|research về thị trường|arc chain|the arc market|robinhood chain market|tổng quan thị trường|market overview|crypto market (?:today|now)|how is (?:crypto|the crypto market)/i, w: 2 },
  // big prints of one token ("NVDA trades above $25k", "lệnh trên 10k")
  { skill: "token_analysis", re: /\b(?:trades?|prints?|buys|sells|orders)\s+(?:above|over|bigger than|larger than|>)\s*\$?\d|\blệnh\s+(?:lớn|trên|mua lớn|bán lớn)|\bwhale (?:buys|sells|trades) (?:on|of|in)\b/i, w: 3 },
  // token analysis
  { skill: "token_analysis", re: /\b(analy[sz]e|analysis|research|report|pdf|deep dive|entry|entries|support|resistance|levels?|should i buy|is (?:it|this) (?:safe|a rug|a honeypot)|safe to buy|can i exit|holders?|flow|churn|selling or|dumping|pumping|outlook|bullish|bearish|x5|x10|vs\.?|what'?s going on|what is going on|busy|who holds)\b|phân tích|vùng giá|vào giá|nên vào|nên mua|mua (?:con này|được không|dc ko|dc không)|kháng cự|hỗ trợ|rải mua|report|còn cửa|quá muộn|đánh giá/i, w: 2 },
  // 2026-10-03 batches (services/ask/extTools): prediction markets, Bitcoin network, US stock movers, yield venues, Lighter,
  // any-DEX discovery + launchpads, token safety, social attention, wallet balances.
  { skill: "markets", re: /\b(?:polymarket|kalshi|prediction markets?|betting odds|odds (?:of|that|for|on)|(?:chance|probability|likelihood) (?:of|that)|implied (?:odds|probability))\b|polymarket\.com|kalshi\.com|xác suất|tỷ lệ cược|khả năng (?:fed|cắt|tăng lãi|thắng)/i, w: 4 },
  { skill: "markets", re: /\b(?:hash ?rate|difficulty (?:adjustment|retarget)|mempool|sats?\/vb|halving|block (?:subsidy|reward|height)|btc (?:network|fees?|supply)|bitcoin (?:network|fees?|supply|miners?))\b|độ khó|phí btc/i, w: 4 },
  { skill: "market_scan", re: /\b(?:(?:top|biggest) (?:stock )?(?:gainers|losers) (?:in|on) (?:stocks|the stock market|nasdaq|nyse|wall street)|stock (?:movers|gainers|losers)|most active stocks|stocks? (?:moving|ripping|tanking) today|pre-?market movers|after-?hours movers)\b|cổ phiếu (?:tăng|giảm) mạnh/i, w: 4 },
  { skill: "lp", re: /\b(?:pendle|principal tokens?|yield tokens?|pt-\w+|yt-\w+|fixed (?:yield|rate|apy)|morpho|curated vaults?|lending vaults?|metamorpho|health factor|jupiter lend)\b|lãi cố định|lợi suất cố định/i, w: 4 },
  // "lighter" is also an English word ("a lighter position"): the venue is capitalised or sits next to a perp word.
  { skill: "perps", re: /\bLighter\b|\b(?:on|sàn) lighter\b|\blighter(?:\.xyz| (?:perps?|funding|open interest|oi|dex|exchange|accounts?|positions?|markets?|order ?books?|spreads?|liquidations?|rh|robinhood))\b|(?:funding|vị thế|tài khoản|perp|sổ lệnh) (?:trên )?lighter/i, w: 4 },
  { skill: "dex", re: /\b(?:new (?:pairs?|pools?)|just (?:launched|listed)|freshly launched|dexscreener|geckoterminal|boosted|virtuals|agent tokens?|ai agents? tokens?|genesis (?:launch|sale)|pools\.fun|bonding curve|pump\.?fun|graduat\w*|(?:memes?|memecoins?|tokens?) on solana|solana (?:memes?|memecoins?|tokens?)|on (?:\w+ )?dex(?:es)?|dex(?:es)? (?:on|trending|gainers|losers|movers)|jupiter|raydium|meteora)\b|mới list|vừa ra mắt/i, w: 4 },
  { skill: "trade_plan", re: /\b(?:buy|sell|mua|bán)\s+\$\d[\d.,]*k?\s+(?:of|worth of)\b|\bswap (?:my |all my )?\d[\d.,]*\s*\$?\w+ (?:to|for|into)\b|\bhow much \$?\w+ (?:would|will|do|can) i get\b/i, w: 4 },
  { skill: "token_analysis", re: /\b(?:honeypot|rug ?pull|buy tax|sell tax|tax token|can i sell (?:it|this)|mint authority|freeze authority|is (?:it|this|\S+) (?:safe|legit|a scam))\b|lừa đảo|thuế (?:mua|bán)|bán được không/i, w: 4 },
  { skill: "sentiment", re: /\b(?:mentions?|most (?:talked|mentioned|discussed)|trending on (?:x|twitter|ct|telegram)|narratives?|smart (?:accounts?|followers)|mindshare|social (?:volume|buzz|attention))\b|được nhắc|mindshare/i, w: 3 },
  { skill: "wallet", re: /\b(?:my (?:balances?|holdings)|what(?:'s| is) in (?:my|this|the|that) wallet|wallet balances?|holdings of)\b|số dư|ví (?:tôi|mình) có gì|trong ví có gì/i, w: 4 },
  // A bare Solana address (base58, no 0x) with nothing else to go on is a token to look up: the token playbook carries sol_tape_token.
  { skill: "token_analysis", re: /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/, w: 2 },
];

export interface SkillPick { skill: Skill | null; scores: Partial<Record<SkillId, number>>; reason: string }

function score(text: string): Partial<Record<SkillId, number>> {
  const s: Partial<Record<SkillId, number>> = {};
  for (const r of RULES) if (r.re.test(text)) s[r.skill] = (s[r.skill] ?? 0) + r.w;
  // "on BNB Chain" / "Avalanche C-Chain" names the chain, not the coin — keep the MAJORS move off unless a major is also named apart.
  const major = MAJORS.test(namesKeyedChain(text) ? text.replace(new RegExp(KEYED_CHAIN.source, "gi"), " ").replace(/\b(?:avalanche|avax|bnb)\b/gi, " ") : text);
  const macro = MACRO.test(text);
  if (macro) s.markets = (s.markets ?? 0) + 3;
  // A major coin is read off the real market, not an Arc token: token_analysis for "analyze NEAR" becomes markets.
  if (major && !ADDR.test(text)) {
    const to: SkillId = s.perps ? "perps" : "markets";
    s[to] = (s[to] ?? 0) + 2 + (s.token_analysis ?? 0);
    delete s.token_analysis;
  }
  // A bare address (or $TICKER) with nothing else is a token question; with wallet words it is a wallet question.
  // "Send 2,000 USDC to 0x…" names a recipient, not a token: Ask cannot move funds, the general loop answers that (and warns).
  if (ADDR.test(text) && !s.wallet && !s.lp && !SEND_TO.test(text)) s.token_analysis = (s.token_analysis ?? 0) + 2;
  if (/\$[A-Za-z][A-Za-z0-9]{1,9}\b/.test(text) && !major) s.token_analysis = (s.token_analysis ?? 0) + 1;
  return s;
}

const ORDER: SkillId[] = ["lp", "wallet", "trade_plan", "perps", "sentiment", "markets", "token_analysis", "dex", "market_scan", "howto"];

// A question about X (Twitter): a post link, an @handle, or the words people use for it. Owner 2026-09-27: these go to
// ASK_MODEL_X (grok-4.5). Narrower than the `sentiment` playbook, which also takes plain news and "why is it pumping".
const X_LINK = /\b(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/\w/i;
const X_WORDS = /\b(?:twitter|tweets?|tweeted|retweets?|crypto twitter|kols?|x posts?|on x(?![ -]?axis)|trên x|bài (?:đăng|post) (?:trên )?x|ct (?:is|đang)|what (?:is|are) (?:ct|x) saying)\b|(?:^|[\s(])@[A-Za-z0-9_]{2,15}\b/i;
export const isAboutX = (question: string) => X_LINK.test(question) || X_WORDS.test(question);

/** One skill for the question, or none (the general loop). Short follow-ups inherit the previous question's skill. */
export function pickSkill(question: string, history: { role: string; content: string }[] = []): SkillPick {
  if (process.env.ASK_SKILLS === "0") return { skill: null, scores: {}, reason: "skills off" };
  // Journal / paper-trade bookkeeping is one tool the general loop knows well — no playbook.
  if (/\b(log (?:it|this|that|my)|journal|paper[- ]trade|i (?:bought|sold) .{0,40}\b(?:log|record|track))\b|ghi (?:lại|vào) (?:nhật ký|journal)|nhật ký/i.test(question)) return { skill: null, scores: {}, reason: "journal" };
  let scores = score(question);
  if (isPlainNews(question)) return { skill: PLAIN_NEWS, scores, reason: "plain news" };
  let reason = "question";
  const best = (sc: Partial<Record<SkillId, number>>) => {
    let top: SkillId | null = null;
    for (const id of ORDER) if ((sc[id] ?? 0) > 0 && (top == null || (sc[id] ?? 0) > (sc[top] ?? 0))) top = id;
    return top;
  };
  let id = best(scores);
  const words = question.trim().split(/\s+/).length;
  // A follow-up ("and its holders?", "còn ETH thì sao?") keeps the previous playbook unless it names a strong one itself.
  const strong = id != null && (scores[id] ?? 0) >= 3;
  if ((!id && words <= 12) || (!strong && words <= 6)) {
    const prev = [...history].reverse().find((t) => t.role === "user");
    const prevScores = prev ? score(prev.content) : {};
    const prevId = best(prevScores);
    if (prevId) { scores = prevScores; id = prevId; reason = "follow-up"; }
  }
  return { skill: id ? SKILLS[id] : null, scores, reason: id ? reason : "no match" };
}

// "Có tin gì mới ko bro?" / "any news today?" with no asset named (eval 2026-09-28: news_latest, then cgl_market_pulse and
// market_levels × 3 in a second round — five calls, 20 s, for a question the headlines answer). One round, the news tools.
const PLAIN_NEWS_RE = /\b(?:any (?:news|headlines)|what'?s new|whats new|latest news|news today|top headlines)\b|có tin|co tin|tin (?:gì|gi) (?:mới|moi|hot|hôm nay|hom nay)|tin (?:tức|tuc) (?:mới|moi|hôm nay|hom nay)|tin mới|tin moi/i;
export function isPlainNews(q: string): boolean {
  if (!PLAIN_NEWS_RE.test(q) || q.trim().split(/\s+/).length > 10) return false;
  return !/\$[A-Za-z]{2,}|\b[A-Z]{2,6}\b/.test(q.replace(/\b(?:CT|UTC|US|OK|KO)\b/g, ""));
}
const PLAIN_NEWS: Skill = {
  ...SKILLS.sentiment,
  maxRounds: 1,
  playbook: `${SKILLS.sentiment.playbook}
THIS QUESTION asks for news in general, no asset named: ONE news_latest call (no kind, or kind crypto when they say crypto), then answer from the headlines — no market_levels, price, cgl_* or x_search calls.`,
};

/** The budget line every playbook ends with. */
export const budgetLine = (rounds: number) => `BUDGET: at most ${rounds} rounds of lookups. Put every independent lookup in the SAME round (they run at once), never repeat a call you already made, and stop looking once you can answer — then write the answer.`;

/** Tool names offered under a skill (core first, no duplicates). */
export function skillToolNames(skill: Skill): string[] {
  return [...new Set([...CORE_TOOLS, ...skill.tools])];
}
