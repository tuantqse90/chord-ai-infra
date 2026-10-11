// Classic agents (bot type "classic"), PAPER mode. On each closed candle of the agent's timeframe the runner reads the last
// candles from its signal source (Binance, OKX, Hyperliquid or Perpl), asks the strategy for the target position, and moves
// the paper position there: open, close, flip (two fills) or resize (the grid).
//   venue perpl       perps on Perpl: each fill walks Perpl's live book for its notional (VWAP) and pays the taker fee; a short
//                     is a negative quantity with a negative cost, so value − cost is its PnL like a long's; funding events
//                     move the position's cost (a long pays positive funding); positions are marked to Perpl's mark price.
//   venue monad_spot  long only through Chord's router on Monad (the same paper buy / sell as the strategy agents).
// Every filled fill is an ordinary fill: the committer hashes it into the agent's TrackRecord on Monad.
import { randomBytes } from "node:crypto";
import { emit } from "../bots/bus";
import { closePosition, insertFill, markMint, positionOf, setPosition } from "../bots/store";
import { logEvent, publishStats, type FiredBy } from "../bots/executor";
import type { Fill } from "../bots/types";
import type { ClassicRules } from "../bots/validate";
import { fundingAnnualPerBar, SPOT_TOKENS } from "./backtest";
import { FUNDING_PER_YEAR, SOURCE_NAMES, TF_MS, type Candle, type Funding, type Source, type Tf } from "./data";
import { strategyById } from "./strategies";
import { walkBook, type PerplBook, type PerplMarket, type PerplTicker } from "../perpl/client";

export interface ClassicDeps {
  now: () => number;
  candles: (source: Source, symbol: string, tf: Tf, from: number) => Promise<Candle[]>;
  funding: (source: Source, symbol: string, from: number) => Promise<Funding[]>;
  perplMarket: (symbol: string) => Promise<PerplMarket | null>;
  perplBook: (m: PerplMarket) => Promise<PerplBook>;
  perplTicker: (m: PerplMarket) => Promise<PerplTicker>;
  perplFunding: (m: PerplMarket, from: number, to: number) => Promise<{ t: number; rate: number }[]>;
  spotBuy: (botId: string, mint: string, usd: number, sig: FiredBy) => Promise<Fill>;
  spotSell: (botId: string, mint: string, pct: number, sig: FiredBy) => Promise<Fill>;
  createdAt: (botId: string) => number | null;
}

export const perpMint = (symbol: string) => `perpl:${symbol}`;
export const perpSymbol = (symbol: string) => `${symbol}-PERP`;
export const mintOf = (r: Pick<ClassicRules, "venue" | "symbol">) => (r.venue === "perpl" ? perpMint(r.symbol) : SPOT_TOKENS[r.symbol].address);
const TICK_MS = 15_000, MARK_EVERY_MS = 30_000, FUNDING_EVERY_MS = 300_000, TRIES_PER_BAR = 3;
const newId = () => randomBytes(6).toString("hex");
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const money = (n: number) => `$${Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en-US") : (Math.round(n * 100) / 100).toLocaleString("en-US")}`;
const label = (t: number, grid: boolean) => (grid ? `hold ${Math.round(t * 100)}% of the size` : t > 0 ? "long" : t < 0 ? "short" : "flat");

type Entry = { id: string; rules: ClassicRules; since: number; cur: number; lastBar: number | null; tries: number; busy: boolean; fundingFrom: number };
let seq = 0;

