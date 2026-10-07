// Backtest a strategy on real history, in the same result shape as the copy bot's (src/bots Backtest):
//   wallet_trade / confluence — replay the followed wallets' swaps from Chord's tape (paged, newest 2,000 per wallet);
//   price / schedule          — replay Chord candles of the mint (5-minute bars for 1 or 3 days, 15-minute for 7);
//   new_token                 — replay Chord's new-token board (tokens first seen in the last 24 h only) and graduations
//                               read from each token's pools;
//   lp_event                  — replay the LP tape of the watched pools (it starts when Chord began decoding liquidity).
// Buys fill the action's USD at the trigger's price (the followed trade's own price, or a candle close) with no slippage,
// fees or delay. Exits (TP / SL / trailing / max hold) walk the token's candles after the entry (the tape's trade prices when
// there are none); followed_sells close at the followed sell's price. Limits are replayed exactly. Filters are applied only
// where the history can give the value (smartBuyers1h from the replayed smart traders, ageMin of a new token); every other
// filter is listed in `notes` as not applied. Open positions are marked at Jupiter's price now (else the last price seen).
import { prices as jupPrices, QUOTE_MINTS } from "../bots/market";
import { tokenTrades as tapeTokenTrades, toSource, walletTrades, type TapeRow } from "../bots/tape";
import type { Backtest, SourceTrade } from "../bots/types";
import {
  board, candles as chordCandles, lpEvents as chordLpEvents, lpPool as chordLpPool, tokenView as chordTokenView, AMM_DEXES, LAUNCHPAD_DEXES,
  type BoardRow, type Candle, type LpEventRow, type LpPoolView, type Timeframe, type TokenView, TF_MIN,
} from "./chord";
import { duration, FIELD_LABEL, fieldValue, money, SAFETY_LABEL } from "./explain";
import { EVERY_MS, isFieldFilter, parseStrategy, StrategyInputError, type Strategy, type Trigger, type TriggerOf, type Wallets } from "./schema";
import { ConfluenceWindow, graduationOf, resolveWallets as resolve, trendingMints } from "./sources";

export interface StrategyBacktest extends Backtest {
  strategy: string;
  trigger: Trigger["type"];
  /** times the trigger fired in the replay (before filters and limits) */
  signals: number;
  /** alert / webhook strategies: times they would have alerted */
  alerts: number;
  /** wallet triggers: how many followed wallets the replay could read, and the ones it could not (left out) */
  walletsRead?: number;
  unreadWallets?: string[];
  /** hours the replay really covers when the data reaches back less than `days` (new tokens: Chord's board keeps 24 h) */
  coveredHours?: number;
}

export interface StrategyBacktestDeps {
  walletPage: (wallet: string, limit: number, beforeS: number | null) => Promise<TapeRow[]>;
  /** a token's newest swaps (its price path when Chord has few candles for it) */
  tokenTrades: (mint: string, limit: number) => Promise<TapeRow[]>;
  resolveWallets: (w: Wallets) => Promise<string[]>;
  candles: (mint: string, tf: Timeframe, limit: number) => Promise<Candle[]>;
  board: (sort: "new" | "volume", limit: number) => Promise<BoardRow[]>;
  tokenView: (mint: string, hours: number) => Promise<TokenView | null>;
  lpPool: (pool: string, hours: number) => Promise<LpPoolView | null>;
  lpEvents: (pool: string, limit: number, beforeS: number | null) => Promise<LpEventRow[]>;
  trending: () => Promise<string[]>;
  prices: (mints: string[]) => Promise<Map<string, number>>;
  now: () => number;
}
const defaults = (): StrategyBacktestDeps => ({
  walletPage: walletTrades, tokenTrades: (m, l) => tapeTokenTrades(m, l), resolveWallets: (w) => resolve(w), candles: (m, tf, l) => chordCandles(m, tf, l), board: (s, l) => board(s, l),
  tokenView: (m, h) => chordTokenView(m, h), lpPool: (p, h) => chordLpPool(p, h), lpEvents: (p, l, b) => chordLpEvents(p, l, b),
  trending: () => trendingMints(10), prices: jupPrices, now: () => Date.now(),
});

export const MAX_TRADES_PER_WALLET = 2000;
const WALLET_READS_AT_ONCE = 4;
const PAGE = 200;
const MAX_PAGES = 12;
const MAX_FILLS_RETURNED = 1000;
const MAX_EQUITY_POINTS = 400;
const MAX_CANDLE_TOKENS = 40;
const MAX_GRAD_LOOKUPS = 60;
const MAX_TRENDING = 10;
const MAX_LP_PAGES = 5;
/** fewer candles than this for a token = also read its newest swaps for the price path */
const SPARSE_CANDLES = 12;
const MIN = 60_000;

const cents = (n: number) => Math.round(n * 100) / 100;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const utcDay = (ms: number) => Math.floor(ms / 86_400_000);

