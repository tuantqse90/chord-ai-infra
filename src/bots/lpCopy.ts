// Copy smart LPs (ask2049-notes/PROMPT-copy-smart-lp.md): the smart-LP board, the LP copy agent's follower and its backtest.
//
// The board ranks Solana LP wallets on Chord's LP tape by what they earned providing liquidity, built ONLY on positions the tape
// saw from their first deposit (Chord's raw sort=pnl counts the withdrawal of a position opened before the tape as profit: a
// $0 deposit and a $33k withdrawal read "$127k realized, 100 % win rate"). Wallets that are vaults / rebalancing bots, that only
// remove (creators, migrators), that seed their own pools (launchers), that bet on one pool or put in too little are dropped and
// counted. Score = luck-shrunk realized ROI of closed positions (× a win-rate skill factor) + luck-shrunk claimed-fee yield of the
// open ones, in % points. Cached 10 min.
//
// The copy agent (bot type "lp", params.mode "copy") polls each followed wallet's LP events every minute (at most 4 wallets at
// a time: Chord's Solana read API errors under concurrent load) and mirrors them in paper: an add / open in a pool it does not
// hold opens a position there with the WALLET's range (DLMM bins / CLMM ticks turned into prices; full range on PumpSwap and
// DAMM v2), sized amountUsd, through the LP runner's state, marking and fills; a remove of half or more of the wallet's deposit
// (or a close) closes it. It never rebalances on its own. LP exodus / token drop exits and the daily loss stop still apply. Every
// copied fill carries the wallet's own event as its source (wallet, signature, time, words), so the tape shows the reaction time.
import { randomBytes } from "node:crypto";
import { emit } from "./bus";
import { BotInputError } from "./errors";
import { logEvent, publishStats, todayLoss } from "./executor";
import { money, pctText, priceText } from "./lp";
import { amountsAt, clmmRange, dlmmRange, FULL_RANGE, inRange, invertRange, liquidityForAny, valueAt, type PriceRange } from "./lpMath";
import { isExodus, livePair, lpSince, poolHourly, poolInfo, pricePath, short, venueLabel, venueStats, type LpDeps, type PoolInfo, type PricePoint, type VenueStats } from "./lpData";
import { closeLpPosition, errText, freshState, markLp, positionExit, recordLp, safetyIssue, stateRange, withdrawText, type LpHooks, type Pxs } from "./lpRunner";
import { botRow, hasFill, insertFill, lpCopyStateOf, lpCopyStatesOf, lpFollowOf, saveLpCopyState, saveLpFollow, setPosition, sourceKey } from "./store";
import { LP_VENUES, validateDays, validateLpCopyParams, type LpCopyRules } from "./validate";
import type { Fill, LpCopyBacktest, LpFollowState, LpState, SmartLp, SmartLpBoard, SourceTrade } from "./types";

export const BOARD_TTL_MS = 10 * 60_000;
export const MIN_SEEN_POSITIONS = 3;
export const MAX_POSITIONS_A_DAY = 40;
export const MIN_DEPOSITED_USD = 1_000;
export const PRIOR_POSITIONS = 3;          // luck shrink: n / (n + 3), the smart-traders board's α
export const READ_MAX = 30;                // wallets whose positions are read per board (plus Chord's pnl top 5); launchers use some
export const POLL_LIMIT = 50;              // newest events read per wallet per minute
export const CLOSE_SHARE = 0.5;            // the copy closes once the wallet took out half of its deposit (or closed)
export const RANGE_SANITY = 50;            // a converted range whose near bound sits 50× from the price is a decimals / side mismatch
const CHORD_CONCURRENCY = 4;
const SKIPS_PER_MIN = 20;
const POLL_WARN_MS = 30 * 60_000;
const ROUND_TOL = 1e-6;

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const hoursText = (h: number) => (h >= 48 ? `${Math.round(h / 24)} days` : `${h >= 10 ? Math.round(h) : h.toFixed(1)} h`);
const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
/** "−30%", "+45%", "+2.5%": a bound's distance from the price. */
const signedPct = (x: number) => { const a = Math.round(Math.abs(x) * 10) / 10; return `${x < 0 ? "−" : "+"}${a >= 10 ? Math.round(a) : a.toFixed(1)}%`; };

// ── Chord reads: one gate for every wallet-level call of this module ─────────────────────────────────────────────────
let active = 0;
const waiters: (() => void)[] = [];
/** At most 4 of these calls in flight; a finished call hands its slot to the next waiter. */
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  if (active < CHORD_CONCURRENCY) active++;
  else await new Promise<void>((r) => waiters.push(r));
  try { return await fn(); } finally { const next = waiters.shift(); if (next) next(); else active--; }
}
/** The same deps with every Chord read behind the gate: for pool-level reads (lpData) of this module. Never hand it to a
 *  function here that gates on its own (walletPositions, walletEvents, pollWallets): a call waiting on its own slot would hang. */
export const gatedDeps = (d: LpDeps): LpDeps => ({ ...d, chord: <T>(path: string, ttlMs: number, timeoutMs?: number) => gated(() => d.chord<T>(path, ttlMs, timeoutMs)) });
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// ── tape shapes (Chord /v1/chains/solana/lp/*) ───────────────────────────────────────────────────────────────────────
export interface TopRow { wallet: string; positions: number; open: number; pools: number; depositedUsd: number; withdrawnUsd: number; feesClaimedUsd: number; realizedPnlUsd: number | null; realizedPositions: number; winRate: number | null }
export interface TapePosition {
  position: string; dex: string; pool: string; mintA: string | null; symbolA: string | null; mintB: string | null; symbolB: string | null;
  lower: number | null; upper: number | null; status: "open" | "closed"; openedAt: number | null; closedAt: number | null; firstEvent: number; lastEvent: number;
  depositedA: number | null; depositedB: number | null; depositedUsd: number; withdrawnUsd: number; feesClaimedUsd: number; realizedPnlUsd: number | null; partial: boolean;
}
/** `pool` can be null (Chord's DLMM `close` events carry none, measured 07/10): the move takes it from the other events of its transaction. */
export interface TapeEvent { ts: number; signature: string; dex: string; kind: string; pool: string | null; position: string; owner: string | null; usd: number | null; lower: number | null; upper: number | null }
/** One move of a wallet = its events of one transaction on one position (an open + add, a remove + fee + close, …). */
export interface LpMove { wallet: string; signature: string; ts: number /* unix s */; dex: string; pool: string | null; position: string; kinds: string[]; addUsd: number | null; removeUsd: number | null; lower: number | null; upper: number | null }

const topRow = (r: any): TopRow | null => (r && typeof r.wallet === "string" ? {
  wallet: r.wallet, positions: num(r.positions) ?? 0, open: num(r.open) ?? 0, pools: num(r.pools) ?? 0, depositedUsd: num(r.depositedUsd) ?? 0, withdrawnUsd: num(r.withdrawnUsd) ?? 0,
  feesClaimedUsd: num(r.feesClaimedUsd) ?? 0, realizedPnlUsd: num(r.realizedPnlUsd), realizedPositions: num(r.realizedPositions) ?? 0, winRate: num(r.winRate),
} : null);
export const tapePosition = (p: any): TapePosition | null => (p && typeof p.position === "string" && typeof p.pool === "string" && num(p.firstEvent) != null ? {
  position: p.position, dex: String(p.dex ?? "unknown"), pool: p.pool, mintA: str(p.mintA), symbolA: str(p.symbolA), mintB: str(p.mintB), symbolB: str(p.symbolB),
  lower: num(p.lower), upper: num(p.upper), status: p.status === "closed" ? "closed" : "open", openedAt: num(p.openedAt), closedAt: num(p.closedAt),
  firstEvent: num(p.firstEvent)!, lastEvent: num(p.lastEvent) ?? num(p.firstEvent)!, depositedA: num(p.depositedA), depositedB: num(p.depositedB),
  depositedUsd: num(p.depositedUsd) ?? 0, withdrawnUsd: num(p.withdrawnUsd) ?? 0, feesClaimedUsd: num(p.feesClaimedUsd) ?? 0, realizedPnlUsd: num(p.realizedPnlUsd), partial: p.partial === true,
} : null);
const tapeEvent = (e: any): TapeEvent | null => (e && typeof e.signature === "string" && (str(e.position) ?? str(e.pool)) && num(e.ts) != null ? {
  ts: num(e.ts)!, signature: e.signature, dex: String(e.dex ?? "unknown"), kind: String(e.kind ?? ""), pool: str(e.pool), position: str(e.position) ?? `pool:${e.pool}`, owner: str(e.owner),
  usd: num(e.usd), lower: num(e.lower), upper: num(e.upper),
} : null);

