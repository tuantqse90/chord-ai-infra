// Paper execution. A followed wallet's BUY passes the bot's gates, then a real Jupiter quote USDC → token for usdPerTrade
// prices the fill; a gate that fails is a "skipped" fill whose reason the person sees. A followed wallet's SELL of a token
// the bot holds (mirrorSells) is priced by a quote token → USDC for the whole position and closes it with its PnL.
// Alert bots write an event (and POST a webhook) instead. Nothing is ever signed or sent on-chain.
import { randomBytes } from "node:crypto";
import { isPublicHttpsUrl } from "../chord/utils/safeFetchUrl";
import { emit } from "./bus";
import { http, knownSymbol, paperQuote, prices, SOL_MINT, tokenInfo, USDC_MINT, type PaperQuote, type TokenInfo } from "./market";
import { addToPosition, botRow, closePosition, hasFill, insertEvent, insertFill, markMint, openPositions, positionOf, positionsOf, realizedSince, refreshStats, setPosition, sourceKey } from "./store";
import type { Bot, BotEvent, Fill, SourceTrade } from "./types";
import type { validateAlertParams, validateCopyParams } from "./validate";

export type CopyRules = ReturnType<typeof validateCopyParams>;
export type AlertRules = ReturnType<typeof validateAlertParams>;

export interface ExecDeps {
  quote: (inMint: string, outMint: string, amount: number, slippageBps: number) => Promise<PaperQuote>;
  tokenInfo: (mint: string) => Promise<TokenInfo | null>;
  prices: (mints: string[]) => Promise<Map<string, number>>;
  webhook: (url: string, body: unknown) => Promise<{ ok: boolean; status: number | null; error?: string }>;
  now: () => number;
}
export interface ExecHooks {
  /** Pause a running bot from inside the engine (daily loss stop). */
  pause: (botId: string, msg: string) => void;
}

async function postWebhook(url: string, body: unknown): Promise<{ ok: boolean; status: number | null; error?: string }> {
  if (!isPublicHttpsUrl(url)) return { ok: false, status: null, error: "not a public https URL" };
  try {
    const r = await http(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "ask2049-bots/1" }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(5_000) });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: null, error: (e as Error)?.name === "TimeoutError" ? "timed out after 5 s" : String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

export const defaultExecDeps = (): ExecDeps => ({ quote: paperQuote, tokenInfo, prices, webhook: postWebhook, now: () => Date.now() });

const newId = () => randomBytes(6).toString("hex");
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const money = (n: number) => `$${Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en-US") : (Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160);
const utcMidnight = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000;
const lossStopMsg = (loss: number, stop: number) =>
  `Daily loss stop: today's loss ${money(loss)} reached the ${money(stop)} stop, so the bot paused. Resumed today, it pauses again at the next buy unless the loss shrinks; the day restarts at 00:00 UTC.`;

export function logEvent(botId: string, level: BotEvent["level"], msg: string, ts = Date.now()): BotEvent {
  const e: BotEvent = { ts, level, msg };
  insertEvent(botId, e);
  emit(botId, { type: "event", event: e });
  return e;
}

/** Recompute the bot's stats and push them to its subscribers. */
export function publishStats(botId: string): Bot | null {
  const bot = refreshStats(botId);
  if (bot) emit(botId, { type: "stats", bot });
  return bot;
}

function record(f: Fill): Fill | null {
  if (!insertFill(f)) return null;
  emit(f.botId, { type: "fill", fill: f });
  return f;
}

/** Today's (UTC) loss in USD: realized since midnight plus every open position's unrealized PnL, as a positive number. */
export function todayLoss(botId: string, now: number): number {
  const realized = realizedSince(botId, utcMidnight(now));
  const unrealized = positionsOf(botId).reduce((a, p) => a + (p.pnlUsd ?? 0), 0);
  return Math.max(0, -(realized + unrealized));
}

/** One source trade for one copy bot. Returns the fill written (filled or skipped), or null when the trade is not the
 *  bot's business (a sell of a token it does not hold, mirrorSells off, already answered). */
