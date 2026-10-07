// The LP agent in paper mode. Opening: Chord's pool facts, a safety check, Jupiter's live prices, the venue's fee APR and a
// range (preset from 7 days of hourly volatility, or ±rangePct); the deposit becomes CL liquidity L. Every minute (one batched
// Jupiter price call for every LP bot, see index.ts) each open position is marked: in / out of range, fees accrued (fee APR ×
// time in range: an estimate), exact IL, value, LP vs HODL. A running bot also acts: it rebalances after the price has been out
// of range for `outOfRangeMinutes` (at most `maxPerDay` a UTC day, the swap priced by a real Jupiter quote), and exits on an LP
// exodus, a token drop or the daily loss stop. A paused bot's position is still marked (it would still be in the pool) but
// nothing is rebalanced or exited. Nothing is ever signed or sent.
//
// Ledger: a fill "buy" = open (usd = deposit), a fill "sell" = rebalance or close (usd = value + fees taken out of the range,
// pnlUsd = that minus the range's cost basis and the swap cost). The one Position row is keyed by the POOL address:
// qty = USD put into the current range, priceUsd = what each of those dollars is worth now (CL value + unclaimed fees),
// so valueUsd = qty × priceUsd and pnlUsd = unrealized PnL of the current range.
//
// The LP copy agent (lpCopy.ts) holds up to maxOpenPositions such positions, one per pool, and reuses the marking (markLp),
// the exit checks (positionExit), the close (closeLpPosition) and the fill writer (recordLp) here; it never rebalances.
import { randomBytes } from "node:crypto";
import { KNOWN_MINTS } from "../solana/tokens";
import { emit } from "./bus";
import { logEvent, publishStats, todayLoss } from "./executor";
import { DEFAULT_IMPACT_PCT, DEFAULT_SWAP_FEE_PCT, money, pctText, priceText, rangeFor, recenter, swapShare } from "./lp";
import { amountsAt, boundsPct, FULL_RANGE, inRange, liquidityFor, sigma, valueAt, type PriceRange } from "./lpMath";
import { isExodus, livePair, poolInfo, pricePath, short, venueStats, type LpDeps, type PoolInfo } from "./lpData";
import { addLpPoint, botRow, closePosition, insertFill, lpStateOf, saveLpState, setBotName, setPosition } from "./store";
import type { Fill, LpFillKind, LpState, SourceTrade } from "./types";
import type { LpRules } from "./validate";

export const LP_TICK_MS = 60_000;
export const FEE_REFRESH_MS = 5 * 60_000;
export const EXODUS_CHECK_MS = 5 * 60_000;
export const POINT_EVERY_MS = 10 * 60_000;
export const MAX_ACCRUAL_MS = 5 * 60_000;   // a tick after downtime accrues at most 5 min of fees
const YEAR_MS = 365 * 86_400_000;
const WARN_EVERY_MS = 30 * 60_000;

export interface LpHooks {
  isRunning: (botId: string) => boolean;
  /** Take the bot out of the running set with a final status, an event and fresh stats. */
  stop: (botId: string, status: "stopped" | "error", level: "info" | "warn" | "error", msg: string, error: string | null) => void;
}

