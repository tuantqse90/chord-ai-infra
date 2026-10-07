// Bots as a service: the shapes shared by the engine, the HTTP routes, the page and the Ask tools
// (ask2049-notes/bots-contract.md, copied verbatim). Every timestamp the engine produces is unix MILLISECONDS.
export type BotType = "copy" | "alert" | "lp" | "custom";
export type BotMode = "paper" | "live";
export type BotStatus = "running" | "paused" | "stopped" | "error";
export interface CopyParams {
  wallets: string[];            // 1..10 Solana wallets (base58, case kept)
  usdPerTrade: number;          // 1..1000, USDC per mirrored buy
  maxPerTokenUsd?: number;      // default 3 × usdPerTrade (adds to a held token stop there)
  maxOpenPositions?: number;    // default 10
  mirrorSells?: boolean;        // default true: when a followed wallet sells a token the bot holds, the bot sells all of it
  slippageBps?: number;         // default 100
  minLiquidityUsd?: number;     // default 20000 (token's liquidity per Jupiter); below = skipped
  safety?: boolean;             // default true: skip tokens with a live mint or freeze authority
  dailyLossStopUsd?: number | null; // pause the bot when today's realized + unrealized loss passes this
}
/** A custom agent (bot type "custom"): one Strategy v1 (src/strategy/schema.ts), defaults filled; templateId when started from the gallery. */
export interface CustomParams { strategy: unknown; templateId?: string | null }
export interface AlertParams { wallets?: string[]; mints?: string[]; minUsd?: number /* default 1000 */; webhook?: string | null /* https only */ }
export interface BotStats { trades: number; buys: number; sells: number; skipped: number; investedUsd: number; realizedUsd: number; unrealizedUsd: number; openPositions: number; winRate: number | null; lastEventAt: number | null }
export interface Bot { id: string; name: string; type: BotType; mode: BotMode; status: BotStatus; params: CopyParams | AlertParams | LpParams | LpCopyParams | CustomParams; createdAt: number; updatedAt: number; stats: BotStats; error: string | null }
/** `detail`: what fired, in plain words (custom agents; LP copy agents: "copied LP 3cco…YEVYS: added $20,867 to SI-SOL (range −30% / +45%)").
 *  An LP copy agent's copied move has via "lp" with the LP wallet as `wallet` and its signature as `tx` (its own exit rules keep the pool). */
export interface SourceTrade { wallet: string; tx: string; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number | null; priceUsd: number | null; ts: number; via: "websocket" | "tape" | "lp" | "strategy"; detail?: string }
export interface Fill { id: string; botId: string; ts: number; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number; tokenAmount: number; priceUsd: number | null; status: "filled" | "skipped"; reason: string | null; pnlUsd: number | null; source: SourceTrade; quote: { provider: "Jupiter"; route: string[]; priceImpactPct: number | null } | null; mode: BotMode; kind?: LpFillKind }
export interface BotEvent { ts: number; level: "info" | "warn" | "error"; msg: string }
export interface Position { mint: string; symbol: string | null; qty: number; costUsd: number; priceUsd: number | null; valueUsd: number | null; pnlUsd: number | null; openedAt: number }
export interface Backtest { days: number; wallets: string[]; usdPerTrade: number; trades: number; buys: number; sells: number; skipped: number; investedUsd: number; realizedUsd: number; unrealizedUsd: number; winRate: number | null; maxDrawdownUsd: number; equity: { ts: number; usd: number }[]; fills: Omit<Fill, "id" | "botId" | "quote" | "mode">[]; notes: string[] }
export interface Trader { wallet: string; score: number; realizedPnlUsd: number; roi: number; winRate: number; trades: number; tokens: number; volumeUsd: number; medianHoldS: number; lastTrade: number; bestToken: { mint: string | null; symbol: string; image: string | null; realizedPnlUsd: number } | null }