/** The candle size for a window: 5-minute bars for 1 and 3 days, 15-minute for 7 (Chord serves at most 1,000 bars). */
export function timeframeFor(days: number): Timeframe { return days <= 3 ? "5m" : "15m"; }

async function walletHistory(d: StrategyBacktestDeps, wallet: string, cutoffS: number): Promise<{ rows: TapeRow[]; capped: boolean }> {
  const out: TapeRow[] = [];
  const keys = new Set<string>();
  let before: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await d.walletPage(wallet, PAGE, before);
    let fresh = 0, oldest = Infinity;
    for (const r of rows) {
      oldest = Math.min(oldest, r.ts);
      const k = `${r.tx}|${r.token}|${r.side}|${r.tokenAmount}|${r.ts}`;
      if (keys.has(k)) continue;
      keys.add(k);
      fresh++;
      if (r.ts >= cutoffS) out.push(r);
    }
    if (out.length >= MAX_TRADES_PER_WALLET) return { rows: out.slice(0, MAX_TRADES_PER_WALLET), capped: true };
    if (rows.length < PAGE || oldest < cutoffS || !Number.isFinite(oldest)) break;
    const next: number = fresh ? oldest + 1 : oldest;
    if (next === before) break;
    before = next;
  }
  return { rows: out, capped: false };
}

// ── the simulation ───────────────────────────────────────────────────────────────────────────────────────────────────
interface Bar { t: number; end: number; o: number; h: number; l: number; c: number }
type BtFill = Backtest["fills"][number];
interface Pos { qty: number; cost: number; symbol: string | null; openedAt: number; entry: number; peak: number; bars: Bar[]; cursor: number }
interface Sig { ts: number; mint: string; symbol: string | null; price: number | null; source: SourceTrade; known?: Partial<Record<string, number>> }

const toBars = (cs: Candle[], stepMs: number): Bar[] => cs.map((c) => ({ t: c.t, end: c.t + stepMs, o: c.o, h: c.h, l: c.l, c: c.c }));
const pointBars = (pts: { ts: number; p: number }[]): Bar[] => pts.sort((a, b) => a.ts - b.ts).map((x) => ({ t: x.ts, end: x.ts, o: x.p, h: x.p, l: x.p, c: x.p }));

class Sim {
  pos = new Map<string, Pos>();
  fills: BtFill[] = [];
  realized = 0; invested = 0; buys = 0; sells = 0; skipped = 0; wins = 0; alerts = 0; signals = 0;
  alertTimes: number[] = [];
  equity: { ts: number; usd: number }[] = [];
  private peakEq = 0;
  maxDd = 0;
  private ledger = { day: -1, spent: 0, trades: 0 };
  private lastAct = new Map<string, number>();
  lastPx = new Map<string, number>();
  notApplied = new Set<string>();

  constructor(readonly s: Strategy, startMs: number, private path: (mint: string) => Promise<Bar[]>) {
    this.point(startMs);
  }

  private point(ts: number): void {
    let u = 0;
    for (const [m, p] of this.pos) u += p.qty * (this.lastPx.get(m) ?? p.entry) - p.cost;
    const usd = this.realized + u;
    this.equity.push({ ts, usd });
    this.peakEq = Math.max(this.peakEq, usd);
    this.maxDd = Math.max(this.maxDd, this.peakEq - usd);
  }

  /** Walk every open position's bars up to `ts` in time order, closing the ones an exit catches. */
  advance(ts: number): void {
    const e = this.s.exits ?? {};
    const steps: { end: number; mint: string; i: number }[] = [];
    for (const [m, p] of this.pos) for (let i = p.cursor; i < p.bars.length && p.bars[i].end <= ts; i++) steps.push({ end: p.bars[i].end, mint: m, i });
    steps.sort((a, b) => a.end - b.end);
    for (const st of steps) {
      const p = this.pos.get(st.mint);
      if (!p || st.i < p.cursor) continue;
      const bar = p.bars[st.i];
      p.cursor = st.i + 1;
      if (bar.t < p.openedAt) continue; // a candle that began before the entry: what it saw is not this position's
      let exitAt: number | null = null, why = "";
      if (e.maxHoldMin != null && bar.t >= p.openedAt + e.maxHoldMin * MIN) { exitAt = bar.o; why = `max hold ${duration(e.maxHoldMin)}`; }
      else {
        const sl = e.stopLossPct != null ? p.entry * (1 - e.stopLossPct / 100) : -Infinity;
        const tr = e.trailingPct != null ? p.peak * (1 - e.trailingPct / 100) : -Infinity;
        const stop = Math.max(sl, tr);
        const stopWhy = tr > sl ? `trailing stop ${e.trailingPct} %` : `stop loss −${e.stopLossPct} %`;
        const tp = e.takeProfitPct != null ? p.entry * (1 + e.takeProfitPct / 100) : Infinity;
        const at = (x: number, level: number, dir: 1 | -1) => (dir < 0 ? x <= level * (1 + 1e-12) : x >= level * (1 - 1e-12)); // float slack
        if (at(bar.o, stop, -1)) { exitAt = bar.o; why = stopWhy; }
        else if (at(bar.l, stop, -1)) { exitAt = stop; why = stopWhy; }
        else if (at(bar.o, tp, 1)) { exitAt = bar.o; why = `take profit +${e.takeProfitPct} %`; }
        else if (at(bar.h, tp, 1)) { exitAt = tp; why = `take profit +${e.takeProfitPct} %`; }
      }
      if (exitAt != null) { this.close(st.mint, bar.end, exitAt, { wallet: "exit", tx: "" }, why); continue; }
      p.peak = Math.max(p.peak, bar.h);
      this.lastPx.set(st.mint, bar.c);
      this.point(bar.end);
    }
  }