export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 200);
const utcDay = (ms: number) => Math.floor(ms / 86_400_000);
export const mins = (ms: number) => (ms >= 90 * 60_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`);
let seq = 0;

export const rangeOf = (st: LpState): PriceRange => (!st.range || st.range.full ? FULL_RANGE : { lower: st.range.lower, upper: st.range.upper ?? Infinity });
export function stateRange(p: number, r: PriceRange, rules: Pick<LpRules, "preset" | "rangePct">, logWidth: number | null, full: boolean): NonNullable<LpState["range"]> {
  const b = boundsPct(p, r);
  return { lower: r.lower, upper: Number.isFinite(r.upper) ? r.upper : null, downPct: b.downPct, upPct: Number.isFinite(b.upPct) ? b.upPct : null, full, preset: full ? null : rules.preset, rangePct: full ? null : rules.rangePct, logWidth };
}
export const rangeText = (st: LpState) => (st.range?.full ? "full range" : `${priceText(st.range!.lower)}–${st.range!.upper == null ? "∞" : priceText(st.range!.upper)} ${st.quoteSymbol ?? "quote"} per ${st.tokenSymbol ?? "token"}`);

/** Write one LP fill (and push it to the bot's stream). The source is the pool itself (an agent's own move) unless a copied
 *  move is given; `kind` is kept on the fill either way. Null when the bot is gone or the source was already answered. */
export function recordLp(botId: string, kind: LpFillKind, st: LpState, f: { ts: number; usd: number; tokenAmount: number; tokenUsd: number; pnlUsd: number | null; reason: string; quote: Fill["quote"] }, source?: SourceTrade): Fill | null {
  const bot = botRow(botId);
  if (!bot) return null;
  const side = kind === "open" ? "buy" : "sell";
  const fill: Fill = {
    id: randomBytes(6).toString("hex"), botId, ts: f.ts, side, mint: st.pool, symbol: st.pair, usd: f.usd, tokenAmount: f.tokenAmount, priceUsd: f.tokenUsd,
    status: "filled", reason: f.reason, pnlUsd: f.pnlUsd, quote: f.quote, mode: bot.mode, kind,
    source: source ?? { wallet: st.pool, tx: `lp:${kind}:${f.ts}:${++seq}`, side, mint: st.pool, symbol: st.pair, usd: f.usd, priceUsd: f.tokenUsd, ts: f.ts, via: "lp" },
  };
  if (!insertFill(fill)) return null;
  emit(botId, { type: "fill", fill });
  return fill;
}
const record = recordLp;

/** At most one event per `every` ms for this key (kept on the position, so it survives restarts). */
export function warnOnce(botId: string, st: LpState, key: string, every: number, level: "info" | "warn", msg: string, now: number): void {
  if (now - (st.warned[key] ?? 0) < every) return;
  st.warned[key] = now;
  logEvent(botId, level, msg, now);
}

/** Why a token may not be opened when safety is on (Jupiter's mint / freeze facts): `refuse` = a rule said no, `fail` = Jupiter
 *  could not be read. Null = safe, or a known major. */
export async function safetyIssue(d: LpDeps, token: string, sym: string): Promise<{ refuse: string } | { fail: string } | null> {
  if (KNOWN_MINTS[token]) return null;
  let t;
  try { t = await d.tokenInfo(token); } catch (e) { return { fail: `Jupiter could not be read to check ${sym}'s safety (${errText(e)})` }; }
  if (!t) return { refuse: `Jupiter has no safety facts for ${sym} (mint / freeze authority)` };
  if (t.mintAuthorityDisabled !== true) return { refuse: `${sym} ${t.mintAuthorityDisabled === false ? "still has a live mint authority (more can be minted)" : "has no mint-authority check on Jupiter"}` };
  if (t.freezeAuthorityDisabled !== true) return { refuse: `${sym} ${t.freezeAuthorityDisabled === false ? "still has a live freeze authority (holders can be frozen)" : "has no freeze-authority check on Jupiter"}` };
  return null;
}

export function freshState(info: PoolInfo, now: number): LpState {
  return {
    pool: info.pool, dex: info.dex, venue: info.venue, pair: info.pair, token: info.token, tokenSymbol: info.tokenSymbol, quote: info.quote, quoteSymbol: info.quoteSymbol,
    status: "opening", range: null, liquidity: 0, leg: null, first: null, feeApr: { pct: null, source: "not read yet", at: 0 }, feeRatePct: null,
    inRange: null, outSince: null, timeInRangeMs: 0, trackedMs: 0, feesTotalUsd: 0, rebalanceCostUsd: 0, rebalances: 0, rebalancesToday: { day: utcDay(now), n: 0 },
    mark: null, exodus: null, closedAt: null, closeReason: null, warned: {},
  };
}

