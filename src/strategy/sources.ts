// Trigger sources the agents engine does not have (src/bots/triggers.ts already delivers followed wallets' trades), on Monad:
//  · confluence  — a sliding window over wallet trades: one hit per token per window once ≥ minWallets distinct wallets did the side;
//  · price       — one batched price call per tick for every price trigger (Chord's Monad price map, the runner makes it), a small
//                  in-memory history per token for change_pct over windowMin (seeded from Chord's Monad candles), edge-triggered;
//  · schedule    — a timer: due when the interval has passed since the last run (the first run right away).
// Chord has no Monad launch board and no Monad LP tape, so there is no new_token or lp_event source (the schema refuses both).
import { QUOTE_MINTS } from "../bots/market";
import { smartTraders } from "../bots/tape";
import type { SourceTrade } from "../bots/types";
import { board, candles as chordCandles, type Fetch } from "./chord";
import { EVERY_MS, type TriggerOf, type Wallets } from "./schema";

const MIN = 60_000;

// ── wallets ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The addresses a Wallets block means right now: the list as given, or the smart-traders board (Chord, cached 60 s). */
export async function resolveWallets(w: Wallets, board_ = smartTraders): Promise<string[]> {
  if ("list" in w) return [...w.list];
  const rows = await board_(w.smartTraders.days, w.smartTraders.top);
  return rows.map((r) => r.wallet).slice(0, w.smartTraders.top);
}

// ── confluence ───────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ConfluenceHit { mint: string; symbol: string | null; side: "buy" | "sell"; wallets: string[]; firstTs: number; ts: number; usd: number | null; trade: SourceTrade }

/** Distinct wallets doing `side` on one token inside a sliding window. push() answers a hit at most once per token per window
 *  (the window restarts at the hit), when the trade that arrives makes the count reach minWallets. */
export class ConfluenceWindow {
  private byMint = new Map<string, { at: Map<string, { ts: number; usd: number | null }>; lastHit: number | null; newest: number }>();
  private pushes = 0;
  readonly windowMs: number;
  constructor(readonly opts: { minWallets: number; windowMin: number; side: "buy" | "sell" }) {
    this.windowMs = opts.windowMin * MIN;
  }

  push(t: SourceTrade): ConfluenceHit | null {
    if (t.side !== this.opts.side) return null;
    if (++this.pushes % 500 === 0) this.sweep(t.ts);
    let m = this.byMint.get(t.mint);
    if (!m) this.byMint.set(t.mint, (m = { at: new Map(), lastHit: null, newest: t.ts }));
    m.newest = Math.max(m.newest, t.ts);
    const cut = m.newest - this.windowMs;
    if (t.ts < cut) return null; // too old for the window (a late tape row)
    const prev = m.at.get(t.wallet);
    m.at.set(t.wallet, { ts: Math.max(prev?.ts ?? 0, t.ts), usd: t.usd == null ? prev?.usd ?? null : (prev?.usd ?? 0) + t.usd });
    for (const [w, x] of m.at) if (x.ts < cut) m.at.delete(w);
    if (m.at.size < this.opts.minWallets) return null;
    if (m.lastHit != null && t.ts - m.lastHit < this.windowMs) return null;
    m.lastHit = t.ts;
    const entries = [...m.at.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const usd = entries.reduce((a, [, x]) => a + (x.usd ?? 0), 0);
    return { mint: t.mint, symbol: t.symbol, side: t.side, wallets: entries.map(([w]) => w), firstTs: entries[0][1].ts, ts: t.ts, usd: usd || null, trade: t };
  }

  /** Mints with nothing inside the window are forgotten. */
  sweep(now: number): void {
    for (const [mint, m] of this.byMint) {
      for (const [w, x] of m.at) if (x.ts < now - this.windowMs) m.at.delete(w);
      if (!m.at.size && (m.lastHit == null || now - m.lastHit >= this.windowMs)) this.byMint.delete(mint);
    }
  }
  size(): number { return this.byMint.size; }
}

// ── price ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SAMPLE_GAP_MS = 20_000;
const MAX_SAMPLES = 3_000;

/** A few hours of prices per mint (one sample every ≥ 20 s), enough for change_pct over the longest window asked for. */
export class PriceHistory {
  private s = new Map<string, { ts: number; p: number }[]>();
  constructor(private keepMs = 1445 * MIN) {}
  setKeep(ms: number): void { this.keepMs = Math.max(this.keepMs, ms + 5 * MIN); }