const walletPath = (w: string) => `/v1/chains/solana/lp/wallet/${encodeURIComponent(w)}?status=all&limit=200`;
const eventsPath = (w: string, limit: number, before: number | null) => `/v1/chains/solana/lp/wallet/${encodeURIComponent(w)}/events?limit=${limit}${before ? `&before=${before}` : ""}`;

/** The wallet's LP positions on Chord (most recently active first, up to 200), cached 10 min. */
export async function walletPositions(d: LpDeps, wallet: string): Promise<TapePosition[]> {
  const j = await gated(() => d.chord<any>(walletPath(wallet), BOARD_TTL_MS));
  if (!Array.isArray(j?.rows)) throw new Error("Chord's LP wallet answer had no positions");
  return (j.rows as any[]).map(tapePosition).filter((p): p is TapePosition => !!p);
}
/** When Chord's LP decoding started (unix s), from a leaderboard answer's `since` (= max(window start, coverage start)). */
const coverageOf = (since: number | null, windowStartS: number) => (since != null && since > windowStartS + 60 ? since : null);

/** Group a wallet's events (any order) into moves, oldest first. */
export function toMoves(wallet: string, events: TapeEvent[]): LpMove[] {
  const by = new Map<string, LpMove>();
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const k = `${e.signature}|${e.position}`;
    let m = by.get(k);
    if (!m) { m = { wallet, signature: e.signature, ts: e.ts, dex: e.dex, pool: e.pool, position: e.position, kinds: [], addUsd: null, removeUsd: null, lower: null, upper: null }; by.set(k, m); }
    m.pool ??= e.pool;
    if (!m.kinds.includes(e.kind)) m.kinds.push(e.kind);
    if (e.kind === "add" && e.usd != null) m.addUsd = (m.addUsd ?? 0) + e.usd;
    if (e.kind === "remove" && e.usd != null) m.removeUsd = (m.removeUsd ?? 0) + e.usd;
    if (e.lower != null && e.upper != null && (e.kind === "add" || m.lower == null)) { m.lower = e.lower; m.upper = e.upper; }
  }
  return [...by.values()].sort((a, b) => a.ts - b.ts);
}
const isEntry = (m: LpMove) => m.kinds.includes("add") || m.kinds.includes("open");
const isExit = (m: LpMove) => m.kinds.includes("remove") || m.kinds.includes("close");

// ── ranges ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The wallet's range in this pool as QUOTE-PER-TOKEN prices: DLMM bins / CLMM ticks through the pool's decimals (and bin step),
 *  full range on PumpSwap and DAMM v2 (one pool-wide range). `why` when it cannot be known. */
export function copyRange(info: Pick<PoolInfo, "dex" | "venue" | "fullRange" | "token" | "mintA" | "decimalsA" | "decimalsB">, binStep: number | null, lower: number | null, upper: number | null): { r: PriceRange; full: boolean } | { why: string } {
  if (info.fullRange) return { r: FULL_RANGE, full: true };
  if (lower == null || upper == null) return { why: "the wallet's range is not on Chord's tape" };
  if (info.decimalsA == null || info.decimalsB == null) return { why: "the pool's token decimals are unknown" };
  let ab: PriceRange;
  if (info.dex === "meteora_dlmm") {
    if (!(binStep != null && binStep > 0)) return { why: "the pool's bin step is unknown (Meteora's API did not answer)" };
    ab = dlmmRange(lower, upper, binStep, info.decimalsA, info.decimalsB);
  } else if (info.dex === "raydium_clmm") ab = clmmRange(lower, upper, info.decimalsA, info.decimalsB);
  else return { why: `${info.venue} ranges are not supported` };
  const r = info.token === info.mintA ? ab : invertRange(ab);
  if (!(r.lower > 0) || !(r.upper > r.lower) || !Number.isFinite(r.upper)) return { why: "the wallet's range is empty" };
  return { r, full: false };
}
/** "−30% / +45%", or a single-sided range: "+5% / +40%, all above the price (token only)". */
export function rangeWords(p: number, r: PriceRange, full: boolean): string {
  if (full) return "full range";
  const lo = (r.lower / p - 1) * 100, hi = (r.upper / p - 1) * 100;
  const side = p < r.lower ? ", all above the price (token only)" : p > r.upper ? ", all below the price (quote only)" : "";
  return `${signedPct(lo)} / ${signedPct(hi)}${side}`;
}
/** A converted range is believable when the price is inside it or its near bound is within 50× of the price. */
const sane = (p: number, r: PriceRange) => (p < r.lower ? r.lower / p <= RANGE_SANITY : p > r.upper ? p / r.upper <= RANGE_SANITY : true);

// ── the smart-LP board ───────────────────────────────────────────────────────────────────────────────────────────────
/** A pool seed: both sides deposited, and either both are round numbers or one side is exactly a power of ten of at least a
 *  million (a launchpad token's whole supply: 20.01 SOL + 1,000,000,000 tokens). The wallet set the starting price, i.e. it
 *  created the pool (measured 07/10: every such position of the board's top 3 was its pool's first LP event). In-ratio deposits
 *  into an existing pool are computed from the pool's ratio and are almost never that. */
const round2 = (x: number | null) => { if (!(x != null && x > 0)) return false; const m = 10 ** (Math.floor(Math.log10(x)) - 1); return Math.abs(x / m - Math.round(x / m)) < ROUND_TOL * (x / m); };
const supply = (x: number | null) => x != null && x >= 1e6 && Math.abs(x / 10 ** Math.round(Math.log10(x)) - 1) < ROUND_TOL;
export const seeded = (p: Pick<TapePosition, "depositedA" | "depositedB">) =>
  (p.depositedA ?? 0) > 0 && (p.depositedB ?? 0) > 0 && ((round2(p.depositedA) && round2(p.depositedB)) || supply(p.depositedA) || supply(p.depositedB));

const DROP = {
  onlyRemoves: "only removes or claims on the tape (creators, migrators, LPs from before the tape)",
  vault: `vault or rebalancing script (more than ${MAX_POSITIONS_A_DAY} positions a day)`,
  onePool: "one pool only (one bet, not a track record)",
  fewSeen: `fewer than ${MIN_SEEN_POSITIONS} positions seen from their first deposit`,
  small: `under ${money(MIN_DEPOSITED_USD)} put in on positions seen from the first deposit`,
  launcher: "pool launcher (opens new pools with a whole token supply or round amounts: it sets the price, a copy cannot)",
  unread: "Chord could not be read for it",
  noEdge: "no edge yet: realized ROI plus fee yield at or below zero on the positions seen",
} as const;

