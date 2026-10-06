import { describe, expect, it } from "bun:test";
import { addr } from "../bots/_testkit";
import { parseStrategy, type TriggerOf } from "./schema";
import { checkPrice, ConfluenceWindow, EdgeTrigger, graduationOf, LpEventSource, NewTokenSource, PriceHistory, resolveWallets, scheduleDue } from "./sources";
import { fakeFetch, trade } from "./_testkit";

const [W1, W2, W3, W4] = [1, 2, 3, 4].map((i) => addr(200 + i));
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map((i) => addr(300 + i));
const P1 = addr(401), P2 = addr(402);
const MIN = 60_000;
const T0 = 1_800_000_000_000;

describe("confluence window", () => {
  it("emits once per token per window when ≥ minWallets distinct wallets did the side", () => {
    const w = new ConfluenceWindow({ minWallets: 3, windowMin: 15, side: "buy" });
    expect(w.push(trade({ wallet: W1, mint: A, ts: T0 }))).toBeNull();
    expect(w.push(trade({ wallet: W1, mint: A, ts: T0 + MIN }))).toBeNull(); // same wallet again: still 1
    expect(w.push(trade({ wallet: W2, mint: A, ts: T0 + 2 * MIN, side: "sell" }))).toBeNull(); // wrong side
    expect(w.push(trade({ wallet: W2, mint: A, ts: T0 + 3 * MIN }))).toBeNull();
    expect(w.push(trade({ wallet: W3, mint: B, ts: T0 + 4 * MIN }))).toBeNull(); // another token
    const hit = w.push(trade({ wallet: W3, mint: A, ts: T0 + 5 * MIN, usd: 50 }));
    expect(hit).toMatchObject({ mint: A, side: "buy", wallets: [W1, W2, W3], firstTs: T0 + MIN, ts: T0 + 5 * MIN, usd: 350 });
    // a 4th wallet inside the same window: no second hit
    expect(w.push(trade({ wallet: W4, mint: A, ts: T0 + 10 * MIN }))).toBeNull();
    // 15 min after the hit, W3 (5 min) and W4 (10 min) are still inside the window with W2 again: a new hit
    expect(w.push(trade({ wallet: W2, mint: A, ts: T0 + 19 * MIN }))).toBeNull(); // 14 min after the hit
    expect(w.push(trade({ wallet: W2, mint: A, ts: T0 + 20 * MIN }))?.wallets).toEqual([W3, W4, W2]);
  });

  it("forgets wallets that fell out of the window", () => {
    const w = new ConfluenceWindow({ minWallets: 2, windowMin: 10, side: "sell" });
    expect(w.push(trade({ wallet: W1, mint: A, ts: T0, side: "sell" }))).toBeNull();
    expect(w.push(trade({ wallet: W2, mint: A, ts: T0 + 11 * MIN, side: "sell" }))).toBeNull(); // W1 is 11 min old
    expect(w.push(trade({ wallet: W1, mint: A, ts: T0 + 12 * MIN, side: "sell" }))?.wallets).toEqual([W2, W1]);
    expect(w.push(trade({ wallet: W3, mint: A, ts: T0 - 5 * MIN, side: "sell" }))).toBeNull(); // too old for the window
    w.sweep(T0 + 60 * MIN);
    expect(w.size()).toBe(0);
  });
});

