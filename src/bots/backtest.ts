// Backtest a copy bot on real history: every followed wallet's swaps over `days` from Chord's tape (paged, newest 2,000 per
// wallet), replayed in time order with the bot's own rules. Buys fill usdPerTrade at the wallet's own trade price; mirrored
// sells close the whole position at the sell's price; open positions are marked at Jupiter's current price (else the last
// tape price). Gates that need live data (safety, liquidity, daily loss stop) cannot be replayed and the notes say so.
import { prices as jupPrices, QUOTE_MINTS } from "./market";
import { walletTrades, toSource, type TapeRow } from "./tape";
import { BotInputError } from "./errors";
import { validateCopyParams, validateDays } from "./validate";
import type { Backtest, CopyParams } from "./types";

export const MAX_TRADES_PER_WALLET = 2000;
const PAGE = 200;
const MAX_PAGES = 25;
const MAX_FILLS_RETURNED = 1000;
const MAX_EQUITY_POINTS = 400;

export interface BacktestDeps {
  page: (wallet: string, limit: number, beforeS: number | null) => Promise<TapeRow[]>;
  prices: (mints: string[]) => Promise<Map<string, number>>;
  now: () => number;
}
const defaults = (): BacktestDeps => ({ page: walletTrades, prices: jupPrices, now: () => Date.now() });

const cents = (n: number) => Math.round(n * 100) / 100;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** The wallet's rows at or after `cutoffS`, newest first, at most 2,000. The box serves `before` strictly (ts < before), so a
 *  page boundary inside one second is re-asked with before = that second + 1 and the repeats are dropped. */