interface Verdict { row: SmartLp | null; drop: string | null }
/** One wallet from its positions: what the row is built on, or why it is dropped. */
export function judge(wallet: string, all: TapePosition[], o: { sinceS: number; coverageS: number | null; nowS: number; positionsAll: number }): Verdict {
  const days = Math.max(1, (o.nowS - o.sinceS) / 86_400);
  const perDay = o.positionsAll / days;
  if (perDay > MAX_POSITIONS_A_DAY) return { row: null, drop: DROP.vault };
  const seen = all.filter((p) => !p.partial && p.depositedUsd > 0 && p.lastEvent >= o.sinceS && (o.coverageS == null || p.firstEvent >= o.coverageS));
  if (!seen.length) return { row: null, drop: DROP.onlyRemoves };
  const seeds = seen.filter(seeded).length;
  if (seeds >= 2 && seeds >= seen.length / 2) return { row: null, drop: DROP.launcher };
  if (seen.length < MIN_SEEN_POSITIONS) return { row: null, drop: DROP.fewSeen };
  const pools = new Set(seen.map((p) => p.pool));
  if (pools.size < 2) return { row: null, drop: DROP.onePool };
  const dep = seen.reduce((a, p) => a + p.depositedUsd, 0);
  if (dep < MIN_DEPOSITED_USD) return { row: null, drop: DROP.small };
  const closed = seen.filter((p) => p.status === "closed" && p.realizedPnlUsd != null), open = seen.filter((p) => p.status === "open");
  const cDep = closed.reduce((a, p) => a + p.depositedUsd, 0), realized = closed.reduce((a, p) => a + (p.realizedPnlUsd ?? 0), 0);
  const wins = closed.filter((p) => (p.realizedPnlUsd ?? 0) > 0).length;
  const roi = closed.length && cDep > 0 ? realized / cDep : null;
  const oDep = open.reduce((a, p) => a + p.depositedUsd, 0), oFees = open.reduce((a, p) => a + p.feesClaimedUsd, 0);
  const fees = seen.reduce((a, p) => a + p.feesClaimedUsd, 0);
  // luck shrink: n / (n + 3) on both parts; a profitable ROI also weighs by a shrunk win rate (0.35 + 0.65 × (wins + 1.5) / (n + 3))
  const nC = closed.length, nO = open.length;
  const winAdj = (wins + PRIOR_POSITIONS / 2) / (nC + PRIOR_POSITIONS);
  const roiPart = roi == null ? 0 : Math.max(-1, Math.min(1, roi)) * (nC / (nC + PRIOR_POSITIONS)) * (roi > 0 ? 0.35 + 0.65 * winAdj : 1);
  const feePart = oDep > 0 ? Math.min(1, oFees / oDep) * (nO / (nO + PRIOR_POSITIONS)) : 0;
  const holds = closed.map((p) => (p.closedAt ?? p.lastEvent) - (p.openedAt ?? p.firstEvent)).filter((s) => s >= 0);
  const byPool = new Map<string, { dep: number; pair: string }>();
  for (const p of seen) {
    const pair = `${p.symbolA ?? short(p.mintA ?? "?")}-${p.symbolB ?? short(p.mintB ?? "?")}`;
    byPool.set(p.pool, { dep: (byPool.get(p.pool)?.dep ?? 0) + p.depositedUsd, pair });
  }
  return {
    drop: null,
    row: {
      wallet, score: r2((roiPart + feePart) * 100), positions: seen.length, positionsAll: o.positionsAll, closed: nC, open: nO, pools: pools.size,
      pairs: [...byPool.values()].sort((a, b) => b.dep - a.dep).slice(0, 3).map((x) => x.pair), venues: [...new Set(seen.map((p) => venueLabel(p.dex)))],
      depositedUsd: r2(dep), feesUsd: r2(fees), feeYieldPct: r2((fees / dep) * 100), realizedUsd: closed.length ? r2(realized) : null, roiPct: roi != null ? r2(roi * 100) : null,
      winRate: nC ? Math.round((wins / nC) * 1000) / 1000 : null, medianHoldS: median(holds), positionsPerDay: r2(perDay), lastEventAt: Math.max(...seen.map((p) => p.lastEvent)) * 1000,
    },
  };
}

type Built = Omit<SmartLpBoard, "days" | "rows"> & { all: SmartLp[] };
type BoardEntry = { at: number; p: Promise<Built>; coverage: number | null };
const boards = new Map<number, BoardEntry>();

async function buildBoard(hours: number, d: LpDeps): Promise<Built> {
  const nowS = Math.floor(d.now() / 1000), windowS = nowS - hours * 3600;
  const tops = await Promise.all((["fees", "deposits", "pnl"] as const).map((s) => gated(() => d.chord<any>(`/v1/chains/solana/lp/top?sort=${s}&limit=100&hours=${hours}`, 5 * 60_000))));
  const lists = tops.map((j) => (Array.isArray(j?.rows) ? (j.rows as any[]).map(topRow).filter((r): r is TopRow => !!r) : []));
  if (!lists.some((l) => l.length)) throw new Error("Chord's Solana LP leaderboard answered without rows");
  const sinceS = Math.max(windowS, ...tops.map((j) => num(j?.since) ?? 0));
  const coverageS = coverageOf(Math.max(...tops.map((j) => num(j?.since) ?? 0)), windowS);
  const days = Math.max(1, (nowS - sinceS) / 86_400);
  const byWallet = new Map<string, TopRow>();
  for (const l of lists) for (const r of l) if (!byWallet.has(r.wallet)) byWallet.set(r.wallet, r);
  const dropped = new Map<string, string>();
  // first cut on Chord's own totals (every position active in the window, those from before the tape too): cheap, no reads
  const survivors: TopRow[] = [];
  for (const r of byWallet.values()) {
    const why = r.depositedUsd <= 0 ? DROP.onlyRemoves : r.positions / days > MAX_POSITIONS_A_DAY ? DROP.vault : r.pools < 2 ? DROP.onePool
      : r.positions < MIN_SEEN_POSITIONS ? DROP.fewSeen : r.depositedUsd < MIN_DEPOSITED_USD ? DROP.small : null;
    if (why) dropped.set(r.wallet, why); else survivors.push(r);
  }
  const proxy = (r: TopRow) => (r.feesClaimedUsd + Math.max(0, r.realizedPnlUsd ?? 0)) / Math.max(r.depositedUsd, MIN_DEPOSITED_USD);
  const pnlTop = lists[2].slice(0, 5);
  const toRead = [...new Set([...survivors.sort((a, b) => proxy(b) - proxy(a)).slice(0, READ_MAX).map((r) => r.wallet), ...pnlTop.filter((r) => !dropped.has(r.wallet)).map((r) => r.wallet)])];
  const notes: string[] = [];
  const rows: SmartLp[] = [];
  let unread = 0;
  await mapLimit(toRead, CHORD_CONCURRENCY, async (w) => {
    let pos: TapePosition[];
    try { pos = await walletPositions(d, w); }
    catch { dropped.set(w, DROP.unread); unread++; return; }
    const v = judge(w, pos, { sinceS, coverageS, nowS, positionsAll: byWallet.get(w)?.positions ?? pos.length });
    if (v.row && v.row.score > 0) rows.push(v.row); else dropped.set(w, v.drop ?? DROP.noEdge);
  });
  rows.sort((a, b) => b.score - a.score || b.depositedUsd - a.depositedUsd);
  const counts = new Map<string, number>();
  for (const why of dropped.values()) counts.set(why, (counts.get(why) ?? 0) + 1);
  const rank = new Map(rows.map((r, i) => [r.wallet, i + 1]));
  const trap = pnlTop.map((t) => {
    const at = rank.get(t.wallet), row = at ? rows[at - 1] : null;
    return {
      wallet: t.wallet, chordRealizedPnlUsd: t.realizedPnlUsd != null ? r2(t.realizedPnlUsd) : null, chordWinRate: t.winRate, chordDepositedUsd: r2(t.depositedUsd), chordWithdrawnUsd: r2(t.withdrawnUsd),
      verdict: row ? `rank ${at} here: score ${row.score}, built on ${plural(row.positions, "position")}${row.realizedUsd != null ? `, realized ${money(row.realizedUsd)}` : ""}` : `dropped: ${dropped.get(t.wallet) ?? `not read (outside the ${READ_MAX} wallets read)`}`,
    };
  });
  if (coverageS != null) notes.push(`Chord's Solana LP tape starts ${utc(coverageS * 1000)}: this board covers ${hoursText((nowS - coverageS) / 3600)}, not the whole window asked.`);
  notes.push("Built only on positions the tape saw from their first deposit. Chord's raw sort=pnl also counts what a wallet withdraws from a position opened before the tape (a $0 deposit), which reads as pure profit; those wallets are in `trap` with what this board made of them.");
  notes.push(`Score = luck-shrunk realized ROI of closed positions (× a win-rate skill factor, positive ROI only) + luck-shrunk claimed-fee yield of open positions, in % points; shrink = n / (n + ${PRIOR_POSITIONS}). Fees are what the wallet CLAIMED on Chord's tape; unclaimed fees are not seen.`);
  notes.push(`Candidates: Chord's top 100 LP wallets by claimed fees, deposits and realized PnL over the window (${byWallet.size} wallets); ${toRead.length} read position by position${unread ? ` (${unread} could not be read)` : ""}, the rest dropped on Chord's own totals.`);
  notes.push("Past LP results on a young tape: a few positions per wallet, many in pools that launched hours ago. Copy in paper first and read each wallet's pools.");
  return {
    windowHours: hours, since: sinceS * 1000, coverageStart: coverageS != null ? coverageS * 1000 : null, all: rows,
    dropped: [...counts.entries()].map(([reason, wallets]) => ({ reason, wallets })).sort((a, b) => b.wallets - a.wallets), trap,
    candidates: byWallet.size, read: toRead.length, notes, at: d.now(),
  };
}

/** The smart-LP board over 1 / 3 / 7 days, best first (cached 10 min; while Chord's LP coverage is younger than the window, the
 *  windows share one build). */