describe("price triggers", () => {
  const trig = (x: unknown) => parseStrategy({ trigger: x, action: { type: "alert" } }).trigger as TriggerOf<"price">;

  it("change_pct over windowMin from the in-memory history (warming up until it covers the window)", () => {
    const h = new PriceHistory();
    const t = trig({ type: "price", mint: A, op: "change_pct", value: 15, windowMin: 60 });
    for (let i = 0; i <= 30; i++) h.record(A, 1 + i * 0.001, T0 + i * MIN); // 1.000 → 1.030 over 30 min
    expect(checkPrice(t, A, 1.03, T0 + 30 * MIN, h)).toMatchObject({ met: false, warming: true, changePct: null });
    for (let i = 31; i <= 60; i++) h.record(A, 1.03 + (i - 30) * 0.004, T0 + i * MIN); // → 1.150 at 60 min
    const c = checkPrice(t, A, 1.15, T0 + 60 * MIN, h);
    expect(c.met).toBe(true);
    expect(c.changePct).toBeCloseTo(15, 6);
    expect(c.detail).toBe("+15.0 % in 60 min ($1 → $1.15)");
    // 70 min: the price an hour ago was 1.01 (at 10 min) → +13.9 %: not met
    h.record(A, 1.15, T0 + 70 * MIN);
    expect(checkPrice(t, A, 1.15, T0 + 70 * MIN, h).changePct).toBeCloseTo((1.15 / 1.01 - 1) * 100, 6);
    expect(checkPrice(t, A, 1.15, T0 + 70 * MIN, h).met).toBe(false);

    const drop = trig({ type: "price", mint: A, op: "change_pct", value: -20, windowMin: 15 });
    const h2 = new PriceHistory();
    h2.record(B, 10, T0); h2.record(B, 9, T0 + 5 * MIN); h2.record(B, 7.9, T0 + 15 * MIN);
    expect(checkPrice(drop, B, 7.9, T0 + 15 * MIN, h2)).toMatchObject({ met: true });
    expect(checkPrice(drop, B, 8.1, T0 + 15 * MIN, h2).met).toBe(false);
  });

  it("above / below and the edge: fires once, re-arms after the condition stops holding", () => {
    const h = new PriceHistory();
    const t = trig({ type: "price", mint: A, op: "above", value: 2 });
    const e = new EdgeTrigger();
    const fire = (p: number) => e.update("bot|A", checkPrice(t, A, p, T0, h).met);
    expect([fire(1.9), fire(2.1), fire(2.5), fire(1.5), fire(2.2)]).toEqual([false, true, false, false, true]);
    expect(checkPrice(trig({ type: "price", mint: A, op: "below", value: 2 }), A, 1.5, T0, h).met).toBe(true);
  });

  it("history keeps samples ≥ 20 s apart and seeds older candles in front", () => {
    const h = new PriceHistory();
    h.record(A, 1, T0); h.record(A, 2, T0 + 5_000); h.record(A, 3, T0 + 10_000); h.record(A, 4, T0 + 30_000);
    expect(h.at(A, T0 + 10_000)).toBe(3);
    expect(h.at(A, T0 + 29_000)).toBe(3);
    expect(h.at(A, T0 + 30_000)).toBe(4);
    h.seed(A, [{ ts: T0 - 60_000, p: 0.5 }, { ts: T0 + 1, p: 9 }]);
    expect(h.oldest(A)).toBe(T0 - 60_000);
    expect(h.at(A, T0 - 1)).toBe(0.5);
  });
});

describe("schedule", () => {
  it("due on the first run, then after each interval", () => {
    expect(scheduleDue("1h", null, T0)).toBe(true);
    expect(scheduleDue("1h", T0, T0 + 59 * MIN)).toBe(false);
    expect(scheduleDue("1h", T0, T0 + 60 * MIN)).toBe(true);
    expect(scheduleDue("1w", T0, T0 + 6 * 86_400_000)).toBe(false);
  });
});

describe("wallets", () => {
  it("a list is itself; smartTraders reads the board", async () => {
    expect(await resolveWallets({ list: [W1, W2] })).toEqual([W1, W2]);
    const asked: unknown[] = [];
    const ws = await resolveWallets({ smartTraders: { top: 2, days: 3 } }, async (days, limit) => { asked.push([days, limit]); return [{ wallet: W3 }, { wallet: W4 }, { wallet: W1 }] as any; });
    expect(ws).toEqual([W3, W4]);
    expect(asked).toEqual([[3, 2]]);
  });
});