  record(mint: string, price: number, ts: number): void {
    if (!(price > 0) || !Number.isFinite(price)) return;
    let xs = this.s.get(mint);
    if (!xs) this.s.set(mint, (xs = []));
    const last = xs[xs.length - 1];
    if (last && ts < last.ts) return;
    // samples stay ≥ 20 s apart: inside the gap after the one before it, the newest sample is replaced, not added
    if (xs.length >= 2 && ts - xs[xs.length - 2].ts < SAMPLE_GAP_MS) { last.p = price; last.ts = ts; }
    else xs.push({ ts, p: price });
    const cut = ts - this.keepMs;
    let drop = 0;
    while (drop < xs.length - 1 && xs[drop + 1].ts <= cut) drop++;
    if (drop) xs.splice(0, drop);
    if (xs.length > MAX_SAMPLES) xs.splice(0, xs.length - MAX_SAMPLES);
  }
  /** Older points (candles), merged in before what is already there. */
  seed(mint: string, points: { ts: number; p: number }[]): void {
    const xs = this.s.get(mint) ?? [];
    const first = xs[0]?.ts ?? Infinity;
    const older = points.filter((x) => x.ts < first && x.p > 0).sort((a, b) => a.ts - b.ts);
    this.s.set(mint, [...older, ...xs]);
  }
  /** The newest sample at or before `ts`. */
  at(mint: string, ts: number): number | null {
    const xs = this.s.get(mint);
    if (!xs?.length) return null;
    let lo = 0, hi = xs.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (xs[mid].ts <= ts) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found >= 0 ? xs[found].p : null;
  }
  oldest(mint: string): number | null { return this.s.get(mint)?.[0]?.ts ?? null; }
  latest(mint: string): { ts: number; p: number } | null { const xs = this.s.get(mint); return xs?.length ? xs[xs.length - 1] : null; }
  has(mint: string): boolean { return !!this.s.get(mint)?.length; }
  forget(keep: Set<string>): void { for (const m of this.s.keys()) if (!keep.has(m)) this.s.delete(m); }
}

export interface PriceCheck { met: boolean; price: number; changePct: number | null; detail: string; warming?: boolean }
/** Does a price trigger hold for one mint now. change_pct compares with the price windowMin ago (null until the history covers
 *  the window: warming up). */
export function checkPrice(t: TriggerOf<"price">, mint: string, price: number, now: number, h: PriceHistory): PriceCheck {
  if (t.op === "above") return { met: price > t.value, price, changePct: null, detail: `price $${fmt(price)} ${price > t.value ? "above" : "not above"} $${fmt(t.value)}` };
  if (t.op === "below") return { met: price < t.value, price, changePct: null, detail: `price $${fmt(price)} ${price < t.value ? "below" : "not below"} $${fmt(t.value)}` };
  const win = (t.windowMin ?? 60) * MIN;
  const oldest = h.oldest(mint);
  const then = oldest != null && oldest <= now - win + 60_000 ? h.at(mint, now - win) ?? h.at(mint, oldest) : null;
  if (then == null || !(then > 0)) return { met: false, price, changePct: null, detail: `warming up: needs ${t.windowMin ?? 60} min of prices`, warming: true };
  const pct = (price / then - 1) * 100;
  const met = t.value > 0 ? pct >= t.value - 1e-9 : pct <= t.value + 1e-9; // 1e-9: 1.15 / 1.00 is 14.999… in floating point
  return { met, price, changePct: pct, detail: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)} % in ${t.windowMin ?? 60} min ($${fmt(then)} → $${fmt(price)})` };
}
const fmt = (n: number) => (n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toPrecision(4));

/** Fires on the way in: true the first time a condition holds, then not again until it has stopped holding. */
export class EdgeTrigger {
  private on = new Map<string, boolean>();
  update(key: string, met: boolean): boolean {
    const was = this.on.get(key) ?? false;
    this.on.set(key, met);
    return met && !was;
  }
  forget(prefix: string): void { for (const k of this.on.keys()) if (k.startsWith(prefix)) this.on.delete(k); }
}

/** Older prices from Chord's candles (1-minute closes up to 1,000, 5-minute beyond), so change_pct does not wait a whole window. */
export async function seedFromCandles(mint: string, windowMin: number, f?: Fetch): Promise<{ ts: number; p: number }[]> {
  const tf = windowMin + 2 <= 1000 ? "1m" : "5m";
  const limit = tf === "1m" ? windowMin + 2 : Math.ceil(windowMin / 5) + 2;
  const cs = await chordCandles(mint, tf, limit, f);
  return cs.map((c) => ({ ts: c.t + (tf === "1m" ? 60_000 : 300_000), p: c.c }));
}

/** Chord's most traded Monad tokens: the 24 h volume board without the quote tokens (USDC, AUSD, USDT0, WMON, MON). */
export const TRENDING_SIZE = 20;
export async function trendingMints(limit = TRENDING_SIZE, f?: Fetch): Promise<string[]> {
  const rows = await board("volume", 60, f);
  return rows.filter((r) => !QUOTE_MINTS.has(r.mint) && !(r.symbol && QUOTE_MINTS.has(r.symbol))).slice(0, limit).map((r) => r.mint);
}

// ── schedule ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Is a schedule due: never run, or the interval has passed since the last run. */
export function scheduleDue(every: keyof typeof EVERY_MS, lastRunMs: number | null, now: number): boolean {
  return lastRunMs == null || now - lastRunMs >= EVERY_MS[every];
}