export async function smartLps(daysIn: unknown, limit: unknown, d: LpDeps): Promise<SmartLpBoard> {
  const days = validateDays(daysIn ?? 3);
  const n = Math.max(1, Math.min(50, Math.floor(Number(limit ?? 20)) || 20));
  const now = d.now();
  for (const [k, v] of boards) if (now - v.at > BOARD_TTL_MS) boards.delete(k);
  // a build whose window was clipped by the coverage start serves every window that starts before that coverage too
  let hit = boards.get(days) ?? [...boards.values()].find((v) => v.coverage != null && v.coverage >= now - days * 86_400_000);
  if (!hit) {
    const e: BoardEntry = { at: now, p: buildBoard(days * 24, d), coverage: null };
    boards.set(days, e);
    e.p.then((b) => { e.coverage = b.coverageStart; }, () => { if (boards.get(days) === e) boards.delete(days); });
    hit = e;
  }
  const b = await hit.p;
  return { ...b, all: undefined, days, rows: b.all.slice(0, n) } as SmartLpBoard;
}

// ── the copy agent ───────────────────────────────────────────────────────────────────────────────────────────────────
export const COPY_OUT_NOTE = "Copy mode never rebalances on its own: the position moves when the copied wallet moves.";
export const initialFollow = (c: LpCopyRules, since: number): LpFollowState => ({
  wallets: c.smartLps ? [] : [...c.wallets], from: c.smartLps ? "smart" : "given", board: c.smartLps, resolvedAt: null, picked: [], since,
  cursors: {}, lastPollAt: null, pollErrors: {}, moves: 0, copied: 0, skipped: 0,
});

/** Settle which wallets the agent copies: the ones given, or the smart-LP board's top N right now (kept until deleted). */
export async function copyStart(botId: string, c: LpCopyRules, d: LpDeps, hooks: LpHooks): Promise<void> {
  if (!botRow(botId)) return;
  const now = d.now();
  const f = lpFollowOf(botId) ?? initialFollow(c, now);
  if (f.resolvedAt) return;
  if (c.smartLps) {
    let board: SmartLpBoard;
    try { board = await smartLps(c.smartLps.days, 10, d); }
    catch (e) { return hooks.stop(botId, "error", "error", `Could not read the smart-LP board on Chord (${errText(e).slice(0, 120)}). Resume the agent to try again.`, errText(e)); }
    const picked = board.rows.slice(0, c.smartLps.top);
    if (!picked.length) return hooks.stop(botId, "stopped", "warn", `No wallet passes the smart-LP rules right now (${board.candidates} candidates on Chord's tape). Resume later, or give the wallets to copy.`, "no smart LP to copy");
    f.wallets = picked.map((r) => r.wallet);
    f.picked = picked.map((r) => ({ wallet: r.wallet, score: r.score, positions: r.positions }));
  }
  f.resolvedAt = now;
  if (!botRow(botId)) return;
  saveLpFollow(botId, f, now);
  const who = c.smartLps ? `the top ${plural(f.wallets.length, "wallet")} of the smart-LP board (${c.smartLps.days} d): ${f.picked.map((p) => `${short(p.wallet)} (score ${p.score}, ${plural(p.positions, "position")})`).join(", ")}` : `${plural(f.wallets.length, "wallet")}: ${f.wallets.map(short).join(", ")}`;
  logEvent(botId, "info", `Following ${who}. Each LP add from now on opens a ${money(c.amountUsd)} paper position in the same pool with the same range (at most ${c.maxOpenPositions} open, pools with ${money(c.minPoolTvlUsd)} TVL or more)${c.followRemoves ? "; their removes close it" : "; removes are not followed (exit rules only)"}. Checked every minute.`, now);
  publishStats(botId);
}

/** Each wallet's newest LP events (≤ 4 wallets at a time), newest first, or the error. */
export async function pollWallets(wallets: string[], d: LpDeps): Promise<Map<string, TapeEvent[] | Error>> {
  const out = new Map<string, TapeEvent[] | Error>();
  await mapLimit([...new Set(wallets)], CHORD_CONCURRENCY, async (w) => {
    try {
      const j = await gated(() => d.chord<any>(eventsPath(w, POLL_LIMIT, null), 20_000));
      if (!Array.isArray(j?.events)) throw new Error("Chord's LP events answer had no list");
      out.set(w, (j.events as any[]).map(tapeEvent).filter((e): e is TapeEvent => !!e));
    } catch (e) { out.set(w, e instanceof Error ? e : new Error(String(e))); }
  });
  return out;
}

/** Mints of every open copied position, for the tick's one batched price call. */
export function copyMints(botIds: string[]): string[] {
  const s = new Set<string>();
  for (const id of botIds) for (const st of lpCopyStatesOf(id)) if (st.status === "open") { s.add(st.token); s.add(st.quote); }
  return [...s];
}

const evKey = (e: TapeEvent) => `${e.signature}:${e.kind}:${e.position}`;
/** The wallet's events this agent has not read yet (newer than its cursor), and the cursor moved past them. */
function unread(f: LpFollowState, wallet: string, events: TapeEvent[]): TapeEvent[] {
  const cur = f.cursors[wallet];
  const fresh = events.filter((e) => !cur || e.ts > cur.ts || (e.ts === cur.ts && !cur.keys.includes(evKey(e))));
  if (fresh.length) {
    const top = Math.max(...events.map((e) => e.ts));
    f.cursors[wallet] = { ts: top, keys: [...new Set([...(cur && cur.ts === top ? cur.keys : []), ...events.filter((e) => e.ts === top).map(evKey)])].slice(-200) };
  }
  return fresh;
}