describe("new tokens / graduations (Chord's new-token board)", () => {
  const row = (mint: string, dex: string, firstSeenS: number) => ({ token: mint, symbol: mint.slice(0, 3), name: null, priceUsd: 0.001, liquidityUsd: 30_000, marketCapUsd: 90_000, volume24hUsd: 9000, dex, pool: P1, firstSeen: firstSeenS });

  it("baseline first, then launches, curve → AMM moves, and AMM-first tokens looked up for a finished curve", async () => {
    let now = T0;
    const nowS = () => Math.floor(now / 1000);
    let boardRows: unknown[] = [row(A, "pumpfun", nowS() - 600)];
    const f = fakeFetch({
      "/tokens?sort=new": () => ({ tokens: boardRows }),
      [`/token/${D}?`]: { token: D, pools: [{ pool: P1, dex: "pumpswap", liquidityUsd: 50_000, firstSeen: nowS() - 100, lastTrade: nowS() }, { pool: P2, dex: "pumpfun", liquidityUsd: 0, firstSeen: nowS() - 900, lastTrade: nowS() - 120 }] },
      [`/token/${E}?`]: { token: E, pools: [{ pool: P1, dex: "meteora_damm_v2", liquidityUsd: 20_000, firstSeen: nowS() - 60, lastTrade: nowS() }] },
    });
    const src = new NewTokenSource({ fetch: f, now: () => now });
    expect(await src.poll()).toEqual([]); // baseline: A was already there
    now += 30_000;
    boardRows = [row(A, "pumpswap", nowS() - 630), row(B, "pumpfun", nowS() - 20), row(C, "pumpfun", nowS() - 3 * 3600), row(D, "pumpswap", nowS() - 900), row(E, "meteora_damm_v2", nowS() - 60)];
    const evs = await src.poll();
    expect(evs.map((e) => [e.mint, e.source, e.ts])).toEqual([
      [A, "graduation", now], // was on its curve, now on PumpSwap
      [B, "launch", (nowS() - 20) * 1000], // new on its curve
      // C: on the board for the first time but launched 3 h ago: history, not a signal
      [D, "graduation", T0 - 120_000], // first met on an AMM with a finished curve behind it (its view was made at T0)
      [E, "launch", (nowS() - 60) * 1000], // straight onto an AMM: a launch
    ]);
    expect(evs[0]).toMatchObject({ via: "chord", dex: "pumpswap", liquidityUsd: 30_000 });
    expect(f.calls.filter((u) => u.includes("/token/")).length).toBe(2);
    now += 30_000;
    expect(await src.poll()).toEqual([]); // nothing new
    expect(src.lastVia).toBe("chord");
  });

  it("falls back to GeckoTerminal's new Solana pools when Chord cannot be read", async () => {
    let now = T0;
    const pool = (mint: string, dex: string, createdMs: number, id: string) => ({ id, attributes: { name: "PEPE / SOL", address: id, pool_created_at: new Date(createdMs).toISOString(), reserve_in_usd: "12000", market_cap_usd: null, fdv_usd: "50000", base_token_price_usd: "0.0001" }, relationships: { base_token: { data: { id: `solana_${mint}` } }, dex: { data: { id: dex } } } });
    let gt = { data: [pool(A, "pump-fun", now - 60_000, "p1")] };
    const src = new NewTokenSource({ fetch: fakeFetch({ "/tokens?sort=new": 503 }), now: () => now, geckoNewPools: async () => gt });
    expect(await src.poll()).toEqual([]);
    now += 60_000;
    const gradMint = `${B.slice(0, -4)}pump`;
    gt = { data: [pool(A, "pump-fun", T0 - 60_000, "p1"), pool(C, "pump-fun", now - 5_000, "p2"), pool(gradMint, "pumpswap", now - 10_000, "p3")] };
    const evs = await src.poll();
    expect(evs.map((e) => [e.mint, e.source, e.via])).toEqual([[C, "launch", "geckoterminal"], [gradMint, "graduation", "geckoterminal"]]);
    expect(evs[0]).toMatchObject({ symbol: "PEPE", liquidityUsd: 12000, marketCapUsd: 50000, priceUsd: 0.0001 });
    expect(src.lastVia).toBe("geckoterminal");
    expect(src.lastError).toMatch(/answered 503/);
  });

  it("graduationOf: the curve's last trade, only when an AMM now holds the depth", () => {
    const v = (pools: any[]) => ({ mint: A, symbol: null, priceUsd: null, change1hPct: null, change24hPct: null, marketCapUsd: null, liquidityUsd: null, volume24hUsd: null, firstSeen: 1, pools });
    expect(graduationOf(v([{ pool: P1, dex: "pumpfun", liquidityUsd: 0, volumeUsd: 0, firstSeen: 100, lastTrade: 500 }, { pool: P2, dex: "pumpswap", liquidityUsd: 9000, volumeUsd: 0, firstSeen: 101, lastTrade: 900 }]))).toBe(500_000);
    // a tiny AMM pool beside a live curve is not a graduation
    expect(graduationOf(v([{ pool: P1, dex: "pumpfun", liquidityUsd: 20_000, volumeUsd: 0, firstSeen: 100, lastTrade: 900 }, { pool: P2, dex: "pumpswap", liquidityUsd: 1000, volumeUsd: 0, firstSeen: 101, lastTrade: 901 }]))).toBeNull();
    expect(graduationOf(v([{ pool: P2, dex: "pumpswap", liquidityUsd: 9000, volumeUsd: 0, firstSeen: 101, lastTrade: 900 }]))).toBeNull();
  });
});

