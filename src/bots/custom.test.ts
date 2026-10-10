// Custom agents (bot type "custom") through the engine: a followed wallet's trade reaches the strategy runner, which buys
// through the engine's paper fill (the fill's source is the trade, with the trigger's words), and sells on the wallet's sell.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { addr, useTempDb } from "./_testkit";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("./index");
beforeAll(() => { E._resetBots(); tmp = useTempDb("bots-custom"); });
afterAll(() => { E._resetBots(); tmp.restore(); });

let clock = 1_800_000_000_000;
const W = addr(31), MINT = addr(32);
beforeEach(() => {
  E._setBotDeps({ exec: {
    now: () => clock,
    quote: async (inMint, _out, amount) => ({ amountOut: inMint === MINT ? amount * 0.012 : amount * 100, priceImpactPct: 0.1, route: ["Fake"], outSymbol: "TOK", inSymbol: "TOK", feeBps: 5 }),
  } });
});
const strategy = {
  version: 1, name: "Follow W", trigger: { type: "wallet_trade", wallets: { list: [W] }, side: "any" },
  filters: [], action: { type: "buy", usd: 10 }, exits: { sellWhen: "followed_sells" }, limits: { maxOpenPositions: 3, dailyBudgetUsd: 50 },
};
const trade = (side: "buy" | "sell", tx: string, ts: number) => ({ wallet: W, tx, side, mint: MINT, symbol: "TOK", usd: 250, priceUsd: 0.01, ts, via: "tape" as const });

describe("custom agents in the engine", () => {
  it("validates the strategy with block-named errors; a template id is kept; the name comes from the strategy", () => {
    expect(() => E.createBot("own-c1", { type: "custom", params: { strategy: { ...strategy, action: { type: "buy", usd: 0 } } } })).toThrow(/Action/);
    expect(() => E.createBot("own-c1", { type: "custom", params: { strategy, extra: 1 } })).toThrow(/unknown field "extra"/);
    const b = E.createBot("own-c1", { type: "custom", params: { strategy, templateId: "copy-trader" } });
    expect(b).toMatchObject({ type: "custom", name: "Follow W", mode: "paper", status: "running", params: { templateId: "copy-trader" } });
    E.deleteBot("own-c1", b.id);
  });
  it("a bot deleted while its strategy is still starting is not resurrected in the runner", async () => {
    const b = E.createBot("own-c3", { type: "custom", params: { strategy } });
    E.deleteBot("own-c3", b.id);
    await E._drain();
    await new Promise((r) => setTimeout(r, 0));
    expect(E._strategies().has(b.id)).toBe(false);
  });
  it("a followed buy → paper buy with the trade as source; the wallet's sell → sell all with PnL; on the leaderboard", async () => {
    const b = E.createBot("own-c2", { type: "custom", params: { strategy } });
    await E._drain();
    expect(E._strategies().followedWallets()).toContain(W);
    clock += 1_000;
    E._dispatch(trade("buy", "tx-b1", clock - 400));
    await E._drain();
    let d = E.getBot("own-c2", b.id)!;
    const buy = d.fills.find((f) => f.status === "filled" && f.side === "buy")!;
    expect(buy).toMatchObject({ usd: 10, tokenAmount: 1000, source: { wallet: W, tx: "tx-b1", via: "tape" } });
    expect(buy.source.detail).toMatch(/bought/);
    expect(d.positions.map((p) => p.mint)).toEqual([MINT]);
    clock += 1_000;
    E._dispatch(trade("sell", "tx-s1", clock - 300));
    await E._drain();
    d = E.getBot("own-c2", b.id)!;
    const sell = d.fills.find((f) => f.status === "filled" && f.side === "sell")!;
    expect(sell.usd).toBeCloseTo(12, 6);
    expect(sell.pnlUsd).toBeCloseTo(2, 6);
    expect(d.positions).toEqual([]);
    expect(E.leaderboard(50).some((x) => x.id === b.id)).toBe(true);
    E.setStatus("own-c2", b.id, "paused");
    expect(E._strategies().has(b.id)).toBe(false);
    E.setStatus("own-c2", b.id, "running");
    await E._drain();
    expect(E._strategies().has(b.id)).toBe(true);
    E.deleteBot("own-c2", b.id);
    expect(E._strategies().has(b.id)).toBe(false);
  });
});