/** Open (or re-open after an exit) the bot's paper LP position. Failures stop the bot with the reason as an event. */
export async function lpOpen(botId: string, p: LpRules, d: LpDeps, hooks: LpHooks, autoName = false): Promise<LpState | null> {
  const bot = botRow(botId);
  if (!bot || bot.type !== "lp") return null;
  const cur = lpStateOf(botId);
  if (cur?.status === "open") return cur;
  const end = (status: "stopped" | "error", msg: string) => {
    const s = lpStateOf(botId);
    if (s?.status === "opening" && botRow(botId)) saveLpState(botId, { ...s, status: "closed", closedAt: d.now(), closeReason: msg }, d.now());
    hooks.stop(botId, status, status === "error" ? "error" : "warn", msg, msg.slice(0, 200));
    return null;
  };
  const refuse = (msg: string) => end("stopped", msg);
  const fail = (msg: string) => end("error", msg);
  let info: PoolInfo;
  try { info = await poolInfo(d, p.pool); }
  catch (e) { return (e as Error)?.name === "BotInputError" ? refuse(`Cannot open: ${errText(e)}.`) : fail(`Cannot open: ${errText(e)}. Resume the bot to try again.`); }
  let st = freshState(info, d.now());
  if (botRow(botId)) saveLpState(botId, st, d.now());
  const sym = info.tokenSymbol ?? short(info.token);

  if (p.safety && !KNOWN_MINTS[info.token]) {
    let t;
    try { t = await d.tokenInfo(info.token); } catch (e) { return fail(`Cannot open: Jupiter could not be read to check ${sym}'s safety (${errText(e)}). Resume to try again.`); }
    if (!t) return refuse(`Not opened: Jupiter has no safety facts for ${sym} (mint / freeze authority). Create the bot with safety: false to open anyway.`);
    if (t.mintAuthorityDisabled !== true) return refuse(`Not opened, safety: ${sym} ${t.mintAuthorityDisabled === false ? "still has a live mint authority (more can be minted)" : "has no mint-authority check on Jupiter"}.`);
    if (t.freezeAuthorityDisabled !== true) return refuse(`Not opened, safety: ${sym} ${t.freezeAuthorityDisabled === false ? "still has a live freeze authority (holders can be frozen)" : "has no freeze-authority check on Jupiter"}.`);
  }
  const [px, venue, path] = await Promise.all([
    d.prices([info.token, info.quote]).catch(() => new Map<string, number>()),
    venueStats(d, info.dex, info.pool, info.token),
    p.preset && !info.fullRange ? pricePath(d, info, 168).catch(() => ({ points: [], notes: [] })) : Promise.resolve(null),
  ]);
  const live = livePair(px, info);
  if (!live) return fail(`Cannot open: no USD price for ${info.pair} (Jupiter has none, and Chord's pool price is missing). Resume to try again.`);
  const now = d.now();
  const p0 = live.tokenUsd / live.quoteUsd;
  const s = path ? sigma(path.points.map((x) => x.p)) : null;
  let built: { r: PriceRange; logWidth: number | null };
  try { built = rangeFor(p0, p, s, info.fullRange); } catch (e) { return refuse(`Not opened: ${errText(e)}.`); }
  const L = liquidityFor(p.amountUsd / live.quoteUsd, p0, built.r);
  const a = amountsAt(L, p0, built.r);
  if (!botRow(botId) || !hooks.isRunning(botId)) return null; // deleted or paused while reading
  const v = venue.v;
  st = {
    ...st, status: "open", range: stateRange(p0, built.r, p, built.logWidth, info.fullRange), liquidity: L,
    leg: { openedAt: now, costUsd: p.amountUsd, tokenAmount: a.token, quoteAmount: a.quote, price: p0, feesUsd: 0 },
    first: { openedAt: now, amountUsd: p.amountUsd, tokenAmount: a.token, quoteAmount: a.quote, tokenUsd: live.tokenUsd, quoteUsd: live.quoteUsd },
    feeApr: { pct: v?.feeAprPct ?? null, source: v ? `${v.source}: ${v.feeAprHow}` : (venue.err ?? "no venue API"), at: now }, feeRatePct: v?.feeRatePct ?? null,
    inRange: true,
    mark: { ts: now, price: p0, tokenUsd: live.tokenUsd, quoteUsd: live.quoteUsd, valueUsd: p.amountUsd, equityUsd: p.amountUsd, hodlUsd: p.amountUsd, quoteOnlyUsd: p.amountUsd, ilUsd: 0, vsHodlUsd: 0 },
    exodus: { checkedAt: now, ...info.lastHour },
  };
  const width = st.range!.full ? `full range (${info.venue} pools have no range to choose)`
    : `${rangeText(st)} (−${pctText(st.range!.downPct)} / +${pctText(st.range!.upPct!)}; ${p.preset ? `${p.preset} = ${({ tight: 1, balanced: 2, wide: 3 })[p.preset]}σ over 24 h, σ ${pctText(s! * 100)} an hour` : `±${p.rangePct}% custom`})`;
  const fill = record(botId, "open", st, {
    ts: now, usd: p.amountUsd, tokenAmount: a.token, tokenUsd: live.tokenUsd, pnlUsd: null, quote: null,
    reason: `Open ${info.pair} on ${info.venue}: ${width}, at ${priceText(p0)} ${info.quoteSymbol ?? "quote"} per ${sym}`,
  });
  if (!fill) return null;
  setPosition(botId, { mint: info.pool, symbol: `${info.pair} LP`, qty: p.amountUsd, costUsd: p.amountUsd, priceUsd: 1, openedAt: now, ts: now });
  saveLpState(botId, st, now);
  addLpPoint(botId, { ts: now, price: p0, lower: st.range!.full ? null : st.range!.lower, upper: st.range!.upper, equityUsd: p.amountUsd, hodlUsd: p.amountUsd, feesUsd: 0, inRange: true });
  st.warned.point = now;
  saveLpState(botId, st, now);
  if (autoName) setBotName(botId, `LP ${info.pair} ${p.preset ?? `±${p.rangePct}%`}`.slice(0, 40));
  logEvent(botId, "info", `Opened a paper LP position: ${money(p.amountUsd)} in ${info.pair} (${info.venue}), ${width}. Holds ${a.token.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${sym} + ${a.quote.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${info.quoteSymbol ?? "quote"} (prices: ${live.source}). Fee APR ${st.feeApr.pct != null ? `${pctText(st.feeApr.pct)} (${st.feeApr.source}), an estimate counted only while in range` : `unknown (${st.feeApr.source}): fees are not counted`}.`, now);
  if (isExodus(info.lastHour.depositsUsd, info.lastHour.withdrawalsUsd, info.tvlUsd)) {
    logEvent(botId, "warn", `LP exodus right now: ${money(info.lastHour.withdrawalsUsd)} withdrawn vs ${money(info.lastHour.depositsUsd)} deposited in the last hour.${p.exits.lpExodus ? " The exodus exit is checked from the next 5-minute check." : ""}`, now);
  }
  publishStats(botId);
  return st;
}