async function history(deps: BacktestDeps, wallet: string, cutoffS: number): Promise<{ rows: TapeRow[]; capped: boolean }> {
  const out: TapeRow[] = [];
  const keys = new Set<string>();
  let before: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await deps.page(wallet, PAGE, before);
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

type Pos = { qty: number; cost: number; symbol: string | null };
type BtFill = Backtest["fills"][number];

export async function runBacktest(input: { params: CopyParams | unknown; days: unknown }, deps: Partial<BacktestDeps> = {}): Promise<Backtest> {
  const d = { ...defaults(), ...deps };
  if (!input || typeof input !== "object") throw new BotInputError("backtest needs { params, days }");
  const p = validateCopyParams(input.params);
  const days = validateDays(input.days);
  const nowMs = d.now();
  const cutoffS = Math.floor(nowMs / 1000) - days * 86_400;
  const notes: string[] = [];

  const got = await Promise.all(p.wallets.map(async (w) => {
    try { return { w, ...(await history(d, w, cutoffS)), error: null as string | null }; }
    catch (e) { return { w, rows: [] as TapeRow[], capped: false, error: String((e as Error)?.message ?? e).slice(0, 140) }; }
  }));
  if (got.every((g) => g.error)) throw new Error(`Chord's Solana tape could not be read for any followed wallet (${got[0].error})`);
  for (const g of got) {
    if (g.error) notes.push(`Wallet ${short(g.w)}: the tape could not be read (${g.error}); it is left out.`);
    else if (!g.rows.length) notes.push(`Wallet ${short(g.w)}: no swaps on the tape in the last ${days} day${days > 1 ? "s" : ""}.`);
    else if (g.capped) notes.push(`Wallet ${short(g.w)}: only its newest ${MAX_TRADES_PER_WALLET.toLocaleString("en-US")} swaps were replayed (from ${day(g.rows[g.rows.length - 1].ts)}).`);
  }

  // Time order across wallets; inside one second keep each wallet's own order (the tape serves newest first).
  const events = got.flatMap((g) => g.rows.map((r, i) => ({ r, w: g.w, seq: -i }))).filter((e) => !QUOTE_MINTS.has(e.r.token));
  events.sort((a, b) => a.r.ts - b.r.ts || (a.w === b.w ? a.seq - b.seq : 0));

  const pos = new Map<string, Pos>();
  const lastPx = new Map<string, number>();
  const fills: BtFill[] = [];
  let realized = 0, invested = 0, buys = 0, sells = 0, skipped = 0, wins = 0;
  const equity: { ts: number; usd: number }[] = [{ ts: cutoffS * 1000, usd: 0 }];
  let peak = 0, maxDd = 0;
  const unrealized = (px: Map<string, number>) => {
    let u = 0;
    for (const [m, q] of pos) u += q.qty * (px.get(m) ?? q.cost / q.qty) - q.cost;
    return u;
  };
  const point = (tsMs: number, usd: number) => {
    equity.push({ ts: tsMs, usd });
    peak = Math.max(peak, usd);
    maxDd = Math.max(maxDd, peak - usd);
  };

  for (const { r, w } of events) {
    const src = toSource(r, w);
    if (!src) continue;
    const priced = r.priceUsd != null && r.priceUsd > 0 ? r.priceUsd : null;
    const before = { held: pos.has(r.token) };
    if (priced) lastPx.set(r.token, priced);
    const base = { ts: r.ts * 1000, side: r.side, mint: r.token, symbol: r.symbol, source: src } as const;
    let changed = false;
    if (r.side === "buy") {
      const held = pos.get(r.token);
      let reason: string | null = null;
      if (!held && pos.size >= p.maxOpenPositions) reason = `max open positions: ${p.maxOpenPositions} already open`;
      else if (held && held.cost + p.usdPerTrade > p.maxPerTokenUsd + 1e-9) reason = `max per token: another $${p.usdPerTrade} would pass the $${p.maxPerTokenUsd} cap`;
      else if (!priced) reason = "the tape has no USD price for this buy";
      if (reason) {
        skipped++;
        fills.push({ ...base, usd: p.usdPerTrade, tokenAmount: 0, priceUsd: priced, status: "skipped", reason, pnlUsd: null });
      } else {
        const qty = p.usdPerTrade / priced!;
        const cur = held ?? { qty: 0, cost: 0, symbol: r.symbol };
        pos.set(r.token, { qty: cur.qty + qty, cost: cur.cost + p.usdPerTrade, symbol: cur.symbol ?? r.symbol });
        invested += p.usdPerTrade;
        buys++;
        changed = true;
        fills.push({ ...base, usd: p.usdPerTrade, tokenAmount: qty, priceUsd: priced, status: "filled", reason: null, pnlUsd: null });
      }
    } else if (p.mirrorSells && pos.has(r.token)) {
      const held = pos.get(r.token)!;
      if (!priced) {
        skipped++;
        fills.push({ ...base, usd: 0, tokenAmount: held.qty, priceUsd: null, status: "skipped", reason: "the tape has no USD price for this sell; the position is kept", pnlUsd: null });
      } else {
        const value = held.qty * priced;
        const pnl = value - held.cost;
        realized += pnl;
        sells++;
        if (pnl > 0) wins++;
        pos.delete(r.token);
        changed = true;
        fills.push({ ...base, symbol: r.symbol ?? held.symbol, usd: value, tokenAmount: held.qty, priceUsd: priced, status: "filled", reason: null, pnlUsd: pnl });
      }
    }
    if (changed || (before.held && priced)) point(r.ts * 1000, realized + unrealized(lastPx));
  }

  // Mark what is still open: Jupiter's price now, else the last price the tape showed.
  let jupMarked = 0, tapeMarked = 0;
  if (pos.size) {
    let live = new Map<string, number>();
    try { live = await d.prices([...pos.keys()]); } catch { /* the tape price stands in */ }
    for (const m of pos.keys()) {
      const v = live.get(m);
      if (v != null) { lastPx.set(m, v); jupMarked++; } else tapeMarked++;
    }
  }
  const unreal = unrealized(lastPx);
  point(nowMs, realized + unreal);

  notes.push("Fills are priced at each followed wallet's own trade price on Chord's tape, with no slippage, price impact, fees or delay: a live copy lands after the wallet's own swap, so results are worse, much worse when the wallet buys in the first seconds of a launch.");
  notes.push("Safety (mint / freeze authority), minimum liquidity and the daily loss stop need live data and were not applied in this backtest.");
  notes.push("The tape reads PumpSwap, pump.fun, Meteora, Raydium and Orca; swaps on prop AMMs and order books are not on it.");
  if (!p.mirrorSells) notes.push("mirrorSells is off: positions are never sold, only marked.");
  if (pos.size) notes.push(`${pos.size} open position${pos.size > 1 ? "s" : ""} marked at ${jupMarked ? `Jupiter's current price (${jupMarked})` : ""}${jupMarked && tapeMarked ? " and " : ""}${tapeMarked ? `the last tape price (${tapeMarked})` : ""}.`);
  if (fills.length > MAX_FILLS_RETURNED) notes.push(`${fills.length.toLocaleString("en-US")} fills in the replay; the newest ${MAX_FILLS_RETURNED} are listed.`);

  return {
    days, wallets: p.wallets, usdPerTrade: p.usdPerTrade, trades: buys + sells, buys, sells, skipped, investedUsd: cents(invested), realizedUsd: cents(realized),
    unrealizedUsd: cents(unreal), winRate: sells ? wins / sells : null, maxDrawdownUsd: cents(maxDd), equity: thin(equity).map((e) => ({ ts: e.ts, usd: cents(e.usd) })),
    fills: fills.slice(-MAX_FILLS_RETURNED).map((f) => ({ ...f, usd: cents(f.usd), pnlUsd: f.pnlUsd == null ? null : cents(f.pnlUsd) })), notes,
  };
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

