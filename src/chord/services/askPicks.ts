// ask2049: stand-in for the read side of Chord's services/askPicks.ts (2026-10-06). Chord scores the board every 4 h in its own
// worker (Redis ask:picks:latest / ask:picks:hist) and grades past picks against its candles. Here the board and its 7-day track
// record come from Chord's public route GET /v1/ask/picks, which already applies withMarketCaps, publicPick (no target, stop or
// R:R leaves Chord — owner 2026-09-27: analysis only) and publicRecord. gradePick reads the public candle route.
import { chordGet } from "./chordApi";

/** One pick as GET /v1/ask/picks returns it (Chord's Pick minus target / invalidation / levels / rr). */
export interface Pick {
  /** 4663 = Robinhood Chain · 8453 Base · 56 BNB Chain · 43114 Avalanche; absent = Arc 5042 (history before 2026-09-24). */
  chain?: number;
  /** Token name — a symbol alone is ambiguous (Robinhood lists the AMC stock and an "A Meme Coin" AMC). */
  name?: string | null;
  ts: number; token: string; symbol: string; side: "bullish" | "bearish"; score: number; confidence: "low" | "medium" | "high";
  priceUsd: number;
  /** Reasons that agree with the side, strongest first, and the strongest reasons against it. */
  why: string[]; against: string[];
  /** Market cap at the pick price = total supply × price (FDV for a token with locked allocations). Null = supply unreadable. */
  marketCapUsd?: number | null;
  facts: { change24hPct: number | null; buyShare1h: number | null; buyShare24h: number | null; realBuyerPct: number | null; top10Pct: number | null; vsVwapPct: number | null; lastHourVsPriorPct: number | null; lastHourUsd: number; lastHourTrades: number | null; volume24h: number; traders: number;
    /** The chain's index skips trades under this (BNB $100): counts, volumes and buy shares are over the rest. */
    minTradeUsd?: number };
}
/** The chain a pick is on, by name (absent = Arc). */
export function pickChainName(chain: number | undefined): string {
  return chain === 4663 ? "Robinhood Chain" : chain === 8453 ? "Base" : chain === 56 ? "BNB Chain" : chain === 43114 ? "Avalanche" : "Arc";
}
export interface PickOutcome { hitTarget: boolean; hitStop: boolean; movePct: number | null; status: "target" | "stop" | "open" | "expired" }
/** Chord's publicRecord: how many picks, how many moved their way 48 h on, the average move (last 7 days). */
export interface PublicRecord { graded: number; open: number; rightWayPct: number | null; avgMovePct: number | null }
const HORIZON_SEC = 48 * 3600;

/** The latest board (null when Chord has not computed one) and the 7-day record, in one public read. */
export async function getPicksBoard(): Promise<{ latest: { ts: number; picks: Pick[] } | null; record: PublicRecord | null }> {
  const j = await chordGet<{ computedAt?: number | null; picks?: Pick[]; trackRecord7d?: PublicRecord | null }>("/v1/ask/picks", 60_000);
  if (!j || typeof j !== "object" || !("picks" in j)) throw new Error("Chord API: no picks board");
  const latest = typeof j.computedAt === "number" && j.computedAt > 0 ? { ts: j.computedAt, picks: Array.isArray(j.picks) ? j.picks : [] } : null;
  return { latest, record: j.trackRecord7d ?? null };
}

/** Grade a past pick against the 1h candles since it was made. */
export async function gradePick(p: Pick & { target?: number | null; invalidation?: number | null }): Promise<PickOutcome> {
  // ask2049: Chord reads its own 1h candles (memeChart.getDbChart for Arc / Robinhood Chain, chainCandles for the keyed chains);
  // here GET /v1/candles over the same 48 h window. A public pick has no target / invalidation, so hitTarget / hitStop stay
  // false and the status is open or expired — the tool reads movePct only, which is Chord's math unchanged.
  const chain = p.chain ?? 5042;
  const from = p.ts - 3_600, to = p.ts + HORIZON_SEC + 3_600;
  const cs = await chordGet<{ candles?: { t: number; o: number; h: number; l: number; c: number }[] }>(`/v1/candles?chain=${chain}&token=${p.token.toLowerCase()}&tf=1h&from=${from}&to=${to}&limit=60`, 60_000)
    .then((j) => (Array.isArray(j?.candles) ? j.candles : [])).catch(() => []);
  const after = cs.filter((c) => c.t >= p.ts && c.t <= p.ts + HORIZON_SEC);
  if (!after.length) return { hitTarget: false, hitStop: false, movePct: null, status: "open" };
  const hi = Math.max(...after.map((c) => c.h)), lo = Math.min(...after.map((c) => c.l).filter((x) => x > 0));
  const last = after[after.length - 1].c;
  const movePct = +(((last - p.priceUsd) / p.priceUsd) * 100).toFixed(1);
  const bull = p.side === "bullish";
  const hitTarget = p.target != null && (bull ? hi >= p.target : lo <= p.target);
  const hitStop = p.invalidation != null && (bull ? lo <= p.invalidation : hi >= p.invalidation);
  const expired = Math.floor(Date.now() / 1000) - p.ts > HORIZON_SEC;
  return { hitTarget, hitStop, movePct, status: hitTarget && !hitStop ? "target" : hitStop && !hitTarget ? "stop" : hitTarget && hitStop ? (bull ? (movePct >= 0 ? "target" : "stop") : (movePct <= 0 ? "target" : "stop")) : expired ? "expired" : "open" };
}

/** What leaves the API (owner 2026-09-27: analysis only — no stop, target or R:R anywhere). GET /v1/ask/picks already applies it;
 *  kept here so a field the route ever adds back cannot reach the model. */
export function publicPick<T extends Pick & { target?: unknown; invalidation?: unknown; levels?: unknown; rr?: unknown }>(p: T): Omit<T, "target" | "invalidation" | "levels" | "rr"> {
  const { target: _t, invalidation: _i, levels: _l, rr: _r, ...rest } = p;
  return rest;
}
