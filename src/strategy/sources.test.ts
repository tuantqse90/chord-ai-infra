import { describe, expect, it } from "bun:test";
import { addr } from "../bots/_testkit";
import { parseStrategy, type TriggerOf } from "./schema";
import { checkPrice, ConfluenceWindow, EdgeTrigger, PriceHistory, resolveWallets, scheduleDue } from "./sources";
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
