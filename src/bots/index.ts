// Bots as a service, the engine (ask2049-notes/bots-contract.md). Copy-trader, alert and LP-agent bots, backtests, PAPER mode
// only. Running bots live in memory (what they follow, since when); every trade the triggers see is routed to the bots that
// follow its wallet (or watch its mint), one queue per bot, so one bot's failure never touches another. LP bots follow no
// wallet: a 1-minute tick marks every open LP position from one batched price call and lets running ones act (lpRunner.ts).
import { randomBytes } from "node:crypto";
import { logger } from "../chord/utils/logger";
import { runBacktest } from "./backtest";
import { _resetBus, subscribe as busSubscribe } from "./bus";
import { BotInputError, BotLimitError, BotLiveError } from "./errors";
import { _resetExecutor, alertTrade, copyTrade, defaultExecDeps, logEvent, markAll, publishStats, type AlertRules, type CopyRules, type ExecDeps, type ExecHooks } from "./executor";
import { lpBacktest as runLpBacktest, lpRange as runLpRange, lpScan as runLpScan, type LpScanOpts } from "./lp";
import { _resetLpData, defaultLpDeps, type LpDeps } from "./lpData";
import { LP_TICK_MS, lpMints, lpOpen, lpStep, type LpHooks } from "./lpRunner";
import { _resetMarket } from "./market";
import * as S from "./store";
import { smartTraders as board } from "./tape";
import { Triggers, type TriggerDeps, type TriggerStatus } from "./triggers";
import { botName, validateMode, validateParams, validateType, type LpRules } from "./validate";
import type { Backtest, Bot, BotEvent, BotStreamEvent, BotType, CopyParams, Fill, LpBacktest, LpPoint, LpRangeAnswer, LpScan, LpState, Position, SourceTrade, Trader } from "./types";

export * from "./types";
export { BotInputError, BotLimitError, BotLiveError } from "./errors";
export { LP_SCAN_SORTS, type LpScanOpts, type LpScanSort } from "./lp";

export const MAX_BOTS_PER_OWNER = 5;
export const MAX_RUNNING = 200;
export const MARK_MS = 30_000;

type RunEntry = { id: string; type: BotType; params: CopyRules | AlertRules | LpRules; since: number };
const running = new Map<string, RunEntry>();
const queues = new Map<string, Promise<void>>();
let triggers: Triggers | null = null;
let triggerDeps: Partial<TriggerDeps> = {};
let execDeps: ExecDeps = defaultExecDeps();
let markTimer: ReturnType<typeof setInterval> | null = null;
let lpTimer: ReturnType<typeof setInterval> | null = null;
let lpDeps: LpDeps = defaultLpDeps();
let initialized = false;

const hooks: ExecHooks = {
  pause(botId, msg) {
    if (!running.has(botId)) return;
    running.delete(botId);
    S.setBotStatus(botId, "paused", null, execDeps.now());
    follow();
    logEvent(botId, "warn", msg, execDeps.now());
    publishStats(botId);
  },
};

const lpHooks: LpHooks = {
  isRunning: (botId) => running.has(botId),
  stop(botId, status, level, msg, error) {
    running.delete(botId);
    if (!S.botRow(botId)) return;
    const now = lpDeps.now();
    S.setBotStatus(botId, status, error, now);
    logEvent(botId, level, msg, now);
    publishStats(botId);
  },
};

function trig(): Triggers {
  if (!triggers) triggers = new Triggers(dispatch, triggerDeps);
  return triggers;
}

/** Point the triggers at what the running bots follow. */
function follow(): void {
  const wallets = new Set<string>(), mints = new Set<string>();
  for (const r of running.values()) {
    if (r.type === "lp") continue;
    for (const w of (r.params as CopyRules | AlertRules).wallets) wallets.add(w);
    if (r.type === "alert") for (const m of (r.params as AlertRules).mints) mints.add(m);
  }
  trig().setFollowed(wallets, mints);
}