  private close(mint: string, ts: number, price: number, src: { wallet: string; tx: string }, reason: string | null): void {
    const p = this.pos.get(mint);
    if (!p) return;
    const value = p.qty * price, pnl = value - p.cost;
    this.realized += pnl;
    this.sells++;
    if (pnl > 0) this.wins++;
    this.pos.delete(mint);
    this.lastPx.set(mint, price);
    this.fills.push({ ts, side: "sell", mint, symbol: p.symbol, usd: value, tokenAmount: p.qty, priceUsd: price, status: "filled", reason, pnlUsd: pnl,
      source: { wallet: src.wallet, tx: src.tx, side: "sell", mint, symbol: p.symbol, usd: value, priceUsd: price, ts, via: "tape" } });
    this.point(ts);
  }

  /** A followed wallet sold `mint` (sellWhen followed_sells). */
  followedSell(t: SourceTrade): void {
    this.advance(t.ts);
    if (this.pos.has(t.mint) && t.priceUsd != null && t.priceUsd > 0) this.close(t.mint, t.ts, t.priceUsd, { wallet: t.wallet, tx: t.tx }, `followed wallet ${short(t.wallet)} sold`);
  }

  private skip(sig: Sig, usd: number, reason: string): void {
    this.skipped++;
    this.fills.push({ ts: sig.ts, side: this.s.action.type === "sell" ? "sell" : "buy", mint: sig.mint, symbol: sig.symbol, usd, tokenAmount: 0, priceUsd: sig.price, status: "skipped", reason, pnlUsd: null, source: sig.source });
  }

  async signal(sig: Sig): Promise<void> {
    this.advance(sig.ts);
    this.signals++;
    const a = this.s.action, l = this.s.limits;
    const day = utcDay(sig.ts);
    if (this.ledger.day !== day) this.ledger = { day, spent: 0, trades: 0 };
    const last = this.lastAct.get(sig.mint);
    const cooling = l.cooldownMin > 0 && last != null && sig.ts - last < l.cooldownMin * MIN;
    if (a.type === "alert" || a.type === "webhook") {
      if (cooling || !this.filtersPass(sig).ok) return;
      this.alerts++;
      if (this.alertTimes.length < 5) this.alertTimes.push(sig.ts);
      this.lastAct.set(sig.mint, sig.ts);
      return;
    }
    const usd = a.type === "buy" ? a.usd : 0;
    if (this.ledger.trades >= l.maxTradesPerDay) return this.skip(sig, usd, `max trades a day: ${l.maxTradesPerDay} already`);
    if (a.type === "buy" && this.ledger.spent + a.usd > l.dailyBudgetUsd + 1e-9) return this.skip(sig, usd, `daily budget: ${money(this.ledger.spent)} spent, another ${money(a.usd)} would pass ${money(l.dailyBudgetUsd)}`);
    if (cooling) return this.skip(sig, usd, `cooldown: acted on this token ${((sig.ts - last!) / MIN).toFixed(1)} min before (${l.cooldownMin} min)`);
    const f = this.filtersPass(sig);
    if (!f.ok) return this.skip(sig, usd, f.reason);
    if (a.type === "sell") {
      const p = this.pos.get(sig.mint);
      if (!p) return this.skip(sig, 0, "the bot holds none of this token");
      const price = sig.price ?? this.lastPx.get(sig.mint) ?? null;
      if (!price) return this.skip(sig, 0, "no price at that time");
      this.ledger.trades++;
      this.lastAct.set(sig.mint, sig.ts);
      if (a.pct >= 100) return this.close(sig.mint, sig.ts, price, { wallet: sig.source.wallet, tx: sig.source.tx }, null);
      const qty = p.qty * a.pct / 100, cost = p.cost * a.pct / 100, value = qty * price;
      p.qty -= qty; p.cost -= cost;
      this.realized += value - cost; this.sells++; if (value > cost) this.wins++;
      this.fills.push({ ts: sig.ts, side: "sell", mint: sig.mint, symbol: p.symbol, usd: value, tokenAmount: qty, priceUsd: price, status: "filled", reason: null, pnlUsd: value - cost, source: sig.source });
      return this.point(sig.ts);
    }
    // buy
    const held = this.pos.get(sig.mint);
    if (!held && this.pos.size >= l.maxOpenPositions) return this.skip(sig, usd, `max open positions: ${l.maxOpenPositions} already open`);
    if (held && held.cost + a.usd > l.maxPerTokenUsd + 1e-9) return this.skip(sig, usd, `max per token: another ${money(a.usd)} would pass the ${money(l.maxPerTokenUsd)} cap`);
    let bars: Bar[] = [];
    try { bars = await this.path(sig.mint); } catch { /* the signal's own price stands */ }
    let price = sig.price;
    if (price == null || !(price > 0)) {
      const bar = bars.find((b) => b.end >= sig.ts);
      price = bar && bar.t <= sig.ts + 15 * MIN ? bar.c : null;
    }
    if (price == null || !(price > 0)) return this.skip(sig, usd, "no price on the tape at that time");
    const qty = a.usd / price;
    const cursor = bars.findIndex((b) => b.t >= sig.ts);
    if (held) {
      held.qty += qty; held.cost += a.usd; held.entry = held.cost / held.qty;
    } else {
      this.pos.set(sig.mint, { qty, cost: a.usd, symbol: sig.symbol, openedAt: sig.ts, entry: price, peak: price, bars, cursor: cursor < 0 ? bars.length : cursor });
    }
    this.lastPx.set(sig.mint, price);
    this.invested += a.usd; this.buys++;
    this.ledger.spent += a.usd; this.ledger.trades++;
    this.lastAct.set(sig.mint, sig.ts);
    this.fills.push({ ts: sig.ts, side: "buy", mint: sig.mint, symbol: sig.symbol, usd: a.usd, tokenAmount: qty, priceUsd: price, status: "filled", reason: null, pnlUsd: null, source: sig.source });
    this.point(sig.ts);
  }