/** What the engine pushes to a bot's subscribers (SSE on /v1/bots/:id/stream). */
export type BotStreamEvent = { type: "fill"; fill: Fill } | { type: "event"; event: BotEvent } | { type: "stats"; bot: Bot };

// ── LP agent (bot type "lp", ask2049-notes/bots-contract.md "## LP agent") ─────────────────────────────────────────────
// Prices of a pool are always QUOTE PER TOKEN: `token` is the volatile side (Chord's `token`), `quote` the other one (SOL,
// USDC, …). Every USD figure says where it came from; fee income is an ESTIMATE (pool fee APR × time in range).
export type LpPreset = "tight" | "balanced" | "wide";
export type LpFillKind = "open" | "rebalance" | "close";
export interface LpParams {
  mode?: "single";              // the default: one pool, the agent's own range and rebalances. "copy" = LpCopyParams
  pool: string;                 // Solana pool address (base58, case kept) — Meteora DLMM / DAMM v2, Raydium CLMM, PumpSwap
  amountUsd: number;            // 10..10000, the paper deposit
  preset?: LpPreset;            // default "balanced" when rangePct is not given (tight 1σ, balanced 2σ, wide 3σ over 24 h)
  rangePct?: number | null;     // custom range ±% around the price (1..90): lower = p × (1 − r), upper = p × (1 + r); not with preset
  rebalance?: { outOfRangeMinutes?: number /* default 30, 5..1440 */; maxPerDay?: number /* default 4, 0..24; 0 = never */ };
  exits?: { lpExodus?: boolean /* default true */; tokenDropPct?: number | null /* 5..95, from the first open */; dailyLossStopUsd?: number | null };
  safety?: boolean;             // default true: do not open on a token with a live mint or freeze authority
}
export interface LpFlag { code: "thin_tvl" | "new_pool" | "lp_exodus" | "mint_authority" | "freeze_authority" | "safety_unknown" | "no_tvl" | "no_fee_apr" | "short_history"; msg: string }
export interface LpVolatility { hourlyPct: number; dailyPct: number; points: number }
export interface LpPoolScan {
  pool: string; dex: string; venue: string; pair: string;
  token: string; tokenSymbol: string | null; quote: string; quoteSymbol: string | null; priceUsd: number | null;
  tvlUsd: number | null; tvlSource: string | null;
  volume24hUsd: number | null; volumeSource: string | null; volumeTvl: number | null;
  fees24hUsd: number | null;    // the venue's swap fees over 24 h (all of it, protocol share included)
  feeAprPct: number | null; feeAprSource: string | null; feeRatePct: number | null;
  feesClaimed24hUsd: number; deposits24hUsd: number; withdrawals24hUsd: number; netFlow24hUsd: number; lps24h: number; openPositions: number | null;
  lastHour: { depositsUsd: number; withdrawalsUsd: number } | null;
  ageHours: number | null; ageSource: string;
  volatility: LpVolatility | null;
  safety: { mintAuthority: "renounced" | "live" | "unknown"; freezeAuthority: "renounced" | "live" | "unknown"; liquidityUsd: number | null } | null;
  binStep: number | null; tickSpacing: number | null;
  flags: LpFlag[]; score: number;
}
export interface LpScan { rows: LpPoolScan[]; best: string | null; windowHours: number; notes: string[]; at: number }
export interface LpRangePreset {
  preset: LpPreset; sigmas: number; lower: number; upper: number; lowerUsd: number; upperUsd: number; downPct: number; upPct: number;
  expectedTimeInRangePct: number | null; bins: number | null; ticks: number | null;
}
export interface LpRangeAnswer {
  pool: string; dex: string; pair: string; token: string; quote: string; price: number; priceUsd: number; quoteUsd: number; priceSource: string;
  horizonHours: number; volatility: (LpVolatility & { horizonPct: number }) | null; fullRange: boolean; presets: LpRangePreset[]; venueShape: string; notes: string[];
}
export interface LpBacktest {
  pool: string; dex: string; pair: string; days: number; amountUsd: number; preset: LpPreset | null; rangePct: number | null;
  rebalance: { outOfRangeMinutes: number; maxPerDay: number }; exits: { lpExodus: boolean; tokenDropPct: number | null };
  range: { lower: number; upper: number; downPct: number; upPct: number } | null; fullRange: boolean;
  hours: number; timeInRangePct: number; feeAprPct: number | null; feeAprSource: string | null; feesUsd: number;
  ilUsd: number; rebalances: number; rebalanceCostUsd: number; costSource: string; exited: { ts: number; reason: string } | null;
  finalUsd: number; hodlUsd: number; quoteOnlyUsd: number; lpVsHodlUsd: number; pnlUsd: number; maxDrawdownUsd: number;
  equity: { ts: number; usd: number; hodlUsd: number; quoteOnlyUsd: number; price: number; lower: number | null; upper: number | null; inRange: boolean }[];
  fills: { ts: number; kind: LpFillKind; usd: number; price: number; pnlUsd: number | null; reason: string }[];
  notes: string[];
}
/** The live (paper) LP position of one bot, kept beside its Position row; GET /v1/bots/:id answers it as `lp.state`. */
export interface LpState {
  pool: string; dex: string; venue: string; pair: string; token: string; tokenSymbol: string | null; quote: string; quoteSymbol: string | null;
  status: "opening" | "open" | "closed";
  range: { lower: number; upper: number | null /* null = no upper bound (full range) */; downPct: number; upPct: number | null; full: boolean; preset: LpPreset | null; rangePct: number | null; logWidth: number | null } | null;
  liquidity: number;            // L of the CL math (quote-unit √price scale)
  leg: { openedAt: number; costUsd: number; tokenAmount: number; quoteAmount: number; price: number; feesUsd: number } | null;
  first: { openedAt: number; amountUsd: number; tokenAmount: number; quoteAmount: number; tokenUsd: number; quoteUsd: number } | null;
  feeApr: { pct: number | null; source: string; at: number };
  feeRatePct: number | null;    // the venue's base swap fee, for rebalance costs
  inRange: boolean | null; outSince: number | null; timeInRangeMs: number; trackedMs: number;
  feesTotalUsd: number; rebalanceCostUsd: number; rebalances: number; rebalancesToday: { day: number; n: number };
  mark: { ts: number; price: number; tokenUsd: number; quoteUsd: number; valueUsd: number; equityUsd: number; hodlUsd: number; quoteOnlyUsd: number; ilUsd: number; vsHodlUsd: number } | null;
  exodus: { checkedAt: number; depositsUsd: number; withdrawalsUsd: number } | null;
  closedAt: number | null; closeReason: string | null;
  warned: Record<string, number>;
  /** LP copy agents: the move this position copies (the LP wallet, its position, transaction and deposit; what it took out since). */
  copied?: { wallet: string; position: string; tx: string; ts: number; usd: number | null; removedUsd: number } | null;
}
export interface LpPoint { ts: number; price: number; lower: number | null; upper: number | null; equityUsd: number; hodlUsd: number; feesUsd: number; inRange: boolean }