function enqueue(botId: string, job: () => Promise<unknown>): Promise<void> {
  const next = (queues.get(botId) ?? Promise.resolve())
    .then(job)
    .then(() => undefined, (e) => {
      try { if (S.botRow(botId)) logEvent(botId, "error", `Could not handle a trade: ${String((e as Error)?.message ?? e).slice(0, 200)}`, execDeps.now()); }
      catch (e2) { logger.warn({ err: String(e2).slice(0, 200) }, "bots: could not record an error event"); }
    });
  queues.set(botId, next);
  void next.then(() => { if (queues.get(botId) === next) queues.delete(botId); });
  return next;
}

/** Route one source trade to every running bot it concerns (trades from before a bot started or resumed are not its). */
function dispatch(t: SourceTrade): void {
  for (const r of running.values()) {
    if (r.type === "lp") continue;
    const relevant = r.type === "copy"
      ? (r.params as CopyRules).wallets.includes(t.wallet)
      : (r.params as AlertRules).wallets.includes(t.wallet) || (r.params as AlertRules).mints.includes(t.mint);
    if (!relevant || t.ts < r.since - 1_000) continue;
    void enqueue(r.id, () => (r.type === "copy" ? copyTrade(r.id, r.params as CopyRules, t, execDeps, hooks) : alertTrade(r.id, r.params as AlertRules, t, execDeps)));
  }
}

async function markTick(): Promise<void> {
  try { await markAll(execDeps, hooks, running, trig().status().wallets > 0); }
  catch (e) { logger.warn({ err: String(e).slice(0, 200) }, "bots: marking tick failed"); }
}

const lpStepErrAt = new Map<string, number>();
/** The LP tick: one batched price call for every open LP position, then one step per bot in its own queue. */
async function lpTick(): Promise<void> {
  try {
    const ids = S.openLpBots();
    if (!ids.length) return;
    let px = new Map<string, number>();
    try { px = await lpDeps.prices(lpMints(ids.map((id) => S.lpStateOf(id)))); } catch { /* each bot warns about its missing price */ }
    await Promise.all(ids.map((id) => enqueue(id, () => lpStep(id, px, lpDeps, lpHooks).catch((e) => {
      const now = lpDeps.now();
      if (now - (lpStepErrAt.get(id) ?? 0) < 30 * 60_000) return;
      lpStepErrAt.set(id, now);
      if (S.botRow(id)) logEvent(id, "error", `The LP tick failed for this bot: ${String((e as Error)?.message ?? e).slice(0, 200)} (retried every minute).`, now);
    }))));
  } catch (e) { logger.warn({ err: String(e).slice(0, 200) }, "bots: LP tick failed"); }
}

function enqueueLpOpen(id: string, params: LpRules, autoName = false): void {
  void enqueue(id, async () => {
    try { await lpOpen(id, params, lpDeps, lpHooks, autoName); }
    catch (e) { lpHooks.stop(id, "error", "error", `Could not open the LP position: ${String((e as Error)?.message ?? e).slice(0, 200)}. Resume the bot to try again.`, String((e as Error)?.message ?? e).slice(0, 200)); }
  });
}

/** On server boot: load running bots, start their triggers and the 30 s marking. Safe to call twice. */
export function initBots(): void {
  if (initialized) return;
  initialized = true;
  const now = execDeps.now();
  for (const b of S.allBots("running")) {
    try {
      const params = validateParams(b.type, b.params);
      running.set(b.id, { id: b.id, type: b.type, params, since: now });
      if (b.type === "lp" && S.lpStateOf(b.id)?.status !== "open") enqueueLpOpen(b.id, params as LpRules);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      S.setBotStatus(b.id, "error", msg, now);
      logEvent(b.id, "error", `This bot's settings are no longer valid (${msg}); fix them by creating a new bot.`, now);
      publishStats(b.id);
    }
  }
  follow();
  trig().start();
  markTimer = setInterval(() => { void markTick(); }, MARK_MS);
  (markTimer as any).unref?.();
  const warm = setTimeout(() => { void markTick(); }, 3_000);
  (warm as any).unref?.();
  lpTimer = setInterval(() => { void lpTick(); }, LP_TICK_MS);
  (lpTimer as any).unref?.();
  const lpWarm = setTimeout(() => { void lpTick(); }, 5_000);
  (lpWarm as any).unref?.();
  logger.info({ running: running.size }, "bots: engine started");
}

