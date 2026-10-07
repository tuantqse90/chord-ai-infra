import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetChordApi } from "../chord/services/chordApi";
import { addr, useTempDb } from "./_testkit";
import { prices, setBotsFetch, tokenInfo, _resetMarket } from "./market";
import { walletTrades } from "./tape";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("./index");
beforeAll(() => { E._resetBots(); tmp = useTempDb("bots-engine"); });
afterAll(() => { E._resetBots(); setBotsFetch(null); tmp.restore(); });
beforeEach(() => { E._setBotDeps({ exec: { now: () => 1_800_000_000_000 } }); });

const W1 = addr(71), W2 = addr(72);
const copy = { type: "copy" as const, params: { wallets: [W1], usdPerTrade: 10 } };

describe("limits and modes", () => {
  it("5 bots per owner (409), another owner is not affected", () => {
    for (let i = 0; i < 5; i++) E.createBot("owner-a", { ...copy, name: `b${i}` });
    let err: any;
    try { E.createBot("owner-a", copy); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(E.BotLimitError);
    expect(err).toMatchObject({ name: "BotLimitError", status: 409, code: "too_many_bots" });
    expect(err.message).toMatch(/at most 5 bots per account/);
    expect(E.createBot("owner-b", copy).status).toBe("running");
    expect(E.listBots("owner-a").length).toBe(5);
  });
  it("live mode throws the dedicated error the API maps to 403 live_not_enabled; bad input is a BotInputError", () => {
    let err: any;
    try { E.createBot("owner-c", { ...copy, mode: "live" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(E.BotLiveError);
    expect(err).toMatchObject({ name: "BotLiveError", status: 403, code: "live_not_enabled" });
    expect(() => E.createBot("owner-c", { type: "grid" as any, params: {} })).toThrow(E.BotInputError);
    expect(() => E.createBot("owner-c", { type: "copy", params: { wallets: [W1] } })).toThrow(/usdPerTrade is required/);
    expect(E.listBots("owner-c")).toEqual([]);
  });
  it("200 running bots on the server at most", () => {
    const already = E.leaderboard(200).filter((b) => b.status === "running").length;
    let i = 0;
    for (; already + i < E.MAX_RUNNING; i++) E.createBot(`bulk-${Math.floor(i / 5)}`, copy);
    expect(() => E.createBot("bulk-last", copy)).toThrow(/200 bots are already running/);
    const paused = E.listBots("bulk-0")[0];
    E.setStatus("bulk-0", paused.id, "paused");
    expect(E.createBot("bulk-last", copy).status).toBe("running");
    // resuming over the cap keeps it paused and says why
    expect(E.setStatus("bulk-0", paused.id, "running")!.status).toBe("paused");
    expect(E.getBot("bulk-0", paused.id)!.events[0].msg).toMatch(/Cannot resume right now/);
    for (let o = 0; o <= Math.floor(i / 5); o++) for (const b of E.listBots(`bulk-${o}`)) E.deleteBot(`bulk-${o}`, b.id);
    for (const b of E.listBots("bulk-last")) E.deleteBot("bulk-last", b.id);
    expect(E.leaderboard(500).length).toBe(already);
  });
});

describe("ownership, status, delete, leaderboard", () => {
  it("only the owner reads, steers and deletes; the public view has no webhook", () => {
    const b = E.createBot("owner-d", { type: "alert", params: { wallets: [W2], webhook: "https://hooks.example.com/z" } });
    expect(E.getBot("owner-x", b.id)).toBeNull();
    expect(E.setStatus("owner-x", b.id, "paused")).toBeNull();
    expect(E.deleteBot("owner-x", b.id)).toBe(false);
    expect((E.getBot("owner-d", b.id)!.bot.params as any).webhook).toBe("https://hooks.example.com/z");
    expect((E.getBot(null, b.id)!.bot.params as any).webhook).toBeNull();
    expect(E.getBot("owner-d", b.id)!.bot).not.toHaveProperty("owner");
    expect(E.setStatus("owner-d", b.id, "paused")!.status).toBe("paused");
    expect(E.setStatus("owner-d", b.id, "running")!.status).toBe("running");
    expect(E.getBot("owner-d", b.id)!.events.map((e) => e.msg).slice(0, 2)).toEqual(["Resumed: trades from now on are mirrored.", "Paused."]);
    expect(E.deleteBot("owner-d", b.id)).toBe(true);
    expect(E.getBot(null, b.id)).toBeNull();
  });
  it("leaderboard: copy bots only, by realized + unrealized, no owner", () => {
    const lb = E.leaderboard(500);
    expect(lb.every((b) => b.type === "copy" && !("owner" in b))).toBe(true);
    for (let i = 1; i < lb.length; i++) expect(lb[i - 1].stats.realizedUsd + lb[i - 1].stats.unrealizedUsd).toBeGreaterThanOrEqual(lb[i].stats.realizedUsd + lb[i].stats.unrealizedUsd);
  });
  it("subscribe gets the bot's events, and stops after unsubscribe", () => {
    const b = E.createBot("owner-e", copy);
    const seen: string[] = [];
    const off = E.subscribe(b.id, (e) => seen.push(e.type));
    E.setStatus("owner-e", b.id, "paused");
    off();
    E.setStatus("owner-e", b.id, "running");
    expect(seen).toEqual(["event", "stats"]);
  });
});

describe("Chord and Jupiter reads", () => {
  it("smartTraders maps Chord's board (lastTrade to ms, nulls to 0, best token symbol fallback)", async () => {
    _resetChordApi();
    const realFetch = globalThis.fetch;
    let url = "";
    globalThis.fetch = (async (u: string) => {
      url = String(u);
      return new Response(JSON.stringify({ traders: [
        { wallet: W1, score: 0.9, realizedPnlUsd: 1234.5, roi: null, winRate: 0.7, trades: 40, tokens: 12, volumeUsd: 9000, medianHoldS: null, lastTrade: 1_800_000_000, bestToken: { token: W2, symbol: null, name: "Best", image: "", realizedPnlUsd: 800 } },
        { wallet: W2, score: 0.5, realizedPnlUsd: 10, roi: 0.1, winRate: 0.5, trades: 4, tokens: 2, volumeUsd: 100, medianHoldS: 60, lastTrade: 1_799_999_000, bestToken: null },
      ] }), { status: 200 });
    }) as any;
    try {
      const t = await E.smartTraders(3, 1);
      expect(url).toMatch(/\/v1\/chains\/solana\/smart-traders\?days=3&limit=100$/);
      expect(t).toEqual([{ wallet: W1, score: 0.9, realizedPnlUsd: 1234.5, roi: 0, winRate: 0.7, trades: 40, tokens: 12, volumeUsd: 9000, medianHoldS: 0, lastTrade: 1_800_000_000_000, bestToken: { mint: W2, symbol: "Best", image: null, realizedPnlUsd: 800 } }]);
      await expect(E.smartTraders(2 as any, 5)).rejects.toThrow(/days must be 1, 3 or 7/);
    } finally {
      globalThis.fetch = realFetch;
      _resetChordApi();
    }
  });

  it("the tape is read with Chord's headers and its rows keep the address case", async () => {
    const was = process.env.CHORD_API_KEY;
    process.env.CHORD_API_KEY = "nt_live_test";
    let headers: Record<string, string> = {}, url = "";
    setBotsFetch(async (u, init) => { url = u; headers = init?.headers as Record<string, string>; return new Response(JSON.stringify({ trades: [{ ts: 1, side: "buy", token: W2, symbol: "X", usd: 5, priceUsd: 1, tokenAmount: 5, tx: "abc" }] })); });
    try {
      const rows = await walletTrades(W1, 50, 1234);
      expect(url).toMatch(new RegExp(`/v1/chains/solana/wallet/${W1}/trades\\?limit=50&before=1234$`));
      expect(headers["X-API-Key"]).toBe("nt_live_test");
      expect(rows[0].token).toBe(W2);
    } finally {
      if (was === undefined) delete process.env.CHORD_API_KEY; else process.env.CHORD_API_KEY = was;
      setBotsFetch(null);
    }
  });

  it("prices: one batched Jupiter call for many mints, cached 30 s; token info cached", async () => {
    _resetMarket();
    const calls: string[] = [];
    setBotsFetch(async (u) => {
      calls.push(u);
      if (u.includes("/price/v3")) return new Response(JSON.stringify({ [W1]: { usdPrice: 2 }, [W2]: { usdPrice: 3 } }));
      return new Response(JSON.stringify([{ id: W1, symbol: "AAA", name: "A", decimals: 6, liquidity: 50_000, usdPrice: 2, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false } }]));
    });
    try {
      const m = await prices([W1, W2, addr(99), W1]);
      expect([...m.entries()]).toEqual([[W1, 2], [W2, 3]]);
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatch(/\/price\/v3\?ids=/);
      await prices([W1, W2]);
      expect(calls.length).toBe(1);
      const info = await tokenInfo(W1);
      expect(info).toMatchObject({ symbol: "AAA", liquidityUsd: 50_000, mintAuthorityDisabled: true, freezeAuthorityDisabled: false });
      await tokenInfo(W1);
      expect(calls.length).toBe(2);
    } finally {
      setBotsFetch(null);
      _resetMarket();
    }
  });
});
