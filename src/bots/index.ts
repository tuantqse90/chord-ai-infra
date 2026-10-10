// Agents as a service on Monad, the engine. Copy-trader, alert and custom (strategy) agents, backtests, PAPER mode only.
// Running agents live in memory (what they follow, since when); every trade the triggers see on Chord's Monad feed is routed
// to the agents that follow its wallet (or watch its token), one queue per agent, so one agent's failure never touches another.
// Custom bots run in the strategy runner (src/strategy/runner.ts): it sees every followed trade, asks for the wallets it needs,
// and acts through the same paper fills (strategyBuy / strategySell) and the same stores.
import { randomBytes } from "node:crypto";
import { logger } from "../chord/utils/logger";
import { runBacktest } from "./backtest";
import { _resetBus, subscribe as busSubscribe } from "./bus";
import { BotInputError, BotLimitError, BotLiveError } from "./errors";
import { createStrategyRunner, type StrategyRunner } from "../strategy/runner";
import { _resetExecutor, alertTrade, copyTrade, defaultExecDeps, logEvent, markAll, publishStats, strategyBuy, strategySell, strategySkip, type AlertRules, type CopyRules, type ExecDeps, type ExecHooks } from "./executor";
import { _resetMarket } from "./market";
import * as S from "./store";
import { _resetTape, smartTraders as board, startFeed } from "./tape";
import { Triggers, type TriggerDeps, type TriggerStatus } from "./triggers";
import { botName, validateMode, validateParams, validateType, type CustomRules } from "./validate";
import type { Backtest, Bot, BotEvent, BotStreamEvent, BotType, CopyParams, Fill, Position, SourceTrade, Trader } from "./types";

export * from "./types";
export { BotInputError, BotLimitError, BotLiveError } from "./errors";

export const MAX_BOTS_PER_OWNER = 5;
export const MAX_RUNNING = 200;
export const MARK_MS = 30_000;

type RunEntry = { id: string; type: BotType; params: CopyRules | AlertRules | CustomRules; since: number };
const running = new Map<string, RunEntry>();
const queues = new Map<string, Promise<void>>();
let triggers: Triggers | null = null;
let triggerDeps: Partial<TriggerDeps> = {};
let execDeps: ExecDeps = defaultExecDeps();
let markTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let strategies: StrategyRunner | null = null;
const SKIPS_PER_MIN = 20;
const skipRate = new Map<string, { m: number; n: number }>();

const hooks: ExecHooks = {
  pause(botId, msg) {
    if (!running.has(botId)) return;
    running.delete(botId);
    strategies?.remove(botId);
    S.setBotStatus(botId, "paused", null, execDeps.now());
    follow();
    logEvent(botId, "warn", msg, execDeps.now());
    publishStats(botId);
  },
};

function trig(): Triggers {
  if (!triggers) triggers = new Triggers(dispatch, triggerDeps);
  return triggers;
}

/** The strategy runner for custom bots, wired to the engine's trade stream, paper fills and stores. */
function strat(): StrategyRunner {
  if (strategies) return strategies;
  strategies = createStrategyRunner({
    // dispatch() hands every followed trade to handleTrade directly, so trades reach custom bots with or without the timers
    onWalletTrade: () => () => {},
    paperBuy: (id, mint, usd, sig) => strategyBuy(id, mint, usd, sig, execDeps),
    paperSell: (id, mint, pct, sig) => strategySell(id, mint, pct, sig, execDeps),
    emitEvent: (id, e) => { if (S.botRow(id)) logEvent(id, e.level, e.msg, e.ts); },
    positions: (id) => S.positionsOf(id),
    now: () => execDeps.now(),
    setFollowed: () => follow(),
    recentFills: (id) => S.fillsOf(id, 200),
    // a skip is a skipped fill (the agent's tape and the public feed show which check said no), at most 20 a minute per agent
    recordSkip: (id, k) => {
      const m = Math.floor(execDeps.now() / 60_000), r = skipRate.get(id);
      if (r && r.m === m && r.n >= SKIPS_PER_MIN) return;
      skipRate.set(id, r && r.m === m ? { m, n: r.n + 1 } : { m, n: 1 });
      const run = running.get(id);
      const a = run?.type === "custom" ? (run.params as CustomRules).strategy.action : null;
      strategySkip(id, { ts: k.ts, mint: k.mint, symbol: k.symbol, reason: k.reason, trigger: k.trigger }, a?.type === "buy" ? a.usd : 0);
    },
  });
  return strategies;
}
/** Hand a custom bot to the runner; a strategy that no longer validates or cannot start stops the bot with the reason. */
function startStrategy(id: string, params: CustomRules, since: number): void {
  strat().add(id, params.strategy, { since }).then(() => {
    // paused or deleted while the strategy was starting (smart-trader wallets resolve over the network): do not resurrect it
    if (running.get(id)?.type !== "custom") strategies?.remove(id);
    follow();
  }, (e) => {
    running.delete(id);
    strategies?.remove(id);
    if (!S.botRow(id)) return;
    const msg = String((e as Error)?.message ?? e).slice(0, 200);
    S.setBotStatus(id, "error", msg, execDeps.now());
    logEvent(id, "error", `Could not start this agent's strategy: ${msg}`, execDeps.now());
    publishStats(id);
    follow();
  });
}

