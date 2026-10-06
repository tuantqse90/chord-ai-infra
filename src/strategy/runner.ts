// Runs custom bots (engine bot type "custom", PAPER): trigger → filters → limits → action, and exits on the marking tick.
// Everything that touches the engine comes in through `deps`, so the main session plugs it into src/bots later:
//   onWalletTrade  the engine's SourceTrade stream (followed wallets: websocket + tape); `setFollowed` tells the engine which
//                  wallets the custom bots need followed;
//   paperBuy / paperSell  the engine's paper fill (a real Jupiter quote; nothing is sent);
//   emitEvent / positions / now.
// Per bot, signals are handled one at a time (a queue), so limits never race. Every skip records the stage (filter / limit /
// action), the check and the value it saw. Cheap bot-wide limits (trades a day, daily budget, cooldown) are checked before the
// token snapshot is read, so a bot that is out of budget does not spend data calls; the rest follows the plan's order.
import { http, prices as jupPrices } from "../bots/market";
import { isPublicHttpsUrl } from "../chord/utils/safeFetchUrl";
import type { BotEvent, Fill, Position, SourceTrade } from "../bots/types";
import { duration, money } from "./explain";
import { parseStrategy, type Filter, type Strategy, type Trigger, type TriggerOf, type Wallets } from "./schema";
import { buildSnapshot, evaluateFilters, type TokenSnapshot } from "./snapshot";
import {
  checkPrice, ConfluenceWindow, EdgeTrigger, LpEventSource, NewTokenSource, PriceHistory, resolveWallets as resolve, scheduleDue, seedFromCandles, trendingMints,
  type LpSignal, type NewTokenEvent,
} from "./sources";

export interface SkipRecord {
  ts: number; mint: string; symbol: string | null;
  stage: "filter" | "limit" | "action";
  /** the filter field / safety check, or the limit's name */
  check: string;
  value: number | boolean | null;
  reason: string;
  /** what fired: the trigger's own words */
  trigger: string;
}

/** What fired a paper fill: the trigger (or the exit) in plain words, the followed wallet's trade when there is one, and when
 *  it fired (unix ms) — the engine's Fill.source and the feed's reaction time (fill ts − signal ts). */
export interface FiredBy { detail: string; trade?: SourceTrade; ts: number }

export interface StrategyRunnerDeps {
  /** Subscribe to the engine's SourceTrade stream; answers the unsubscribe. */
  onWalletTrade: (fn: (t: SourceTrade) => void) => () => void;
  paperBuy: (botId: string, mint: string, usd: number, signal?: FiredBy) => Promise<Fill>;
  /** exits pass detail like "take profit +100.0 %", "stop loss −30.0 %", "trailing stop −25.0 % from the peak", "max hold 1 day",
   *  "followed wallet AbCd…wXyZ sold" (with that sell as `trade`) */
  paperSell: (botId: string, mint: string, pct: number, signal?: FiredBy) => Promise<Fill>;
  emitEvent: (botId: string, e: BotEvent) => void;
  positions: (botId: string) => Position[] | Promise<Position[]>;
  now: () => number;
  // ── optional (defaults in brackets) ──
  /** The wallets the custom bots need followed (wire to the engine's Triggers.setFollowed, merged with the copy bots'). */
  setFollowed?: (wallets: string[]) => void;
  /** "The tokens you hold" for lp_event without pools / mints and price mint "held" [this bot's positions]. */
  heldMints?: (botId: string) => string[] | Promise<string[]>;
  /** Store a skip (e.g. as a skipped fill) [an info event, at most 20 a minute per bot]. */
  recordSkip?: (botId: string, skip: SkipRecord) => void;
  /** The bot's recent fills, read once when it starts: today's spend, trades, cooldowns and the last scheduled run survive a restart [none]. */
  recentFills?: (botId: string) => Fill[] | Promise<Fill[]>;
  /** USD prices, many mints in one batched call [Jupiter price v3, cached 30 s]. */
  prices?: (mints: string[]) => Promise<Map<string, number>>;
  snapshot?: (mint: string, filters: Filter[]) => Promise<TokenSnapshot>;
  resolveWallets?: (w: Wallets) => Promise<string[]>;
  /** Chord's trending Solana tokens [the 24 h volume board, top 20, refreshed every 5 min]. */
  trending?: () => Promise<string[]>;
  /** Older prices for change_pct so it does not wait a whole window [Chord candles]. */
  seedPrices?: (mint: string, windowMin: number) => Promise<{ ts: number; p: number }[]>;
  newTokens?: { poll(): Promise<NewTokenEvent[]> };
  lp?: { poll(pools: string[], withEvents: Set<string>): Promise<LpSignal[]>; poolsOf(mint: string): Promise<string[]> };
  webhook?: (url: string, body: unknown) => Promise<{ ok: boolean; status: number | null; error?: string }>;
}