/** A server that forgot initBots still runs its bots once one is created; tests never start network loops. */
function ensureStarted(): void {
  if (!initialized && process.env.NODE_ENV !== "test") initBots();
}

const stripOwner = <T extends { owner?: string }>(b: T): Omit<T, "owner"> => { const { owner: _o, ...rest } = b; return rest; };
/** What anyone may see of a bot: no owner (never on a Bot anyway) and no webhook URL. */
function publicBot(b: Bot): Bot {
  if (b.type !== "alert") return b;
  const p = b.params as { webhook?: string | null };
  return p.webhook ? { ...b, params: { ...b.params, webhook: null } } : b;
}

export function createBot(owner: string, input: { name?: string; type: BotType; params: unknown; mode?: Bot["mode"] }): Bot {
  if (typeof owner !== "string" || !owner) throw new BotInputError("bots need an owner (a session or an API key)");
  if (!input || typeof input !== "object") throw new BotInputError("send { type, params, name?, mode? }");
  const type = validateType(input.type);
  const mode = validateMode(input.mode);
  if (mode === "live") throw new BotLiveError();
  const params = validateParams(type, input.params);
  if (S.countOf(owner) >= MAX_BOTS_PER_OWNER) throw new BotLimitError(`at most ${MAX_BOTS_PER_OWNER} bots per account: delete one to start another`);
  if (S.countRunning() >= MAX_RUNNING) throw new BotLimitError(`${MAX_RUNNING} bots are already running on this server: try again later`);
  ensureStarted();
  const now = execDeps.now();
  const id = randomBytes(6).toString("hex");
  const name = botName(input.name, type, params);
  S.insertBot({ id, owner, name, type, mode, status: "running", params, ts: now });
  running.set(id, { id, type, params, since: now });
  follow();
  if (type === "lp") {
    const l = params as LpRules;
    logEvent(id, "info", `Opening a paper LP position: $${l.amountUsd} in pool ${l.pool.slice(0, 4)}…${l.pool.slice(-4)}, ${l.preset ? `${l.preset} range` : `±${l.rangePct}% range`}, rebalance after ${l.rebalance.outOfRangeMinutes} min out of range (max ${l.rebalance.maxPerDay} a day)${l.exits.lpExodus ? ", exit on an LP exodus" : ""}${l.exits.tokenDropPct != null ? `, exit if the token drops ${l.exits.tokenDropPct}%` : ""}. Prices from Jupiter and Chord; nothing is sent.`, now);
    enqueueLpOpen(id, l, !(typeof input.name === "string" && input.name.trim()));
  } else if (type === "copy") {
    const c = params as CopyRules;
    logEvent(id, "info", `Started in paper mode: $${c.usdPerTrade} per mirrored buy from ${c.wallets.length} wallet${c.wallets.length > 1 ? "s" : ""}${c.mirrorSells ? ", sells mirrored" : ""}. Fills are priced by real Jupiter quotes; nothing is sent.`, now);
  } else {
    const a = params as AlertRules;
    logEvent(id, "info", `Watching ${[a.wallets.length && `${a.wallets.length} wallet${a.wallets.length > 1 ? "s" : ""}`, a.mints.length && `${a.mints.length} mint${a.mints.length > 1 ? "s" : ""}`].filter(Boolean).join(" and ")} for trades of $${a.minUsd} or more${a.webhook ? ", with a webhook" : ""}.`, now);
  }
  return publishStats(id)!;
}