export async function copyTrade(botId: string, p: CopyRules, t: SourceTrade, deps: ExecDeps, hooks: ExecHooks): Promise<Fill | null> {
  const bot = botRow(botId);
  if (!bot || bot.type !== "copy") return null;
  if (hasFill(botId, sourceKey(t))) return null;
  const base = { id: newId(), botId, side: t.side, mint: t.mint, source: t, mode: bot.mode } as const;
  let symbol = t.symbol ?? knownSymbol(t.mint);
  const sym = () => symbol ?? short(t.mint);

  if (t.side === "sell") {
    if (!p.mirrorSells) return null;
    const pos = positionOf(botId, t.mint);
    if (!pos) return null;
    symbol = symbol ?? pos.symbol;
    const skipSell = (reason: string) => {
      const f = record({ ...base, ts: deps.now(), symbol, usd: 0, tokenAmount: pos.qty, priceUsd: null, status: "skipped", reason, pnlUsd: null, quote: null });
      publishStats(botId);
      return f;
    };
    if (bot.status !== "running") return skipSell(`the bot was ${bot.status} when this sell came in; the position is kept`);
    let q: PaperQuote;
    try { q = await deps.quote(t.mint, USDC_MINT, pos.qty, p.slippageBps); } catch (e) { return skipSell(`no Jupiter quote to sell ${sym()}: ${errText(e)}; the position is kept`); }
    if (!(q.amountOut >= 0) || !Number.isFinite(q.amountOut)) return skipSell("Jupiter's sell quote was unreadable; the position is kept");
    if (!botRow(botId)) return null; // deleted while quoting
    const pnl = q.amountOut - pos.costUsd;
    const f = record({ ...base, ts: deps.now(), symbol: symbol ?? q.inSymbol, usd: q.amountOut, tokenAmount: pos.qty, priceUsd: pos.qty > 0 ? q.amountOut / pos.qty : null,
      status: "filled", reason: null, pnlUsd: pnl, quote: { provider: "Jupiter", route: q.route, priceImpactPct: q.priceImpactPct } });
    if (f) closePosition(botId, t.mint);
    publishStats(botId);
    return f;
  }

  // BUY
  const skip = (reason: string) => {
    const f = record({ ...base, ts: deps.now(), symbol, usd: p.usdPerTrade, tokenAmount: 0, priceUsd: t.priceUsd, status: "skipped", reason, pnlUsd: null, quote: null });
    publishStats(botId);
    return f;
  };
  if (bot.status !== "running") return skip(`the bot was ${bot.status} when this buy came in`);
  if (p.dailyLossStopUsd != null) {
    const loss = todayLoss(botId, deps.now());
    if (loss >= p.dailyLossStopUsd) {
      hooks.pause(botId, lossStopMsg(loss, p.dailyLossStopUsd));
      return skip(`daily loss stop: today's loss ${money(loss)} reached the ${money(p.dailyLossStopUsd)} stop`);
    }
  }
  const pos = positionOf(botId, t.mint);
  if (!pos && positionsOf(botId).length >= p.maxOpenPositions) return skip(`max open positions: ${p.maxOpenPositions} already open`);
  if (pos && pos.costUsd + p.usdPerTrade > p.maxPerTokenUsd + 1e-9) {
    return skip(`max per token: already ${money(pos.costUsd)} in ${sym()}, another ${money(p.usdPerTrade)} would pass the ${money(p.maxPerTokenUsd)} cap`);
  }
  if (p.safety || p.minLiquidityUsd > 0) {
    let info: TokenInfo | null;
    try { info = await deps.tokenInfo(t.mint); } catch (e) { return skip(`could not check the token on Jupiter (${errText(e)})`); }
    if (!info) return skip(`Jupiter does not list ${sym()}, so its safety and liquidity cannot be checked`);
    symbol = symbol ?? info.symbol;
    if (p.safety) {
      if (info.mintAuthorityDisabled !== true) return skip(info.mintAuthorityDisabled === false ? `safety: ${sym()} still has a live mint authority (more can be minted)` : `safety: Jupiter has no mint-authority check for ${sym()}`);
      if (info.freezeAuthorityDisabled !== true) return skip(info.freezeAuthorityDisabled === false ? `safety: ${sym()} still has a live freeze authority (holders can be frozen)` : `safety: Jupiter has no freeze-authority check for ${sym()}`);
    }
    if (p.minLiquidityUsd > 0 && (info.liquidityUsd == null || info.liquidityUsd < p.minLiquidityUsd)) {
      return skip(info.liquidityUsd == null ? `liquidity unknown on Jupiter (minimum ${money(p.minLiquidityUsd)})` : `liquidity ${money(info.liquidityUsd)} is below the bot's ${money(p.minLiquidityUsd)} minimum`);
    }
  }
  let q: PaperQuote;
  try { q = await deps.quote(USDC_MINT, t.mint, p.usdPerTrade, p.slippageBps); } catch (e) { return skip(`no Jupiter quote: ${errText(e)}`); }
  if (!(q.amountOut > 0) || !Number.isFinite(q.amountOut)) return skip("Jupiter quoted nothing out for this buy");
  if (!botRow(botId)) return null; // deleted while quoting
  const priceUsd = p.usdPerTrade / q.amountOut;
  symbol = symbol ?? q.outSymbol;
  const f = record({ ...base, ts: deps.now(), symbol, usd: p.usdPerTrade, tokenAmount: q.amountOut, priceUsd, status: "filled", reason: null, pnlUsd: null,
    quote: { provider: "Jupiter", route: q.route, priceImpactPct: q.priceImpactPct } });
  if (f) addToPosition(botId, { mint: t.mint, symbol, qty: q.amountOut, costUsd: p.usdPerTrade, priceUsd, ts: f.ts });
  publishStats(botId);
  return f;
}

