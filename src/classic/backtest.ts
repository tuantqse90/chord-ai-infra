// Replay a classic strategy on real candles: the target decided at a bar's close is traded at the next bar's open, with the
// venue's taker fee, a slippage allowance and (for perps) every funding print of the data source. Fixed notional
// (size × leverage), no compounding, no parameter search on the reported window. Every assumption ends up in `notes`.
import { candles, funding, FUNDING_PER_YEAR, HL_MAX_CANDLES, SOURCE_NAMES, SOURCES, TF_MS, TFS, type Candle, type Funding, type Source, type Tf } from "./data";
import { ClassicInputError, paramsFor, strategyById, type Params } from "./strategies";
import type { Series } from "./indicators";

export type Venue = "perpl" | "monad_spot";
export const VENUES: readonly Venue[] = ["perpl", "monad_spot"];
/** Perpl tier-1 taker 3.45 bps (live /v1/pub/context, 11/10); Chord's router on Monad 5 bps. */
export const VENUE_FEE_BPS: Record<Venue, number> = { perpl: 3.45, monad_spot: 5 };
/** Monad spot: the token Chord's router trades for each symbol (long only, no leverage). */
export const SPOT_TOKENS: Record<string, { symbol: string; address: string }> = {
  BTC: { symbol: "cbBTC", address: "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b" },
  ETH: { symbol: "WETH", address: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242" },
  MON: { symbol: "WMON", address: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" },
};
const MAJORS = new Set(["BTC", "ETH", "SOL"]);
export const slippageBps = (venue: Venue, symbol: string) => (venue === "monad_spot" ? 10 : MAJORS.has(symbol) ? 2 : 5);
export const MAX_DAYS = 1095;
export const MAX_SIZE_USD = 10_000;

export interface BacktestInput { strategy: string; params?: unknown; symbol: string; tf?: Tf; days?: number; source: Source; venue?: Venue; sizeUsd?: number; leverage?: number }
export interface Trip { side: "long" | "short"; entryTs: number; exitTs: number | null; entryPx: number; exitPx: number | null; pnlUsd: number; feesUsd: number; fundingUsd: number }
export interface BacktestResult {
  strategy: string; title: string; rule: string; params: Params; symbol: string; tf: Tf; days: number; source: Source; venue: Venue; sizeUsd: number; leverage: number;
  from: number; to: number; bars: number; coveredDays: number; fills: number; trades: Trip[];
  pnlUsd: number; returnPct: number; buyHoldUsd: number; buyHoldPct: number; maxDrawdownPct: number; sharpe: number | null; winRate: number | null;
  tradeCount: number; avgHoldH: number | null; exposurePct: number; feesUsd: number; fundingUsd: number; position: number;
  equity: { t: number; usd: number }[]; notes: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
export function normalizeInput(i: BacktestInput) {
  const s = strategyById(String(i.strategy ?? ""));
  if (!s) throw new ClassicInputError(`no classic strategy "${i.strategy}"`);
  const venue: Venue = i.venue === "monad_spot" ? "monad_spot" : "perpl";
  const symbol = String(i.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) throw new ClassicInputError("symbol: a ticker like BTC, ETH or MON");
  if (venue === "monad_spot" && !SPOT_TOKENS[symbol]) throw new ClassicInputError(`Monad spot trades ${Object.keys(SPOT_TOKENS).join(", ")} through Chord's router; use Perpl for ${symbol}`);
  if (!(SOURCES as readonly string[]).includes(i.source)) throw new ClassicInputError(`source: one of ${SOURCES.join(", ")}`);
  const tf = (i.tf ?? s.tf) as Tf;
  if (!TFS.includes(tf)) throw new ClassicInputError(`tf: one of ${TFS.join(", ")}`);
  const days = Math.round(Number(i.days ?? s.days));
  if (!(days >= 7 && days <= MAX_DAYS)) throw new ClassicInputError(`days: 7 to ${MAX_DAYS}`);
  const sizeUsd = Number(i.sizeUsd ?? 100);
  if (!(sizeUsd >= 10 && sizeUsd <= MAX_SIZE_USD)) throw new ClassicInputError(`sizeUsd: 10 to ${MAX_SIZE_USD.toLocaleString("en-US")}`);
  const leverage = venue === "monad_spot" ? 1 : Number(i.leverage ?? 1);
  if (!(leverage >= 1 && leverage <= 3)) throw new ClassicInputError("leverage: 1 to 3");
  const params = paramsFor(s, i.params);
  if (venue === "monad_spot" && "shorts" in params) params.shorts = 0;
  if (s.needsFunding && venue === "monad_spot") throw new ClassicInputError(`${s.title} needs perps (funding); run it on Perpl`);
  return { s, venue, symbol, tf, days, sizeUsd, leverage, params, source: i.source as Source };
}

/** Funding as % a year at each bar's close: the average of the prints in the 24 h before it, × prints per year (one print
 *  is noisy: Perpl's rate moves in whole micros per ~43 min interval). */
export function fundingAnnualPerBar(bars: Candle[], prints: Funding[], tf: Tf, perYear: number, windowMs = 86_400_000): Series {
  const out: Series = [];
  let lo = 0, hi = 0, sum = 0;
  for (const b of bars) {
    const close = b.t + TF_MS[tf];
    while (hi < prints.length && prints[hi].t <= close) sum += prints[hi++].rate;
    while (lo < hi && prints[lo].t <= close - windowMs) sum -= prints[lo++].rate;
    out.push(hi > lo ? (sum / (hi - lo)) * perYear * 100 : null);
  }
  return out;
}

export interface SimInput { bars: Candle[]; targets: (number | null)[]; start: number; prints: Funding[]; tf: Tf; notional: number; feeBps: number; slipBps: number; perps: boolean }
/** The bar-by-bar ledger: trades at opens, funding inside bars, equity at closes. Exported for tests. */
export function simulate(x: SimInput) {
  const { bars, targets, start, tf, notional, feeBps, slipBps, perps } = x;
  let qty = 0, avg = 0, avgFee = 0, cur = 0, realized = 0, fees = 0, fund = 0, fills = 0, held = 0, exits = 0, exitWins = 0;
  let trip: Trip | null = null, tripStart = { realized: 0, fees: 0, fund: 0 };
  const trips: Trip[] = [], equity: { t: number; usd: number }[] = [];
  const printsAt = new Map<number, Funding[]>();
  if (perps) for (const f of x.prints) { const i = Math.floor((f.t - bars[0].t) / TF_MS[tf]); if (i >= start && i < bars.length) printsAt.set(i, [...(printsAt.get(i) ?? []), f]); }
  const trade = (dq: number, px: number, ts: number) => {
    if (!dq) return;
    const exec = px * (1 + (Math.sign(dq) * slipBps) / 1e4), fee = (Math.abs(dq) * exec * feeBps) / 1e4;
    fees += fee; fills++;
    if (qty === 0 || Math.sign(qty) === Math.sign(dq)) {
      const n = Math.abs(qty) + Math.abs(dq);
      avg = (avg * Math.abs(qty) + exec * Math.abs(dq)) / n; avgFee = (avgFee * Math.abs(qty) + fee) / n; qty += dq;
    } else {
      // an exit: the part of the position it closes, against the average cost and entry fee of what it closes, after its own fee
      const closing = Math.min(Math.abs(dq), Math.abs(qty)), r = (exec - avg) * closing * Math.sign(qty);
      realized += r; exits++; if (r - closing * avgFee - fee * (closing / Math.abs(dq)) > 0) exitWins++;
      qty += dq; if (Math.abs(qty) < 1e-12) { qty = 0; avg = 0; avgFee = 0; }
      else if (Math.sign(qty) === Math.sign(dq)) { avg = exec; avgFee = fee / Math.abs(dq); } // flipped in one fill
    }
    if (qty !== 0 && !trip) { trip = { side: qty > 0 ? "long" : "short", entryTs: ts, exitTs: null, entryPx: exec, exitPx: null, pnlUsd: 0, feesUsd: 0, fundingUsd: 0 }; tripStart = { realized, fees: fees - (Math.abs(dq) * exec * feeBps) / 1e4, fund }; }
    if (qty === 0 && trip) { const t = trip as Trip; t.exitTs = ts; t.exitPx = exec; t.feesUsd = r2(fees - tripStart.fees); t.fundingUsd = r2(fund - tripStart.fund); t.pnlUsd = r2(realized - tripStart.realized - (fees - tripStart.fees) + (fund - tripStart.fund)); trips.push(t); trip = null; }
  };
  for (let i = start; i < bars.length; i++) {
    const b = bars[i], tgt = targets[i - 1] ?? 0;
    if (tgt !== cur) {
      if (tgt === 0 || Math.sign(tgt) !== Math.sign(cur)) { trade(-qty, b.o, b.t); if (tgt !== 0) trade((tgt * notional) / b.o, b.o, b.t); }
      else trade(((tgt - cur) * notional) / b.o, b.o, b.t);
      cur = tgt;
    }
    for (const f of printsAt.get(i) ?? []) if (qty !== 0) fund += -qty * b.c * f.rate;
    if (qty !== 0) held++;
    equity.push({ t: b.t + TF_MS[tf], usd: realized - fees + fund + qty * (b.c - avg) });
  }
  if (trip) { const t = trip as Trip, last = bars[bars.length - 1]; t.pnlUsd = r2(realized - tripStart.realized - (fees - tripStart.fees) + (fund - tripStart.fund) + qty * (last.c - avg)); t.feesUsd = r2(fees - tripStart.fees); t.fundingUsd = r2(fund - tripStart.fund); trips.push(t); }
  return { equity, trips, fills, fees, fund, held, exits, exitWins, position: cur };
}

function stats(equity: { t: number; usd: number }[], sizeUsd: number) {
  let peak = sizeUsd, dd = 0;
  for (const e of equity) { const v = sizeUsd + e.usd; peak = Math.max(peak, v); dd = Math.max(dd, peak > 0 ? (peak - v) / peak : 0); }
  const byDay = new Map<number, number>();
  for (const e of equity) byDay.set(Math.floor((e.t - 1) / 86_400_000), e.usd);
  const days = [...byDay.values()], rets = days.slice(1).map((v, i) => (v - days[i]) / sizeUsd);
  let sharpe: number | null = null;
  if (rets.length >= 10) {
    const m = rets.reduce((a, b) => a + b, 0) / rets.length, sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
    sharpe = sd > 0 ? Math.round((m / sd) * Math.sqrt(365) * 100) / 100 : null;
  }
  return { maxDrawdownPct: Math.round(dd * 1e4) / 100, sharpe };
}
const thin = <T>(a: T[], n: number) => (a.length <= n ? a : a.filter((_, i) => i % Math.ceil(a.length / n) === 0 || i === a.length - 1));

export async function backtest(input: BacktestInput, now = Date.now()): Promise<BacktestResult> {
  const { s, venue, symbol, tf, days, sizeUsd, leverage, params, source } = normalizeInput(input);
  const notes: string[] = [];
  const warm = s.warmup(params) + 5, step = TF_MS[tf];
  const windowFrom = Math.floor((now - days * 86_400_000) / step) * step;
  let from = windowFrom - warm * step;
  if (source === "hyperliquid") {
    const oldest = Math.floor(now / step) * step - (HL_MAX_CANDLES - 5) * step;
    if (from < oldest) { from = oldest; notes.push(`Hyperliquid keeps about ${HL_MAX_CANDLES} candles back from now.`); }
  }
  const bars = await candles(source, symbol, tf, from, now);
  if (bars.length < warm + 10) throw new ClassicInputError(`${SOURCE_NAMES[source]} has ${bars.length} ${tf} candles for ${symbol} in this window: not enough for ${s.title} (needs ${warm} to warm up)`);
  const perps = venue === "perpl";
  let prints: Funding[] = [];
  if (perps || s.needsFunding) {
    try { prints = await funding(source, symbol, from, now); } catch (e) { notes.push(`Funding from ${SOURCE_NAMES[source]} did not load (${(e as Error).message}): none counted.`); }
    if (source === "okx" && days > 85) notes.push("OKX keeps about 3 months of funding: older bars carry none.");
  }
  const start = Math.max(1, bars.findIndex((b) => b.t >= windowFrom));
  // the grid centres on the last close before the window (not the first warm-up bar)
  const ctx = { fundingAnnualPct: fundingAnnualPerBar(bars, prints, tf, FUNDING_PER_YEAR[source]), anchor: start - 1 };
  const targets = s.signal(bars, params, ctx);
  const covered = Math.round((bars[bars.length - 1].t + step - bars[start].t) / 86_400_000);
  if (covered < days - 2) notes.push(`${SOURCE_NAMES[source]} has ${symbol} ${tf} candles from ${new Date(bars[start].t).toISOString().slice(0, 10)}: this replay covers ${covered} of the ${days} days.`);
  const feeBps = VENUE_FEE_BPS[venue], slipBps = slippageBps(venue, symbol), notional = sizeUsd * leverage;
  const sim = simulate({ bars, targets, start, prints, tf, notional, feeBps, slipBps, perps });
  const st = stats(sim.equity, sizeUsd);
  const closed = sim.trips.filter((t) => t.exitTs != null);
  // a grid only goes flat above its range, so its round trips win by construction: each sell is its trade instead
  const grid = !!s.fractional;
  const first = bars[start], last = bars[bars.length - 1];
  const buyHoldUsd = r2(notional * (last.c / first.o - 1));
  const pnl = sim.equity.length ? sim.equity[sim.equity.length - 1].usd : 0;
  notes.push(`Signals on closed ${tf} candles from ${SOURCE_NAMES[source]}; trades at the next candle's open.`);
  notes.push(`${venue === "perpl" ? "Perpl" : "Chord's router on Monad"}: ${feeBps} bps fee per side, ${slipBps} bps slippage allowance, $${notional.toLocaleString("en-US")} per position (${sizeUsd} × ${leverage}x), no compounding.`);
  if (perps && source !== "perpl") notes.push(`Funding: ${SOURCE_NAMES[source]}'s prints stand in for Perpl's.`);
  if (venue === "monad_spot") notes.push(`Long only on Monad spot (${SPOT_TOKENS[symbol].symbol}); no funding.`);
  if (grid) notes.push(`${s.title}: centred on the last close before the window; a trade is one sell, won when it sells above the average cost of the lots it closes after fees both ways (funding is not split per sell).${s.id === "grid" ? " Below the range it holds the full size with no stop." : ""}`);
  return {
    strategy: s.id, title: s.title, rule: s.rule(params), params, symbol, tf, days, source, venue, sizeUsd, leverage,
    from: first.t, to: last.t + step, bars: bars.length - start, coveredDays: covered, fills: sim.fills, trades: sim.trips.slice(-200),
    pnlUsd: r2(pnl), returnPct: r2((pnl / sizeUsd) * 100), buyHoldUsd, buyHoldPct: r2((buyHoldUsd / sizeUsd) * 100),
    maxDrawdownPct: st.maxDrawdownPct, sharpe: st.sharpe,
    winRate: grid ? (sim.exits ? Math.round((sim.exitWins / sim.exits) * 100) / 100 : null) : closed.length ? Math.round((closed.filter((t) => t.pnlUsd > 0).length / closed.length) * 100) / 100 : null,
    tradeCount: grid ? sim.exits : closed.length, avgHoldH: !grid && closed.length ? Math.round((closed.reduce((a, t) => a + ((t.exitTs as number) - t.entryTs), 0) / closed.length / 3_600_000) * 10) / 10 : null,
    exposurePct: Math.round((sim.held / Math.max(1, bars.length - start)) * 1000) / 10, feesUsd: r2(sim.fees), fundingUsd: r2(sim.fund), position: sim.position,
    equity: thin(sim.equity.map((e) => ({ t: e.t, usd: r2(e.usd) })), 400), notes,
  };
}

export interface AcrossSources { results: Partial<Record<Source, BacktestResult>>; errors: Partial<Record<Source, string>>; agree: boolean | null; spreadPct: number | null; note: string | null }
/** The same strategy on every source, side by side; says when the sign of the result depends on the data source. */
export async function backtestAll(input: Omit<BacktestInput, "source">, sources: readonly Source[] = SOURCES): Promise<AcrossSources> {
  const results: AcrossSources["results"] = {}, errors: AcrossSources["errors"] = {};
  await Promise.all(sources.map(async (source) => {
    try { results[source] = await backtest({ ...input, source }); }
    catch (e) { errors[source] = (e as Error).message; }
  }));
  const r = Object.values(results) as BacktestResult[];
  if (!r.length && Object.values(errors).some((m) => /must|one of|no classic|needs|symbol|days|tf:|sizeUsd|leverage|parameter|shorter/i.test(String(m)))) throw new ClassicInputError(Object.values(errors)[0] as string);
  // a result within ±1 % of the size is "flat" and agrees with either side; a gain on one source and a loss on another does not
  const up = r.some((x) => x.returnPct >= 1), down = r.some((x) => x.returnPct <= -1);
  const agree = r.length >= 2 ? !(up && down) : null;
  const rets = r.map((x) => x.returnPct);
  return { results, errors, agree, spreadPct: r.length >= 2 ? r2(Math.max(...rets) - Math.min(...rets)) : null, note: agree === false ? "The sources disagree on the sign: the edge depends on the data, not the rule." : null };
}
