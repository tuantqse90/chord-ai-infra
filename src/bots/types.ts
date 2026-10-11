// Bots as a service: the shapes shared by the engine, the HTTP routes, the page and the Ask tools
// (agents on Monad). Every timestamp the engine produces is unix MILLISECONDS.
export type BotType = "copy" | "alert" | "custom" | "classic" | "lp";
export type BotMode = "paper" | "live";
export type BotStatus = "running" | "paused" | "stopped" | "error";
export interface CopyParams {
  wallets: string[];            // 1..10 Monad wallets (0x…, lower-cased)
  usdPerTrade: number;          // 1..1000, USDC per mirrored buy
  maxPerTokenUsd?: number;      // default 3 × usdPerTrade (adds to a held token stop there)
  maxOpenPositions?: number;    // default 10
  mirrorSells?: boolean;        // default true: when a followed wallet sells a token the bot holds, the bot sells all of it
  slippageBps?: number;         // default 100
  minLiquidityUsd?: number;     // default 20000 (token's liquidity per Chord); below = skipped
  safety?: boolean;             // default true: skip tokens with a live mint or freeze authority
  dailyLossStopUsd?: number | null; // pause the bot when today's realized + unrealized loss passes this
}
/** A custom agent (bot type "custom"): one Strategy v1 (src/strategy/schema.ts), defaults filled; templateId when started from the gallery. */
export interface CustomParams { strategy: unknown; templateId?: string | null }
/** A classic agent (bot type "classic", src/classic): a textbook strategy on a symbol, traded on Perpl perps or Monad spot. */
export interface ClassicParams { strategy: string; params?: Record<string, number>; symbol: string; tf?: "15m" | "1h" | "4h" | "1d"; venue?: "perpl" | "monad_spot"; sizeUsd?: number; leverage?: number; signalSource?: "binance" | "okx" | "hyperliquid" | "perpl"; templateId?: string | null }
/** An LP agent (bot type "lp", src/lp): paper liquidity in a Monad pool from Chord's LP index. */
export interface LpParams { pool: string; amountUsd?: number; preset?: "tight" | "balanced" | "wide" | "full"; rebalance?: boolean }
export interface AlertParams { wallets?: string[]; mints?: string[]; minUsd?: number /* default 1000 */; webhook?: string | null /* https only */ }
export interface BotStats { trades: number; buys: number; sells: number; skipped: number; investedUsd: number; realizedUsd: number; unrealizedUsd: number; openPositions: number; winRate: number | null; lastEventAt: number | null }
export interface Bot { id: string; name: string; type: BotType; mode: BotMode; status: BotStatus; params: CopyParams | AlertParams | CustomParams | ClassicParams | LpParams; createdAt: number; updatedAt: number; stats: BotStats; error: string | null }
/** `detail`: what fired, in plain words (custom agents). Addresses and tx hashes are lower case. */
export interface SourceTrade { wallet: string; tx: string; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number | null; priceUsd: number | null; ts: number; via: "tape" | "strategy"; detail?: string }
export interface Fill { id: string; botId: string; ts: number; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number; tokenAmount: number; priceUsd: number | null; status: "filled" | "skipped"; reason: string | null; pnlUsd: number | null; source: SourceTrade; quote: { provider: string; route: string[]; priceImpactPct: number | null } | null; mode: BotMode }
export interface BotEvent { ts: number; level: "info" | "warn" | "error"; msg: string }
export interface Position { mint: string; symbol: string | null; qty: number; costUsd: number; priceUsd: number | null; valueUsd: number | null; pnlUsd: number | null; openedAt: number }
export interface Backtest { days: number; wallets: string[]; usdPerTrade: number; trades: number; buys: number; sells: number; skipped: number; investedUsd: number; realizedUsd: number; unrealizedUsd: number; winRate: number | null; maxDrawdownUsd: number; equity: { ts: number; usd: number }[]; fills: Omit<Fill, "id" | "botId" | "quote" | "mode">[]; notes: string[] }
export interface Trader { wallet: string; score: number; realizedPnlUsd: number; roi: number | null; winRate: number; trades: number; tokens: number; volumeUsd: number; medianHoldS: number | null; lastTrade: number; bestToken: { mint: string | null; symbol: string; image: string | null; realizedPnlUsd: number } | null }

/** What the engine pushes to a bot's subscribers (SSE on /v1/bots/:id/stream). */
export type BotStreamEvent = { type: "fill"; fill: Fill } | { type: "event"; event: BotEvent } | { type: "stats"; bot: Bot };