export function listBots(owner: string): Bot[] {
  return S.botsOf(owner);
}

/** LP bots also answer `lp`: the position's state (range, liquidity, fees, IL, marks) and its chart points (every 10 min). */
export function getBot(owner: string | null, id: string): { bot: Bot; positions: Position[]; fills: Fill[]; events: BotEvent[]; lp?: { state: LpState | null; points: LpPoint[] } } | null {
  const row = typeof id === "string" ? S.botRow(id) : null;
  if (!row || (owner !== null && row.owner !== owner)) return null;
  const bot = stripOwner(row);
  const out = { bot: owner === null ? publicBot(bot) : bot, positions: S.positionsOf(id), fills: S.fillsOf(id, 200), events: S.eventsOf(id, 100) };
  return row.type === "lp" ? { ...out, lp: { state: S.lpStateOf(id), points: S.lpPointsOf(id) } } : out;
}

export function setStatus(owner: string, id: string, status: "running" | "paused"): Bot | null {
  if (status !== "running" && status !== "paused") throw new BotInputError(`status must be "running" or "paused"`);
  const row = S.botRow(id);
  if (!row || row.owner !== owner) return null;
  const now = execDeps.now();
  if (status === "paused") {
    if (row.status !== "paused") {
      running.delete(id);
      S.setBotStatus(id, "paused", row.status === "error" ? row.error : null, now);
      follow();
      logEvent(id, "info", row.type === "lp" && S.lpStateOf(id)?.status === "open" ? "Paused: the LP position stays in the pool and is still marked, but nothing is rebalanced or exited." : "Paused.", now);
    }
    return publishStats(id);
  }
  if (row.status === "running") return stripOwner(row);
  let params: CopyRules | AlertRules | LpRules;
  try { params = validateParams(row.type, row.params); }
  catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 200);
    S.setBotStatus(id, "error", msg, now);
    logEvent(id, "error", `Cannot resume: this bot's settings are not valid (${msg}).`, now);
    return publishStats(id);
  }
  if (S.countRunning() >= MAX_RUNNING) {
    logEvent(id, "warn", `Cannot resume right now: ${MAX_RUNNING} bots are already running on this server.`, now);
    return publishStats(id);
  }
  ensureStarted();
  S.setBotStatus(id, "running", null, now);
  running.set(id, { id, type: row.type, params, since: now });
  follow();
  if (row.type === "lp") {
    const open = S.lpStateOf(id)?.status === "open";
    logEvent(id, "info", open ? "Resumed: the agent manages the LP position again." : `Resumed: re-entering the pool with $${(params as LpRules).amountUsd}.`, now);
    if (!open) enqueueLpOpen(id, params as LpRules);
  } else logEvent(id, "info", "Resumed: trades from now on are mirrored.", now);
  return publishStats(id);
}

export function deleteBot(owner: string, id: string): boolean {
  const row = S.botRow(id);
  if (!row || row.owner !== owner) return false;
  running.delete(id);
  S.removeBot(id);
  follow();
  return true;
}

const btCache = new Map<string, { at: number; p: Promise<Backtest> }>();
/** Replay the wallets' recent history with the bot's rules. Same params + days inside 60 s share one run. */
export function backtest(input: { params: CopyParams; days: 1 | 3 | 7 }): Promise<Backtest> {
  const key = JSON.stringify([input?.params ?? null, input?.days ?? null]);
  const now = Date.now();
  for (const [k, v] of btCache) if (now - v.at > 60_000) btCache.delete(k);
  const hit = btCache.get(key);
  if (hit) return hit.p;
  const p = runBacktest(input);
  p.catch(() => btCache.delete(key));
  btCache.set(key, { at: now, p });
  return p;
}