// ── custom agents (src/strategy runner) ──────────────────────────────────────────────────────────────────────────────
/** What fired a strategy action: the followed wallet's trade when there is one, the plain-words trigger always. */
export interface FiredBy { detail: string; trade?: SourceTrade; ts: number }
const STRATEGY_SLIPPAGE_BPS = 100;
let synth = 0;
/** The fill's source: the triggering trade (with the trigger's words), else a strategy source unique to this action. */
export function strategySource(botId: string, side: "buy" | "sell", mint: string, sig: FiredBy | undefined, now: number): SourceTrade {
  if (sig?.trade) return { ...sig.trade, detail: sig.detail };
  return { wallet: "", tx: `strategy:${botId}:${now}:${++synth}`, side, mint, symbol: null, usd: null, priceUsd: null, ts: sig?.ts ?? now, via: "strategy", detail: sig?.detail ?? "strategy" };
}

/** A strategy BUY of `usd` USDC of `mint`, priced by a real Jupiter quote. A failed quote is a skipped fill (never thrown). */
export async function strategyBuy(botId: string, mint: string, usd: number, sig: FiredBy | undefined, deps: ExecDeps): Promise<Fill> {
  const bot = botRow(botId);
  const now = deps.now();
  const source = strategySource(botId, "buy", mint, sig, now);
  let symbol = source.symbol ?? knownSymbol(mint);
  const base = { id: newId(), botId, side: "buy" as const, mint, source, mode: bot?.mode ?? "paper" as const };
  const skip = (reason: string): Fill => {
    const f: Fill = { ...base, ts: deps.now(), symbol, usd, tokenAmount: 0, priceUsd: source.priceUsd, status: "skipped", reason, pnlUsd: null, quote: null };
    record(f);
    publishStats(botId);
    return f;
  };
  if (!bot) return skip("the agent was deleted");
  if (hasFill(botId, sourceKey(source))) return skip("this trade was already answered");
  let q: PaperQuote;
  try { q = await deps.quote(USDC_MINT, mint, usd, STRATEGY_SLIPPAGE_BPS); } catch (e) { return skip(`no Jupiter quote: ${errText(e)}`); }
  if (!(q.amountOut > 0) || !Number.isFinite(q.amountOut)) return skip("Jupiter quoted nothing out for this buy");
  if (!botRow(botId)) return skip("the agent was deleted");
  const priceUsd = usd / q.amountOut;
  symbol = symbol ?? q.outSymbol;
  const f: Fill = { ...base, ts: deps.now(), symbol, usd, tokenAmount: q.amountOut, priceUsd, status: "filled", reason: null, pnlUsd: null,
    quote: { provider: "Jupiter", route: q.route, priceImpactPct: q.priceImpactPct } };
  if (record(f)) addToPosition(botId, { mint, symbol, qty: q.amountOut, costUsd: usd, priceUsd, ts: f.ts });
  publishStats(botId);
  return f;
}