  /** The filters the history can answer; the others are noted as not applied. */
  private filtersPass(sig: Sig): { ok: true } | { ok: false; reason: string } {
    for (const f of this.s.filters) {
      if (!isFieldFilter(f)) { this.notApplied.add(SAFETY_LABEL[f.safety]); continue; }
      const v = sig.known?.[f.field];
      if (v === undefined) { this.notApplied.add(FIELD_LABEL[f.field]); continue; }
      const ok = f.op === "between" ? v >= (f.value as number[])[0] && v <= (f.value as number[])[1]
        : f.op === ">" ? v > (f.value as number) : f.op === ">=" ? v >= (f.value as number) : f.op === "<" ? v < (f.value as number) : v <= (f.value as number);
      if (!ok) return { ok: false, reason: `filter ${f.field}: ${FIELD_LABEL[f.field]} ${fieldValue(f.field, v)}` };
    }
    return { ok: true };
  }

  /** Close the replay at `now`: walk the bars, then mark what is still open (Jupiter now, else the last price seen). */
  async finish(now: number, live: (mints: string[]) => Promise<Map<string, number>>): Promise<{ jup: number; last: number; unrealized: number }> {
    this.advance(now);
    let jup = 0, last = 0;
    if (this.pos.size) {
      let px = new Map<string, number>();
      try { px = await live([...this.pos.keys()]); } catch { /* the last price stands in */ }
      for (const m of this.pos.keys()) { const v = px.get(m); if (v != null) { this.lastPx.set(m, v); jup++; } else last++; }
    }
    let u = 0;
    for (const [m, p] of this.pos) u += p.qty * (this.lastPx.get(m) ?? p.entry) - p.cost;
    this.point(now);
    return { jup, last, unrealized: u };
  }
}

/** At most MAX_EQUITY_POINTS points, first and last kept, and each bucket's lowest point (so the drawdown still shows). */
function thin(points: { ts: number; usd: number }[]): { ts: number; usd: number }[] {
  if (points.length <= MAX_EQUITY_POINTS) return points;
  const inner = points.slice(1, -1);
  const size = Math.ceil(inner.length / (MAX_EQUITY_POINTS - 2));
  const out = [points[0]];
  for (let i = 0; i < inner.length; i += size) {
    const bucket = inner.slice(i, i + size);
    out.push(bucket.reduce((lo, x) => (x.usd < lo.usd ? x : lo), bucket[0]));
  }
  out.push(points[points.length - 1]);
  return out;
}

const synth = (label: string, mint: string, symbol: string | null, ts: number, price: number | null, tx = ""): SourceTrade =>
  ({ wallet: label, tx, side: "buy", mint, symbol, usd: null, priceUsd: price, ts, via: "tape" });