export type Pxs = { p: number; tokenUsd: number; quoteUsd: number };
export type SaveLp = (st: LpState, now: number) => void;
/** "12.5 TOKEN + 3.1 SOL": what a withdrawal hands back. */
export const withdrawText = (st: LpState, a: { token: number; quote: number }) =>
  `${a.token.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${st.tokenSymbol ?? "token"} + ${a.quote.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${st.quoteSymbol ?? "quote"}`;

/** Close one position at the market (no swap): the close fill (reason `Exit, <why>` unless given; source = the copied move when
 *  given), the Position row removed, the state closed and saved. Null when the bot is gone (deleted while a check was reading). */
export function closeLpPosition(botId: string, st: LpState, pxs: Pxs, why: string, now: number, save: SaveLp, copied?: { source: SourceTrade; reason: string }): { value: number; pnl: number; a: { token: number; quote: number } } | null {
  if (!botRow(botId)) return null;
  const R = rangeOf(st);
  const value = valueAt(st.liquidity, pxs.p, R) * pxs.quoteUsd + st.leg!.feesUsd;
  const a = amountsAt(st.liquidity, pxs.p, R);
  const pnl = value - st.leg!.costUsd;
  record(botId, "close", st, { ts: now, usd: value, tokenAmount: a.token, tokenUsd: pxs.tokenUsd, pnlUsd: pnl, quote: null, reason: copied?.reason ?? `Exit, ${why}` }, copied?.source);
  closePosition(botId, st.pool);
  st.status = "closed"; st.closedAt = now; st.closeReason = why; st.leg = { ...st.leg!, feesUsd: 0 };
  save(st, now);
  return { value, pnl, a };
}

/** Close the position at the market (no swap), write the close fill and stop the bot. */
function closeLp(botId: string, st: LpState, pxs: Pxs, why: string, hooks: LpHooks, now: number): void {
  const c = closeLpPosition(botId, st, pxs, why, now, (s, t) => saveLpState(botId, s, t));
  if (!c) return;
  hooks.stop(botId, "stopped", "warn", `Exited: ${why}. Withdrew ${money(c.value)} at the market (${withdrawText(st, c.a)}, no swap), ${c.pnl >= 0 ? "+" : ""}${money(c.pnl)} on this range. The bot stopped; resume it to re-enter with ${money(st.first?.amountUsd ?? 0)}.`, null);
}

/** The position's own exit rules: its token down `tokenDropPct` from the position's first open, an LP exodus on its pool
 *  (Chord's last hour, read every 5 min; with the exodus exit off it only warns). Null = the position stays. */