export function createClassicRunner(deps: ClassicDeps) {
  const agents = new Map<string, Entry>();
  let timer: ReturnType<typeof setInterval> | null = null, lastMark = 0, lastFunding = 0;

  /** The position the agent holds now, as a target: the sign for ±1 strategies, the size share (in grid steps) for the grids. */
  function currentTarget(id: string, r: ClassicRules): number {
    const pos = positionOf(id, mintOf(r));
    if (!pos || !pos.qty) return 0;
    if (!strategyById(r.strategy)?.fractional) return Math.sign(pos.qty);
    const step = 1 / (r.params.levels || 10), share = Math.abs(pos.costUsd) / (r.sizeUsd * r.leverage);
    return Math.max(0, Math.min(1, Math.round(share / step) * step));
  }

  function record(f: Fill): boolean {
    if (!insertFill(f)) return false;
    emit(f.botId, { type: "fill", fill: f });
    return true;
  }
  function source(e: Entry, side: "buy" | "sell", barClose: number, lastClose: number, detail: string) {
    return { wallet: "", tx: `classic:${e.id}:${barClose}:${++seq}`, side, mint: mintOf(e.rules), symbol: e.rules.venue === "perpl" ? perpSymbol(e.rules.symbol) : SPOT_TOKENS[e.rules.symbol].symbol, usd: null, priceUsd: lastClose, ts: barClose, via: "strategy" as const, detail };
  }
  function skip(e: Entry, side: "buy" | "sell", usd: number, reason: string, src: ReturnType<typeof source>): void {
    record({ id: newId(), botId: e.id, ts: deps.now(), side, mint: src.mint, symbol: src.symbol, usd, tokenAmount: 0, priceUsd: src.priceUsd, status: "skipped", reason, pnlUsd: null, quote: null, source: src, mode: "paper" });
  }

  /** One perp fill on Perpl: walk the book, pay the fee, move the position. dq = signed quantity (+ buys, − sells). */
  async function perpTrade(e: Entry, m: PerplMarket, dqUsd: number | null, closeAll: boolean, src: (side: "buy" | "sell") => ReturnType<typeof source>): Promise<boolean> {
    const mint = perpMint(e.rules.symbol), pos = positionOf(e.id, mint);
    let side: "buy" | "sell", notional: number;
    const b = await deps.perplBook(m);
    const mid = b.bids.length && b.asks.length ? (b.bids[0].price + b.asks[0].price) / 2 : null;
    if (closeAll) {
      if (!pos || !pos.qty) return true;
      side = pos.qty > 0 ? "sell" : "buy";
      notional = Math.abs(pos.qty) * (mid ?? pos.priceUsd ?? 0);
    } else {
      side = (dqUsd as number) > 0 ? "buy" : "sell";
      notional = Math.abs(dqUsd as number);
    }
    const s = src(side);
    if (!mid) { skip(e, side, notional, "Perpl's book is empty on one side: no price to fill at", s); return false; }
    const w = walkBook(b, side, notional);
    if (!w || !w.complete) { skip(e, side, notional, `Perpl's book could not fill ${money(notional)} of ${m.symbol} within 100 levels`, s); return false; }
    const fee = (w.filledUsd * m.takerFeeBps) / 1e4, now = deps.now();
    const qtyTraded = closeAll ? Math.abs(pos!.qty) : w.size;
    const dq = side === "buy" ? qtyTraded : -qtyTraded;
    let pnl: number | null = null;
    const quote = { provider: "Perpl", route: [perpSymbol(m.symbol)], priceImpactPct: w.impactPct };
    const fill: Fill = { id: newId(), botId: e.id, ts: now, side, mint, symbol: perpSymbol(m.symbol), usd: Math.round(qtyTraded * w.vwap * 100) / 100, tokenAmount: qtyTraded, priceUsd: w.vwap, status: "filled", reason: null, pnlUsd: null, quote, source: s, mode: "paper" };
    if (pos && pos.qty && Math.sign(dq) !== Math.sign(pos.qty)) {
      // reducing or closing: realize the share being closed (fee included)
      const share = Math.min(1, qtyTraded / Math.abs(pos.qty));
      pnl = share * (pos.qty * w.vwap - pos.costUsd) - fee;
      fill.pnlUsd = Math.round(pnl * 100) / 100;
      if (!record(fill)) return false;
      if (share >= 0.999) closePosition(e.id, mint);
      else setPosition(e.id, { mint, symbol: pos.symbol, qty: pos.qty * (1 - share), costUsd: pos.costUsd * (1 - share), priceUsd: w.vwap, openedAt: pos.openedAt, ts: now });
    } else {
      // opening or adding: a long's cost is what it paid plus the fee; a short's is minus what it received, less the fee
      const cost = dq > 0 ? qtyTraded * w.vwap + fee : -(qtyTraded * w.vwap - fee);
      if (!record(fill)) return false;
      setPosition(e.id, { mint, symbol: perpSymbol(m.symbol), qty: (pos?.qty ?? 0) + dq, costUsd: (pos?.costUsd ?? 0) + cost, priceUsd: w.vwap, openedAt: pos?.openedAt ?? now, ts: now });
    }
    return true;
  }

  async function evaluate(e: Entry): Promise<void> {
    const r = e.rules, s = strategyById(r.strategy);
    if (!s) return;
    const step = TF_MS[r.tf], now = deps.now(), lastOpen = Math.floor(now / step) * step - step;
    if (e.lastBar === lastOpen) return;
    const anchor = s.anchored ? Math.floor((deps.createdAt(e.id) ?? e.since) / step) * step - step : null;
    const from = anchor ?? lastOpen - (s.warmup(r.params) + 60) * step;
    const bars = await deps.candles(r.signalSource, r.symbol, r.tf, from);
    const last = bars[bars.length - 1];
    if (!last || last.t < lastOpen) { if (++e.tries >= TRIES_PER_BAR) { e.lastBar = lastOpen; e.tries = 0; } return; } // the source has not closed this bar yet
    let fundingAnnualPct = bars.map(() => null as number | null);
    if (s.needsFunding) fundingAnnualPct = fundingAnnualPerBar(bars, await deps.funding(r.signalSource, r.symbol, from - 86_400_000), r.tf, FUNDING_PER_YEAR[r.signalSource]);
    const targets = s.signal(bars, r.params, { fundingAnnualPct });
    const tgt = targets[targets.length - 1] ?? 0;
    e.cur = currentTarget(e.id, r);
    if (tgt === e.cur) { e.lastBar = lastOpen; e.tries = 0; return; }
    const barClose = last.t + step, grid = !!s.fractional;
    const detail = `${s.title} on ${SOURCE_NAMES[r.signalSource]} ${r.tf}, ${hhmm(barClose)} UTC close: ${label(tgt, grid)} (${s.rule(r.params)})`;
    const notional = r.sizeUsd * r.leverage;
    let ok = true;
    if (r.venue === "monad_spot") {
      const mint = mintOf(r), sig: FiredBy = { detail, ts: barClose };
      const f = tgt > e.cur ? await deps.spotBuy(e.id, mint, Math.round((tgt - e.cur) * r.sizeUsd * 100) / 100, sig)
        : await deps.spotSell(e.id, mint, tgt <= 0 ? 100 : Math.round(((e.cur - tgt) / e.cur) * 10_000) / 100, sig);
      ok = f.status === "filled";
    } else {
      const src = (side: "buy" | "sell") => source(e, side, barClose, last.c, detail);
      let m: PerplMarket | null = null;
      try { m = await deps.perplMarket(r.symbol); } catch (err) { skip(e, tgt > e.cur ? "buy" : "sell", notional, `Perpl data unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}`, src(tgt > e.cur ? "buy" : "sell")); ok = false; }
      if (ok && !m) { skip(e, "buy", notional, `${r.symbol} is not listed on Perpl any more`, src("buy")); ok = false; }
      if (ok && m) {
        try {
          if (tgt === 0 || Math.sign(tgt) !== Math.sign(e.cur)) {
            ok = await perpTrade(e, m, null, true, src);
            if (ok && tgt !== 0) ok = await perpTrade(e, m, tgt * notional, false, src);
          } else ok = await perpTrade(e, m, (tgt - e.cur) * notional, false, src);
        } catch (err) { skip(e, tgt > e.cur ? "buy" : "sell", notional, `Perpl data unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}`, src(tgt > e.cur ? "buy" : "sell")); ok = false; }
      }
    }
    e.cur = currentTarget(e.id, r);
    if (ok || ++e.tries >= TRIES_PER_BAR) { e.lastBar = lastOpen; e.tries = 0; }
    publishStats(e.id);
  }

  /** Mark perps to Perpl's mark price; every 5 minutes, fold Perpl's funding events into the positions' cost. */
  async function mark(): Promise<void> {
    const now = deps.now();
    const perps = [...agents.values()].filter((e) => e.rules.venue === "perpl");
    const doFunding = now - lastFunding >= FUNDING_EVERY_MS;
    if (doFunding) lastFunding = now;
    for (const sym of new Set(perps.map((e) => e.rules.symbol))) {
      try {
        const m = await deps.perplMarket(sym); if (!m) continue;
        const t = await deps.perplTicker(m);
        markMint(perpMint(sym), t.mark, now);
        if (!doFunding) continue;
        const holders = perps.filter((e) => e.rules.symbol === sym && positionOf(e.id, perpMint(sym))?.qty);
        if (!holders.length) continue;
        const events = await deps.perplFunding(m, Math.min(...holders.map((e) => e.fundingFrom)) + 1, now);
        for (const e of holders) {
          const pos = positionOf(e.id, perpMint(sym)); if (!pos) continue;
          const due = events.filter((f) => f.t > e.fundingFrom && f.t >= pos.openedAt);
          if (!due.length) continue;
          const paid = due.reduce((a, f) => a + pos.qty * t.mark * f.rate, 0); // > 0 = the position paid
          setPosition(e.id, { mint: pos.mint, symbol: pos.symbol, qty: pos.qty, costUsd: pos.costUsd + paid, priceUsd: t.mark, openedAt: pos.openedAt, ts: now });
          e.fundingFrom = due[due.length - 1].t;
        }
      } catch { /* the next tick tries again */ }
    }
    for (const e of perps) publishStats(e.id);
  }

  async function tick(): Promise<void> {
    for (const e of agents.values()) {
      if (e.busy) continue;
      e.busy = true;
      try { await evaluate(e); }
      catch (err) { logEvent(e.id, "warn", `Could not read the ${e.rules.tf} candles from ${SOURCE_NAMES[e.rules.signalSource]}: ${String((err as Error)?.message ?? err).slice(0, 160)}`, deps.now()); e.tries++; }
      finally { e.busy = false; }
    }
    if (deps.now() - lastMark >= MARK_EVERY_MS) { lastMark = deps.now(); await mark().catch(() => {}); }
  }

  return {
    add(id: string, rules: ClassicRules, since: number): void {
      agents.set(id, { id, rules, since, cur: currentTarget(id, rules), lastBar: null, tries: 0, busy: false, fundingFrom: since });
      void (async () => { const e = agents.get(id); if (!e || e.busy) return; e.busy = true; try { await evaluate(e); } catch { /* the timer retries */ } finally { e.busy = false; } })();
    },
    remove(id: string): void { agents.delete(id); },
    has: (id: string) => agents.has(id),
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, TICK_MS);
      (timer as any).unref?.();
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; agents.clear(); },
    status: () => ({ agents: agents.size }),
    tick, evaluate: (id: string) => { const e = agents.get(id); return e ? evaluate(e) : Promise.resolve(); }, mark,
  };
}
export type ClassicRunner = ReturnType<typeof createClassicRunner>;
