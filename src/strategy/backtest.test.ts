import { describe, expect, it } from "bun:test";
import { addr } from "../bots/_testkit";
import type { TapeRow } from "../bots/tape";
import { backtestStrategy, type StrategyBacktestDeps } from "./backtest";
import type { Candle, TokenView } from "./chord";

const [W1, W2, W3] = [1, 2, 3].map((i) => addr(1000 + i));
const [A, B, C, X, Y] = [1, 2, 3, 4, 5].map((i) => addr(1100 + i));
const POOL = addr(1201);
const NOW = 1_800_000_000_000; // 08:00 UTC
const CUT = NOW - 86_400_000; // days = 1
const S = CUT / 1000;
const STEP = 300_000; // 5-minute candles for a 1-day window
const MIN = 60_000;

const row = (dt: number, side: "buy" | "sell", token: string, priceUsd: number, wallet: string): TapeRow =>
  ({ ts: S + dt, side, token, symbol: token.slice(0, 3), usd: 100, priceUsd, tokenAmount: 1, tx: `t${dt}${wallet.slice(0, 2)}`, wallet });
/** The box: newest first, `before` strict, at most `limit` rows. */
const page = (rows: TapeRow[]): StrategyBacktestDeps["walletPage"] => async (w, limit, before) =>
  rows.filter((r) => r.wallet === w && (before == null || r.ts < before)).sort((a, b) => b.ts - a.ts).slice(0, limit);
const bar = (k: number, o: number, h: number, l: number, c: number): Candle => ({ t: CUT + k * STEP, o, h, l, c });
const flat = (k: number, p: number) => bar(k, p, p, p, p);
const deps = (o: Partial<StrategyBacktestDeps>): Partial<StrategyBacktestDeps> => ({ now: () => NOW, prices: async () => new Map(), candles: async () => [], tokenTrades: async () => [], ...o });
/** n flat bars after the last one given (a token with enough candles is walked on candles only) */
const pad = (cs: Candle[], n = 12) => [...cs, ...Array.from({ length: n }, (_, i) => flat(cs[cs.length - 1].t / STEP - CUT / STEP + 1 + i, cs[cs.length - 1].c))];