export async function positionExit(botId: string, st: LpState, tokenUsd: number, exits: { lpExodus: boolean; tokenDropPct: number | null }, d: LpDeps, now: number): Promise<string | null> {
  if (exits.tokenDropPct != null && tokenUsd <= st.first!.tokenUsd * (1 - exits.tokenDropPct / 100)) {
    return `token drop: ${st.tokenSymbol ?? "the token"} is down ${pctText((1 - tokenUsd / st.first!.tokenUsd) * 100)} from the open (stop at ${exits.tokenDropPct}%)`;
  }
  if (now - (st.exodus?.checkedAt ?? 0) < EXODUS_CHECK_MS) return null;
  try {
    const info = await poolInfo(d, st.pool);
    st.exodus = { checkedAt: now, ...info.lastHour };
    if (isExodus(info.lastHour.depositsUsd, info.lastHour.withdrawalsUsd, info.tvlUsd)) {
      const what = `LP exodus: ${money(info.lastHour.withdrawalsUsd)} withdrawn vs ${money(info.lastHour.depositsUsd)} deposited in the last hour (Chord's LP tape)`;
      if (exits.lpExodus) return what;
      warnOnce(botId, st, "exodus", 60 * 60_000, "warn", `${what}; the exodus exit is off, so the position stays.`, now);
    }
  } catch (e) { st.exodus = { checkedAt: now, depositsUsd: st.exodus?.depositsUsd ?? 0, withdrawalsUsd: st.exodus?.withdrawalsUsd ?? 0 }; warnOnce(botId, st, "exoduserr", WARN_EVERY_MS, "warn", `Could not read the pool's LP flows on Chord (${errText(e).slice(0, 100)}): the exodus check waits.`, now); }
  return null;
}

async function rebalance(botId: string, st: LpState, rules: LpRules, pxs: { p: number; tokenUsd: number; quoteUsd: number }, valueUsd: number, d: LpDeps, now: number): Promise<void> {
  const R = rangeOf(st);
  const legValue = valueUsd + st.leg!.feesUsd;
  const nr = recenter(pxs.p, st.range!.logWidth, st.range!.rangePct);
  const swapUsd = swapShare(st.liquidity, pxs.p, R, nr) * legValue;
  const above = pxs.p > R.upper;
  let cost = 0, how = "nothing to swap", quote: Fill["quote"] = null;
  if (swapUsd >= 0.01) {
    try {
      const q = above ? await d.quote(st.quote, st.token, swapUsd / pxs.quoteUsd, 100) : await d.quote(st.token, st.quote, swapUsd / pxs.tokenUsd, 100);
      const out = q.amountOut * (above ? pxs.tokenUsd : pxs.quoteUsd);
      if (!(out > 0) || !Number.isFinite(out)) throw new Error("Jupiter quoted nothing out");
      cost = Math.max(0, swapUsd - out);
      how = `Jupiter quote: ${money(swapUsd)} of ${above ? st.quoteSymbol ?? "quote" : st.tokenSymbol ?? "token"} in, ${money(out)} out at market${q.priceImpactPct != null ? `, impact ${pctText(q.priceImpactPct)}` : ""}`;
      quote = { provider: "Jupiter", route: q.route, priceImpactPct: q.priceImpactPct };
    } catch (e) {
      const pct = (st.feeRatePct ?? DEFAULT_SWAP_FEE_PCT) + DEFAULT_IMPACT_PCT;
      cost = swapUsd * pct / 100;
      how = `no Jupiter quote (${errText(e).slice(0, 80)}): stated estimate ${pctText(pct)} = ${st.feeRatePct != null ? "pool fee" : "assumed 0.25 % fee"} + 0.5 % impact on ${money(swapUsd)}`;
    }
  }
  if (!botRow(botId)) return;
  const basis = legValue - cost;
  const pnl = basis - st.leg!.costUsd;
  const a0 = amountsAt(st.liquidity, pxs.p, R);
  const old = rangeText(st);
  const outFor = now - (st.outSince ?? now);
  record(botId, "rebalance", st, {
    ts: now, usd: legValue, tokenAmount: a0.token, tokenUsd: pxs.tokenUsd, pnlUsd: pnl, quote,
    reason: `Rebalance: ${above ? "above" : "below"} the range ${old} for ${mins(outFor)}; took out ${money(legValue)} (fees ${money(st.leg!.feesUsd)}), swap cost ${money(cost)} (${how})`,
  });
  const L = liquidityFor(basis / pxs.quoteUsd, pxs.p, nr);
  const a = amountsAt(L, pxs.p, nr);
  st.liquidity = L;
  st.range = stateRange(pxs.p, nr, { preset: st.range!.preset, rangePct: st.range!.rangePct }, st.range!.logWidth, false);
  st.leg = { openedAt: now, costUsd: basis, tokenAmount: a.token, quoteAmount: a.quote, price: pxs.p, feesUsd: 0 };
  st.rebalances++; st.rebalancesToday.n++; st.rebalanceCostUsd += cost; st.inRange = true; st.outSince = null;
  setPosition(botId, { mint: st.pool, symbol: `${st.pair} LP`, qty: basis, costUsd: basis, priceUsd: 1, openedAt: now, ts: now });
  logEvent(botId, "info", `Rebalanced (${st.rebalancesToday.n} of ${rules.rebalance.maxPerDay} today): the price sat ${above ? "above" : "below"} ${old} for ${mins(outFor)}. New range ${rangeText(st)} around ${priceText(pxs.p)}; ${money(basis)} back in after a ${money(cost)} swap (${how}). This range ${pnl >= 0 ? "+" : ""}${money(pnl)} realized.`, now);
}

