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
