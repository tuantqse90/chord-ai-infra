import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { addr, useTempDb } from "../src/bots/_testkit";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("../src/bots");
const { _agentsTest } = await import("../src/agentsApi");
const { market, scoreOf, capitalOf, _marketTest } = await import("../src/market");
const { _closeTrustDb } = await import("../src/trust/registry");
beforeAll(() => { E._resetBots(); _agentsTest.reset(); _marketTest.reset(); _closeTrustDb(); tmp = useTempDb("market"); });
afterAll(() => { _marketTest.reset(); _agentsTest.reset(); _closeTrustDb(); E._resetBots(); tmp.restore(); });

const W = addr(41);
const post = (body: unknown, session?: string) => market.request("/listings", { method: "POST", headers: { "content-type": "application/json", ...(session ? { "x-session": session } : {}) }, body: JSON.stringify(body) });

describe("market score", () => {
  it("evidence scales everything; missing validation / rating count half; results map ±10 % to 0..1", () => {
    expect(scoreOf({ registered: false, committed: 50, validationAvg: 100, pnl7d: 10, investedUsd: 10, ratingAvg: 100 }).total).toBe(0);
    expect(scoreOf({ registered: true, committed: 20, validationAvg: 100, pnl7d: 10, investedUsd: 100, ratingAvg: 100 })).toEqual({ total: 100, evidence: 1, validation: 1, results: 1, rating: 1 });
    expect(scoreOf({ registered: true, committed: 10, validationAvg: null, pnl7d: 0, investedUsd: 0, ratingAvg: null })).toEqual({ total: 25, evidence: 0.5, validation: 0.5, results: 0.5, rating: 0.5 });
    expect(scoreOf({ registered: true, committed: 40, validationAvg: 80, pnl7d: -20, investedUsd: 100, ratingAvg: null }).total).toBe(Math.round(100 * (0.4 * 0.8 + 0 + 0.2 * 0.5)));
  });
});

describe("market capital", () => {
  const st = (investedUsd: number) => ({ trades: 2, buys: 1, sells: 1, skipped: 0, investedUsd, realizedUsd: 0, unrealizedUsd: 0, openPositions: 1, winRate: null, lastEventAt: null });
  it("a classic agent that reversed once is measured on its size, not on both entries; LP on its deposit; others on what they bought", () => {
    expect(capitalOf({ type: "classic", params: { sizeUsd: 2000, leverage: 1 }, stats: st(4000) } as never)).toBe(2000);
    expect(capitalOf({ type: "classic", params: { sizeUsd: 1000, leverage: 3 }, stats: st(500) } as never)).toBe(1000);
    expect(capitalOf({ type: "lp", params: { amountUsd: 2000 }, stats: st(2000) } as never)).toBe(2000);
    expect(capitalOf({ type: "custom", params: { strategy: {} }, stats: st(30) } as never)).toBe(30);
    expect(capitalOf({ type: "classic", params: {}, stats: st(700) } as never)).toBe(700);
  });
});

describe("/v1/market", () => {
  it("lists only your own trading agents, edits keep the listing date, mine marks yours, unlist removes it", async () => {
    const a = E.createBot("owner-mkt-1", { name: "Whale mirror", type: "copy", params: { wallets: [W], usdPerTrade: 15 } });
    const alert = E.createBot("owner-mkt-1", { name: "Watcher", type: "alert", params: { wallets: [W] } });
    const pitch = "Copies one Monad whale with $15 a trade and mirrors its sells.";
    expect((await post({ botId: a.id, pitch })).status).toBe(401);
    expect((await post({ botId: a.id, pitch }, "someone-else-1")).status).toBe(404);
    const al = await post({ botId: alert.id, pitch }, "owner-mkt-1");
    expect(al.status).toBe(400);
    expect((await al.json()).message).toContain("Only trading agents");
    expect((await post({ botId: a.id, pitch: "short" }, "owner-mkt-1")).status).toBe(400);
    const r = await post({ botId: a.id, pitch: `  ${pitch}\n` }, "owner-mkt-1");
    expect(r.status).toBe(201);
    const first = await r.json();
    expect(first).toMatchObject({ botId: a.id, title: "Whale mirror", pitch });
    const again = await (await post({ botId: a.id, title: "Whale mirror v2", pitch }, "owner-mkt-1")).json();
    expect(again.listedAt).toBe(first.listedAt);
    const pub = await (await market.request("/")).json();
    expect(pub.listings).toHaveLength(1);
    expect(pub.listings[0]).toMatchObject({ rank: 1, botId: a.id, title: "Whale mirror v2", agent: { name: "Whale mirror", type: "copy" }, record: { agentId: null, committed: 0 }, score: { total: 0 } });
    expect(pub.listings[0]).not.toHaveProperty("owner");
    expect(pub.listings[0]).not.toHaveProperty("mine");
    expect(pub.scoring).toContain("evidence");
    const mine = await (await market.request("/", { headers: { "x-session": "owner-mkt-1" } })).json();
    expect(mine.listings[0].mine).toBe(true);
    expect((await market.request(`/listings/${a.id}`, { method: "DELETE", headers: { "x-session": "someone-else-1" } })).status).toBe(404);
    expect((await market.request(`/listings/${a.id}`, { method: "DELETE", headers: { "x-session": "owner-mkt-1" } })).status).toBe(204);
    expect((await (await market.request("/")).json()).listings).toHaveLength(0);
  });
  it("sort=new puts the latest first, ranks follow the sort, a deleted agent leaves the market", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const b = E.createBot("owner-mkt-2", { name: `Agent ${i}`, type: "copy", params: { wallets: [addr(50 + i)], usdPerTrade: 10 } });
      expect((await post({ botId: b.id, pitch: `Copies wallet number ${i} on Monad.` }, "owner-mkt-2")).status).toBe(201);
      ids.push(b.id);
      await Bun.sleep(2);
    }
    const byNew = await (await market.request("/?sort=new")).json();
    expect(byNew.sort).toBe("new");
    expect(byNew.listings.map((l: any) => l.botId)).toEqual([...ids].reverse());
    expect(byNew.listings.map((l: any) => l.rank)).toEqual([1, 2, 3]);
    expect((await (await market.request("/?sort=bogus")).json()).sort).toBe("score");
    E.deleteBot("owner-mkt-2", ids[0]);
    _marketTest.reset();
    expect((await (await market.request("/")).json()).listings.map((l: any) => l.botId).sort()).toEqual([ids[1], ids[2]].sort());
  });
});