const skipRate = new Map<string, { m: number; n: number }>();
const pollWarned = new Map<string, number>();
/** A skipped copy (the check that said no is the reason), at most 20 a minute per agent. Null when already answered. */
function skip(botId: string, c: LpCopyRules, f: LpFollowState, mv: LpMove & { pool: string }, symbol: string | null, reason: string, now: number): Fill | null {
  const bot = botRow(botId);
  if (!bot) return null;
  const source = moveSource(mv, "buy", mv.pool, symbol, null);
  if (hasFill(botId, sourceKey(source))) return null;
  const m = Math.floor(now / 60_000), r = skipRate.get(botId);
  if (r && r.m === m && r.n >= SKIPS_PER_MIN) return null;
  skipRate.set(botId, r && r.m === m ? { m, n: r.n + 1 } : { m, n: 1 });
  const fill: Fill = { id: randomBytes(6).toString("hex"), botId, ts: now, side: "buy", mint: mv.pool, symbol, usd: c.amountUsd, tokenAmount: 0, priceUsd: null,
    status: "skipped", reason, pnlUsd: null, quote: null, source, mode: bot.mode, kind: "open" };
  if (!insertFill(fill)) return null;
  f.skipped++;
  emit(botId, { type: "fill", fill });
  return fill;
}
function moveSource(mv: LpMove, side: "buy" | "sell", pool: string, symbol: string | null, priceUsd: number | null, words?: string): SourceTrade {
  const pair = symbol ?? short(pool);
  const usd = side === "buy" ? mv.addUsd : mv.removeUsd;
  const detail = words ?? (side === "buy"
    ? `copied LP ${short(mv.wallet)}: ${mv.addUsd != null ? `added ${money(mv.addUsd)} to` : "opened a position in"} ${pair}`
    : `copied LP ${short(mv.wallet)}: ${mv.kinds.includes("close") ? "closed its position in" : `removed ${usd != null ? money(usd) : "liquidity"} from`} ${pair}`);
  return { wallet: mv.wallet, tx: mv.signature, side, mint: pool, symbol, usd: usd != null ? r2(usd) : null, priceUsd, ts: mv.ts * 1000, via: "lp", detail };
}
const lagText = (now: number, tsS: number) => { const s = Math.max(0, Math.round(now / 1000 - tsS)); return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`; };

/** Open a copy of the wallet's add, or say (a skipped fill) which check said no. */
async function copyEntry(botId: string, c: LpCopyRules, f: LpFollowState, mv: LpMove & { pool: string }, d: LpDeps, g: LpDeps, now: number): Promise<void> {
  const held = lpCopyStateOf(botId, mv.pool);
  const sym0 = held?.pair ?? null;
  if (hasFill(botId, sourceKey(moveSource(mv, "buy", mv.pool, null, null)))) return; // this transaction already answered (other positions of it)
  if (held?.status === "open") { skip(botId, c, f, mv, sym0, `already holds ${held.pair} (one position per pool)`, now); return; }
  const open = lpCopyStatesOf(botId).filter((s) => s.status === "open").length;
  if (open >= c.maxOpenPositions) { skip(botId, c, f, mv, sym0, `max open positions (${c.maxOpenPositions}) reached`, now); return; }
  if (!(LP_VENUES as readonly string[]).includes(mv.dex)) { skip(botId, c, f, mv, sym0, `unsupported venue (${mv.dex}): the LP agent models Meteora DLMM / DAMM v2, Raydium CLMM and PumpSwap`, now); return; }
  if (!(c.venues as string[]).includes(mv.dex)) { skip(botId, c, f, mv, sym0, `${venueLabel(mv.dex)} is not one of this agent's venues`, now); return; }
  let info: PoolInfo;
  try { info = await poolInfo(g, mv.pool); }
  catch (e) { skip(botId, c, f, mv, sym0, (e as Error)?.name === "BotInputError" ? "pool not on Chord's LP tape" : `Chord could not be read for the pool (${errText(e).slice(0, 80)})`, now); return; }
  const venue = await venueStats(g, info.dex, info.pool, info.token);
  const v = venue.v;
  const tvl = v?.tvlUsd ?? info.tvlUsd;
  if (c.minPoolTvlUsd > 0 && tvl == null) { skip(botId, c, f, mv, info.pair, `pool TVL unknown (${venue.err ?? "no venue answer"}), the floor is ${money(c.minPoolTvlUsd)}`, now); return; }
  if (tvl != null && tvl < c.minPoolTvlUsd) { skip(botId, c, f, mv, info.pair, `pool TVL ${money(tvl)} is under the ${money(c.minPoolTvlUsd)} floor`, now); return; }
  if (c.exits.lpExodus && isExodus(info.lastHour.depositsUsd, info.lastHour.withdrawalsUsd)) { skip(botId, c, f, mv, info.pair, `flag: LP exodus on the pool right now (${money(info.lastHour.withdrawalsUsd)} out vs ${money(info.lastHour.depositsUsd)} in over the last hour)`, now); return; }
  const sym = info.tokenSymbol ?? short(info.token);
  if (c.safety) {
    const s = await safetyIssue(d, info.token, sym);
    if (s) { skip(botId, c, f, mv, info.pair, "refuse" in s ? `safety: ${s.refuse}` : `safety unchecked: ${s.fail}`, now); return; }
  }
  // bounds: from the move, else the wallet's position on the tape (one read)
  let lower = mv.lower, upper = mv.upper;
  if (!info.fullRange && (lower == null || upper == null)) {
    try { const p = (await walletPositions(d, mv.wallet)).find((x) => x.position === mv.position); lower = p?.lower ?? null; upper = p?.upper ?? null; } catch { /* range stays unknown */ }
  }
  const rg = copyRange(info, v?.binStep ?? null, lower, upper);
  if ("why" in rg) { skip(botId, c, f, mv, info.pair, `range unknown: ${rg.why}`, now); return; }
  const px = await d.prices([info.token, info.quote]).catch(() => new Map<string, number>());
  const live = livePair(px, info);
  if (!live) { skip(botId, c, f, mv, info.pair, `no USD price for ${info.pair} (Jupiter has none and Chord's pool price is missing)`, now); return; }
  const p0 = live.tokenUsd / live.quoteUsd;
  if (!rg.full && !sane(p0, rg.r)) { skip(botId, c, f, mv, info.pair, `range unknown: the wallet's bounds sit more than ${RANGE_SANITY}× from the price (${priceText(p0)}), the tape and the pool do not agree`, now); return; }
  if (!botRow(botId)) return;
  const L = liquidityForAny(c.amountUsd / live.quoteUsd, p0, rg.r);
  const a = amountsAt(L, p0, rg.r);
  const inR = inRange(p0, rg.r);
  const words = rangeWords(p0, rg.r, rg.full);
  let st: LpState = freshState(info, now);
  st = {
    ...st, status: "open", range: stateRange(p0, rg.r, { preset: null, rangePct: null }, null, rg.full), liquidity: L,
    leg: { openedAt: now, costUsd: c.amountUsd, tokenAmount: a.token, quoteAmount: a.quote, price: p0, feesUsd: 0 },
    first: { openedAt: now, amountUsd: c.amountUsd, tokenAmount: a.token, quoteAmount: a.quote, tokenUsd: live.tokenUsd, quoteUsd: live.quoteUsd },
    feeApr: { pct: v?.feeAprPct ?? null, source: v ? `${v.source}: ${v.feeAprHow}` : (venue.err ?? "no venue API"), at: now }, feeRatePct: v?.feeRatePct ?? null,
    inRange: inR, outSince: inR ? null : now,
    mark: { ts: now, price: p0, tokenUsd: live.tokenUsd, quoteUsd: live.quoteUsd, valueUsd: c.amountUsd, equityUsd: c.amountUsd, hodlUsd: c.amountUsd, quoteOnlyUsd: c.amountUsd, ilUsd: 0, vsHodlUsd: 0 },
    exodus: { checkedAt: now, ...info.lastHour }, warned: { point: now },
    copied: { wallet: mv.wallet, position: mv.position, tx: mv.signature, ts: mv.ts * 1000, usd: mv.addUsd, removedUsd: 0 },
  };
  const bounds = rg.full ? `full range (${info.venue} pools have no range to choose)` : `${priceText(rg.r.lower)}–${priceText(rg.r.upper)} ${info.quoteSymbol ?? "quote"} per ${sym} (${words})`;
  const detail = `copied LP ${short(mv.wallet)}: ${mv.addUsd != null ? `added ${money(mv.addUsd)} to` : "opened a position in"} ${info.pair} (${rg.full ? "full range" : `range ${words}`})`;
  const fill = recordLp(botId, "open", st, {
    ts: now, usd: c.amountUsd, tokenAmount: a.token, tokenUsd: live.tokenUsd, pnlUsd: null, quote: null,
    reason: `Copied ${short(mv.wallet)}: open ${info.pair} on ${info.venue}, ${bounds}, at ${priceText(p0)} ${info.quoteSymbol ?? "quote"} per ${sym}, ${lagText(now, mv.ts)} after its add`,
  }, moveSource(mv, "buy", info.pool, info.pair, live.tokenUsd, detail));
  if (!fill) return;
  setPosition(botId, { mint: info.pool, symbol: `${info.pair} LP`, qty: c.amountUsd, costUsd: c.amountUsd, priceUsd: 1, openedAt: now, ts: now });
  saveLpCopyState(botId, st, now);
  f.copied++;
  logEvent(botId, "info", `Copied ${short(mv.wallet)} into ${info.pair} (${info.venue}): ${money(c.amountUsd)} on ${bounds}, ${lagText(now, mv.ts)} after its ${mv.addUsd != null ? `${money(mv.addUsd)} add` : "open"}. Holds ${a.token.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${sym} + ${a.quote.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${info.quoteSymbol ?? "quote"} (prices: ${live.source}). Fee APR ${st.feeApr.pct != null ? `${pctText(st.feeApr.pct)}, an estimate counted only while in range` : "unknown: fees are not counted"}.`, now);
}

/** The wallet took liquidity out of a pool the agent copied from it: close once it took out half its deposit or closed. */
function copyExit(botId: string, c: LpCopyRules, mv: LpMove, marks: Map<string, Pxs>, now: number): void {
  if (!c.followRemoves) return;
  const st = lpCopyStatesOf(botId).find((s) => s.status === "open" && s.copied?.wallet === mv.wallet && s.copied.position === mv.position);
  const cp = st?.copied;
  if (!st || !cp || mv.ts * 1000 < cp.ts) return;
  cp.removedUsd += mv.removeUsd ?? 0;
  const closes = mv.kinds.includes("close") || cp.usd == null || !(cp.usd > 0) || cp.removedUsd >= CLOSE_SHARE * cp.usd;
  if (!closes) {
    saveLpCopyState(botId, st, now);
    logEvent(botId, "info", `${short(mv.wallet)} took ${money(mv.removeUsd ?? 0)} out of ${st.pair} (${pctText((cp.removedUsd / cp.usd!) * 100)} of its deposit so far): the copy stays until it takes out half or closes.`, now);
    return;
  }
  const m = marks.get(st.pool);
  const pxs: Pxs = m ?? { p: st.mark!.price, tokenUsd: st.mark!.tokenUsd, quoteUsd: st.mark!.quoteUsd };
  const what = mv.kinds.includes("close") ? "closed its position" : `took out ${money(cp.removedUsd)} of its ${money(cp.usd!)}`;
  const why = `the copied wallet ${short(mv.wallet)} ${what} in ${st.pair}`;
  const res = closeLpPosition(botId, st, pxs, why, now, (s, t) => saveLpCopyState(botId, s, t), {
    source: moveSource(mv, "sell", st.pool, st.pair, pxs.tokenUsd),
    reason: `Copied ${short(mv.wallet)}: close ${st.pair}, ${lagText(now, mv.ts)} after it ${what}${m ? "" : ` (valued at the last mark, ${utc(st.mark!.ts)}: no price this minute)`}`,
  });
  if (res) logEvent(botId, "info", `Copied an exit: ${why}. Withdrew ${money(res.value)} at the market (${withdrawText(st, res.a)}, no swap), ${res.pnl >= 0 ? "+" : ""}${money(res.pnl)} on this position.`, now);
}