/** Point the triggers at what the running bots follow. */
function follow(): void {
  const wallets = new Set<string>(), mints = new Set<string>();
  for (const w of strategies?.followedWallets() ?? []) wallets.add(w);
  for (const r of running.values()) {
    if (r.type === "custom") continue;
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
  if (strategies) { try { strategies.handleTrade(t); } catch (e) { logger.warn({ err: String(e).slice(0, 200) }, "bots: strategy runner refused a trade"); } }
  for (const r of running.values()) {
    if (r.type === "custom") continue;
    const relevant = r.type === "copy"
      ? (r.params as CopyRules).wallets.includes(t.wallet)
      : (r.params as AlertRules).wallets.includes(t.wallet) || (r.params as AlertRules).mints.includes(t.mint);
    if (!relevant || t.ts < r.since - 1_000) continue;
    void enqueue(r.id, () => (r.type === "copy" ? copyTrade(r.id, r.params as CopyRules, t, execDeps, hooks) : alertTrade(r.id, r.params as AlertRules, t, execDeps)));
  }
}

async function markTick(): Promise<void> {
  try { await markAll(execDeps, hooks, running); }
  catch (e) { logger.warn({ err: String(e).slice(0, 200) }, "bots: marking tick failed"); }
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
      if (b.type === "custom") startStrategy(b.id, params as CustomRules, now);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      S.setBotStatus(b.id, "error", msg, now);
      logEvent(b.id, "error", `This bot's settings are no longer valid (${msg}); fix them by creating a new bot.`, now);
      publishStats(b.id);
    }
  }
  follow();
  void startFeed();
  trig().start();
  strat().start();
  markTimer = setInterval(() => { void markTick(); }, MARK_MS);
  (markTimer as any).unref?.();
  const warm = setTimeout(() => { void markTick(); }, 3_000);
  (warm as any).unref?.();
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
  if (type === "custom") {
    const st = (params as CustomRules).strategy;
    logEvent(id, "info", `Started in paper mode: ${st.name}. Every action is priced by a real router quote on Monad; nothing is sent, every fill is committed on-chain.`, now);
    startStrategy(id, params as CustomRules, now);
  } else if (type === "copy") {
    const c = params as CopyRules;
    logEvent(id, "info", `Started in paper mode: $${c.usdPerTrade} per mirrored buy from ${c.wallets.length} wallet${c.wallets.length > 1 ? "s" : ""}${c.mirrorSells ? ", sells mirrored" : ""}. Fills are priced by real router quotes on Monad; nothing is sent, every fill is committed on-chain.`, now);
  } else {
    const a = params as AlertRules;
    logEvent(id, "info", `Watching ${[a.wallets.length && `${a.wallets.length} wallet${a.wallets.length > 1 ? "s" : ""}`, a.mints.length && `${a.mints.length} token${a.mints.length > 1 ? "s" : ""}`].filter(Boolean).join(" and ")} for trades of $${a.minUsd} or more${a.webhook ? ", with a webhook" : ""}.`, now);
  }
  return publishStats(id)!;
}