describe("strategy backtest", () => {
  it("wallet_trade: tape replay, limits, TP / SL walked on candles (numbers checked by hand)", async () => {
    const rows = [
      row(-50, "buy", C, 1, W1), // before the window
      row(100, "buy", A, 1.0, W1), // buy 100 A for $100
      row(200, "buy", A, 1.2, W1), // skip: $100 + $100 > $100 per token
      row(300, "buy", B, 2.0, W1), // buy 50 B for $100
      row(400, "buy", C, 1.0, W1), // skip: 2 positions open
      row(500, "sell", A, 1.1, W1), // a sell: not this bot's trigger (side buy, no followed_sells)
    ];
    const candles: Record<string, Candle[]> = {
      [A]: pad([bar(0, 1, 1.05, 0.95, 1), bar(1, 1, 1.3, 0.98, 1.25), bar(2, 1.25, 1.6, 1.2, 1.55)]), // TP 1.5 inside bar 2 → +$50
      [B]: pad([bar(1, 2, 2.1, 1.9, 2), bar(2, 2, 2.05, 1.7, 1.8), bar(3, 1.7, 1.75, 1.5, 1.55)]), // SL 1.6 inside bar 3 → −$20
    };
    const asked: [string, string, number][] = [];
    const bt = await backtestStrategy({
      name: "copy W1", trigger: { type: "wallet_trade", wallets: { list: [W1] }, side: "buy" }, action: { type: "buy", usd: 100 },
      exits: { takeProfitPct: 50, stopLossPct: 20 }, limits: { maxOpenPositions: 2, maxPerTokenUsd: 100, dailyBudgetUsd: 1000, cooldownMin: 0 },
    }, 1, deps({ walletPage: page(rows), candles: async (m, tf, limit) => { asked.push([m, tf, limit]); return candles[m] ?? []; } }));
    expect(bt).toMatchObject({ strategy: "copy W1", trigger: "wallet_trade", signals: 4, alerts: 0, days: 1, wallets: [W1], usdPerTrade: 100,
      trades: 4, buys: 2, sells: 2, skipped: 2, investedUsd: 200, realizedUsd: 30, unrealizedUsd: 0, winRate: 0.5, maxDrawdownUsd: 20 });
    expect(asked).toEqual([[A, "5m", 290], [B, "5m", 290]]);
    expect(bt.equity.map((e) => e.usd)).toEqual([0, 0, 0, 25, 25, 50, 40, 30, 30]);
    expect(bt.equity[0].ts).toBe(CUT);
    expect(bt.equity.at(-1)!.ts).toBe(NOW);
    expect(bt.fills.map((f) => `${f.side}:${f.status}:${f.mint === A ? "A" : f.mint === B ? "B" : "C"}`)).toEqual(["buy:filled:A", "buy:skipped:A", "buy:filled:B", "buy:skipped:C", "sell:filled:A", "sell:filled:B"]);
    expect(bt.fills.filter((f) => f.status === "skipped").map((f) => f.reason)).toEqual(["max per token: another $100 would pass the $100 cap", "max open positions: 2 already open"]);
    expect(bt.fills[4]).toMatchObject({ ts: CUT + 3 * STEP, usd: 150, tokenAmount: 100, priceUsd: 1.5, pnlUsd: 50, reason: "take profit +50 %", source: { wallet: "exit" } });
    expect(bt.fills[5]).toMatchObject({ ts: CUT + 4 * STEP, usd: 80, priceUsd: 1.6, pnlUsd: -20, reason: "stop loss −20 %" });
    expect(bt.notes.join(" ")).toMatch(/fill at the followed wallet's own trade price/);
  });

  it("a token with few candles is walked on its tape trades too (a launch that died after the buy)", async () => {
    const rows = [row(600, "buy", A, 1.0, W1)];
    const asked: string[] = [];
    const bt = await backtestStrategy({ name: "x", trigger: { type: "wallet_trade", wallets: { list: [W1] } }, action: { type: "buy", usd: 100 }, exits: { stopLossPct: 30 } }, 1, deps({
      walletPage: page(rows),
      candles: async () => [bar(1, 1, 1.2, 0.9, 1.1)], // one candle, before the buy: not this position's
      tokenTrades: async (m) => { asked.push(m); return [row(900, "sell", A, 0.6, W2), row(700, "sell", A, 0.9, W2), row(650, "buy", A, 1.05, W3)]; },
    }));
    expect(asked).toEqual([A]);
    // 1.05 and 0.9 hold above the 0.7 stop; 0.6 gaps through it: sold at 0.6 → −$40
    expect(bt.fills.map((f) => [f.side, f.ts, f.priceUsd, f.pnlUsd, f.reason])).toEqual([["buy", CUT + 600_000, 1, null, null], ["sell", CUT + 900_000, 0.6, -40, "stop loss −30 %"]]);
    expect(bt.notes.join(" ")).toMatch(/1 token had fewer than 12 candles on Chord: its exits were walked on the tape's trade prices too/);
  });

  it("confluence of smart traders: smartBuyers1h from the replay, followed_sells, tape prices when there are no candles", async () => {
    const rows = [
      row(60, "buy", A, 1.0, W1), row(120, "buy", A, 1.1, W2), // hit: 2 smart wallets → buy A $50 at 1.1
      row(180, "buy", A, 1.2, W3), // same window: no second hit
      row(600, "sell", A, 1.65, W1), // a followed wallet sells A → sold at 1.65: +$25
      row(700, "buy", B, 2, W1), row(800, "buy", B, 2, W3), // hit → buy B $50 at 2
      row(900, "sell", B, 0.9, W2), // B's next price 0.9 hits the 50 % stop first: −$27.50
      row(1000, "buy", C, 5, W2), row(1100, "buy", C, 5, W3), // hit → buy C $50 at 5, held, marked at Jupiter's 6: +$10
    ];
    const bt = await backtestStrategy({
      name: "crowd", trigger: { type: "confluence", wallets: { smartTraders: { top: 3, days: 1 } }, minWallets: 2, windowMin: 10, side: "buy" },
      filters: [{ field: "smartBuyers1h", op: ">=", value: 2 }, { field: "liquidityUsd", op: ">=", value: 1000 }],
      action: { type: "buy", usd: 50 }, exits: { sellWhen: "followed_sells", stopLossPct: 50 }, limits: { dailyBudgetUsd: 500 },
    }, 1, deps({ walletPage: page(rows), resolveWallets: async () => [W1, W2, W3], prices: async (m) => new Map(m.filter((x) => x === C).map((x) => [x, 6])) }));
    expect(bt).toMatchObject({ signals: 3, buys: 3, sells: 2, skipped: 0, investedUsd: 150, realizedUsd: -2.5, unrealizedUsd: 10, winRate: 0.5, maxDrawdownUsd: 27.5, wallets: [W1, W2, W3] });
    expect(bt.equity.map((e) => e.usd)).toEqual([0, 0, 0, 4.55, 25, 25, 25, 25, -2.5, -2.5, -2.5, 7.5]);
    expect(bt.fills.filter((f) => f.side === "sell").map((f) => [f.mint === A ? "A" : "B", f.usd, f.pnlUsd, f.reason])).toEqual([["A", 75, 25, `followed wallet ${W1.slice(0, 4)}…${W1.slice(-4)} sold`], ["B", 22.5, -27.5, "stop loss −50 %"]]);
    expect(bt.fills.find((f) => f.side === "sell" && f.mint === A)!.source.wallet).toBe(W1);
    const notes = bt.notes.join(" ");
    expect(notes).toMatch(/Not applied \(they need live data\): liquidity\./);
    expect(notes).toMatch(/The smart-traders board is today's/);
    expect(notes).toMatch(/1 open position marked at Jupiter's current price \(1\)/);
  });

  it("smartBuyers1h filter says no when fewer smart wallets bought in the hour", async () => {
    const rows = [row(60, "buy", A, 1, W1), row(120, "buy", A, 1, W2)];
    const bt = await backtestStrategy({
      name: "x", trigger: { type: "wallet_trade", wallets: { smartTraders: { top: 2, days: 1 } }, side: "buy" },
      filters: [{ field: "smartBuyers1h", op: ">=", value: 2 }], action: { type: "buy", usd: 10 },
    }, 1, deps({ walletPage: page(rows), resolveWallets: async () => [W1, W2] }));
    expect(bt.fills.map((f) => [f.status, f.reason])).toEqual([["skipped", "filter smartBuyers1h: smart traders buying in the last hour 1"], ["filled", null]]);
  });

  it("schedule: one buy per interval at the candle close", async () => {
    const candles = Array.from({ length: 288 }, (_, k) => flat(k, 1 + 0.001 * k));
    const bt = await backtestStrategy({ name: "dca", trigger: { type: "schedule", every: "4h", mint: A }, action: { type: "buy", usd: 10 }, limits: { maxPerTokenUsd: 1000 } },
      1, deps({ candles: async () => candles, prices: async () => new Map([[A, 1.3]]) }));
    const px = [1, 1.047, 1.095, 1.143, 1.191, 1.239, 1.287]; // 08:05 (first bar's close), then every 4 h until now
    expect(bt.fills.map((f) => f.priceUsd)).toEqual(px);
    expect(bt.fills.map((f) => f.ts)).toEqual([CUT + STEP, ...[4, 8, 12, 16, 20, 24].map((h) => CUT + h * 3600_000)]);
    const qty = px.reduce((a, p) => a + 10 / p, 0);
    expect(bt).toMatchObject({ buys: 7, sells: 0, investedUsd: 70, realizedUsd: 0, winRate: null });
    expect(bt.unrealizedUsd).toBe(Math.round((qty * 1.3 - 70) * 100) / 100);
  });

  it("price change_pct on candles: fires on the way in, re-arms, trailing stop exit", async () => {
    // $1 flat, +20 % at bar 100, −12.5 % at bar 150, +42.9 % at bar 200
    const candles = Array.from({ length: 288 }, (_, k) => flat(k, k < 100 ? 1 : k < 150 ? 1.2 : k < 200 ? 1.05 : 1.5));
    const bt = await backtestStrategy({ name: "mom", trigger: { type: "price", mint: B, op: "change_pct", value: 15, windowMin: 60 }, action: { type: "buy", usd: 10 }, exits: { trailingPct: 10 } },
      1, deps({ candles: async () => candles }));
    expect(bt.signals).toBe(2);
    expect(bt.fills.map((f) => [f.side, f.ts, f.priceUsd, f.pnlUsd])).toEqual([
      ["buy", CUT + 101 * STEP, 1.2, null], ["sell", CUT + 151 * STEP, 1.05, -1.25], ["buy", CUT + 201 * STEP, 1.5, null],
    ]);
    expect(bt.fills[1].reason).toBe("trailing stop 10 %");
    expect(bt).toMatchObject({ buys: 2, sells: 1, realizedUsd: -1.25, unrealizedUsd: 0, winRate: 0 });
    expect(bt.notes.join(" ")).toMatch(/1 open position marked at the last price seen \(1\)/);
  });

  it("new_token graduations from the board, ageMin from the history, other filters noted", async () => {
    const boardRows = [
      { mint: X, symbol: "XXX", name: null, priceUsd: 1, liquidityUsd: 1, marketCapUsd: 1, volume24hUsd: 9000, dex: "pumpfun", pool: POOL, firstSeen: S + 3600, change24hPct: null },
      { mint: Y, symbol: "YYY", name: null, priceUsd: 1, liquidityUsd: 1, marketCapUsd: 1, volume24hUsd: 9000, dex: "pumpswap", pool: POOL, firstSeen: S + 2 * 3600, change24hPct: null },
      { mint: C, symbol: "CCC", name: null, priceUsd: 1, liquidityUsd: 1, marketCapUsd: 1, volume24hUsd: 9000, dex: "pumpswap", pool: POOL, firstSeen: S - 3600, change24hPct: null }, // older than the window
    ];
    const view: TokenView = { mint: Y, symbol: "YYY", priceUsd: 1, change1hPct: null, change24hPct: null, marketCapUsd: 1, liquidityUsd: 1, volume24hUsd: 1, firstSeen: S + 2 * 3600, pools: [
      { pool: addr(1301), dex: "pumpfun", liquidityUsd: 0, volumeUsd: 1, firstSeen: S + 2 * 3600, lastTrade: S + 3 * 3600 },
      { pool: POOL, dex: "pumpswap", liquidityUsd: 40_000, volumeUsd: 1, firstSeen: S + 3 * 3600, lastTrade: S + 5 * 3600 },
    ] };
    const yCandles = Array.from({ length: 30 }, (_, i) => flat(36 + i, 36 + i >= 48 ? 0.0025 : 0.001));
    const strategy = (maxAge: number) => ({ name: "grad", trigger: { type: "new_token", source: "graduation" },
      filters: [{ field: "ageMin", op: "<=", value: maxAge }, { field: "holders", op: ">=", value: 150 }], action: { type: "buy", usd: 10 }, exits: { takeProfitPct: 100 } });
    const d = deps({ board: async () => boardRows as any, tokenView: async (m) => (m === Y ? view : null), candles: async (m) => (m === Y ? yCandles : []) });
    const bt = await backtestStrategy(strategy(90), 1, d);
    expect(bt.fills.map((f) => [f.side, f.mint === Y, f.ts, f.priceUsd, f.pnlUsd])).toEqual([["buy", true, CUT + 3 * 3600_000, 0.001, null], ["sell", true, CUT + 49 * STEP, 0.0025, 15]]);
    expect(bt.notes.join(" ")).toMatch(/Not applied \(they need live data\): holders\./);
    expect(bt.notes.join(" ")).toMatch(/new-token board holds the tokens first seen in the last 24 h/);
    const young = await backtestStrategy(strategy(30), 1, d);
    expect(young.fills.map((f) => [f.status, f.reason])).toEqual([["skipped", "filter ageMin: age 1 h"]]);
    const any = await backtestStrategy({ ...strategy(90), trigger: { type: "new_token", source: "any" }, filters: [], action: { type: "alert" } }, 3, d);
    expect(any.alerts).toBe(4); // over 3 days: X, Y and C launched, Y graduated
    expect(any.notes.join(" ")).toMatch(/Only the last 24 h of the 3 days could be replayed/);
  });

  it("lp_event exodus as alerts: counted from the LP tape, coverage noted", async () => {
    const h0 = Math.floor(S / 3600) * 3600 + 3600;
    const bt = await backtestStrategy({ name: "guard", trigger: { type: "lp_event", pools: [POOL], event: "exodus", minUsd: 5000 }, action: { type: "alert" } }, 1, deps({
      lpPool: async () => ({ pool: POOL, token: A, symbol: "AAA", since: S - 100, hourly: [
        { hour: h0, depositsUsd: 1000, withdrawalsUsd: 9000 }, // exodus
        { hour: h0 + 3600, depositsUsd: 1000, withdrawalsUsd: 1500 }, // not: under 2 × deposits
        { hour: h0 + 7200, depositsUsd: 0, withdrawalsUsd: 4000 }, // not: under minUsd
        { hour: h0 + 10800, depositsUsd: 2000, withdrawalsUsd: 50_000 }, // exodus
      ] }),
    }));
    expect(bt).toMatchObject({ trigger: "lp_event", signals: 2, alerts: 2, trades: 0, investedUsd: 0 });
    expect(bt.notes.join(" ")).toMatch(/Would have alerted 2 times \(first: /);
    expect(bt.notes.join(" ")).toMatch(/Chord's LP tape starts at /);
    const held = await backtestStrategy({ name: "g", trigger: { type: "lp_event", event: "exodus" }, action: { type: "alert" } }, 1, deps({}));
    expect(held.notes.join(" ")).toMatch(/watches the tokens the bot holds; a backtest starts holding nothing/);
  });

  it("refuses bad input and fails loudly when no wallet can be read", async () => {
    await expect(backtestStrategy({ trigger: { type: "nope" }, action: { type: "alert" } }, 1)).rejects.toThrow(/Trigger › type/);
    await expect(backtestStrategy({ trigger: { type: "new_token" }, action: { type: "alert" } }, 5)).rejects.toThrow(/days: must be 1, 3 or 7/);
    await expect(backtestStrategy({ trigger: { type: "wallet_trade", wallets: { list: [W1] } }, action: { type: "buy", usd: 5 } }, 1,
      deps({ walletPage: async () => { throw new Error("Chord's tape answered 503"); } }))).rejects.toThrow(/could not be read for any followed wallet/);
  });
});

describe("wallet reads", () => {
  it("at most 4 at a time, a failed wallet is read once more, one still failing is named and counted out", async () => {
    let live = 0, peak = 0;
    const tries = new Map<string, number>();
    const ws = [W1, W2, W3, ...[1, 2, 3, 4, 5].map((i) => addr(1200 + i))];
    const walletPage: StrategyBacktestDeps["walletPage"] = async (w) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      const n = (tries.get(w) ?? 0) + 1; tries.set(w, n);
      if (w === W1 && n === 1) throw new Error("Chord's tape answered 503");
      if (w === W2) throw new Error("Chord's tape answered 503");
      return [];
    };
    const bt = await backtestStrategy({ name: "x", trigger: { type: "wallet_trade", wallets: { list: ws } }, action: { type: "buy", usd: 10 } }, 1, deps({ walletPage }));
    expect(peak).toBeLessThanOrEqual(4);
    expect(tries.get(W1)).toBe(2);
    expect(bt.walletsRead).toBe(7);
    expect(bt.unreadWallets).toEqual([W2]);
    expect(bt.notes[0]).toMatch(/^Replayed 7 of 8 wallets: 1 could not be read/);
  });
});