/** Mark one open position at this minute's prices (the tick's batch, else Chord's pool price): the venue's fee APR (read again
 *  every 5 min), fees accrued for the time in range, in / out of range events (`outNote` ends the out-of-range one), value, IL,
 *  LP vs HODL, its Position row, and a chart point every 10 min when `points`. Null = no price this minute (warned, saved). */
export async function markLp(botId: string, st: LpState, px: Map<string, number>, d: LpDeps, now: number, o: { outNote: string; points: boolean; save: SaveLp }): Promise<{ pxs: Pxs; valueUsd: number; inR: boolean } | null> {
  if (!st.range || !st.leg || !st.first) return null;
  let live = livePair(px, { token: st.token, quote: st.quote });
  if (!live) {
    try { const info = await poolInfo(d, st.pool); live = livePair(px, info); } catch { /* no fallback */ }
  }
  if (!live) {
    warnOnce(botId, st, "noprice", WARN_EVERY_MS, "warn", `No price for ${st.pair} this minute (Jupiter and Chord): the position was not marked.`, now);
    o.save(st, now);
    return null;
  }
  const R = rangeOf(st);
  const p = live.tokenUsd / live.quoteUsd;
  const pxs = { p, tokenUsd: live.tokenUsd, quoteUsd: live.quoteUsd };
  const dt = st.mark ? Math.min(MAX_ACCRUAL_MS, Math.max(0, now - st.mark.ts)) : 0;
  const inR = inRange(p, R);
  const valueUsd = valueAt(st.liquidity, p, R) * live.quoteUsd;

  if (now - st.feeApr.at >= FEE_REFRESH_MS) {
    const vs = await venueStats(d, st.dex, st.pool, st.token);
    if (vs.v?.feeAprPct != null) st.feeApr = { pct: vs.v.feeAprPct, source: `${vs.v.source}: ${vs.v.feeAprHow}`, at: now };
    else st.feeApr = { ...st.feeApr, at: now };
    if (vs.v?.feeRatePct != null) st.feeRatePct = vs.v.feeRatePct;
  }
  const wasIn = st.inRange ?? inR;
  const credit = ((wasIn ? 1 : 0) + (inR ? 1 : 0)) / 2;
  const fee = st.feeApr.pct != null ? valueUsd * (st.feeApr.pct / 100) * (dt / YEAR_MS) * credit : 0;
  st.leg.feesUsd += fee; st.feesTotalUsd += fee; st.trackedMs += dt; st.timeInRangeMs += dt * credit;
  if (wasIn && !inR) {
    st.outSince = now;
    const side = p < R.lower ? `below ${priceText(R.lower)}` : `above ${priceText(R.upper)}`;
    logEvent(botId, "warn", `Out of range: ${st.pair} at ${priceText(p)} is ${side}; no fees while out.${o.outNote ? ` ${o.outNote}` : ""}`, now);
  } else if (!wasIn && inR) {
    logEvent(botId, "info", `Back in range after ${mins(now - (st.outSince ?? now))}: ${st.pair} at ${priceText(p)}.`, now);
    st.outSince = null;
  } else if (!inR && st.outSince == null) st.outSince = now;
  st.inRange = inR;

  const equity = valueUsd + st.leg.feesUsd;
  const hodl = st.first.tokenAmount * live.tokenUsd + st.first.quoteAmount * live.quoteUsd;
  const il = valueUsd - (st.leg.tokenAmount * live.tokenUsd + st.leg.quoteAmount * live.quoteUsd);
  st.mark = { ts: now, price: p, tokenUsd: live.tokenUsd, quoteUsd: live.quoteUsd, valueUsd, equityUsd: equity, hodlUsd: hodl,
    quoteOnlyUsd: st.first.amountUsd / st.first.quoteUsd * live.quoteUsd, ilUsd: il, vsHodlUsd: equity - hodl };
  setPosition(botId, { mint: st.pool, symbol: `${st.pair} LP`, qty: st.leg.costUsd, costUsd: st.leg.costUsd, priceUsd: st.leg.costUsd > 0 ? equity / st.leg.costUsd : null, openedAt: st.leg.openedAt, ts: now });
  if (o.points && now - (st.warned.point ?? 0) >= POINT_EVERY_MS) {
    st.warned.point = now;
    addLpPoint(botId, { ts: now, price: p, lower: st.range.full ? null : st.range.lower, upper: st.range.upper, equityUsd: equity, hodlUsd: hodl, feesUsd: st.feesTotalUsd, inRange: inR });
  }
  return { pxs, valueUsd, inR };
}