/** One minute of a copy agent: mark every open position, run the exit rules (running only), then copy the wallets' new moves. */
export async function copyStep(botId: string, px: Map<string, number>, polled: Map<string, TapeEvent[] | Error> | null, d: LpDeps, hooks: LpHooks): Promise<void> {
  const bot = botRow(botId);
  if (!bot || bot.type !== "lp" || (bot.params as LpCopyRules).mode !== "copy") return;
  const c = bot.params as LpCopyRules;
  const now = d.now();
  const g = gatedDeps(d);
  const running = hooks.isRunning(botId);
  const save = (s: LpState, t: number) => saveLpCopyState(botId, s, t);
  const marks = new Map<string, Pxs>();
  const open = lpCopyStatesOf(botId).filter((s) => s.status === "open");
  for (const st of open) {
    const m = await markLp(botId, st, px, g, now, { outNote: running ? COPY_OUT_NOTE : "The agent is paused: nothing is copied or closed.", points: false, save });
    if (m) marks.set(st.pool, m.pxs);
  }
  if (!botRow(botId)) return;
  for (const st of open) save(st, now);
  if (running && open.length) {
    if (c.exits.dailyLossStopUsd != null) {
      const loss = todayLoss(botId, now);
      if (loss >= c.exits.dailyLossStopUsd) {
        const why = `daily loss stop: today's loss ${money(loss)} reached the ${money(c.exits.dailyLossStopUsd)} stop`;
        let out = 0;
        for (const st of open) { const pxs = marks.get(st.pool) ?? { p: st.mark!.price, tokenUsd: st.mark!.tokenUsd, quoteUsd: st.mark!.quoteUsd }; out += closeLpPosition(botId, st, pxs, why, now, save)?.value ?? 0; }
        return hooks.stop(botId, "stopped", "warn", `Exited every copied position: ${why}. Withdrew ${money(out)} at the market (no swap). The agent stopped; resume it to copy again.`, null);
      }
    }
    for (const st of open) {
      const pxs = marks.get(st.pool);
      if (!pxs) continue;
      const why = await positionExit(botId, st, pxs.tokenUsd, c.exits, g, now);
      if (!why || !botRow(botId)) continue;
      const res = closeLpPosition(botId, st, pxs, why, now, save);
      if (res) logEvent(botId, "warn", `Exited ${st.pair}: ${why}. Withdrew ${money(res.value)} at the market (${withdrawText(st, res.a)}, no swap), ${res.pnl >= 0 ? "+" : ""}${money(res.pnl)} on this position. The agent keeps copying.`, now);
    }
  }
  const f = lpFollowOf(botId);
  if (running && f?.resolvedAt && polled) {
    const fresh: LpMove[] = [];
    for (const w of f.wallets) {
      const r = polled.get(w);
      if (!r) continue;
      if (r instanceof Error) {
        f.pollErrors[w] = errText(r).slice(0, 160);
        const k = `${botId}:${w}`;
        if (now - (pollWarned.get(k) ?? 0) >= POLL_WARN_MS) { pollWarned.set(k, now); logEvent(botId, "warn", `Could not read ${short(w)}'s LP events on Chord (${errText(r).slice(0, 100)}): retried every minute.`, now); }
        continue;
      }
      delete f.pollErrors[w];
      fresh.push(...toMoves(w, unread(f, w, r)));
    }
    fresh.sort((a, b) => a.ts - b.ts);
    for (const mv of fresh) {
      if (!botRow(botId) || !hooks.isRunning(botId)) break;
      if (isExit(mv)) copyExit(botId, c, mv, marks, now);
      if (isEntry(mv) && mv.ts * 1000 >= f.since - 1_000) { f.moves++; if (mv.pool) await copyEntry(botId, c, f, mv as LpMove & { pool: string }, d, g, now); }
      else if (isExit(mv) && mv.ts * 1000 >= f.since - 1_000) f.moves++;
    }
    f.lastPollAt = now;
    if (botRow(botId)) saveLpFollow(botId, f, now);
  }
  if (!botRow(botId)) return;
  publishStats(botId);
}

