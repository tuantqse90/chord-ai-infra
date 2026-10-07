// Chord's Solana tape (api.getchord.xyz/v1/chains/solana/*): a wallet's or a token's newest swaps, and the smart-traders
// board. Tape times are unix SECONDS; everything handed to the rest of the engine is converted to milliseconds.
// The polls and the backtest pages go straight to Chord with chordHeaders() (uncached: thousands of distinct paths would
// only churn the shared chordGet cache the Ask tools rely on); the board goes through chordGet, cached 60 s.
import { chordHeaders, config } from "../config";
import { chordGet } from "../chord/services/chordApi";
import { http, QUOTE_MINTS } from "./market";
import { isPubkey } from "../solana/tokens";
import { validateDays } from "./validate";
import type { SourceTrade, Trader } from "./types";

/** One swap row as the tape serves it. */
export interface TapeRow { ts: number; side: "buy" | "sell"; token: string; symbol: string | null; usd: number | null; priceUsd: number | null; tokenAmount: number; tx: string; wallet?: string | null }

async function chordJson<T>(path: string, timeoutMs = 8_000): Promise<T> {
  const base = config.chordApi();
  if (!base) throw new Error("Chord's API is switched off on this server (CHORD_API=off)");
  const r = await http(`${base}${path}`, { headers: chordHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`Chord's tape ${path.split("?")[0].replace(/\/[1-9A-HJ-NP-Za-km-z]{32,44}\//, "/…/")} answered ${r.status}`);
  return (await r.json()) as T;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function rowsOf(j: any): TapeRow[] {
  if (!Array.isArray(j?.trades)) throw new Error("Chord's tape answered without a trade list");
  return j.trades
    .filter((r: any) => r && typeof r.tx === "string" && typeof r.token === "string" && (r.side === "buy" || r.side === "sell") && Number.isFinite(Number(r.ts)))
    .map((r: any) => ({ ts: Number(r.ts), side: r.side, token: r.token, symbol: typeof r.symbol === "string" ? r.symbol : null, usd: num(r.usd), priceUsd: num(r.priceUsd),
      tokenAmount: Number(r.tokenAmount) || 0, tx: r.tx, wallet: typeof r.wallet === "string" ? r.wallet : null }));
}

/** The wallet's newest swaps (newest first), at most `limit` (≤ 200), strictly before `beforeS` (unix s) when given. */
export async function walletTrades(wallet: string, limit = 100, beforeS: number | null = null): Promise<TapeRow[]> {
  const q = `limit=${Math.max(1, Math.min(200, limit))}${beforeS ? `&before=${Math.floor(beforeS)}` : ""}`;
  return rowsOf(await chordJson(`/v1/chains/solana/wallet/${encodeURIComponent(wallet)}/trades?${q}`));
}
/** The token's newest swaps across its pools (newest first), each with the wallet that made it. */
export async function tokenTrades(mint: string, limit = 100): Promise<TapeRow[]> {
  return rowsOf(await chordJson(`/v1/chains/solana/token/${encodeURIComponent(mint)}/trades?limit=${Math.max(1, Math.min(200, limit))}`));
}

/** A tape row as a source trade; null for rows the bots never act on (the "token" is SOL / USDC / USDT, or no wallet). */
export function toSource(r: TapeRow, wallet: string | null = r.wallet ?? null): SourceTrade | null {
  if (!wallet || QUOTE_MINTS.has(r.token)) return null;
  return { wallet, tx: r.tx, side: r.side, mint: r.token, symbol: r.symbol, usd: r.usd, priceUsd: r.priceUsd, ts: r.ts * 1000, via: "tape" };
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
function toTrader(r: any): Trader {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const bt = r.bestToken;
  return {
    wallet: String(r.wallet), score: n(r.score), realizedPnlUsd: n(r.realizedPnlUsd), roi: n(r.roi), winRate: n(r.winRate), trades: n(r.trades),
    tokens: n(r.tokens), volumeUsd: n(r.volumeUsd), medianHoldS: n(r.medianHoldS), lastTrade: n(r.lastTrade) * 1000,
    bestToken: bt && typeof bt === "object" ? {
      mint: typeof bt.token === "string" && isPubkey(bt.token) ? bt.token : null, // the page reads its picture through /v1/logo/solana/<mint>
      symbol: (typeof bt.symbol === "string" && bt.symbol) || (typeof bt.name === "string" && bt.name) || (typeof bt.token === "string" ? short(bt.token) : "?"),
      image: typeof bt.image === "string" && bt.image ? bt.image : null, realizedPnlUsd: n(bt.realizedPnlUsd),
    } : null,
  };
}

/** Chord's Solana smart-traders board (bots removed by its own rules), best first. roi / winRate / medianHoldS the board
 *  could not compute come back as 0; lastTrade is unix ms. */
export async function smartTraders(days: 1 | 3 | 7, limit = 20): Promise<Trader[]> {
  const d = validateDays(days);
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 20));
  const j = await chordGet<{ traders?: unknown }>(`/v1/chains/solana/smart-traders?days=${d}&limit=100`, 60_000);
  if (!Array.isArray(j?.traders)) throw new Error("Chord's smart-traders board answered without a list");
  return (j.traders as any[]).filter((r) => r && typeof r.wallet === "string").slice(0, n).map(toTrader);
}
