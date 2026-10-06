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
export interface Bot { id: string; name: string; type: BotType; mode: BotMode; status: BotStatus; params: CopyParams | AlertParams | LpParams | CustomParams; createdAt: number; updatedAt: number; stats: BotStats; error: string | null }
export interface SourceTrade { wallet: string; tx: string; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number | null; priceUsd: number | null; ts: number; via: "websocket" | "tape" | "lp" | "strategy"; /** custom agents: what fired, in plain words */ detail?: string }
export interface Fill { id: string; botId: string; ts: number; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number; tokenAmount: number; priceUsd: number | null; status: "filled" | "skipped"; reason: string | null; pnlUsd: number | null; source: SourceTrade; quote: { provider: "Jupiter"; route: string[]; priceImpactPct: number | null } | null; mode: BotMode; kind?: LpFillKind }
export interface BotEvent { ts: number; level: "info" | "warn" | "error"; msg: string }
export interface Position { mint: string; symbol: string | null; qty: number; costUsd: number; priceUsd: number | null; valueUsd: number | null; pnlUsd: number | null; openedAt: number }
export interface Backtest { days: number; wallets: string[]; usdPerTrade: number; trades: number; buys: number; sells: number; skipped: number; investedUsd: number; realizedUsd: number; unrealizedUsd: number; winRate: number | null; maxDrawdownUsd: number; equity: { ts: number; usd: number }[]; fills: Omit<Fill, "id" | "botId" | "quote" | "mode">[]; notes: string[] }
export interface Trader { wallet: string; score: number; realizedPnlUsd: number; roi: number; winRate: number; trades: number; tokens: number; volumeUsd: number; medianHoldS: number; lastTrade: number; bestToken: { symbol: string; image: string | null; realizedPnlUsd: number } | null }

/** What the engine pushes to a bot's subscribers (SSE on /v1/bots/:id/stream). */
export type BotStreamEvent = { type: "fill"; fill: Fill } | { type: "event"; event: BotEvent } | { type: "stats"; bot: Bot };

// ── LP agent (bot type "lp", ask2049-notes/bots-contract.md "## LP agent") ─────────────────────────────────────────────
// Prices of a pool are always QUOTE PER TOKEN: `token` is the volatile side (Chord's `token`), `quote` the other one (SOL,
// USDC, …). Every USD figure says where it came from; fee income is an ESTIMATE (pool fee APR × time in range).
export type LpPreset = "tight" | "balanced" | "wide";
export type LpFillKind = "open" | "rebalance" | "close";
export interface LpParams {
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
}
export interface LpPoint { ts: number; price: number; lower: number | null; upper: number | null; equityUsd: number; hodlUsd: number; feesUsd: number; inRange: boolean }
