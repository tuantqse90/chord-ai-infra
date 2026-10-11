import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { useTempDb } from "../src/bots/_testkit";
import type { Candle } from "../src/classic/data";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("../src/bots");
const S = await import("../src/bots/store");
const { trades } = await import("../src/trust/committer");
const { fillDoc } = await import("../src/trust/canonical");

const H = 3_600_000;
let now = 1_800_000_000_000 - (1_800_000_000_000 % H) + 60_000; // one minute into an hour
let path: number[] = [];
const UP = [...Array(16).fill(100), 101, 102, 103, 104, 105, 106], DOWN = [...Array(16).fill(106), 105, 103, 101, 99, 97, 95];
/** candles ending at the last closed hour, closes from `path` (oldest first) */
const bars = (): Candle[] => { const last = Math.floor(now / H) * H - H; return path.map((c, i) => ({ t: last - (path.length - 1 - i) * H, o: c, h: c + 1, l: c - 1, c, v: 1 })); };
const market = { id: 1, symbol: "BTC", priceDecimals: 1, sizeDecimals: 5, maxLeverage: 15, takerFeeBps: 3.45, makerFeeBps: 0.45, fundingIntervalSec: 2580 };
let fundingEvents: { t: number; rate: number }[] = [];
const quoteCalls: any[] = [];

beforeAll(() => {
  E._resetBots(); tmp = useTempDb("classic-agent");
  E._setBotDeps({
    exec: { now: () => now, quote: async (inMint: string, outMint: string, amount: number) => { quoteCalls.push({ inMint, outMint, amount }); return { amountOut: amount / 2500, route: ["uniswap_v4"], priceImpactPct: 0.01, inSymbol: "USDC", outSymbol: "WETH" } as any; } },
    classic: {
      now: () => now,
      candles: async () => bars(),
      funding: async () => [],
      perplMarket: async (s: string) => (s === "BTC" ? market : null),
      perplBook: async () => ({ bids: [{ price: 99.9, size: 100 }], asks: [{ price: 100.1, size: 100 }], at: now }),
      perplTicker: async () => ({ id: 1, mark: 100, oracle: 100, last: 100, bid: 99.9, ask: 100.1, prev24h: null, at: now }),
      perplFunding: async () => fundingEvents,
    },
  });
});
afterAll(() => { E._resetBots(); tmp.restore(); });
const settle = () => Bun.sleep(30);

describe("classic agents", () => {
  it("validates like a backtest: unknown strategy, spot shorts off, a symbol Monad spot does not trade", () => {
    expect(() => E.createBot("owner-c-0", { type: "classic", params: { strategy: "nope", symbol: "BTC" } })).toThrow('no classic strategy "nope"');
    expect(() => E.createBot("owner-c-0", { type: "classic", params: { strategy: "ema-cross", symbol: "SOL", venue: "monad_spot" } })).toThrow("Monad spot trades");
    expect(() => E.createBot("owner-c-0", { type: "classic", params: { strategy: "ema-cross", symbol: "BTC", bogus: 1 } })).toThrow('unknown field "bogus"');
  });

  it("Perpl perps: opens long at the book's VWAP with the fee, flips to short in two fills, funding moves the cost, PnL realized", async () => {
    path = UP;
    const b = E.createBot("owner-c-1", { type: "classic", params: { strategy: "ema-cross", params: { fast: 3, slow: 10 }, symbol: "btc", tf: "1h", venue: "perpl", sizeUsd: 100, leverage: 2, signalSource: "binance" } });
    expect(b.name).toBe("EMA cross BTC 1h");
    expect(trades(b)).toBe(true);
    await settle();
    let fills = S.fillsOf(b.id).filter((f) => f.status === "filled");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ side: "buy", mint: "perpl:BTC", symbol: "BTC-PERP", priceUsd: 100.1, quote: { provider: "Perpl", route: ["BTC-PERP"] }, source: { via: "strategy" } });
    expect(fills[0].usd).toBeCloseTo(200, 1);
    expect(fills[0].source.detail).toContain("EMA cross on Binance 1h");
    let pos = S.positionOf(b.id, "perpl:BTC")!;
    expect(pos.qty).toBeCloseTo(200 / 100.1, 6);
    expect(pos.costUsd).toBeCloseTo(200 + 200 * 3.45e-4, 4);
    // the committed document carries the perp market as its token
    expect(JSON.parse(fillDoc(fills[0], { botId: b.id, agentId: "1" }, 1)).fill.token).toBe("perpl:BTC");

    // the same bar again: nothing new
    await E._classics().evaluate(b.id);
    expect(S.fillsOf(b.id).filter((f) => f.status === "filled")).toHaveLength(1);

    // next hour the trend turns: close the long (sell, with PnL) and open a short (sell)
    now += H; path = DOWN;
    await E._classics().evaluate(b.id);
    fills = S.fillsOf(b.id).filter((f) => f.status === "filled").sort((x, y) => x.ts - y.ts);
    expect(fills.map((f) => f.side)).toEqual(["buy", "sell", "sell"]);
    const close = fills.find((f) => f.pnlUsd != null)!;
    expect(close.pnlUsd).toBeCloseTo((200 / 100.1) * 99.9 - (200 + 200 * 3.45e-4) - (200 / 100.1) * 99.9 * 3.45e-4, 2);
    pos = S.positionOf(b.id, "perpl:BTC")!;
    expect(pos.qty).toBeLessThan(0);
    expect(pos.costUsd).toBeLessThan(0);
    const st = E.getBot(null, b.id)!.bot.stats;
    expect(st.realizedUsd).toBeCloseTo(close.pnlUsd!, 2);
    expect(st.winRate).toBe(0);

    // funding: a short receives positive funding (its cost goes down, PnL up)
    const before = S.positionOf(b.id, "perpl:BTC")!.costUsd;
    now += 400_000;
    fundingEvents = [{ t: now - 1000, rate: 0.001 }];
    await E._classics().mark();
    const after = S.positionOf(b.id, "perpl:BTC")!;
    expect(after.costUsd).toBeCloseTo(before + after.qty * 100 * 0.001, 6);
    expect(after.priceUsd).toBe(100);
    E.deleteBot("owner-c-1", b.id);
  });

  it("Monad spot: long only through Chord's router (the strategy agents' paper buy)", async () => {
    path = UP;
    const b = E.createBot("owner-c-2", { type: "classic", params: { strategy: "ema-cross", params: { fast: 3, slow: 10 }, symbol: "ETH", tf: "1h", venue: "monad_spot", sizeUsd: 50 } });
    await settle();
    const f = S.fillsOf(b.id).filter((x) => x.status === "filled");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ side: "buy", mint: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242", usd: 50, quote: { provider: "Chord router" } });
    expect(quoteCalls.at(-1)).toMatchObject({ outMint: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242", amount: 50 });
    E.deleteBot("owner-c-2", b.id);
  });

  it("a market Perpl does not list is a skipped fill with the reason, never a fill at a borrowed price", async () => {
    path = UP;
    const b = E.createBot("owner-c-3", { type: "classic", params: { strategy: "ema-cross", params: { fast: 3, slow: 10 }, symbol: "ETH", tf: "1h", venue: "perpl", sizeUsd: 100 } });
    await settle();
    const all = S.fillsOf(b.id);
    expect(all.filter((x) => x.status === "filled")).toHaveLength(0);
    expect(all[0]).toMatchObject({ status: "skipped", reason: "ETH is not listed on Perpl any more" });
    E.deleteBot("owner-c-3", b.id);
  });
});
