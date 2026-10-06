import { describe, expect, it } from "bun:test";
import { addr } from "../bots/_testkit";
import type { BotEvent, Fill, Position, SourceTrade } from "../bots/types";
import { createStrategyRunner, type FiredBy, type SkipRecord, type StrategyRunnerDeps } from "./runner";
import type { TokenSnapshot } from "./snapshot";
import type { LpSignal, NewTokenEvent } from "./sources";
import { trade } from "./_testkit";

const [W1, W2, W3, W4] = [1, 2, 3, 4].map((i) => addr(600 + i));
const [A, B, C, D] = [1, 2, 3, 4].map((i) => addr(700 + i));
const POOL = addr(801);
const T0 = 1_800_000_000_000; // 2027-01-15 08:00 UTC
const MIN = 60_000;
const BOT = "bot1";

/** A paper engine: positions per mint, fills at the current price, events and skips recorded. */
function harness(o: { prices?: Record<string, number>; snaps?: Record<string, Partial<TokenSnapshot>>; deps?: Partial<StrategyRunnerDeps> } = {}) {
  let now = T0;
  const px = new Map(Object.entries(o.prices ?? {}));
  const pos = new Map<string, Position>();
  const fills: Fill[] = [];
  const events: BotEvent[] = [];
  const skips: SkipRecord[] = [];
  const snapCalls: string[] = [];
  const fired: [string, FiredBy | undefined][] = [];
  let tradeFn: ((t: SourceTrade) => void) | null = null;
  const fill = (side: "buy" | "sell", mint: string, usd: number, qty: number, price: number, pnl: number | null): Fill => {
    const f: Fill = { id: `f${fills.length}`, botId: BOT, ts: now, side, mint, symbol: mint.slice(0, 3), usd, tokenAmount: qty, priceUsd: price, status: "filled", reason: null, pnlUsd: pnl,
      source: { wallet: "", tx: "", side, mint, symbol: null, usd: null, priceUsd: null, ts: now, via: "tape" }, quote: null, mode: "paper" };
    fills.push(f);
    return f;
  };
  const deps: StrategyRunnerDeps = {
    onWalletTrade: (fn) => { tradeFn = fn; return () => { tradeFn = null; }; },
    paperBuy: async (_id, mint, usd, signal) => {
      fired.push(["buy", signal]);
      const p = px.get(mint)!;
      const qty = usd / p, cur = pos.get(mint);
      pos.set(mint, { mint, symbol: mint.slice(0, 3), qty: (cur?.qty ?? 0) + qty, costUsd: (cur?.costUsd ?? 0) + usd, priceUsd: p, valueUsd: null, pnlUsd: null, openedAt: cur?.openedAt ?? now });
      return fill("buy", mint, usd, qty, p, null);
    },
    paperSell: async (_id, mint, pct, signal) => {
      fired.push(["sell", signal]);
      const p = px.get(mint)!, cur = pos.get(mint)!;
      const qty = cur.qty * pct / 100, cost = cur.costUsd * pct / 100;
      if (pct >= 100) pos.delete(mint); else pos.set(mint, { ...cur, qty: cur.qty - qty, costUsd: cur.costUsd - cost });
      return fill("sell", mint, qty * p, qty, p, qty * p - cost);
    },
    emitEvent: (_id, e) => { events.push(e); },
    positions: () => [...pos.values()],
    now: () => now,
    recordSkip: (_id, s) => { skips.push(s); },
    prices: async (mints) => new Map(mints.filter((m) => px.has(m)).map((m) => [m, px.get(m)!])),
    snapshot: async (mint) => {
      snapCalls.push(mint);
      const base: TokenSnapshot = { mint, symbol: null, at: now, priceUsd: null, liquidityUsd: null, marketCapUsd: null, fdvUsd: null, volume24hUsd: null, ageMin: null, holders: null, top10Pct: null,
        priceChange5mPct: null, priceChange1hPct: null, priceChange24hPct: null, organicScore: null, buyShare1hPct: null, smartBuyers1h: null,
        safety: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, verified: null, flagged: false }, from: {}, errors: [] };
      return { ...base, ...(o.snaps?.[mint] ?? {}) };
    },
    resolveWallets: async (w) => ("list" in w ? w.list : [W1, W2, W3, W4].slice(0, w.smartTraders.top)),
    seedPrices: async () => [],
    ...o.deps,
  };
  const runner = createStrategyRunner(deps);
  return {
    runner, fills, events, skips, pos, px, snapCalls, fired,
    at: (ms: number) => { now = ms; },
    get now() { return now; },
    /** through the engine subscription when the runner was started, else straight in */
    push: (t: SourceTrade) => (tradeFn ? tradeFn(t) : runner.handleTrade(t)),
  };
}