/** Every copy bot (paper or live) by realized + unrealized PnL. Alert bots do not trade and are left out; no owner, no webhook. */
export function leaderboard(limit = 50): Bot[] {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
  return S.allBots("all")
    .filter((b) => b.type === "copy")
    .map((b) => publicBot(stripOwner(b)))
    .sort((a, b) => b.stats.realizedUsd + b.stats.unrealizedUsd - (a.stats.realizedUsd + a.stats.unrealizedUsd) || a.createdAt - b.createdAt)
    .slice(0, n);
}

// ── LP agent analysis (cached 60 s per identical ask) ──────────────────────────────────────────────────────────────
const lpCache = new Map<string, { at: number; p: Promise<unknown> }>();
function lpCached<T>(key: string, run: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [k, v] of lpCache) if (now - v.at > 60_000) lpCache.delete(k);
  const hit = lpCache.get(key);
  if (hit) return hit.p as Promise<T>;
  const p = run();
  p.catch(() => lpCache.delete(key));
  lpCache.set(key, { at: now, p });
  return p;
}
/** Rank Solana pools for providing liquidity (Chord's LP tape + venue APIs + Jupiter safety); flags on every row. */
export function lpScan(opts: LpScanOpts = {}): Promise<LpScan> {
  return lpCached(`scan:${JSON.stringify(opts ?? {})}`, () => runLpScan(opts ?? {}, lpDeps));
}
/** Tight / balanced / wide ranges for a pool from realized volatility, with the history's time in range. */
export function lpRange(pool: string, horizonHours = 24): Promise<LpRangeAnswer> {
  return lpCached(`range:${pool}:${horizonHours}`, () => runLpRange(pool, horizonHours, lpDeps));
}
/** Replay 1 / 3 / 7 days of hourly prices through an LP position run by the bot's rules. */
export function lpBacktest(input: { pool: string; amountUsd: number; preset?: string; rangePct?: number | null; rebalance?: unknown; exits?: unknown; days: 1 | 3 | 7 }): Promise<LpBacktest> {
  return lpCached(`bt:${JSON.stringify(input ?? null)}`, () => runLpBacktest(input, lpDeps));
}

export function smartTraders(days: 1 | 3 | 7, limit?: number): Promise<Trader[]> {
  return board(days, limit);
}

export function subscribe(botId: string, fn: (e: BotStreamEvent) => void): () => void {
  return busSubscribe(botId, fn);
}

/** For a status page: the trigger connection and polls, and how many bots run. */
export function botsStatus(): TriggerStatus & { running: number; initialized: boolean } {
  return { ...trig().status(), running: running.size, initialized };
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function _setBotDeps(d: { exec?: Partial<ExecDeps>; triggers?: Partial<TriggerDeps>; lp?: Partial<LpDeps> }): void {
  if (d.exec) execDeps = { ...defaultExecDeps(), ...d.exec };
  if (d.lp) { lpDeps = { ...defaultLpDeps(), ...d.lp }; lpCache.clear(); }
  if (d.triggers) { triggerDeps = d.triggers; triggers?.stop(); triggers = null; follow(); }
}
export function _resetBots(): void {
  if (markTimer) clearInterval(markTimer);
  markTimer = null;
  if (lpTimer) clearInterval(lpTimer);
  lpTimer = null;
  lpDeps = defaultLpDeps();
  lpCache.clear();
  lpStepErrAt.clear();
  _resetLpData();
  triggers?.stop();
  triggers = null;
  triggerDeps = {};
  execDeps = defaultExecDeps();
  initialized = false;
  running.clear();
  queues.clear();
  btCache.clear();
  _resetBus();
  _resetExecutor();
  _resetMarket();
  S._closeStore();
}
/** Wait for every queued trade to be handled. */
export async function _drain(): Promise<void> {
  while (queues.size) await Promise.all([...queues.values()]);
}
export const _dispatch = dispatch;
export const _triggers = trig;
export const _markTick = markTick;
export const _lpTick = lpTick;