// ── backtest ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const EVENT_PAGES = 5;
const BT_POOLS = 20;
interface PoolCtx { info: PoolInfo; v: VenueStats | null; venueErr: string | null; path: PricePoint[]; flows: Map<number, { depositsUsd: number; withdrawalsUsd: number }> | null; safety: string | null }
interface SimPos {
  pool: string; ctx: PoolCtx; wallet: string; position: string; tx: string; depositUsd: number | null; removedUsd: number;
  openedS: number; r: PriceRange; full: boolean; L: number; a0: { token: number; quote: number }; tokenUsd0: number; amount: number;
  fees: number; inS: number; trackedS: number; lastT: number; lastIn: boolean; closed: { ts: number; reason: string; value: number; pnl: number } | null;
}
/** The price point in force at unix second t (the last close at or before it), or null before the first candle. */
const at = (path: PricePoint[], t: number): PricePoint | null => {
  let lo = 0, hi = path.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (path[m].t <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? path[best] : null;
};

/** Every event of the wallet since `fromS` (newest pages first, at most 5 × 200), and whether the pages ran out first. */
async function walletEvents(d: LpDeps, w: string, fromS: number): Promise<{ events: TapeEvent[]; capped: boolean }> {
  const events: TapeEvent[] = [];
  let before: number | null = null;
  for (let page = 0; page < EVENT_PAGES; page++) {
    const j = await gated(() => d.chord<any>(eventsPath(w, 200, before), 5 * 60_000));
    const list = (Array.isArray(j?.events) ? (j.events as any[]) : []).map(tapeEvent).filter((e): e is TapeEvent => !!e);
    events.push(...list);
    const next = num(j?.nextBefore);
    if (!list.length || next == null || list[list.length - 1].ts < fromS) return { events: events.filter((e) => e.ts >= fromS), capped: false };
    before = next;
  }
  return { events: events.filter((e) => e.ts >= fromS), capped: true };
}

/** Replay the followed wallets' LP moves of the last 1 / 3 / 7 days with the copy rules, on Chord's 5 / 15 minute closes. */
export async function lpCopyBacktest(input: unknown, d: LpDeps): Promise<LpCopyBacktest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BotInputError("lp copy backtest needs { wallets | smartLps, amountUsd, maxOpenPositions?, minPoolTvlUsd?, venues?, followRemoves?, exits?, days }");
  const { days: rawDays, ...rest } = input as Record<string, unknown>;
  const days = validateDays(rawDays);
  const c = validateLpCopyParams({ ...rest, mode: "copy" });
  const nowS = Math.floor(d.now() / 1000);
  const notes: string[] = [];
  let wallets = c.wallets, walletsFrom = `${plural(wallets.length, "wallet")} given`, coverageS: number | null = null;
  if (c.smartLps) {
    const b = await smartLps(c.smartLps.days, 10, d);
    wallets = b.rows.slice(0, c.smartLps.top).map((r) => r.wallet);
    walletsFrom = `the top ${wallets.length} of the smart-LP board (${c.smartLps.days} d) today`;
    coverageS = b.coverageStart != null ? b.coverageStart / 1000 : null;
    if (!wallets.length) throw new BotInputError("no wallet passes the smart-LP rules right now: give the wallets to copy");
    notes.push("The wallets were picked by today's board, which ranks them on the same days it replays: a look-ahead, so the replay flatters them.");
  }
  const g = gatedDeps(d);
  if (coverageS == null) coverageS = await lpSince(g); // given wallets: when Chord's LP decoding started (null = older than 7 days)
  const fromS = Math.max(nowS - days * 86_400, coverageS ?? 0);
  if (fromS > nowS - days * 86_400) notes.push(`Chord's Solana LP tape starts ${utc(fromS * 1000)}: ${hoursText((nowS - fromS) / 3600)} replayed, not ${days * 24} h.`);
  const stepS = days === 1 ? 300 : 900;

  // each wallet's events, once more after 2 s when Chord times out; a wallet that still cannot be read is named (`unread`)
  const read = await mapLimit(wallets, CHORD_CONCURRENCY, async (w) => {
    for (let attempt = 0; ; attempt++) {
      try { return { w, ...(await walletEvents(d, w, fromS)), err: null as string | null }; }
      catch (e) { if (attempt === 0) { await new Promise((r) => setTimeout(r, 2_000)); continue; } return { w, events: [] as TapeEvent[], capped: false, err: errText(e) }; }
    }
  });
  const unread = read.filter((r) => r.err != null);
  if (unread.length === read.length) throw new Error(`Chord's LP events could not be read for ${unread.length === 1 ? "the wallet" : `any of the ${unread.length} wallets`} (${String(unread[0]?.err).slice(0, 120)}): nothing to replay, try again in a minute`);
  const moves = read.flatMap((r) => toMoves(r.w, r.events)).sort((a, b) => a.ts - b.ts);
  for (const r of read) {
    if (r.err != null) notes.push(`${short(r.w)}: its LP events could not be read on Chord (${r.err.slice(0, 100)}), so its moves are not in this replay.`);
    else if (r.capped) notes.push(`${short(r.w)}: more than ${EVENT_PAGES * 200} LP events in the window; only the newest ${EVENT_PAGES * 200} were replayed.`);
  }

  // the pools the entries would open (supported venues only), read once each: pool facts, venue, candles, hourly flows, safety
  const want = [...new Set(moves.filter((m) => isEntry(m) && m.pool && (c.venues as string[]).includes(m.dex)).map((m) => m.pool!))];
  if (want.length > BT_POOLS) notes.push(`The wallets entered ${want.length} pools; the first ${BT_POOLS} were read, later entries elsewhere count as skipped.`);
  const ctx = new Map<string, PoolCtx | { err: string }>();
  const readErrs: string[] = [];
  const load = async (pool: string): Promise<PoolCtx> => {
    const info = await poolInfo(g, pool);
    const [venue, path, hourly, safe] = await Promise.all([
      venueStats(g, info.dex, info.pool, info.token),
      pricePath(g, info, (nowS - fromS) / 3600 + 1, stepS),
      poolHourly(g, info.pool, Math.ceil((nowS - fromS) / 3600) + 1).catch(() => null),
      c.safety ? safetyIssue(g, info.token, info.tokenSymbol ?? short(info.token)) : Promise.resolve(null),
    ]);
    return { info, v: venue.v, venueErr: venue.err, path: path.points, flows: hourly?.byHour ?? null, safety: safe ? ("refuse" in safe ? `safety: ${safe.refuse}` : `safety unchecked: ${safe.fail}`) : null };
  };
  await mapLimit(want.slice(0, BT_POOLS), 2, async (pool) => {
    for (let attempt = 0; ; attempt++) {
      try { ctx.set(pool, await load(pool)); return; }
      catch (e) {
        if ((e as Error)?.name === "BotInputError") { ctx.set(pool, { err: "pool not on Chord's LP tape" }); return; }
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 2_000)); continue; } // Chord's heavy candle reads time out under load: once more
        readErrs.push(`${short(pool)}: ${errText(e).slice(0, 140)}`);
        ctx.set(pool, { err: "Chord could not be read for the pool (candles or LP data)" });
        return;
      }
    }
  });
  if (readErrs.length) notes.push(`${plural(readErrs.length, "pool")} could not be read on Chord (twice), their entries count as skipped: ${readErrs.slice(0, 3).join("; ")}.`);
  /** The pool's TVL at the end of the move's hour: today's TVL plus the LP withdrawals minus the deposits since (Chord's hourly flows;
   *  price moves since then are not in it). Today's TVL when the flows could not be read. */
  const tvlAt = (k: PoolCtx, tS: number): number | null => {
    const now = k.v?.tvlUsd ?? k.info.tvlUsd;
    if (now == null || !k.flows) return now;
    let back = 0;
    for (const [h, f] of k.flows) if (h > Math.floor(tS / 3600) * 3600) back += f.withdrawalsUsd - f.depositsUsd;
    return Math.max(0, now + back);
  };
  const positionsOf = new Map<string, TapePosition[]>();
  const boundsOf = async (mv: LpMove): Promise<{ lower: number | null; upper: number | null }> => {
    if (mv.lower != null && mv.upper != null) return { lower: mv.lower, upper: mv.upper };
    if (!positionsOf.has(mv.wallet)) positionsOf.set(mv.wallet, await walletPositions(d, mv.wallet).catch(() => []));
    const p = positionsOf.get(mv.wallet)!.find((x) => x.position === mv.position);
    return { lower: p?.lower ?? null, upper: p?.upper ?? null };
  };

  const held = new Map<string, SimPos>();
  const all: SimPos[] = [];
  const fills: LpCopyBacktest["fills"] = [];
  const skips = new Map<string, number>();
  const skipped = (why: string) => skips.set(why, (skips.get(why) ?? 0) + 1);
  let entries = 0, realized = 0, peak = 0, maxDd = 0;
  const equity: LpCopyBacktest["equity"] = [];
  const YEAR_S = 365 * 86_400;
  const valueOf = (s: SimPos, pt: PricePoint) => valueAt(s.L, pt.p, s.r) * pt.quoteUsd;
  /** Move a position's clock to t: fees for the time in range (half credit across a bound), at the price in force at t. */
  const advance = (s: SimPos, t: number) => {
    if (s.closed || t <= s.lastT) return;
    const pt = at(s.ctx.path, t);
    if (!pt) return;
    const inNow = inRange(pt.p, s.r), credit = ((s.lastIn ? 1 : 0) + (inNow ? 1 : 0)) / 2, dt = t - s.lastT;
    const apr = s.ctx.v?.feeAprPct;
    if (apr != null) s.fees += valueOf(s, pt) * (apr / 100) * (dt / YEAR_S) * credit;
    s.inS += dt * credit; s.trackedS += dt; s.lastT = t; s.lastIn = inNow;
  };
  const close = (s: SimPos, t: number, reason: string, wallet: string, tx: string | null) => {
    advance(s, t);
    const pt = at(s.ctx.path, t)!;
    const value = valueOf(s, pt) + s.fees, pnl = value - s.amount;
    s.closed = { ts: t, reason, value, pnl };
    realized += pnl;
    held.delete(s.pool);
    fills.push({ ts: t * 1000, kind: "close", pool: s.pool, pair: s.ctx.info.pair, wallet, tx, usd: r2(value), pnlUsd: r2(pnl), reason });
  };
  const exitsAt = (s: SimPos, t: number) => {
    if (s.closed) return;
    const pt = at(s.ctx.path, t);
    if (!pt) return;
    if (c.exits.tokenDropPct != null && pt.tokenUsd <= s.tokenUsd0 * (1 - c.exits.tokenDropPct / 100)) return close(s, t, `Exit, token drop: ${s.ctx.info.tokenSymbol ?? "the token"} fell ${pctText((1 - pt.tokenUsd / s.tokenUsd0) * 100)} from the open (stop at ${c.exits.tokenDropPct}%)`, s.pool, null);
    if (c.exits.lpExodus && s.ctx.flows && t % 3600 === 0) {
      const fl = s.ctx.flows.get(t - 3600);
      if (fl && t - 3600 >= Math.floor(s.openedS / 3600) * 3600 && isExodus(fl.depositsUsd, fl.withdrawalsUsd)) close(s, t, `Exit, LP exodus: ${money(fl.withdrawalsUsd)} withdrawn vs ${money(fl.depositsUsd)} deposited in the hour to ${utc(t * 1000).slice(11)}`, s.pool, null);
    }
  };

  let mi = 0;
  const grid0 = Math.ceil(fromS / stepS) * stepS;
  for (let t = grid0; t <= nowS + stepS; t += stepS) {
    const tEnd = Math.min(t, nowS);
    for (; mi < moves.length && moves[mi].ts <= tEnd; mi++) {
      const mv = moves[mi];
      if (isExit(mv) && c.followRemoves) {
        const s = [...held.values()].find((x) => x.wallet === mv.wallet && x.position === mv.position); // a close may carry no pool
        if (s) {
          s.removedUsd += mv.removeUsd ?? 0;
          if (mv.kinds.includes("close") || s.depositUsd == null || !(s.depositUsd > 0) || s.removedUsd >= CLOSE_SHARE * s.depositUsd) {
            close(s, mv.ts, `Copied ${short(mv.wallet)}: ${mv.kinds.includes("close") ? "it closed its position" : `it took out ${money(s.removedUsd)} of its ${money(s.depositUsd ?? 0)}`}`, mv.wallet, mv.signature);
          }
        }
      }
      if (!isEntry(mv) || !mv.pool) continue;
      entries++;
      if (held.has(mv.pool)) { skipped("already holds that pool (one position per pool)"); continue; }
      if (held.size >= c.maxOpenPositions) { skipped(`max open positions (${c.maxOpenPositions}) reached`); continue; }
      if (!(LP_VENUES as readonly string[]).includes(mv.dex)) { skipped(`unsupported venue (${mv.dex})`); continue; }
      if (!(c.venues as string[]).includes(mv.dex)) { skipped(`${venueLabel(mv.dex)} is not one of the agent's venues`); continue; }
      const k = ctx.get(mv.pool);
      if (!k) { skipped(`pool not read (more than ${BT_POOLS} pools)`); continue; }
      if ("err" in k) { skipped(k.err); continue; }
      const tvl = tvlAt(k, mv.ts);
      if (c.minPoolTvlUsd > 0 && tvl == null) { skipped("pool TVL unknown"); continue; }
      if (tvl != null && tvl < c.minPoolTvlUsd) { skipped(`pool TVL under the ${money(c.minPoolTvlUsd)} floor at the time (estimate)`); continue; }
      const hourFlow = k.flows?.get(Math.floor(mv.ts / 3600) * 3600 - 3600);
      if (c.exits.lpExodus && hourFlow && isExodus(hourFlow.depositsUsd, hourFlow.withdrawalsUsd)) { skipped("flag: LP exodus on the pool in the hour before"); continue; }
      if (k.safety) { skipped(`${k.safety} (Jupiter's facts today)`); continue; }
      const b = await boundsOf(mv);
      const rg = copyRange(k.info, k.v?.binStep ?? null, b.lower, b.upper);
      if ("why" in rg) { skipped(`range unknown: ${rg.why}`); continue; }
      const pt = at(k.path, mv.ts);
      if (!pt) { skipped("no candle for the pool yet at that time"); continue; }
      if (!rg.full && !sane(pt.p, rg.r)) { skipped("range unknown: the bounds do not match the pool's price"); continue; }
      const L = liquidityForAny(c.amountUsd / pt.quoteUsd, pt.p, rg.r);
      const s: SimPos = {
        pool: mv.pool, ctx: k, wallet: mv.wallet, position: mv.position, tx: mv.signature, depositUsd: mv.addUsd, removedUsd: 0, openedS: mv.ts, r: rg.r, full: rg.full, L,
        a0: amountsAt(L, pt.p, rg.r), tokenUsd0: pt.tokenUsd, amount: c.amountUsd, fees: 0, inS: 0, trackedS: 0, lastT: mv.ts, lastIn: inRange(pt.p, rg.r), closed: null,
      };
      held.set(mv.pool, s); all.push(s);
      if (!equity.length) equity.push({ ts: mv.ts * 1000, usd: r2(realized), deployedUsd: c.amountUsd }); // the curve starts at the first copy
      fills.push({ ts: mv.ts * 1000, kind: "open", pool: mv.pool, pair: k.info.pair, wallet: mv.wallet, tx: mv.signature, usd: c.amountUsd,
        pnlUsd: null, reason: `Copied ${short(mv.wallet)}: ${mv.addUsd != null ? `added ${money(mv.addUsd)} to` : "opened"} ${k.info.pair} (${rg.full ? "full range" : `range ${rangeWords(pt.p, rg.r, false)}`})` });
    }
    for (const s of [...held.values()]) { advance(s, tEnd); exitsAt(s, tEnd); }
    let unreal = 0, deployed = 0;
    for (const s of held.values()) { const pt = at(s.ctx.path, tEnd); if (pt) { unreal += valueOf(s, pt) + s.fees - s.amount; deployed += s.amount; } }
    const pnl = realized + unreal;
    if (all.length) {
      peak = Math.max(peak, pnl); maxDd = Math.max(maxDd, peak - pnl);
      equity.push({ ts: tEnd * 1000, usd: r2(pnl), deployedUsd: r2(deployed) });
    }
    if (tEnd >= nowS) break;
  }

  let unrealized = 0, feesT = 0, ilT = 0;
  const positions: LpCopyBacktest["positions"] = all.map((s) => {
    const end = s.closed?.ts ?? nowS, pt = at(s.ctx.path, end)!;
    const lp = valueOf(s, pt), value = s.closed ? s.closed.value : lp + s.fees;
    const il = lp - (s.a0.token * pt.tokenUsd + s.a0.quote * pt.quoteUsd);
    if (!s.closed) unrealized += value - s.amount;
    feesT += s.fees; ilT += il;
    const p0 = at(s.ctx.path, s.openedS)?.p ?? pt.p;
    return {
      pool: s.pool, pair: s.ctx.info.pair, dex: s.ctx.info.dex, wallet: s.wallet, tx: s.tx, openedAt: s.openedS * 1000, closedAt: s.closed ? s.closed.ts * 1000 : null, closeReason: s.closed?.reason ?? null,
      range: s.full ? null : { lower: Number(s.r.lower.toPrecision(6)), upper: Number(s.r.upper.toPrecision(6)), downPct: r2((1 - s.r.lower / p0) * 100), upPct: r2((s.r.upper / p0 - 1) * 100), full: false },
      amountUsd: s.amount, valueUsd: r2(value), feesUsd: r2(s.fees), ilUsd: r2(il), pnlUsd: r2(value - s.amount), timeInRangePct: s.trackedS ? Math.round((s.inS / s.trackedS) * 1000) / 10 : 0,
    };
  });
  const closedP = all.filter((s) => s.closed);
  const aprs = [...new Set(all.map((s) => (s.ctx.v?.feeAprPct != null ? `${s.ctx.info.pair} ${pctText(s.ctx.v.feeAprPct)}` : null)).filter(Boolean))];
  notes.push(`Replayed on Chord's ${stepS === 300 ? "5" : "15"}-minute closes of each pool (the token's USD close in that pool ÷ the quote's): opens and closes at the close in force when the wallet moved. The live agent reacts within about a minute (one poll); real fills and moves inside a candle differ.`);
  notes.push(`Fees are an ESTIMATE: each pool's fee APR TODAY (its venue's API${aprs.length ? `: ${aprs.slice(0, 4).join(", ")}` : ""}) × the position's value × the time in range (half credit across a bound). The wallets' own claimed fees are not used; launch-day APRs fade. IL is exact range math on the same closes.`);
  notes.push(`Ranges are the wallets' own (Meteora DLMM bins, Raydium CLMM ticks, turned into prices with the pool's decimals and bin step; PumpSwap and DAMM v2 are full range). Single-sided ranges hold one token. The copy never rebalances: out of range it earns nothing until the wallet moves.`);
  notes.push(`${c.followRemoves ? `A copy closes when its wallet closes the position or has taken out ${CLOSE_SHARE * 100}% of its deposit; smaller partial removes are not mirrored.` : "Removes are not followed: copies close on the exit rules only."} The TVL floor uses an estimate of each pool's TVL at the move (today's TVL plus the LP withdrawals minus deposits since, from Chord's hourly flows; price moves since are not in it); token safety uses Jupiter's facts today. The LP exodus exit is replayed from the hourly flows, the token drop from the closes; the daily loss stop is not replayed.`);
  notes.push("Opening assumes the tokens are already held in the ratio the range needs (buying them from USDC adds a swap). Paper only.");
  return {
    days, windowHours: r2((nowS - fromS) / 3600), since: fromS * 1000, wallets, walletsFrom, unread: unread.map((r) => r.w), amountUsd: c.amountUsd, maxOpenPositions: c.maxOpenPositions, minPoolTvlUsd: c.minPoolTvlUsd,
    followRemoves: c.followRemoves, exits: { lpExodus: c.exits.lpExodus, tokenDropPct: c.exits.tokenDropPct },
    moves: moves.filter((m) => isEntry(m) || isExit(m)).length, entries, copied: all.length,
    skipped: [...skips.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    positions, fills: fills.sort((a, b) => a.ts - b.ts), investedUsd: r2(all.length * c.amountUsd), realizedUsd: r2(realized), unrealizedUsd: r2(unrealized), pnlUsd: r2(realized + unrealized),
    feesUsd: r2(feesT), ilUsd: r2(ilT), winRate: closedP.length ? Math.round((closedP.filter((s) => s.closed!.pnl > 0).length / closedP.length) * 1000) / 1000 : null,
    maxDrawdownUsd: r2(maxDd), equity, notes,
  };
}

export function _resetLpCopy(): void { boards.clear(); skipRate.clear(); pollWarned.clear(); active = 0; waiters.length = 0; }
