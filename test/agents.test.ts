import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { addr, useTempDb } from "../src/bots/_testkit";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("../src/bots");
const { agents, _agentsTest: T } = await import("../src/agentsApi");
beforeAll(() => { E._resetBots(); T.reset(); tmp = useTempDb("agents-api"); });
afterAll(() => { T.reset(); E._resetBots(); tmp.restore(); });

const W = addr(91);
const fill = (o: Partial<any>) => ({ id: "f", botId: "b", ts: 1_000, side: "sell", mint: addr(5), symbol: "X", usd: 10, tokenAmount: 1, priceUsd: 1, status: "filled", reason: null, pnlUsd: null, quote: null, mode: "paper",
  source: { wallet: W, tx: "t", side: "sell", mint: addr(5), symbol: "X", usd: 1234, priceUsd: 1, ts: 0, via: "websocket" }, ...o });

describe("agents board math", () => {
  it("spark = running realized PnL at each close, open PnL last; the window drops older closes", () => {
    const bot: any = { stats: { unrealizedUsd: 2 } };
    const fills: any[] = [fill({ ts: 3, pnlUsd: -1 }), fill({ ts: 1, pnlUsd: 5 }), fill({ ts: 2, side: "buy" }), fill({ ts: 4, status: "skipped", pnlUsd: 9 })];
    expect(T.sparkOf(fills, bot)).toEqual([0, 5, 4, 6]);
    expect(T.windowPnl(fills, bot, 2)).toBe(1);
  });
});

describe("/v1/agents", () => {
  it("stats, board, copy (owner + copies counted, webhook never copied), 401 without a session", async () => {
    const src = E.createBot("owner-src-1", { name: "Whale mirror", type: "copy", params: { wallets: [W], usdPerTrade: 15 } });
    const st = await (await agents.request("/stats")).json();
    expect(st).toMatchObject({ live: 1, agents: 1, trades24h: 0, best: null });
    expect((await agents.request(`/${src.id}/copy`, { method: "POST" })).status).toBe(401);
    const r = await agents.request(`/${src.id}/copy`, { method: "POST", headers: { "x-session": "sess-copier-1" } });
    expect(r.status).toBe(201);
    const copy = await r.json();
    expect(copy).toMatchObject({ name: "Copy of Whale mirror", type: "copy", mode: "paper", params: { wallets: [W], usdPerTrade: 15 } });
    expect(E.listBots("sess-copier-1").map((b) => b.id)).toEqual([copy.id]);
    const board = await (await agents.request("/board?window=7d")).json();
    expect(board.window).toBe("7d");
    const row = board.agents.find((a: any) => a.id === src.id);
    expect(row).toMatchObject({ copies: 1, template: "Copy trader", spark: [0, 0] });
    expect(row).not.toHaveProperty("owner");
    expect((await agents.request("/nope/copy", { method: "POST", headers: { "x-session": "sess-copier-1" } })).status).toBe(404);
    E.deleteBot("sess-copier-1", copy.id);
    const after = (await (await agents.request("/board?window=all")).json()).agents.find((a: any) => a.id === src.id);
    expect(after.copies).toBe(0); // a deleted copy no longer counts
  });
  it("feed: a public agent's fill lands in the backlog with the trigger in words and the reaction time", () => {
    const b = E.leaderboard(10)[0];
    T.syncFeed();
    T.emit(b.id, { type: "fill", fill: fill({ botId: b.id, ts: 3_100, side: "buy", pnlUsd: null, source: { wallet: W, tx: "t", side: "buy", mint: addr(5), symbol: "X", usd: 1234, priceUsd: 1, ts: 1_000, via: "websocket" } }) as any });
    T.emit(b.id, { type: "event", event: { ts: 3, level: "info", msg: "quiet" } });
    expect(T.backlog.length).toBe(1);
    expect(T.backlog[0]).toMatchObject({ kind: "fill", side: "buy", usd: 10, reactionS: 2.1, agent: { id: b.id, type: "copy" } });
    expect(T.backlog[0].trigger).toMatch(/^followed wallet \w{4}…\w{4} bought \$1,234$/);
  });
});

describe("board numbers come from every filled fill, not the last 200 rows", () => {
  it("a profitable close followed by 250 skips still shows on the board and in the hero", async () => {
    const S = await import("../src/bots/store");
    const b = E.createBot("owner-busy-1", { name: "Busy", type: "copy", params: { wallets: [addr(150)], usdPerTrade: 10 } });
    const t0 = Date.now() - 3_600_000;
    const src = (i: number) => ({ wallet: addr(150), tx: `t${i}`, side: "sell" as const, mint: addr(151), symbol: "X", usd: 1, priceUsd: 1, ts: t0 + i, via: "tape" as const });
    S.insertFill({ id: "close-1", botId: b.id, ts: t0, side: "sell", mint: addr(151), symbol: "X", usd: 60, tokenAmount: 1, priceUsd: 60, status: "filled", reason: null, pnlUsd: 50, source: src(0), quote: null, mode: "paper" });
    for (let i = 1; i <= 250; i++) S.insertFill({ id: `skip-${i}`, botId: b.id, ts: t0 + i * 1000, side: "buy", mint: addr(151), symbol: "X", usd: 10, tokenAmount: 0, priceUsd: null, status: "skipped", reason: "liquidity", pnlUsd: null, source: src(i), quote: null, mode: "paper" });
    T.reset();
    const today = (await (await agents.request("/board?window=today")).json()).agents.find((a: any) => a.id === b.id);
    expect(today.pnl).toBe(50);
    expect(today.spark.at(-1)).toBe(50);
    const st = await (await agents.request("/stats")).json();
    expect(st.trades24h).toBeGreaterThanOrEqual(1);
    expect(st.skips24h).toBeGreaterThanOrEqual(250);
  });
});
