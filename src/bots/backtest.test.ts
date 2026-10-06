import { describe, expect, it } from "bun:test";
import { addr } from "./_testkit";
import { runBacktest, type BacktestDeps } from "./backtest";
import type { TapeRow } from "./tape";

const W1 = addr(51), W2 = addr(52);
const [A, B, C, D, E, F, G] = [61, 62, 63, 64, 65, 66, 67].map(addr);
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW_MS = 1_800_000_000_000;
const CUT = NOW_MS / 1000 - 3 * 86_400; // days = 3

const r = (dt: number, side: "buy" | "sell", token: string, priceUsd: number | null, tx = `t${dt}`): TapeRow =>
  ({ ts: CUT + dt, side, token, symbol: token.slice(0, 3), usd: null, priceUsd, tokenAmount: 1, tx });

/** The box's semantics: newest first, `before` strict, at most `limit` rows. */
function box(byWallet: Record<string, TapeRow[]>): BacktestDeps["page"] {
  return async (w, limit, before) => (byWallet[w] ?? []).filter((x) => before == null || x.ts < before).sort((a, b) => b.ts - a.ts).slice(0, limit);
}

describe("backtest", () => {
  it("replays a canned day with the bot's rules (numbers checked by hand)", async () => {
    const rows = [
      r(-50, "buy", G, 1), // before the window: not replayed
      r(100, "buy", A, 1), // fill: 100 A for $100
      r(200, "buy", A, 2), // fill: +50 A → 150 A, cost $200
      r(300, "buy", A, 2.5), // skip: $200 + $100 > $200 per-token cap (marks A at 2.5 → equity 175)
      r(400, "buy", B, 0.5), // fill: 200 B for $100 (2 open)
      r(500, "buy", C, 1), // skip: 2 positions open
      r(600, "sell", A, 1.6), // sell 150 A for $240: +$40
      r(700, "sell", B, 0.4), // sell 200 B for $80: -$20
      r(800, "buy", D, 10), // fill: 10 D for $100
      r(850, "buy", USDC, 1), // a USDC "token" row: ignored
      r(900, "buy", E, null), // skip: no USD price
      r(1000, "sell", F, 3), // never held: ignored
    ];
    const bt = await runBacktest({ params: { wallets: [W1], usdPerTrade: 100, maxPerTokenUsd: 200, maxOpenPositions: 2 }, days: 3 }, {
      page: box({ [W1]: rows }), prices: async (m) => new Map(m.filter((x) => x === D).map((x) => [x, 12])), now: () => NOW_MS,
    });
    expect(bt).toMatchObject({ days: 3, wallets: [W1], usdPerTrade: 100, trades: 6, buys: 4, sells: 2, skipped: 3, investedUsd: 400, realizedUsd: 20, unrealizedUsd: 20, winRate: 0.5, maxDrawdownUsd: 155 });
    expect(bt.equity.map((e) => e.usd)).toEqual([0, 0, 100, 175, 175, 40, 20, 20, 40]);
    expect(bt.equity[0].ts).toBe(CUT * 1000);
    expect(bt.equity.at(-1)!.ts).toBe(NOW_MS);
    expect(bt.fills.map((f) => `${f.side}:${f.status}`)).toEqual(["buy:filled", "buy:filled", "buy:skipped", "buy:filled", "buy:skipped", "sell:filled", "sell:filled", "buy:filled", "buy:skipped"]);
    expect(bt.fills[5]).toMatchObject({ mint: A, usd: 240, tokenAmount: 150, priceUsd: 1.6, pnlUsd: 40, source: { wallet: W1, via: "tape", ts: (CUT + 600) * 1000 } });
    expect(bt.fills.filter((f) => f.status === "skipped").map((f) => f.reason)).toEqual([
      "max per token: another $100 would pass the $200 cap", "max open positions: 2 already open", "the tape has no USD price for this buy",
    ]);
    expect(bt.notes.join(" ")).toMatch(/Safety \(mint \/ freeze authority\), minimum liquidity and the daily loss stop need live data/);
    expect(bt.notes.join(" ")).toMatch(/1 open position marked at Jupiter's current price \(1\)/);
  });

  it("pages through the tape (a page boundary inside one second loses nothing) and notes empty wallets", async () => {
    // 205 buys of distinct tokens; the oldest 10 share one second, which straddles the 200-row page boundary.
    const rows = Array.from({ length: 205 }, (_, i) => r(i < 10 ? 500 : 1000 + i, "buy", addr(100 + i), 1, `p${i}`));
    const calls: (number | null)[] = [];
    const page = box({ [W1]: rows });
    const bt = await runBacktest({ params: { wallets: [W1, W2], usdPerTrade: 1, maxOpenPositions: 50 }, days: 3 }, {
      page: async (w, l, b) => { if (w === W1) calls.push(b); return page(w, l, b); }, prices: async () => new Map(), now: () => NOW_MS,
    });
    expect(bt.buys + bt.skipped).toBe(205);
    expect(bt.buys).toBe(50);
    expect(calls).toEqual([null, CUT + 501]);
    expect(bt.notes.some((n) => n.includes(`${W2.slice(0, 4)}…${W2.slice(-4)}: no swaps on the tape in the last 3 days`))).toBe(true);
    expect(bt.notes.join(" ")).toMatch(/50 open positions marked at the last tape price \(50\)/);
  });

  it("caps a wallet at its newest 2,000 swaps and says so; refuses bad params", async () => {
    const rows = Array.from({ length: 2300 }, (_, i) => r(10 + i, "sell", F, 1, `c${i}`));
    const bt = await runBacktest({ params: { wallets: [W1], usdPerTrade: 10 }, days: 3 }, { page: box({ [W1]: rows }), prices: async () => new Map(), now: () => NOW_MS });
    expect(bt.trades).toBe(0);
    expect(bt.notes.join(" ")).toMatch(/only its newest 2,000 swaps were replayed/);
    await expect(runBacktest({ params: { wallets: ["nope"], usdPerTrade: 10 }, days: 3 })).rejects.toThrow(/not a Solana wallet/);
    await expect(runBacktest({ params: { wallets: [W1], usdPerTrade: 10 }, days: 5 })).rejects.toThrow(/days must be 1, 3 or 7/);
  });

  it("fails loudly when no wallet can be read", async () => {
    await expect(runBacktest({ params: { wallets: [W1], usdPerTrade: 10 }, days: 1 }, { page: async () => { throw new Error("Chord's tape answered 503"); }, now: () => NOW_MS }))
      .rejects.toThrow(/could not be read for any followed wallet/);
  });
});
