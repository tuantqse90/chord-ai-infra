import { describe, expect, it } from "bun:test";
import { listTemplates } from "../src/strategy";
import { headlineOf, strategies, templatesWithHeadline, _strategyRoutesTest as T } from "../src/strategyRoutes";

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  strategies.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("/v1/strategies", () => {
  it("templates carry their explanation; validate fills defaults or names the block", async () => {
    const { templates } = await (await strategies.request("/templates")).json();
    expect(templates.length).toBe(listTemplates().length);
    expect(templates[0].explanation[0]).toMatch(/^Trigger: /);
    const ok = await post("/validate", { strategy: templates[0].strategy });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
    const bad = await post("/validate", { strategy: { ...templates[0].strategy, action: { type: "buy", usd: "lots" } } });
    expect(bad.status).toBe(422);
    const j = await bad.json();
    expect(j.ok).toBe(false);
    expect(j.errors.join(" ")).toMatch(/Action/);
  });
  it("compile: an empty description is a 400 with the reason; the per-caller budget answers 429", async () => {
    const r = await post("/compile", { text: "  " }, { "x-session": "sess-empty-1" });
    expect(r.status).toBe(400);
    expect((await r.json()).errors[0]).toMatch(/Describe the bot/);
    T.hits.set("sess-flood-1", Array.from({ length: 12 }, () => Date.now()));
    expect((await post("/compile", { text: "buy dips" }, { "x-session": "sess-flood-1" })).status).toBe(429);
  });
  it("backtest: days other than 1, 3, 7 are refused with the block name", async () => {
    const t = listTemplates()[0];
    const r = await post("/backtest", { strategy: t.strategy, days: 5 });
    expect(r.status).toBe(400);
    expect((await r.json()).errors[0]).toMatch(/days/);
  });
  it("headlines: computed per template (a failing one stays null) and joined with the running count", async () => {
    const ids = listTemplates().map((t) => t.id);
    let n = 0;
    await T.refreshHeadlines((async () => {
      if (n++ === 1) throw new Error("tape down");
      return { days: 3, realizedUsd: 10, unrealizedUsd: 2.345, investedUsd: 60, trades: 4, winRate: 0.5, signals: 9 } as any;
    }) as any);
    const rows = templatesWithHeadline((id) => (id === ids[0] ? 7 : 0));
    expect(rows[0]).toMatchObject({ running: 7, headline: { days: 3, pnlUsd: 12.35, investedUsd: 60, trades: 4, winRate: 0.5, signals: 9 } });
    expect(rows[1].headline).toBeNull();
    expect(headlineOf({ days: 1, realizedUsd: -1, unrealizedUsd: 0, investedUsd: 0, trades: 0, winRate: null, signals: 0 } as any, 5).pnlUsd).toBe(-1);
  });
});

describe("template headlines survive a bad replay", () => {
  it("a replay that could not read its wallets never replaces a clean one", async () => {
    const good = { days: 3, realizedUsd: 30, unrealizedUsd: 0, investedUsd: 100, trades: 6, winRate: 0.5, signals: 8, notes: [] };
    const bad = { ...good, realizedUsd: 0, trades: 0, signals: 0, unreadWallets: ["W1"], notes: ["Wallet W1: the tape could not be read (timed out)"] };
    await T.refreshHeadlines((async () => good) as any);
    await T.refreshHeadlines((async () => bad) as any);
    expect(templatesWithHeadline()[0].headline).toMatchObject({ trades: 6, pnlUsd: 30 });
  });
});