// ── LP copy agent (bot type "lp", params.mode "copy", ask2049-notes/PROMPT-copy-smart-lp.md) ───────────────────────────
// Follows Solana LP wallets on Chord's LP tape and mirrors their moves in paper: an add to a pool the agent does not hold opens
// a position there with the wallet's own range, a remove by that wallet closes it. Ranges are never the agent's own.
export type LpVenue = "meteora_dlmm" | "meteora_damm_v2" | "raydium_clmm" | "pumpswap";
export interface LpCopyParams {
  mode: "copy";
  /** the LP wallets to copy (1..10), or the top N of the smart-LP board (smartLps.top 1..10 over smartLps.days 1 / 3 / 7, default 3 / 3) */
  wallets: string[] | { smartLps: { top?: number; days?: 1 | 3 | 7 } };
  amountUsd: number;            // 10..2000, the paper deposit of each copied position
  maxOpenPositions?: number;    // 1..10, default 3 (one position per pool)
  minPoolTvlUsd?: number;       // default 50,000: a copied add into a thinner pool is skipped
  venues?: LpVenue[] | null;    // default every supported venue
  followRemoves?: boolean;      // default true: the wallet's remove (half or more of its deposit) or close closes the copy
  exits?: { lpExodus?: boolean /* default true */; tokenDropPct?: number | null /* 5..95, from each open */; dailyLossStopUsd?: number | null };
  safety?: boolean;             // default true: never open on a token with a live mint or freeze authority
}
/** One row of the smart-LP board: what the wallet earned providing liquidity on positions the tape saw from the first deposit. */
export interface SmartLp {
  wallet: string; score: number;
  positions: number;            // positions the row is built on: seen from their first deposit, active in the window
  positionsAll: number;         // every position Chord counts for the wallet in the window (some opened before the tape)
  closed: number; open: number; pools: number; pairs: string[]; venues: string[];
  depositedUsd: number; feesUsd: number; feeYieldPct: number;
  realizedUsd: number | null; roiPct: number | null; winRate: number | null; medianHoldS: number | null;
  positionsPerDay: number; lastEventAt: number;
}
export interface SmartLpBoard {
  days: number; windowHours: number; since: number /* ms, start of the window (Chord's LP coverage when later) */; coverageStart: number | null;
  rows: SmartLp[];
  dropped: { reason: string; wallets: number }[];
  /** Chord's own sort=pnl top 5 for the same window, and what this board made of each */
  trap: { wallet: string; chordRealizedPnlUsd: number | null; chordWinRate: number | null; chordDepositedUsd: number; chordWithdrawnUsd: number; verdict: string }[];
  candidates: number; read: number; notes: string[]; at: number;
}
export interface LpCopyBacktest {
  days: number; windowHours: number; since: number; wallets: string[]; walletsFrom: string;
  /** wallets whose LP events could not be read on Chord (twice): their moves are not in the replay */
  unread: string[];
  amountUsd: number; maxOpenPositions: number; minPoolTvlUsd: number; followRemoves: boolean; exits: { lpExodus: boolean; tokenDropPct: number | null };
  moves: number; entries: number; copied: number; skipped: { reason: string; n: number }[];
  positions: {
    pool: string; pair: string; dex: string; wallet: string; tx: string; openedAt: number; closedAt: number | null; closeReason: string | null;
    range: { lower: number; upper: number | null; downPct: number; upPct: number | null; full: boolean } | null;
    amountUsd: number; valueUsd: number; feesUsd: number; ilUsd: number; pnlUsd: number; timeInRangePct: number;
  }[];
  fills: { ts: number; kind: LpFillKind; pool: string; pair: string; wallet: string; tx: string | null; usd: number; pnlUsd: number | null; reason: string }[];
  investedUsd: number; realizedUsd: number; unrealizedUsd: number; pnlUsd: number; feesUsd: number; ilUsd: number; winRate: number | null; maxDrawdownUsd: number;
  equity: { ts: number; usd: number /* PnL so far */; deployedUsd: number }[];
  notes: string[];
}
/** What a copy agent follows and how far it has read each wallet's LP events (kept beside the bot, GET /v1/bots/:id → lp.copy). */
export interface LpFollowState {
  wallets: string[]; from: "given" | "smart"; board: { top: number; days: 1 | 3 | 7 } | null; resolvedAt: number | null;
  picked: { wallet: string; score: number; positions: number }[];
  since: number;                // ms: adds before this (start or resume) are not copied
  cursors: Record<string, { ts: number; keys: string[] }>;
  lastPollAt: number | null; pollErrors: Record<string, string>;
  moves: number; copied: number; skipped: number;
}
