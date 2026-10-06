// Bots as a service: the shapes shared by the engine, the HTTP routes, the page and the Ask tools
// (ask2049-notes/bots-contract.md, copied verbatim). Every timestamp the engine produces is unix MILLISECONDS.
export type BotType = "copy" | "alert";
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
export interface AlertParams { wallets?: string[]; mints?: string[]; minUsd?: number /* default 1000 */; webhook?: string | null /* https only */ }
export interface BotStats { trades: number; buys: number; sells: number; skipped: number; investedUsd: number; realizedUsd: number; unrealizedUsd: number; openPositions: number; winRate: number | null; lastEventAt: number | null }
export interface Bot { id: string; name: string; type: BotType; mode: BotMode; status: BotStatus; params: CopyParams | AlertParams; createdAt: number; updatedAt: number; stats: BotStats; error: string | null }
export interface SourceTrade { wallet: string; tx: string; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number | null; priceUsd: number | null; ts: number; via: "websocket" | "tape" }
export interface Fill { id: string; botId: string; ts: number; side: "buy" | "sell"; mint: string; symbol: string | null; usd: number; tokenAmount: number; priceUsd: number | null; status: "filled" | "skipped"; reason: string | null; pnlUsd: number | null; source: SourceTrade; quote: { provider: "Jupiter"; route: string[]; priceImpactPct: number | null } | null; mode: BotMode }
export interface BotEvent { ts: number; level: "info" | "warn" | "error"; msg: string }
export interface Position { mint: string; symbol: string | null; qty: number; costUsd: number; priceUsd: number | null; valueUsd: number | null; pnlUsd: number | null; openedAt: number }
export interface Backtest { days: number; wallets: string[]; usdPerTrade: number; trades: number; buys: number; sells: number; skipped: number; investedUsd: number; realizedUsd: number; unrealizedUsd: number; winRate: number | null; maxDrawdownUsd: number; equity: { ts: number; usd: number }[]; fills: Omit<Fill, "id" | "botId" | "quote" | "mode">[]; notes: string[] }
export interface Trader { wallet: string; score: number; realizedPnlUsd: number; roi: number; winRate: number; trades: number; tokens: number; volumeUsd: number; medianHoldS: number; lastTrade: number; bestToken: { symbol: string; image: string | null; realizedPnlUsd: number } | null }

/** What the engine pushes to a bot's subscribers (SSE on /v1/bots/:id/stream). */
export type BotStreamEvent = { type: "fill"; fill: Fill } | { type: "event"; event: BotEvent } | { type: "stats"; bot: Bot };