export function listBots(owner: string): Bot[] {
  return S.botsOf(owner);
}

export function getBot(owner: string | null, id: string): { bot: Bot; positions: Position[]; fills: Fill[]; events: BotEvent[] } | null {
  const row = typeof id === "string" ? S.botRow(id) : null;
  if (!row || (owner !== null && row.owner !== owner)) return null;
  const bot = stripOwner(row);
  return { bot: owner === null ? publicBot(bot) : bot, positions: S.positionsOf(id), fills: S.fillsOf(id, 200), events: S.eventsOf(id, 100) };
}

export function setStatus(owner: string, id: string, status: "running" | "paused"): Bot | null {
  if (status !== "running" && status !== "paused") throw new BotInputError(`status must be "running" or "paused"`);
  const row = S.botRow(id);
  if (!row || row.owner !== owner) return null;
  const now = execDeps.now();
  if (status === "paused") {
    if (row.status !== "paused") {
      running.delete(id);
      strategies?.remove(id);
      S.setBotStatus(id, "paused", row.status === "error" ? row.error : null, now);
      follow();
      logEvent(id, "info", "Paused.", now);
    }
    return publishStats(id);
  }
  if (row.status === "running") return stripOwner(row);
  let params: CopyRules | AlertRules | CustomRules;
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
  if (row.type === "custom") {
    logEvent(id, "info", "Resumed: the strategy acts on signals from now on; open positions keep their exits.", now);
    startStrategy(id, params as CustomRules, now);
  } else logEvent(id, "info", "Resumed: trades from now on are mirrored.", now);
  return publishStats(id);
}

export function deleteBot(owner: string, id: string): boolean {
  const row = S.botRow(id);
  if (!row || row.owner !== owner) return false;
  running.delete(id);
  strategies?.remove(id);
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

/** Every trading bot (copy, and custom ones whose strategy buys or sells) by realized + unrealized PnL. Alert bots are
 *  left out (no trades to rank / a different yardstick); no owner, no webhook. */
const trades = (b: Bot) => b.type === "copy" || (b.type === "custom" && ["buy", "sell"].includes(((b.params as any)?.strategy?.action?.type ?? "") as string));
export function leaderboard(limit = 50): Bot[] {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
  return S.allBots("all")
    .filter(trades)
    .map((b) => publicBot(stripOwner(b)))
    .sort((a, b) => b.stats.realizedUsd + b.stats.unrealizedUsd - (a.stats.realizedUsd + a.stats.unrealizedUsd) || a.createdAt - b.createdAt)
    .slice(0, n);
}

export function smartTraders(days: 1 | 3 | 7, limit?: number): Promise<Trader[]> {
  return board(days, limit);
}

export function subscribe(botId: string, fn: (e: BotStreamEvent) => void): () => void {
  return busSubscribe(botId, fn);
}

/** For a status page: the trigger connection and polls, and how many bots run. */
export function botsStatus(): TriggerStatus & { running: number; initialized: boolean; strategies: ReturnType<StrategyRunner["status"]> | null } {
  return { ...trig().status(), running: running.size, initialized, strategies: strategies?.status() ?? null };
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function _setBotDeps(d: { exec?: Partial<ExecDeps>; triggers?: Partial<TriggerDeps> }): void {
  if (d.exec) execDeps = { ...defaultExecDeps(), ...d.exec };
  if (d.triggers) { triggerDeps = d.triggers; triggers?.stop(); triggers = null; follow(); }
}
export function _resetBots(): void {
  if (markTimer) clearInterval(markTimer);
  markTimer = null;
  triggers?.stop();
  triggers = null;
  triggerDeps = {};
  strategies?.stop();
  strategies = null;
  skipRate.clear();
  execDeps = defaultExecDeps();
  initialized = false;
  running.clear();
  queues.clear();
  btCache.clear();
  _resetBus();
  _resetExecutor();
  _resetMarket();
  _resetTape();
  S._closeStore();
}
/** Wait for every queued trade to be handled. */
export async function _drain(): Promise<void> {
  while (queues.size) await Promise.all([...queues.values()]);
  await strategies?.drain();
}
export const _strategies = strat;
export const _dispatch = dispatch;
export const _triggers = trig;
export const _markTick = markTick;