describe("LP events", () => {
  it("exodus = withdrawals > 2 × deposits in an hour; large add / remove events after a baseline", async () => {
    const now = T0;
    const hour = Math.floor(now / 1000 / 3600) * 3600;
    let events = [{ ts: now / 1000 - 600, signature: "s0", kind: "remove", pool: P1, usd: 90_000, owner: W1 }];
    const f = fakeFetch({
      [`/lp/pool/${P1}?`]: { pool: P1, token: A, mintA: A, symbolA: "AAA", mintB: "So11111111111111111111111111111111111111112", symbolB: "SOL", since: 1, hourly: [
        { hour: hour - 3600, depositsUsd: 1000, withdrawalsUsd: 1500 }, { hour, depositsUsd: 2000, withdrawalsUsd: 9000 }] },
      [`/lp/pool/${P1}/events`]: () => ({ events }),
      [`/lp/pool/${P2}?`]: 404,
      [`/token/${B}?`]: { token: B, pools: [{ pool: P2, dex: "meteora_dlmm", liquidityUsd: 5, firstSeen: 1, lastTrade: 2 }, { pool: "x", dex: "pumpfun", liquidityUsd: 9, firstSeen: 1, lastTrade: 2 }] },
    });
    const lp = new LpEventSource({ fetch: f, now: () => now });
    expect(await lp.poolsOf(B)).toEqual([P2]); // the curve is not an LP pool
    let sigs = await lp.poll([P1, P2], new Set([P1]));
    expect(sigs).toEqual([{ pool: P1, token: A, symbol: "AAA", kind: "exodus", usd: 9000, ts: now, hour, depositsUsd: 2000, withdrawalsUsd: 9000 }]);
    // the remove from before the first poll is the baseline; a new one after it is a signal
    events = [{ ts: now / 1000 + 30, signature: "s1", kind: "remove", pool: P1, usd: 40_000, owner: W2 }, { ts: now / 1000 + 20, signature: "s2", kind: "add", pool: P1, usd: 15_000, owner: W2 }, { ts: now / 1000 + 25, signature: "s3", kind: "fee", pool: P1, usd: 5, owner: W2 }, ...events];
    sigs = await lp.poll([P1, P2], new Set([P1]));
    expect(sigs.filter((s) => s.kind !== "exodus").map((s) => [s.kind, s.usd, s.signature])).toEqual([["large_remove", 40_000, "s1"], ["large_add", 15_000, "s2"]]);
    // P2 answered 404: not asked again within 10 min
    expect(f.calls.filter((u) => u.includes(`/lp/pool/${P2}`)).length).toBe(1);
  });
});