const copyStrategy = (extra: Record<string, unknown> = {}) => ({
  name: "copy", trigger: { type: "wallet_trade", wallets: { list: [W1, W2] }, side: "buy" },
  filters: [{ field: "liquidityUsd", op: ">=", value: 30_000 }, { safety: "no_mint_authority" }],
  action: { type: "buy", usd: 20 }, ...extra,
});

describe("strategy runner", () => {
  it("trigger → filter skip (which filter, what value) → buy → take profit on the marking tick", async () => {
    const h = harness({ prices: { [A]: 1, [B]: 1, [C]: 0.5 }, snaps: { [B]: { liquidityUsd: 12_000 }, [C]: { liquidityUsd: 50_000, symbol: "CCC" } } });
    await h.runner.add(BOT, copyStrategy({ exits: { takeProfitPct: 50, stopLossPct: 20 } }));
    h.runner.start();
    expect(h.runner.followedWallets().sort()).toEqual([W1, W2].sort());
    h.push(trade({ wallet: W1, mint: A, ts: T0 + 1000 })); // liquidity unknown
    h.push(trade({ wallet: W2, mint: B, ts: T0 + 2000 })); // liquidity too low
    h.push(trade({ wallet: W3, mint: C, ts: T0 + 3000 })); // not followed
    h.push(trade({ wallet: W1, mint: C, ts: T0 + 4000, side: "sell" })); // wrong side
    h.push(trade({ wallet: W1, mint: C, ts: T0 - 60_000 })); // before the bot started
    h.push(trade({ wallet: W2, mint: C, ts: T0 + 5000 }));
    await h.runner.drain();
    expect(h.skips.map((s) => [s.mint, s.stage, s.check, s.value, s.reason])).toEqual([
      [A, "filter", "liquidityUsd", null, "unknown liquidityUsd"],
      [B, "filter", "liquidityUsd", 12_000, "liquidity $12,000 (needs at least $30,000)"],
    ]);
    expect(h.skips[0].trigger).toBe(`${W1.slice(0, 4)}…${W1.slice(-4)} bought $100`);
    expect(h.fills.map((f) => [f.side, f.mint, f.usd])).toEqual([["buy", C, 20]]);
    expect(h.pos.get(C)).toMatchObject({ qty: 40, costUsd: 20 });

    h.px.set(C, 0.7); h.at(T0 + MIN); await h.runner.tick(); await h.runner.drain();
    expect(h.fills).toHaveLength(1); // +40 %: not yet
    h.px.set(C, 0.75); h.at(T0 + 2 * MIN); await h.runner.tick(); await h.runner.drain();
    expect(h.fills.map((f) => [f.side, f.usd, f.pnlUsd])).toEqual([["buy", 20, null], ["sell", 30, 10]]);
    expect(h.events.at(-1)!.msg).toBe(`Exit (take profit +50.0 %): sold ${C.slice(0, 3)} for $30 (+$10).`);
    // what fired each fill reaches the engine: the followed trade for the buy, the exit's words for the sell
    expect(h.fired).toEqual([
      ["buy", { detail: `${W2.slice(0, 4)}…${W2.slice(-4)} bought $100`, ts: T0 + 5000, trade: trade({ wallet: W2, mint: C, ts: T0 + 5000 }) }],
      ["sell", { detail: "take profit +50.0 %", ts: T0 + 2 * MIN }],
    ]);
    expect(h.pos.size).toBe(0);
    h.runner.stop();
  });

  it("stop loss, trailing stop from the peak, and max hold", async () => {
    const h = harness({ prices: { [A]: 1, [B]: 1, [C]: 1 } });
    await h.runner.add(BOT, { ...copyStrategy({ exits: { stopLossPct: 25, trailingPct: 20, maxHoldMin: 120 } }), filters: [] });
    for (const [m, i] of [[A, 1], [B, 2], [C, 3]] as const) h.push(trade({ wallet: W1, mint: m, ts: T0 + i * 1000 }));
    await h.runner.drain();
    expect(h.pos.size).toBe(3);
    // A falls 25 % → stop loss; B rises to 2 (peak) …
    h.px.set(A, 0.75); h.px.set(B, 2); h.at(T0 + 10 * MIN); await h.runner.tick(); await h.runner.drain();
    // … then to 1.6 = 20 % below its peak → trailing stop (while still +60 %)
    h.px.set(B, 1.6); h.at(T0 + 20 * MIN); await h.runner.tick(); await h.runner.drain();
    // C never moves: sold at 2 h
    h.at(T0 + 119 * MIN); await h.runner.tick(); await h.runner.drain();
    expect(h.pos.has(C)).toBe(true);
    h.at(T0 + 121 * MIN); await h.runner.tick(); await h.runner.drain();
    const sells = h.fills.filter((f) => f.side === "sell");
    expect(sells.map((f) => [f.mint, Math.round(f.pnlUsd! * 100) / 100])).toEqual([[A, -5], [B, 12], [C, 0]]);
    expect(h.events.filter((e) => e.msg.startsWith("Exit")).map((e) => e.msg.split(")")[0])).toEqual([
      "Exit (stop loss −25.0 %", "Exit (trailing stop −20.0 % from the peak", "Exit (max hold 2 h",
    ]);
  });

  it("limits: daily budget, cooldown, open positions, per-token cap, trades a day (no snapshot read when a bot-wide limit says no)", async () => {
    const h = harness({ prices: { [A]: 1, [B]: 1, [C]: 1, [D]: 1 }, snaps: Object.fromEntries([A, B, C, D].map((m) => [m, { liquidityUsd: 1e6 }])) });
    await h.runner.add(BOT, copyStrategy({ limits: { maxOpenPositions: 2, maxPerTokenUsd: 30, dailyBudgetUsd: 60, cooldownMin: 5, maxTradesPerDay: 10 } }));
    const t = (mint: string, dt: number) => h.push(trade({ wallet: W1, mint, ts: T0 + dt }));
    h.at(T0 + 1000); t(A, 1000); await h.runner.drain(); // buy A ($20)
    h.at(T0 + 2000); t(A, 2000); await h.runner.drain(); // cooldown
    h.at(T0 + 6 * MIN); t(A, 6 * MIN); await h.runner.drain(); // $20 + $20 > $30 cap
    h.at(T0 + 7 * MIN); t(B, 7 * MIN); await h.runner.drain(); // buy B
    h.at(T0 + 8 * MIN); t(C, 8 * MIN); await h.runner.drain(); // 2 open
    h.pos.delete(A);
    h.at(T0 + 9 * MIN); t(D, 9 * MIN); await h.runner.drain(); // buy D: $60 spent today
    const before = h.snapCalls.length;
    h.at(T0 + 10 * MIN); t(C, 10 * MIN); await h.runner.drain(); // daily budget, no snapshot read
    expect(h.snapCalls.length).toBe(before);
    expect(h.fills.map((f) => f.mint)).toEqual([A, B, D]);
    expect(h.skips.map((s) => [s.check, s.value])).toEqual([["cooldownMin", 0], ["maxPerTokenUsd", 20], ["maxOpenPositions", 2], ["dailyBudgetUsd", 60]]);
    expect(h.skips[3].reason).toBe("$60 spent today; another $20 would pass the $60 daily budget");
    // a new UTC day resets the budget (one position closed to make room)
    h.pos.delete(B);
    h.at(T0 + 86_400_000); t(C, 86_400_000); await h.runner.drain();
    expect(h.fills.map((f) => f.mint)).toEqual([A, B, D, C]);

    const k = harness({ prices: { [A]: 1, [B]: 1 } });
    await k.runner.add(BOT, { ...copyStrategy({ limits: { maxTradesPerDay: 1, cooldownMin: 0 } }), filters: [] });
    k.push(trade({ wallet: W1, mint: A, ts: T0 + 1 })); k.push(trade({ wallet: W1, mint: B, ts: T0 + 2 }));
    await k.runner.drain();
    expect(k.skips.map((s) => [s.check, s.reason])).toEqual([["maxTradesPerDay", "1 trades today (max 1); the day restarts at 00:00 UTC"]]);
  });

  it("confluence fires once per window; followed_sells exits; today's spend survives a restart", async () => {
    const h = harness({ prices: { [A]: 2 }, deps: { recentFills: () => [
      { ts: T0 - 3600_000, side: "buy", status: "filled", mint: D, usd: 90 } as Fill, // today, another token: counts toward the budget
    ] } });
    const s = { name: "crowd", trigger: { type: "confluence", wallets: { smartTraders: { top: 3, days: 1 } }, minWallets: 3, windowMin: 15, side: "buy" },
      filters: [], action: { type: "buy", usd: 10 }, exits: { sellWhen: "followed_sells" } };
    let followed: string[] = [];
    const h2 = harness({ prices: { [A]: 2 }, deps: { setFollowed: (w) => { followed = w; } } });
    await h2.runner.add(BOT, s);
    expect(followed.sort()).toEqual([W1, W2, W3].sort());
    for (const [w, dt] of [[W1, 0], [W2, MIN], [W1, 2 * MIN], [W3, 3 * MIN], [W2, 4 * MIN]] as const) h2.push(trade({ wallet: w, mint: A, ts: T0 + dt }));
    await h2.runner.drain();
    expect(h2.fills.map((f) => [f.side, f.mint, f.usd])).toEqual([["buy", A, 10]]);
    // a followed wallet sells A: the bot sells all of it
    h2.px.set(A, 3);
    h2.push(trade({ wallet: W2, mint: A, ts: T0 + 5 * MIN, side: "sell" }));
    await h2.runner.drain();
    expect(h2.fills.map((f) => [f.side, f.usd, f.pnlUsd])).toEqual([["buy", 10, null], ["sell", 15, 5]]);
    expect(h2.events.at(-1)!.msg).toMatch(/^Exit \(followed wallet .+ sold\)/);
    const sellSignal = h2.fired.find(([side]) => side === "sell")![1]!;
    expect(sellSignal).toMatchObject({ detail: `followed wallet ${W2.slice(0, 4)}…${W2.slice(-4)} sold`, ts: T0 + 5 * MIN, trade: { wallet: W2, side: "sell", mint: A } });
    expect(h2.fired[0][1]).toMatchObject({ detail: "3 followed wallets bought within 2 min", trade: { wallet: W3, mint: A } });
    h2.runner.remove(BOT);
    expect(followed).toEqual([]);

    // restart: $90 already spent today, budget $100 → the $10 buy fits, the next does not
    await h.runner.add(BOT, { ...s, limits: { dailyBudgetUsd: 100, cooldownMin: 0 } });
    for (const [w, dt] of [[W1, 0], [W2, MIN], [W3, 2 * MIN]] as const) h.push(trade({ wallet: w, mint: A, ts: T0 + dt }));
    for (const [w, dt] of [[W1, 20 * MIN], [W2, 21 * MIN], [W3, 22 * MIN]] as const) h.push(trade({ wallet: w, mint: A, ts: T0 + dt }));
    await h.runner.drain();
    expect(h.fills).toHaveLength(1);
    expect(h.skips.map((x) => x.check)).toEqual(["dailyBudgetUsd"]);
  });

  it("schedule: first run right away, then each interval", async () => {
    const h = harness({ prices: { [A]: 1 } });
    await h.runner.add(BOT, { name: "dca", trigger: { type: "schedule", every: "1h", mint: A }, action: { type: "buy", usd: 10 }, limits: { maxPerTokenUsd: 1000, cooldownMin: 0 } });
    await h.runner.tick(); await h.runner.drain();
    h.at(T0 + 59 * MIN); await h.runner.tick(); await h.runner.drain();
    h.at(T0 + 60 * MIN); await h.runner.tick(); await h.runner.drain();
    expect(h.fills.map((f) => f.ts)).toEqual([T0, T0 + 60 * MIN]);
  });

  it("price change_pct: one batched price call per tick for every price bot, fires on the way in", async () => {
    const calls: string[][] = [];
    const buys: [string, string, number][] = [];
    const px = new Map([[A, 1], [B, 1], [C, 1]]);
    const h = harness({ deps: {
      prices: async (m) => { calls.push([...m].sort()); return new Map(m.filter((x) => px.has(x)).map((x) => [x, px.get(x)!])); },
      trending: async () => [B, C],
      // candles seed the window: flat at $1 for the half hour before the bots start
      seedPrices: async (_m, w) => Array.from({ length: w + 1 }, (_, k) => ({ ts: T0 - (w + 1 - k) * MIN, p: 1 })),
      paperBuy: async (id, mint, usd) => { buys.push([id, mint, h.now]); return { status: "filled", mint, usd, side: "buy", ts: 0, priceUsd: 1, tokenAmount: usd } as Fill; },
    } });
    await h.runner.add("p1", { name: "up", trigger: { type: "price", mint: A, op: "change_pct", value: 10, windowMin: 30 }, action: { type: "alert" } });
    await h.runner.add("p2", { name: "momentum", trigger: { type: "price", mint: "trending", op: "change_pct", value: 15, windowMin: 30 }, action: { type: "buy", usd: 5 } });
    for (let i = 0; i <= 30; i++) {
      h.at(T0 + i * MIN);
      px.set(A, 1 + 0.004 * i); // +12 % at 30 min
      px.set(B, 1 + 0.006 * i); // +18 % at 30 min
      await h.runner.tick(); await h.runner.drain();
    }
    expect(calls.every((c) => c.join() === [A, B, C].sort().join())).toBe(true);
    expect(calls).toHaveLength(31);
    const alerts = h.events.filter((e) => e.msg.startsWith("Alert"));
    expect(alerts.map((e) => e.msg)).toEqual([`Alert: ${A.slice(0, 4)}…${A.slice(-4)}: +10.0 % in 30 min ($1 → $1.1)`]); // at 25 min, once
    expect(alerts[0].ts).toBe(T0 + 25 * MIN);
    // B reached +15 % at 25 min too (1 + 0.006 × 25 = 1.15); C never moved
    expect(buys).toEqual([["p2", B, T0 + 25 * MIN]]);
    expect(h.skips).toEqual([]);
  });

  it("new tokens and LP exodus feed their bots; alerts and webhooks are rate-limited", async () => {
    let evs: NewTokenEvent[] = [];
    let sigs: LpSignal[] = [];
    const hooks: unknown[] = [];
    const h = harness({ prices: { [A]: 1 }, deps: {
      newTokens: { poll: async () => evs },
      lp: { poll: async () => sigs, poolsOf: async (m) => (m === B ? [POOL] : []) },
      webhook: async (url, body) => { hooks.push({ url, body }); return { ok: true, status: 200 }; },
    } });
    await h.runner.add("grad", { name: "grad", trigger: { type: "new_token", source: "graduation" }, action: { type: "buy", usd: 10 } });
    await h.runner.add("guard", { name: "guard", trigger: { type: "lp_event", mints: [B], event: "exodus", minUsd: 5000 }, action: { type: "webhook", url: "https://hooks.example.com/x" } });
    evs = [
      { mint: A, symbol: "AAA", source: "graduation", ts: T0, firstSeen: T0 - 600_000, dex: "pumpswap", pool: POOL, liquidityUsd: 1, marketCapUsd: 1, priceUsd: 1, via: "chord" },
      { mint: C, symbol: "CCC", source: "launch", ts: T0, firstSeen: T0, dex: "pumpfun", pool: POOL, liquidityUsd: 1, marketCapUsd: 1, priceUsd: 1, via: "chord" },
    ];
    await h.runner.pollNewTokens(); await h.runner.drain();
    expect(h.fills.map((f) => f.mint)).toEqual([A]);
    const hour = Math.floor(T0 / 3600_000) * 3600;
    sigs = [
      { pool: POOL, token: B, symbol: "BBB", kind: "exodus", usd: 9000, ts: T0, hour, depositsUsd: 1000, withdrawalsUsd: 9000 },
      { pool: addr(999), token: D, symbol: "DDD", kind: "exodus", usd: 9000, ts: T0, hour }, // not watched
    ];
    await h.runner.pollLp(); await h.runner.drain();
    await h.runner.pollLp(); await h.runner.drain(); // the same hour again: once
    expect(h.events.filter((e) => e.msg.startsWith("Alert")).map((e) => e.msg)).toEqual([`Alert: BBB: liquidity exodus in pool ${POOL.slice(0, 4)}…${POOL.slice(-4)}: $9,000 out vs $1,000 in this hour`]);
    expect(hooks).toHaveLength(1);
    expect((hooks[0] as any).body).toMatchObject({ type: "strategy_signal", bot: { id: "guard", name: "guard" }, trigger: "lp_event", token: { mint: B, symbol: "BBB" } });
    // under the bot's minUsd: nothing
    sigs = [{ pool: POOL, token: B, symbol: "BBB", kind: "exodus", usd: 4000, ts: T0, hour: hour + 3600 }];
    await h.runner.pollLp(); await h.runner.drain();
    expect(hooks).toHaveLength(1);

    // 25 distinct tokens a minute through a webhook bot: 20 webhooks, every alert recorded
    const w = harness({ deps: { webhook: async (url, body) => { hooks.push(body); return { ok: false, status: 500 }; } } });
    await w.runner.add(BOT, { name: "w", trigger: { type: "wallet_trade", wallets: { list: [W1] }, side: "any" }, action: { type: "webhook", url: "https://hooks.example.com/y" } });
    hooks.length = 0;
    for (let i = 0; i < 25; i++) w.push(trade({ wallet: W1, mint: addr(900 + i), ts: T0 + i }));
    await w.runner.drain();
    expect(hooks).toHaveLength(20);
    expect(w.events.filter((e) => e.msg.startsWith("Alert"))).toHaveLength(25);
    expect(w.events.filter((e) => e.msg === "Webhook answered 500")).toHaveLength(20);
  });

  it("refuses an invalid strategy", async () => {
    const h = harness();
    await expect(h.runner.add(BOT, { trigger: { type: "nope" }, action: { type: "alert" } })).rejects.toThrow(/Trigger › type/);
    expect(h.runner.has(BOT)).toBe(false);
  });
});