/** One minute of one bot: mark, accrue, then (running bots only) exits and rebalances. `px` = the tick's batched prices. */
export async function lpStep(botId: string, px: Map<string, number>, d: LpDeps, hooks: LpHooks): Promise<void> {
  const bot = botRow(botId);
  const st = bot?.type === "lp" ? lpStateOf(botId) : null;
  if (!bot || !st || st.status !== "open" || !st.range || !st.leg || !st.first) return;
  const rules = bot.params as unknown as LpRules;
  const now = d.now();
  const save: SaveLp = (s, t) => saveLpState(botId, s, t);
  const outNote = !hooks.isRunning(botId) ? "The bot is paused: no rebalance." : st.range.full ? "" : rules.rebalance.maxPerDay > 0 ? `Rebalance if it stays out ${rules.rebalance.outOfRangeMinutes} min.` : "Rebalancing is off (maxPerDay 0).";
  const m = await markLp(botId, st, px, d, now, { outNote, points: true, save });
  if (!m) return;
  const { pxs, valueUsd, inR } = m;

  if (hooks.isRunning(botId)) {
    // exits first: the daily loss stop, a token drop from the first open, an LP exodus (checked every 5 min)
    let exit: string | null = null;
    save(st, now);
    if (rules.exits.dailyLossStopUsd != null) {
      const loss = todayLoss(botId, now);
      if (loss >= rules.exits.dailyLossStopUsd) exit = `daily loss stop: today's loss ${money(loss)} reached the ${money(rules.exits.dailyLossStopUsd)} stop`;
    }
    if (!exit) exit = await positionExit(botId, st, pxs.tokenUsd, rules.exits, d, now);
    if (exit) { closeLp(botId, st, pxs, exit, hooks, now); return; }
    if (!inR && !st.range.full && st.outSince != null && now - st.outSince >= rules.rebalance.outOfRangeMinutes * 60_000) {
      const day = utcDay(now);
      if (st.rebalancesToday.day !== day) st.rebalancesToday = { day, n: 0 };
      if (rules.rebalance.maxPerDay === 0) warnOnce(botId, st, `norebalance:${day}`, 86_400_000, "info", "Out of range and rebalancing is off (maxPerDay 0): the position waits for the price to come back.", now);
      else if (st.rebalancesToday.n >= rules.rebalance.maxPerDay) warnOnce(botId, st, `maxreb:${day}`, 86_400_000, "warn", `Out of range, but the ${rules.rebalance.maxPerDay} rebalances of today (UTC) are used: the position waits until 00:00 UTC or until the price comes back.`, now);
      else await rebalance(botId, st, rules, pxs, valueUsd, d, now);
    }
  }
  if (!botRow(botId)) return;
  save(st, now);
  publishStats(botId);
}

/** Mint list for the tick's one batched price call. */
export function lpMints(states: (LpState | null)[]): string[] {
  const s = new Set<string>();
  for (const st of states) if (st && st.status === "open") { s.add(st.token); s.add(st.quote); }
  return [...s];
}