// ── entry point ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Replay a strategy over the last `days` (1, 3 or 7). Throws StrategyInputError for a bad strategy or days. */
export async function backtestStrategy(strategy: unknown, days: unknown, deps: Partial<StrategyBacktestDeps> = {}): Promise<StrategyBacktest> {
  const d = { ...defaults(), ...deps };
  const s = parseStrategy(strategy);
  const nDays = Number(days);
  if (nDays !== 1 && nDays !== 3 && nDays !== 7) throw new StrategyInputError(["Backtest › days: must be 1, 3 or 7"]);
  const now = d.now();
  const cutoff = now - nDays * 86_400_000;
  const tf = timeframeFor(nDays);
  const stepMs = TF_MIN[tf] * MIN;
  const notes: string[] = [];
  const t = s.trigger;

  // price paths: candles per token (fetched once, lazily, at most MAX_CANDLE_TOKENS) merged with the replay's own trade prices;
  // a token with few candles (a launch that died within minutes has one) also gets its newest swaps from the tape
  const tapePts = new Map<string, { ts: number; p: number }[]>();
  const candleCache = new Map<string, Promise<Bar[]>>();
  let candleCalls = 0, candleCapped = false, sparsePaths = 0;
  const extraBars = t.type === "price" && t.op === "change_pct" ? Math.ceil((t.windowMin ?? 60) / TF_MIN[tf]) + 2 : 2;
  const barsFor = (mint: string): Promise<Bar[]> => {
    let p = candleCache.get(mint);
    if (!p) {
      if (candleCalls >= MAX_CANDLE_TOKENS) { candleCapped = true; p = Promise.resolve([]); }
      else {
        candleCalls++;
        p = d.candles(mint, tf, Math.min(1000, Math.ceil((now - cutoff) / stepMs) + extraBars)).then((cs) => toBars(cs, stepMs)).catch(() => [] as Bar[]);
      }
      candleCache.set(mint, p);
    }
    return p;
  };
  const pathCache = new Map<string, Promise<Bar[]>>();
  const path = (mint: string): Promise<Bar[]> => {
    let p = pathCache.get(mint);
    if (!p) {
      p = (async () => {
        const bars = await barsFor(mint);
        if (bars.length >= SPARSE_CANDLES) return bars;
        const pts = [...(tapePts.get(mint) ?? [])];
        if (!candleCapped) {
          try { for (const r of await d.tokenTrades(mint, 200)) if (r.priceUsd != null && r.priceUsd > 0) pts.push({ ts: r.ts * 1000, p: r.priceUsd }); } catch { /* the rest stands */ }
          if (pts.length) sparsePaths++;
        }
        return [...bars, ...pointBars(pts)].sort((a, b) => a.end - b.end || a.t - b.t);
      })();
      pathCache.set(mint, p);
    }
    return p;
  };

  let wallets: string[] = [];
  let unread: string[] = [];
  let coveredHours: number | undefined;
  const smartFollow = (t.type === "wallet_trade" || t.type === "confluence") && "smartTraders" in t.wallets;
  const sim = new Sim(s, cutoff, path);

  if (t.type === "wallet_trade" || t.type === "confluence") {
    wallets = await d.resolveWallets(t.wallets);
    if (!wallets.length) throw new Error("No wallets to replay: the smart-traders board answered empty");
    // Chord's Solana read API answers 503 when 20 wallets are paged at once (measured 07/10: 7 of 20 left out, 3 signals instead
    // of 20): 4 at a time, then each failed wallet once more, one by one
    const readOne = async (w: string) => {
      try { return { w, ...(await walletHistory(d, w, Math.floor(cutoff / 1000))), error: null as string | null }; }
      catch (e) { return { w, rows: [] as TapeRow[], capped: false, error: String((e as Error)?.message ?? e).slice(0, 140) }; }
    };
    const got: Awaited<ReturnType<typeof readOne>>[] = new Array(wallets.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(WALLET_READS_AT_ONCE, wallets.length) }, async () => { for (let i = next++; i < wallets.length; i = next++) got[i] = await readOne(wallets[i]); }));
    for (let i = 0; i < got.length; i++) if (got[i].error) got[i] = await readOne(wallets[i]);
    if (got.every((g) => g.error)) throw new Error(`Chord's Solana tape could not be read for any followed wallet (${got[0].error})`);
    for (const g of got) {
      if (g.error) notes.push(`Wallet ${short(g.w)}: the tape could not be read (${g.error}); it is left out.`);
      else if (g.capped) notes.push(`Wallet ${short(g.w)}: only its newest ${MAX_TRADES_PER_WALLET.toLocaleString("en-US")} swaps were replayed (from ${when(g.rows[g.rows.length - 1].ts * 1000)}).`);
    }
    unread = got.filter((g) => g.error).map((g) => g.w);
    if (unread.length) notes.unshift(`Replayed ${wallets.length - unread.length} of ${wallets.length} wallets: ${unread.length} could not be read on Chord's tape, so the numbers above leave their trades out.`);
    const quiet = got.filter((g) => !g.error && !g.rows.length).length;
    if (quiet) notes.push(`${quiet} of ${wallets.length} wallets made no swap on the tape in the window.`);
    const events = got.flatMap((g) => g.rows.map((r, i) => ({ r, w: g.w, seq: -i }))).filter((e) => !QUOTE_MINTS.has(e.r.token));
    events.sort((a, b) => a.r.ts - b.r.ts || (a.w === b.w ? a.seq - b.seq : 0));
    for (const e of events) if (e.r.priceUsd != null && e.r.priceUsd > 0) {
      let xs = tapePts.get(e.r.token);
      if (!xs) tapePts.set(e.r.token, (xs = []));
      xs.push({ ts: e.r.ts * 1000, p: e.r.priceUsd });
    }
    const window = t.type === "confluence" ? new ConfluenceWindow({ minWallets: t.minWallets, windowMin: t.windowMin, side: t.side }) : null;
    // smartBuyers1h, when the followed wallets ARE the smart traders: distinct ones that bought the token in the hour before
    const buysByMint = new Map<string, { w: string; ts: number }[]>();
    const smartBuyers = (mint: string, ts: number) => {
      const xs = buysByMint.get(mint) ?? [];
      return new Set(xs.filter((x) => x.ts > ts - 3600_000 && x.ts <= ts).map((x) => x.w)).size;
    };
    for (const { r, w } of events) {
      const src = toSource(r, w);
      if (!src) continue;
      if (src.side === "buy") { let xs = buysByMint.get(src.mint); if (!xs) buysByMint.set(src.mint, (xs = [])); xs.push({ w, ts: src.ts }); }
      if (src.side === "sell" && s.exits?.sellWhen === "followed_sells") sim.followedSell(src);
      const known = smartFollow ? { smartBuyers1h: smartBuyers(src.mint, src.ts) } : undefined;
      if (t.type === "wallet_trade") {
        if (t.side !== "any" && t.side !== src.side) continue;
        if (t.minUsd > 0 && !(src.usd != null && src.usd >= t.minUsd)) continue;
        await sim.signal({ ts: src.ts, mint: src.mint, symbol: src.symbol, price: src.priceUsd, source: src, known });
      } else {
        const hit = window!.push(src);
        if (hit) await sim.signal({ ts: src.ts, mint: src.mint, symbol: src.symbol, price: src.priceUsd, source: src, known });
      }
    }
    notes.push("Buys fill at the followed wallet's own trade price on Chord's tape, with no slippage, price impact, fees or delay: a live copy lands after the wallet's own swap, so live results are worse, much worse in the first seconds of a launch.");
    if (smartFollow) notes.push("The smart-traders board is today's: those wallets were picked for the profit they made over these same days, so a replay of their trades flatters them.");
    if (s.filters.some((f) => isFieldFilter(f) && f.field === "smartBuyers1h") && !smartFollow) sim.notApplied.add(FIELD_LABEL.smartBuyers1h);
  } else if (t.type === "price" || t.type === "schedule") {
    let mints: string[];
    if (t.type === "schedule") mints = [t.mint];
    else if (t.mint === "trending") {
      mints = (await d.trending()).slice(0, MAX_TRENDING);
      notes.push(`"Trending" is replayed on today's ${mints.length} trending tokens: tokens that trend today were chosen for moving, so the replay is biased in their favour.`);
    } else if (t.mint === "held") { mints = []; notes.push("This trigger watches the tokens the bot holds; a backtest starts holding nothing, so there is nothing to replay."); }
    else mints = [t.mint];
    const series = await Promise.all(mints.map(async (m) => ({ m, bars: await barsFor(m) })));
    for (const x of series) if (!x.bars.length) notes.push(`${short(x.m)}: Chord has no candles for it in the window.`);
    if (t.type === "schedule") {
      const bars = series[0]?.bars ?? [];
      const every = EVERY_MS[t.every];
      for (let at = cutoff; at <= now; at += every) {
        const bar = bars.find((b) => b.end >= at && b.t <= at + every);
        if (!bar) continue;
        await sim.signal({ ts: Math.max(at, bar.end), mint: t.mint, symbol: null, price: bar.c, source: synth(`schedule ${t.every}`, t.mint, null, Math.max(at, bar.end), bar.c) });
      }
      if (EVERY_MS[t.every] > (now - cutoff)) notes.push(`A schedule of every ${t.every} runs once in ${nDays} day${nDays > 1 ? "s" : ""}.`);
    } else {
      const win = Math.max((t.windowMin ?? 60) * MIN, stepMs);
      if (t.op === "change_pct" && (t.windowMin ?? 60) * MIN < stepMs) notes.push(`The ${t.windowMin} min window is shorter than the ${tf} candles; it was replayed over one candle.`);
      const steps = series.flatMap(({ m, bars }) => bars.map((b, i) => ({ m, bars, i, end: b.end }))).filter((x) => x.end > cutoff).sort((a, b) => a.end - b.end);
      const armed = new Map<string, boolean>();
      for (const st of steps) {
        const bar = st.bars[st.i];
        let met: boolean, detail: string;
        if (t.op === "change_pct") {
          let j = st.i;
          while (j >= 0 && st.bars[j].end > bar.end - win) j--;
          if (j < 0) continue;
          const then = st.bars[j].c, ch = (bar.c / then - 1) * 100;
          met = t.value > 0 ? ch >= t.value - 1e-9 : ch <= t.value + 1e-9;
          detail = `${ch >= 0 ? "+" : ""}${ch.toFixed(1)} % in ${t.windowMin ?? 60} min`;
        } else { met = t.op === "above" ? bar.c > t.value : bar.c < t.value; detail = `price ${t.op} $${t.value}`; }
        const was = armed.get(st.m) ?? false;
        armed.set(st.m, met);
        if (met && !was) await sim.signal({ ts: bar.end, mint: st.m, symbol: null, price: bar.c, source: synth(`price: ${detail}`, st.m, null, bar.end, bar.c) });
      }
    }
    notes.push(`Prices are ${tf} candle closes of each token's main pool on Chord's tape; buys fill at the close with no slippage or fees.`);
  } else if (t.type === "new_token") {
    let rows: BoardRow[] = [];
    rows = await d.board("new", 200);
    rows = rows.filter((r) => !QUOTE_MINTS.has(r.mint) && r.firstSeen != null && r.firstSeen * 1000 >= cutoff);
    const evs: { ts: number; row: BoardRow; source: "launch" | "graduation"; ageMin: number }[] = [];
    if (t.source !== "graduation") for (const r of rows) evs.push({ ts: r.firstSeen! * 1000, row: r, source: "launch", ageMin: 0 });
    if (t.source !== "launch") {
      const cands = rows.filter((r) => r.dex && AMM_DEXES.has(r.dex)).slice(0, MAX_GRAD_LOOKUPS);
      if (rows.filter((r) => r.dex && AMM_DEXES.has(r.dex)).length > MAX_GRAD_LOOKUPS) notes.push(`Graduations were looked up for the newest ${MAX_GRAD_LOOKUPS} tokens trading on an AMM only.`);
      let i = 0;
      const views = new Map<string, TokenView | null>();
      const run = async () => { for (let r = cands[i++]; r; r = cands[i++]) { try { views.set(r.mint, await d.tokenView(r.mint, 1)); } catch { views.set(r.mint, null); } } };
      await Promise.all(Array.from({ length: Math.min(4, cands.length) }, run));
      for (const r of cands) {
        const v = views.get(r.mint);
        const g = v ? graduationOf(v) : null;
        if (g != null && g >= cutoff) evs.push({ ts: g, row: r, source: "graduation", ageMin: Math.max(0, (g - r.firstSeen! * 1000) / MIN) });
      }
    }
    evs.sort((a, b) => a.ts - b.ts);
    for (const e of evs) {
      await sim.signal({ ts: e.ts, mint: e.row.mint, symbol: e.row.symbol, price: null, source: synth(e.source === "launch" ? "new token" : "graduation", e.row.mint, e.row.symbol, e.ts, null), known: { ageMin: e.ageMin } });
    }
    notes.push("Chord's new-token board holds the tokens first seen in the last 24 h that reached $5,000 of volume (among the 400 most traded): launches that never traded that much are not on it, so the replay only sees tokens that already got some traction.");
    if (nDays > 1) { notes.unshift(`Only the last 24 h of the ${nDays} days could be replayed: that is how far back the new-token board goes.`); coveredHours = 24; }
    notes.push("Entries fill at the close of the first candle after the launch or graduation, with no slippage or fees: real snipes pay much more in the first minutes.");
  } else {
    const lt = t as TriggerOf<"lp_event">;
    const targets = new Map<string, string | null>();
    for (const p of lt.pools ?? []) targets.set(p, null);
    for (const m of lt.mints ?? []) {
      try {
        const v = await d.tokenView(m, 1);
        for (const p of (v?.pools ?? []).filter((x) => !LAUNCHPAD_DEXES.has(x.dex) && (x.liquidityUsd ?? 0) > 0).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, 3)) if (!targets.has(p.pool)) targets.set(p.pool, m);
      } catch { notes.push(`${short(m)}: its pools could not be read.`); }
    }
    if (!targets.size) notes.push((lt.pools?.length || lt.mints?.length) ? "None of the watched tokens has a pool whose liquidity the tape decodes." : "This trigger watches the tokens the bot holds; a backtest starts holding nothing, so there is nothing to replay.");
    const hours = Math.min(168, nDays * 24);
    const evs: { ts: number; mint: string; symbol: string | null; detail: string; pool: string }[] = [];
    let since: number | null = null;
    for (const [pool, mint] of targets) {
      let v: LpPoolView | null = null;
      try { v = await d.lpPool(pool, hours); } catch (e) { notes.push(`Pool ${short(pool)}: ${String((e as Error)?.message ?? e).slice(0, 100)}.`); continue; }
      if (!v) { notes.push(`Pool ${short(pool)}: the LP tape never saw liquidity move there.`); continue; }
      if (v.since != null) since = since == null ? v.since : Math.max(since, v.since);
      const token = mint ?? v.token;
      if (!token) continue;
      if (lt.event === "exodus") {
        for (const h of v.hourly) {
          if (h.withdrawalsUsd > 2 * h.depositsUsd && h.withdrawalsUsd >= (lt.minUsd ?? 0)) {
            const ts = Math.min(now, (h.hour + 3600) * 1000);
            if (ts >= cutoff) evs.push({ ts, mint: token, symbol: v.symbol, pool, detail: `exodus ${money(h.withdrawalsUsd)} out vs ${money(h.depositsUsd)} in` });
          }
        }
      } else {
        let before: number | null = null;
        for (let page = 0; page < MAX_LP_PAGES; page++) {
          let rows: LpEventRow[] = [];
          try { rows = await d.lpEvents(pool, 200, before); } catch { break; }
          for (const e of rows) {
            const kind = e.kind === "add" ? "large_add" : e.kind === "remove" ? "large_remove" : null;
            if (kind === lt.event && e.usd != null && e.usd >= (lt.minUsd ?? 0) && e.ts * 1000 >= cutoff) evs.push({ ts: e.ts * 1000, mint: token, symbol: v.symbol, pool, detail: `${money(e.usd)} ${kind === "large_add" ? "added" : "removed"}` });
          }
          const oldest = rows.reduce((a, e) => Math.min(a, e.ts), Infinity);
          if (rows.length < 200 || oldest * 1000 < cutoff || !Number.isFinite(oldest)) break;
          before = oldest;
        }
      }
    }
    evs.sort((a, b) => a.ts - b.ts);
    for (const e of evs) await sim.signal({ ts: e.ts, mint: e.mint, symbol: e.symbol, price: null, source: synth(`lp ${short(e.pool)}: ${e.detail}`, e.mint, e.symbol, e.ts, null) });
    if (since != null) notes.push(`Chord's LP tape starts at ${when(since * 1000)}: liquidity moves before that are not on it.`);
  }

  const mark = await sim.finish(now, d.prices);
  if (sparsePaths) notes.push(`${sparsePaths} token${sparsePaths > 1 ? "s" : ""} had fewer than ${SPARSE_CANDLES} candles on Chord: ${sparsePaths > 1 ? "their" : "its"} exits were walked on the tape's trade prices too.`);
  if (candleCapped) notes.push(`Exits were walked on candles for the first ${MAX_CANDLE_TOKENS} tokens bought; the others use the tape's trade prices.`);
  if (sim.notApplied.size) notes.push(`Not applied (they need live data): ${[...sim.notApplied].join(", ")}.`);
  if (s.action.type === "alert" || s.action.type === "webhook") {
    notes.push(sim.alerts ? `Would have alerted ${sim.alerts} time${sim.alerts > 1 ? "s" : ""} (first: ${sim.alertTimes.map(when).join(", ")}).` : "Would not have alerted in the window.");
  }
  if (s.action.type === "sell") notes.push("A sell action needs a position; a backtest starts holding nothing.");
  if (sim.pos.size) notes.push(`${sim.pos.size} open position${sim.pos.size > 1 ? "s" : ""} marked at ${mark.jup ? `Jupiter's current price (${mark.jup})` : ""}${mark.jup && mark.last ? " and " : ""}${mark.last ? `the last price seen (${mark.last})` : ""}.`);
  if (sim.fills.length > MAX_FILLS_RETURNED) notes.push(`${sim.fills.length.toLocaleString("en-US")} fills in the replay; the newest ${MAX_FILLS_RETURNED} are listed.`);

  return {
    strategy: s.name, trigger: t.type, signals: sim.signals, alerts: sim.alerts,
    ...(wallets.length ? { walletsRead: wallets.length - unread.length, unreadWallets: unread } : {}),
    ...(coveredHours != null ? { coveredHours } : {}),
    days: nDays, wallets, usdPerTrade: s.action.type === "buy" ? s.action.usd : 0,
    trades: sim.buys + sim.sells, buys: sim.buys, sells: sim.sells, skipped: sim.skipped,
    investedUsd: cents(sim.invested), realizedUsd: cents(sim.realized), unrealizedUsd: cents(mark.unrealized),
    winRate: sim.sells ? sim.wins / sim.sells : null, maxDrawdownUsd: cents(sim.maxDd),
    equity: thin(sim.equity).map((e) => ({ ts: e.ts, usd: cents(e.usd) })),
    fills: sim.fills.slice(-MAX_FILLS_RETURNED).map((f) => ({ ...f, usd: cents(f.usd), pnlUsd: f.pnlUsd == null ? null : cents(f.pnlUsd) })),
    notes,
  };
}
