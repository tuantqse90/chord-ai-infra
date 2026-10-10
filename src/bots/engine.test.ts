import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetChordApi } from "../chord/services/chordApi";
import { addr, useTempDb } from "./_testkit";
import { prices, setBotsFetch, tokenInfo, _resetMarket } from "./market";
import { feedStatus, toSource, walletTrades, _resetTape } from "./tape";
import { setMonadFetch } from "../monad/chord";

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

describe("Chord's Monad reads", () => {
  const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603", WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
  const A = addr(81), B = addr(82);
  const calls: string[] = [];
  beforeEach(() => { calls.length = 0; _resetMarket(); _resetTape(); process.env.CHORD_API = "https://chord.test"; process.env.CHORD_API_KEY = "nt_live_test"; });
  afterAll(() => { setMonadFetch(null); delete process.env.CHORD_API; delete process.env.CHORD_API_KEY; _resetTape(); });

  it("smartTraders maps Chord's Monad board (Smart Score, realized PnL, top token; no ROI / hold on the board)", async () => {
    setMonadFetch(async (u) => { calls.push(String(u)); return Response.json({ wallets: [{ wallet: W1.toUpperCase().replace("0X", "0x"), smartScore: 41.2, realizedUsd: 65, winRate: 0.66, trades: 147, tokensTraded: 3, volumeUsd: 40930, lastActiveTs: 1_800_000_000, topToken: { symbol: "WETH", pnlUsd: 33 } }] }); });
    const t = await E.smartTraders(1, 5);
    expect(calls[0]).toBe("https://chord.test/v1/smart-money/top?source=onchain&window=24h&limit=100");
    expect(t).toEqual([{ wallet: W1, score: 41.2, realizedPnlUsd: 65, roi: null, winRate: 0.66, trades: 147, tokens: 3, volumeUsd: 40930, medianHoldS: null, lastTrade: 1_800_000_000_000, bestToken: { mint: null, symbol: "WETH", image: null, realizedPnlUsd: 33 } }]);
    await E.smartTraders(7, 5);
    expect(calls[1]).toContain("window=7d");
  });

  it("one shared feed of Chord's large-trade list: paged back to what it holds, a wallet's trades are a filter, quote tokens never become source trades", async () => {
    const page1 = [{ wallet: W1, token: A, symbol: "AAA", side: "buy", usd: 120, tokenAmt: 60, ts: 1_800_000_100, dex: "uniswap_v3", tx: "0xT1" }, { wallet: W2, token: USDC, symbol: "USDC", side: "sell", usd: 80, tokenAmt: 80, ts: 1_800_000_090, dex: "kuru", tx: "0xT2" }];
    const page2 = [{ wallet: W1, token: B, symbol: "BBB", side: "sell", usd: 70, tokenAmt: 7, ts: 1_800_000_050, dex: "hanji", tx: "0xT3" }];
    setMonadFetch(async (u) => { calls.push(String(u)); const page = Number(new URL(String(u)).searchParams.get("page")); return Response.json({ trades: page === 1 ? page1 : page === 2 ? page2 : [], hasMore: page < 2 }); });
    const rows = await walletTrades(W1, 10);
    expect(calls.filter((c) => c.includes("/smart-money/whales")).length).toBe(2); // page 2 says hasMore: false
    expect(rows.map((r) => [r.tx, r.token, r.side, r.priceUsd])).toEqual([["0xt1", A, "buy", 2], ["0xt3", B, "sell", 10]]);
    expect(toSource({ ...rows[0]!, wallet: W1 }, W1)).toMatchObject({ wallet: W1, mint: A, ts: 1_800_000_100_000, via: "tape" });
    expect(toSource({ ts: 1, side: "buy", token: USDC, symbol: "USDC", usd: 1, priceUsd: 1, tokenAmount: 1, tx: "0x", wallet: W2 }, W2)).toBeNull();
    expect(feedStatus().rows).toBe(3);
  });

  it("prices: one call to the Monad price map, per-token stats for a token the map lacks; token facts from the list, decimals and tax kept", async () => {
    setMonadFetch(async (u) => {
      calls.push(String(u));
      const p = new URL(String(u)).pathname;
      if (p === "/v1/tokens/market") return Response.json({ market: { [WMON]: { priceUsd: 0.0247 } } });
      if (p === `/v1/tokens/stats/${B}`) return Response.json({ priceUsd: 3.5, liquidityUsd: 90_000 });
      if (p === "/v1/tokens") return Response.json({ tokens: [{ address: A.toUpperCase().replace("0X", "0x"), symbol: "AAA", name: "Token A", decimals: 8, liquidityUsd: 50_000, taxPct: 2, verified: true }] });
      if (p === `/v1/tokens/stats/${A}`) return Response.json({ priceUsd: 1.25, liquidityUsd: 55_000 });
      return new Response("{}", { status: 404 });
    });
    const px = await prices([WMON, B]);
    expect(Object.fromEntries(px)).toEqual({ [WMON]: 0.0247, [B]: 3.5 });
    const n = calls.length;
    await prices([WMON, B]);
    expect(calls.length).toBe(n); // cached 30 s
    const info = await tokenInfo(A);
    expect(info).toMatchObject({ mint: A, symbol: "AAA", decimals: 8, liquidityUsd: 55_000, usdPrice: 1.25, taxPct: 2, verified: true });
  });
});