export const TICK_MS = 30_000;
export const NEW_TOKEN_POLL_MS = 30_000;
export const LP_POLL_MS = 60_000;
export const WALLET_REFRESH_MS = 10 * 60_000;
const TRENDING_TTL = 5 * 60_000;
const ALERTS_PER_MIN = 30;
const WEBHOOKS_PER_MIN = 20;
const SKIP_EVENTS_PER_MIN = 20;
const MIN = 60_000;

interface Signal { mint: string; symbol: string | null; ts: number; detail: string; trade?: SourceTrade; data?: Record<string, unknown> }
interface Run {
  id: string; s: Strategy; since: number;
  wallets: Set<string>; walletsAt: number;
  confluence: ConfluenceWindow | null;
  ledger: { day: number; spent: number; trades: number };
  lastAct: Map<string, number>;
  peaks: Map<string, number>;
  exiting: Set<string>;
  lastSchedule: number | null;
  lpSeen: Map<string, number>;
  rate: { m: number; alerts: number; hooks: number; skips: number; warned: boolean };
  queue: Promise<void>;
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160);
const utcDay = (ms: number) => Math.floor(ms / 86_400_000);
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)} %`;

async function postWebhook(url: string, body: unknown): Promise<{ ok: boolean; status: number | null; error?: string }> {
  if (!isPublicHttpsUrl(url)) return { ok: false, status: null, error: "not a public https URL" };
  try {
    const r = await http(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "ask2049-strategy/1" }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(5_000) });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: null, error: (e as Error)?.name === "TimeoutError" ? "timed out after 5 s" : errText(e) };
  }
}

export interface StrategyRunner {
  /** Start a custom bot (validates the strategy; resolves smart-trader wallets). `since` = ignore trades before it [now]. */
  add(botId: string, strategy: unknown, opts?: { since?: number }): Promise<Strategy>;
  remove(botId: string): void;
  has(botId: string): boolean;
  /** Timers: marking / price / schedule tick 30 s, new tokens 30 s, LP 60 s, smart-trader wallets 10 min. Tests drive the steps by hand. */
  start(): void;
  stop(): void;
  /** One marking pass: one batched price call, price triggers, schedules, exits (TP / SL / trailing / max hold). */
  tick(): Promise<void>;
  pollNewTokens(): Promise<void>;
  pollLp(): Promise<void>;
  refreshWallets(force?: boolean): Promise<void>;
  /** What the onWalletTrade subscription calls (exposed for tests). */
  handleTrade(t: SourceTrade): void;
  followedWallets(): string[];
  drain(): Promise<void>;
  status(): { running: number; followedWallets: number; lastTickAt: number | null; lastError: string | null; newTokensVia: string | null };
}

export function createStrategyRunner(deps: StrategyRunnerDeps): StrategyRunner {
  const d = deps;
  const prices = d.prices ?? jupPrices;
  const snapshot = d.snapshot ?? ((mint: string, filters: Filter[]) => buildSnapshot(mint, { filters }));
  const resolveWallets = d.resolveWallets ?? ((w: Wallets) => resolve(w));
  const seedPrices = d.seedPrices ?? ((mint: string, w: number) => seedFromCandles(mint, w));
  const webhook = d.webhook ?? postWebhook;
  const lp = d.lp ?? new LpEventSource({ now: d.now });
  const newTokens = d.newTokens ?? new NewTokenSource({ now: d.now });
  let trendingCache: { at: number; mints: string[] } | null = null;
  const trending = async (): Promise<string[]> => {
    if (d.trending) return d.trending();
    const now = d.now();
    if (trendingCache && now - trendingCache.at < TRENDING_TTL) return trendingCache.mints;
    try { trendingCache = { at: now, mints: await trendingMints() }; } catch (e) { lastError = `trending board: ${errText(e)}`; if (!trendingCache) return []; }
    return trendingCache!.mints;
  };

  const runs = new Map<string, Run>();
  const history = new PriceHistory();
  const edges = new EdgeTrigger();
  const seeded = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let timers: ReturnType<typeof setInterval>[] = [];
  let lastTickAt: number | null = null;
  let lastError: string | null = null;
  let ticking: Promise<void> | null = null;

  const event = (id: string, level: BotEvent["level"], msg: string) => {
    try { d.emitEvent(id, { ts: d.now(), level, msg }); } catch { /* the engine's problem, not the bot's */ }
  };
  const minuteRate = (r: Run) => {
    const m = Math.floor(d.now() / MIN);
    if (r.rate.m !== m) r.rate = { m, alerts: 0, hooks: 0, skips: 0, warned: false };
    return r.rate;
  };
  const roll = (r: Run) => {
    const day = utcDay(d.now());
    if (r.ledger.day !== day) r.ledger = { day, spent: 0, trades: 0 };
  };
  const enqueue = (r: Run, job: () => Promise<unknown>): Promise<void> => {
    const next = r.queue.then(job).then(() => undefined, (e) => { if (runs.get(r.id) === r) event(r.id, "error", `Could not handle a signal: ${errText(e)}`); });
    r.queue = next;
    return next;
  };
  const isWalletTrigger = (t: Trigger): t is TriggerOf<"wallet_trade"> | TriggerOf<"confluence"> => t.type === "wallet_trade" || t.type === "confluence";
  const held = async (r: Run): Promise<string[]> => {
    if (d.heldMints) return [...await d.heldMints(r.id)];
    return (await d.positions(r.id)).filter((p) => p.qty > 0).map((p) => p.mint);
  };

  function follow(): void {
    if (d.setFollowed) { try { d.setFollowed(followedWallets()); } catch { /* */ } }
  }
  function followedWallets(): string[] {
    const all = new Set<string>();
    for (const r of runs.values()) for (const w of r.wallets) all.add(w);
    return [...all];
  }

  function skip(r: Run, sig: Signal, stage: SkipRecord["stage"], check: string, value: number | boolean | null, reason: string): void {
    const rec: SkipRecord = { ts: d.now(), mint: sig.mint, symbol: sig.symbol, stage, check, value, reason, trigger: sig.detail };
    if (d.recordSkip) { try { d.recordSkip(r.id, rec); } catch { /* */ } return; }
    const rate = minuteRate(r);
    if (rate.skips++ < SKIP_EVENTS_PER_MIN) event(r.id, "info", `Skipped ${sig.symbol ?? short(sig.mint)} (${sig.detail}): ${stage === "filter" ? "filter" : stage === "limit" ? "limit" : "action"} ${check}: ${reason}`);
  }

  /** filters → limits → action, for one signal of one bot (inside the bot's queue). */
  async function act(r: Run, sig: Signal): Promise<void> {
    if (runs.get(r.id) !== r) return;
    const s = r.s, a = s.action, l = s.limits, now = d.now();
    roll(r);
    // cheap bot-wide limits first: no snapshot is read for a bot that cannot act anyway
    if ((a.type === "buy" || a.type === "sell") && r.ledger.trades >= l.maxTradesPerDay) return skip(r, sig, "limit", "maxTradesPerDay", r.ledger.trades, `${r.ledger.trades} trades today (max ${l.maxTradesPerDay}); the day restarts at 00:00 UTC`);
    if (a.type === "buy" && r.ledger.spent + a.usd > l.dailyBudgetUsd + 1e-9) return skip(r, sig, "limit", "dailyBudgetUsd", r.ledger.spent, `${money(r.ledger.spent)} spent today; another ${money(a.usd)} would pass the ${money(l.dailyBudgetUsd)} daily budget`);
    const last = r.lastAct.get(sig.mint);
    if (l.cooldownMin > 0 && last != null && now - last < l.cooldownMin * MIN) {
      const ago = (now - last) / MIN;
      return skip(r, sig, "limit", "cooldownMin", Math.round(ago * 10) / 10, `acted on this token ${ago.toFixed(1)} min ago (cooldown ${l.cooldownMin} min)`);
    }
    if (s.filters.length) {
      let snap: TokenSnapshot;
      try { snap = await snapshot(sig.mint, s.filters); } catch (e) { return skip(r, sig, "filter", "snapshot", null, `could not read the token (${errText(e)})`); }
      const v = evaluateFilters(s.filters, snap);
      if (!v.pass) return skip(r, sig, "filter", v.field, v.value, v.reason);
      sig.symbol ??= snap.symbol;
    }
    if (runs.get(r.id) !== r) return;
    if (a.type === "buy") {
      const ps = await d.positions(r.id);
      const pos = ps.find((p) => p.mint === sig.mint && p.qty > 0);
      if (!pos && ps.filter((p) => p.qty > 0).length >= l.maxOpenPositions) return skip(r, sig, "limit", "maxOpenPositions", ps.length, `${l.maxOpenPositions} positions already open`);
      if (pos && pos.costUsd + a.usd > l.maxPerTokenUsd + 1e-9) return skip(r, sig, "limit", "maxPerTokenUsd", pos.costUsd, `already ${money(pos.costUsd)} in this token; another ${money(a.usd)} would pass the ${money(l.maxPerTokenUsd)} cap`);
      let f: Fill;
      try { f = await d.paperBuy(r.id, sig.mint, a.usd, firedBy(sig)); } catch (e) { event(r.id, "warn", `Could not paper-buy ${sig.symbol ?? short(sig.mint)}: ${errText(e)}`); return; }
      if (f.status !== "filled") return; // the engine wrote the skipped fill and its reason
      r.ledger.spent += f.usd || a.usd;
      r.ledger.trades++;
      r.lastAct.set(sig.mint, now);
      const entry = f.priceUsd ?? (f.tokenAmount > 0 ? f.usd / f.tokenAmount : null);
      if (entry != null && !r.peaks.has(sig.mint)) r.peaks.set(sig.mint, entry);
      return;
    }
    if (a.type === "sell") {
      const pos = (await d.positions(r.id)).find((p) => p.mint === sig.mint && p.qty > 0);
      if (!pos) return skip(r, sig, "action", "position", null, "the bot holds none of this token");
      let f: Fill;
      try { f = await d.paperSell(r.id, sig.mint, a.pct, firedBy(sig)); } catch (e) { event(r.id, "warn", `Could not paper-sell ${sig.symbol ?? short(sig.mint)}: ${errText(e)}`); return; }
      if (f.status !== "filled") return;
      r.ledger.trades++;
      r.lastAct.set(sig.mint, now);
      if (a.pct >= 100) r.peaks.delete(sig.mint);
      return;
    }
    // alert / webhook
    const rate = minuteRate(r);
    if (rate.alerts >= ALERTS_PER_MIN) {
      if (!rate.warned) { rate.warned = true; event(r.id, "warn", `More than ${ALERTS_PER_MIN} alerts this minute; the rest of this minute's alerts are dropped.`); }
      return;
    }
    rate.alerts++;
    r.lastAct.set(sig.mint, now);
    const msg = `${sig.symbol ?? short(sig.mint)}: ${sig.detail}`;
    event(r.id, "info", `Alert: ${msg}`);
    if (a.type === "webhook") {
      if (rate.hooks >= WEBHOOKS_PER_MIN) return;
      rate.hooks++;
      const res = await webhook(a.url, { type: "strategy_signal", bot: { id: r.id, name: s.name }, trigger: s.trigger.type, token: { mint: sig.mint, symbol: sig.symbol }, message: msg, data: sig.data ?? null, trade: sig.trade ?? null, ts: now });
      if (!res.ok) event(r.id, "warn", `Webhook ${res.status != null ? `answered ${res.status}` : `failed: ${res.error ?? "no answer"}`}`);
    }
  }

  const firedBy = (sig: Signal): FiredBy => ({ detail: sig.detail, ts: sig.ts, ...(sig.trade ? { trade: sig.trade } : {}) });

  async function exit(r: Run, mint: string, why: string, trade?: SourceTrade): Promise<void> {
    if (runs.get(r.id) !== r || r.exiting.has(mint)) return;
    r.exiting.add(mint);
    try {
      const f = await d.paperSell(r.id, mint, 100, { detail: why, ts: trade?.ts ?? d.now(), ...(trade ? { trade } : {}) });
      if (f.status === "filled") {
        r.peaks.delete(mint);
        event(r.id, "info", `Exit (${why}): sold ${f.symbol ?? short(mint)} for ${money(f.usd)}${f.pnlUsd != null ? ` (${f.pnlUsd >= 0 ? "+" : "−"}${money(Math.abs(f.pnlUsd))})` : ""}.`);
      }
    } catch (e) {
      event(r.id, "warn", `Exit (${why}) on ${short(mint)} failed: ${errText(e)}; tried again on the next tick.`);
    } finally {
      r.exiting.delete(mint);
    }
  }

  function handleTrade(t: SourceTrade): void {
    for (const r of runs.values()) {
      if (!r.wallets.has(t.wallet) || t.ts < r.since - 1_000) continue;
      const trig = r.s.trigger;
      if (!isWalletTrigger(trig)) continue;
      // followed_sells: a followed wallet sells a token the bot holds → sell it all (an exit, never limited)
      if (t.side === "sell" && r.s.exits?.sellWhen === "followed_sells") {
        void enqueue(r, async () => {
          const pos = (await d.positions(r.id)).find((p) => p.mint === t.mint && p.qty > 0);
          if (pos) await exit(r, t.mint, `followed wallet ${short(t.wallet)} sold`, t);
        });
      }
      if (trig.type === "wallet_trade") {
        if (trig.side !== "any" && trig.side !== t.side) continue;
        if (trig.minUsd > 0 && !(t.usd != null && t.usd >= trig.minUsd)) continue;
        const sig: Signal = { mint: t.mint, symbol: t.symbol, ts: t.ts, trade: t, detail: `${short(t.wallet)} ${t.side === "buy" ? "bought" : "sold"}${t.usd != null ? ` ${money(t.usd)}` : ""}` };
        void enqueue(r, () => act(r, sig));
      } else {
        const hit = r.confluence!.push(t);
        if (!hit) continue;
        const sig: Signal = { mint: hit.mint, symbol: hit.symbol, ts: hit.ts, trade: t, data: { wallets: hit.wallets, usd: hit.usd },
          detail: `${hit.wallets.length} followed wallets ${hit.side === "buy" ? "bought" : "sold"} within ${Math.max(1, Math.round((hit.ts - hit.firstTs) / MIN))} min` };
        void enqueue(r, () => act(r, sig));
      }
    }
  }

  async function seedRun(r: Run): Promise<void> {
    if (!d.recentFills) return;
    let fills: Fill[] = [];
    try { fills = [...await d.recentFills(r.id)]; } catch { return; }
    const today = utcDay(d.now());
    const side = r.s.action.type === "sell" ? "sell" : "buy";
    for (const f of fills) {
      if (f.status !== "filled" || f.side !== side) continue;
      if (utcDay(f.ts) === today) { r.ledger.trades++; if (side === "buy") r.ledger.spent += f.usd; }
      r.lastAct.set(f.mint, Math.max(r.lastAct.get(f.mint) ?? 0, f.ts));
      if (r.s.trigger.type === "schedule" && f.mint === r.s.trigger.mint && side === "buy") r.lastSchedule = Math.max(r.lastSchedule ?? 0, f.ts);
    }
  }

  async function refreshWallets(force = false): Promise<void> {
    const now = d.now();
    let changed = false;
    for (const r of runs.values()) {
      const t = r.s.trigger;
      if (!isWalletTrigger(t) || !("smartTraders" in t.wallets)) continue;
      if (!force && now - r.walletsAt < WALLET_REFRESH_MS) continue;
      try {
        const ws = await resolveWallets(t.wallets);
        if (ws.length) { r.wallets = new Set(ws); r.walletsAt = now; changed = true; }
      } catch (e) { lastError = `smart traders: ${errText(e)}`; }
    }
    if (changed) follow();
  }

  async function tick(): Promise<void> {
    if (ticking) return ticking;
    ticking = (async () => {
      const now = d.now();
      // what to price: price-trigger mints and every position a bot with price exits holds
      const priceRuns: { r: Run; t: TriggerOf<"price">; mints: string[] }[] = [];
      const exitRuns: { r: Run; ps: Position[] }[] = [];
      for (const r of runs.values()) {
        const t = r.s.trigger;
        try {
          if (t.type === "price") {
            const mints = t.mint === "trending" ? await trending() : t.mint === "held" ? await held(r) : [t.mint];
            priceRuns.push({ r, t, mints });
            if (t.op === "change_pct") history.setKeep((t.windowMin ?? 60) * MIN);
          }
          const e = r.s.exits;
          if (r.s.action.type === "buy" && e && (e.takeProfitPct != null || e.stopLossPct != null || e.trailingPct != null || e.maxHoldMin != null)) {
            exitRuns.push({ r, ps: (await d.positions(r.id)).filter((p) => p.qty > 0 && p.costUsd > 0) });
          }
        } catch (e) { lastError = `tick: ${errText(e)}`; }
      }
      const want = new Set<string>([...priceRuns.flatMap((x) => x.mints), ...exitRuns.flatMap((x) => x.ps.map((p) => p.mint))]);
      let px = new Map<string, number>();
      if (want.size) { try { px = await prices([...want]); } catch (e) { lastError = `prices: ${errText(e)}`; } }
      const priceMints = new Set(priceRuns.flatMap((x) => x.mints));
      for (const m of priceMints) { const v = px.get(m); if (v != null) history.record(m, v, now); }

      // price triggers (change_pct seeds its history from candles once per mint)
      for (const { r, t, mints } of priceRuns) {
        for (const m of mints) {
          const price = px.get(m);
          if (price == null) continue;
          if (t.op === "change_pct" && !seeded.has(m)) {
            seeded.add(m);
            try { history.seed(m, await seedPrices(m, t.windowMin ?? 60)); } catch { /* the window fills from the ticks */ }
          }
          const c = checkPrice(t, m, price, now, history);
          if (c.warming) continue;
          if (edges.update(`${r.id}|${m}`, c.met)) void enqueue(r, () => act(r, { mint: m, symbol: null, ts: now, detail: c.detail, data: { priceUsd: price, changePct: c.changePct } }));
        }
      }
      history.forget(priceMints);

      // schedules
      for (const r of runs.values()) {
        const t = r.s.trigger;
        if (t.type !== "schedule" || !scheduleDue(t.every, r.lastSchedule, now)) continue;
        r.lastSchedule = now;
        void enqueue(r, () => act(r, { mint: t.mint, symbol: null, ts: now, detail: `scheduled run (every ${t.every})` }));
      }

      // exits
      for (const { r, ps } of exitRuns) {
        const e = r.s.exits!;
        for (const p of ps) {
          const price = px.get(p.mint) ?? p.priceUsd;
          if (price == null || !(price > 0)) continue;
          const entry = p.costUsd / p.qty;
          const peak = Math.max(r.peaks.get(p.mint) ?? entry, price);
          r.peaks.set(p.mint, peak);
          const change = (price / entry - 1) * 100;
          let why: string | null = null;
          const eps = 1e-9; // 1.5 / 1.0 is 49.999… % in floating point
          if (e.stopLossPct != null && change <= -e.stopLossPct + eps) why = `stop loss ${pct(change)}`;
          else if (e.takeProfitPct != null && change >= e.takeProfitPct - eps) why = `take profit ${pct(change)}`;
          else if (e.trailingPct != null && price <= peak * (1 - e.trailingPct / 100) * (1 + eps)) why = `trailing stop ${pct((price / peak - 1) * 100)} from the peak`;
          else if (e.maxHoldMin != null && now - p.openedAt >= e.maxHoldMin * MIN) why = `max hold ${duration(e.maxHoldMin)}`;
          if (why) { const reason = why; void enqueue(r, () => exit(r, p.mint, reason)); }
        }
      }
      lastTickAt = now;
    })().finally(() => { ticking = null; });
    return ticking;
  }

  async function pollNewTokens(): Promise<void> {
    const want = [...runs.values()].filter((r) => r.s.trigger.type === "new_token");
    if (!want.length) return;
    let evs: NewTokenEvent[] = [];
    try { evs = await newTokens.poll(); } catch (e) { lastError = `new tokens: ${errText(e)}`; return; }
    for (const ev of evs) {
      for (const r of want) {
        const t = r.s.trigger as TriggerOf<"new_token">;
        if (runs.get(r.id) !== r || (t.source !== "any" && t.source !== ev.source) || ev.ts < r.since - MIN) continue;
        const detail = ev.source === "launch" ? `new token${ev.dex ? ` on ${ev.dex}` : ""}` : `graduated${ev.dex ? ` to ${ev.dex}` : ""}`;
        void enqueue(r, () => act(r, { mint: ev.mint, symbol: ev.symbol, ts: ev.ts, detail, data: { source: ev.source, via: ev.via, liquidityUsd: ev.liquidityUsd } }));
      }
    }
  }

  async function pollLp(): Promise<void> {
    const want = [...runs.values()].filter((r) => r.s.trigger.type === "lp_event");
    if (!want.length) return;
    const watch = new Map<string, Map<string, string | null>>(); // run → pool → the watched mint (null = the pool itself)
    const withEvents = new Set<string>();
    for (const r of want) {
      const t = r.s.trigger as TriggerOf<"lp_event">;
      const m = new Map<string, string | null>();
      for (const p of t.pools ?? []) m.set(p, null);
      let mints = t.mints ?? [];
      if (!mints.length && !(t.pools ?? []).length) { try { mints = await held(r); } catch { mints = []; } }
      for (const mint of mints) {
        try { for (const p of await lp.poolsOf(mint)) if (!m.has(p)) m.set(p, mint); } catch (e) { lastError = `LP pools of ${short(mint)}: ${errText(e)}`; }
      }
      watch.set(r.id, m);
      if (t.event !== "exodus") for (const p of m.keys()) withEvents.add(p);
    }
    const pools = [...new Set([...watch.values()].flatMap((m) => [...m.keys()]))];
    if (!pools.length) return;
    let sigs: LpSignal[] = [];
    try { sigs = await lp.poll(pools, withEvents); } catch (e) { lastError = `LP: ${errText(e)}`; return; }
    const now = d.now();
    for (const r of want) {
      const t = r.s.trigger as TriggerOf<"lp_event">, m = watch.get(r.id)!;
      for (const sg of sigs) {
        if (!m.has(sg.pool) || sg.kind !== t.event || sg.usd < (t.minUsd ?? 0) || sg.ts < r.since - MIN) continue;
        const key = sg.kind === "exodus" ? `${sg.pool}|${sg.hour}` : `${sg.pool}|${sg.signature ?? sg.ts}|${sg.usd}`;
        if (r.lpSeen.has(key)) continue;
        r.lpSeen.set(key, now);
        const mint = m.get(sg.pool) ?? sg.token;
        if (!mint) continue;
        const detail = sg.kind === "exodus"
          ? `liquidity exodus in pool ${short(sg.pool)}: ${money(sg.withdrawalsUsd ?? sg.usd)} out vs ${money(sg.depositsUsd ?? 0)} in this hour`
          : `${money(sg.usd)} of liquidity ${sg.kind === "large_remove" ? "removed from" : "added to"} pool ${short(sg.pool)}`;
        void enqueue(r, () => act(r, { mint, symbol: sg.symbol, ts: sg.ts, detail, data: { pool: sg.pool, kind: sg.kind, usd: sg.usd } }));
      }
      for (const [k, at] of r.lpSeen) if (now - at > 3 * 3600_000) r.lpSeen.delete(k);
    }
  }

  return {
    async add(botId, input, opts = {}) {
      const s = parseStrategy(input);
      if (runs.has(botId)) this.remove(botId);
      const now = d.now();
      const t = s.trigger;
      const r: Run = {
        id: botId, s, since: opts.since ?? now, wallets: new Set(), walletsAt: 0,
        confluence: t.type === "confluence" ? new ConfluenceWindow({ minWallets: t.minWallets, windowMin: t.windowMin, side: t.side }) : null,
        ledger: { day: utcDay(now), spent: 0, trades: 0 }, lastAct: new Map(), peaks: new Map(), exiting: new Set(), lastSchedule: null, lpSeen: new Map(),
        rate: { m: 0, alerts: 0, hooks: 0, skips: 0, warned: false }, queue: Promise.resolve(),
      };
      if (isWalletTrigger(t)) {
        try { r.wallets = new Set(await resolveWallets(t.wallets)); r.walletsAt = now; }
        catch (e) { event(botId, "warn", `Could not read the smart-traders board yet (${errText(e)}); retried every few minutes.`); }
      }
      await seedRun(r);
      runs.set(botId, r);
      follow();
      return s;
    },
    remove(botId) {
      if (!runs.delete(botId)) return;
      edges.forget(`${botId}|`);
      follow();
    },
    has: (botId) => runs.has(botId),
    start() {
      if (!unsubscribe) unsubscribe = d.onWalletTrade(handleTrade);
      if (timers.length) return;
      const every = (ms: number, fn: () => Promise<void>) => {
        const h = setInterval(() => { void fn().catch((e) => { lastError = errText(e); }); }, ms);
        (h as any).unref?.();
        timers.push(h);
      };
      every(TICK_MS, tick);
      every(NEW_TOKEN_POLL_MS, pollNewTokens);
      every(LP_POLL_MS, pollLp);
      every(WALLET_REFRESH_MS / 4, () => refreshWallets());
    },
    stop() {
      for (const h of timers) clearInterval(h);
      timers = [];
      unsubscribe?.();
      unsubscribe = null;
    },
    tick, pollNewTokens, pollLp, refreshWallets, handleTrade, followedWallets,
    async drain() {
      for (let i = 0; i < 20; i++) {
        const qs = [...runs.values()].map((r) => r.queue);
        await Promise.all(qs);
        if ([...runs.values()].every((r, j) => r.queue === qs[j])) return;
      }
    },
    status: () => ({ running: runs.size, followedWallets: followedWallets().length, lastTickAt, lastError, newTokensVia: (newTokens as any).lastVia ?? null }),
  };
}