/** A strategy SELL of `pct` % of the position in `mint` (Jupiter quote token → USDC); 100 % closes it with its PnL. */
export async function strategySell(botId: string, mint: string, pct: number, sig: FiredBy | undefined, deps: ExecDeps): Promise<Fill> {
  const bot = botRow(botId);
  const now = deps.now();
  const source = strategySource(botId, "sell", mint, sig, now);
  const pos = positionOf(botId, mint);
  const share = Math.max(0, Math.min(100, pct)) / 100;
  const qty = (pos?.qty ?? 0) * share;
  const base = { id: newId(), botId, side: "sell" as const, mint, source, mode: bot?.mode ?? "paper" as const };
  const symbol = source.symbol ?? pos?.symbol ?? knownSymbol(mint);
  const skip = (reason: string): Fill => {
    const f: Fill = { ...base, ts: deps.now(), symbol, usd: 0, tokenAmount: qty, priceUsd: null, status: "skipped", reason, pnlUsd: null, quote: null };
    record(f);
    publishStats(botId);
    return f;
  };
  if (!bot) return skip("the agent was deleted");
  if (!pos || !(qty > 0)) return skip(`no position in ${symbol ?? short(mint)} to sell`);
  if (hasFill(botId, sourceKey(source))) return skip("this trade was already answered");
  let q: PaperQuote;
  try { q = await deps.quote(mint, USDC_MINT, qty, STRATEGY_SLIPPAGE_BPS); } catch (e) { return skip(`no Jupiter quote to sell ${symbol ?? short(mint)}: ${errText(e)}; the position is kept`); }
  if (!(q.amountOut >= 0) || !Number.isFinite(q.amountOut)) return skip("Jupiter's sell quote was unreadable; the position is kept");
  if (!botRow(botId)) return skip("the agent was deleted");
  const cost = pos.costUsd * share;
  const f: Fill = { ...base, ts: deps.now(), symbol: symbol ?? q.inSymbol, usd: q.amountOut, tokenAmount: qty, priceUsd: qty > 0 ? q.amountOut / qty : null,
    status: "filled", reason: null, pnlUsd: q.amountOut - cost, quote: { provider: "Jupiter", route: q.route, priceImpactPct: q.priceImpactPct } };
  if (record(f)) {
    if (share >= 0.999) closePosition(botId, mint);
    else setPosition(botId, { mint, symbol: pos.symbol, qty: pos.qty - qty, costUsd: pos.costUsd - cost, priceUsd: pos.priceUsd, openedAt: pos.openedAt, ts: f.ts });
  }
  publishStats(botId);
  return f;
}

/** A signal a strategy's filter / limit said no to, as a skipped fill (the public feed shows it, the agent's tape too). */
export function strategySkip(botId: string, k: { ts: number; mint: string; symbol: string | null; reason: string; trigger: string; trade?: SourceTrade }, usd: number): Fill | null {
  const bot = botRow(botId);
  if (!bot) return null;
  const source = strategySource(botId, k.trade?.side ?? "buy", k.mint, { detail: k.trigger, trade: k.trade, ts: k.ts }, k.ts);
  const f = record({ id: newId(), botId, ts: k.ts, side: source.side, mint: k.mint, symbol: k.symbol ?? source.symbol, usd, tokenAmount: 0, priceUsd: source.priceUsd,
    status: "skipped", reason: k.reason, pnlUsd: null, quote: null, source, mode: bot.mode });
  publishStats(botId);
  return f;
}

// ── alerts ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const ALERTS_PER_MIN = 30;
const WEBHOOKS_PER_MIN = 20;
const alertRate = new Map<string, { m: number; alerts: number; hooks: number; warned: boolean }>();

/** Does this trade fire the alert bot: a watched wallet's trade at or above minUsd, a watched wallet trading a watched mint
 *  (any size), or anyone's trade of a watched mint at or above minUsd. */
export function alertFires(p: AlertRules, t: SourceTrade): boolean {
  const big = t.usd != null && t.usd >= p.minUsd;
  const walletHit = p.wallets.includes(t.wallet), mintHit = p.mints.includes(t.mint);
  return (walletHit && (big || mintHit)) || (mintHit && big);
}

export async function alertTrade(botId: string, p: AlertRules, t: SourceTrade, deps: ExecDeps): Promise<BotEvent | null> {
  const bot = botRow(botId);
  if (!bot || bot.type !== "alert" || bot.status !== "running" || !alertFires(p, t)) return null;
  const now = deps.now();
  const m = Math.floor(now / 60_000);
  let r = alertRate.get(botId);
  if (!r || r.m !== m) alertRate.set(botId, (r = { m, alerts: 0, hooks: 0, warned: false }));
  if (r.alerts >= ALERTS_PER_MIN) {
    if (!r.warned) { r.warned = true; logEvent(botId, "warn", `More than ${ALERTS_PER_MIN} alerts this minute; the rest of this minute's alerts are dropped.`, now); }
    return null;
  }
  r.alerts++;
  const sym = t.symbol ?? knownSymbol(t.mint) ?? short(t.mint);
  const msg = `${short(t.wallet)} ${t.side === "buy" ? "bought" : "sold"} ${t.usd != null ? `${money(t.usd)} of ` : ""}${sym} · tx ${short(t.tx)} (${t.via})`;
  const e = logEvent(botId, "info", msg, now);
  if (p.webhook) {
    if (r.hooks >= WEBHOOKS_PER_MIN) return e;
    r.hooks++;
    const res = await deps.webhook(p.webhook, { type: "alert", bot: { id: botId, name: bot.name }, message: msg, trade: t, ts: now });
    if (!res.ok) logEvent(botId, "warn", `Webhook ${res.status != null ? `answered ${res.status}` : `failed: ${res.error ?? "no answer"}`}`, deps.now());
  }
  publishStats(botId);
  return e;
}

// ── marking ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** One batched price call for every open position (and SOL, which the WebSocket path needs to value SOL legs), then each
 *  holding bot's stats; running copy bots past their daily loss stop are paused. */
export async function markAll(deps: ExecDeps, hooks: ExecHooks, running: Map<string, { type: string; params: unknown }>, withSol: boolean): Promise<void> {
  const open = openPositions();
  const mints = [...new Set(open.map((o) => o.mint))];
  if (!mints.length && !withSol) return;
  const px = await deps.prices(withSol ? [...mints, SOL_MINT] : mints);
  const now = deps.now();
  for (const m of mints) { const v = px.get(m); if (v != null) markMint(m, v, now); }
  for (const botId of new Set(open.map((o) => o.botId))) {
    try {
      publishStats(botId);
      const run = running.get(botId);
      const stop = run?.type === "copy" ? (run.params as CopyRules).dailyLossStopUsd : null;
      if (stop != null) {
        const loss = todayLoss(botId, now);
        if (loss >= stop) hooks.pause(botId, lossStopMsg(loss, stop));
      }
    } catch { /* one bot's marking never stops the others */ }
  }
}

export function _resetExecutor(): void { alertRate.clear(); }
