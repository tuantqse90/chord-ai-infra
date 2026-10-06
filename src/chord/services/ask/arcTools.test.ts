import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetChordApi } from "../chordApi";
import { _resetRhRollup } from "../rhRollup";
beforeEach(() => { _resetChordApi(); _resetRhRollup(); });
import { ARC_TOOL_META, ARC_TOOL_NAMES, ARC_TOOL_SCHEMAS, analysisForModel, arcToolOffered, isArcNonUser, isArcTool, priceAnalysis, runArcTool, type Candle } from "./arcTools";
import { TOOL_META } from "./registry";
import { mockFetch, type MockFetchHandle } from "../../testkit/helpers";

const PORTED = [
  "chord_facts", "chord_points",
  "arc_overview", "arc_trending", "arc_tokens", "arc_new_launches", "arc_launchers", "arc_venues", "arc_index_status", "arc_compare", "arc_market_breadth", "arc_attention", "arc_picks",
  "arc_token", "arc_holders", "arc_price_analysis", "arc_token_trades", "arc_token_flow", "arc_search", "arc_token_pools", "arc_candles",
  "arc_wallet_trades", "arc_wallet_pnl", "arc_wallet_profile", "arc_wallet_pnl_calendar", "arc_top_wallets",
  "lp_pools", "lp_pool", "lp_suggest_range", "lp_plan", "lp_token_pools", "lp_overview", "lp_wallet_positions", "lp_position", "lp_top_wallets", "lp_flow",
  "arc_depth", "arc_execution_plan", "arc_fx",
];
// No public route serves what these read (SQL over Chord's tape / snapshots / bot flags / report builder), or they write /
// quote (the app has its own swap tool).
const NOT_HERE = ["arc_token_traders", "arc_largest_trades", "arc_cotraders", "arc_buyer_quality", "arc_token_risk", "arc_holder_trend", "arc_sql", "arc_tx", "token_performance",
  "arc_quote", "bridge_quote", "lp_watch", "journal_open", "alert_create", "remember", "arc_report", "arc_export_trades", "rh_token", ""];

const USDC = "0x3600000000000000000000000000000000000000";
const A = (c: string) => `0x${c.repeat(40)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const row = (address: string, symbol: string, extra: Record<string, unknown> = {}) => ({
  address, symbol, name: symbol, decimals: 18, logoURI: null, tags: [], listed: false, priceUsd: 2, change24hPct: 5, volume24h: 1000, buyVolume24h: 600, sellVolume24h: 400,
  trades24h: 40, buys24h: 25, sells24h: 15, traders: 12, lastTradeTs: 0, totalSupply: 1e9, marketCapUsd: 2e9, pools: { v3: 1, v2: 0, v4: 0, byDex: { uniswap_v3: 1 } }, routable: true, ...extra,
});

let fx: MockFetchHandle | null = null;
afterEach(() => { fx?.restore(); fx = null; _resetChordApi(); _resetRhRollup(); });

describe("arc tool family: schemas and registry", () => {
  it("one schema and one registry row per ported tool, rows equal to Chord's registry", () => {
    expect([...ARC_TOOL_NAMES].sort()).toEqual([...PORTED].sort());
    expect(new Set(ARC_TOOL_NAMES).size).toBe(ARC_TOOL_NAMES.length);
    expect(Object.keys(ARC_TOOL_META).sort()).toEqual([...PORTED].sort());
    for (const n of PORTED) expect(ARC_TOOL_META[n]).toEqual(TOOL_META[n]);
    for (const s of ARC_TOOL_SCHEMAS) {
      expect(s.type).toBe("function");
      expect(s.function.parameters.type).toBe("object");
      expect(s.function.description.length).toBeGreaterThan(20);
    }
  });

  it("knows its own tools only; every ported tool is offered", () => {
    for (const n of PORTED) { expect(isArcTool(n)).toBe(true); expect(arcToolOffered(n)).toBe(true); }
    for (const n of NOT_HERE) { expect(isArcTool(n)).toBe(false); expect(arcToolOffered(n)).toBe(false); }
  });

  it("isArcNonUser = Chord's static plumbing set (relayer, launcher, bot contract), any case", () => {
    expect(isArcNonUser("0xF70DA97812CB96ACDF810712AA562DB8DFA3DBEF")).toBe(true);
    expect(isArcNonUser("0x0000ffffbe8efe702c8703ae3477ff5de3d319c0")).toBe(true);
    expect(isArcNonUser("0x333d54566d423a7c0243c8c6ec81a3264c4d5333")).toBe(true);
    expect(isArcNonUser(A("1"))).toBe(false);
    expect(isArcNonUser(null)).toBe(false);
  });
});

describe("runArcTool (offline, mocked Chord API)", () => {
  it("chord_facts answers from the static table without a network call", async () => {
    fx = mockFetch({});
    const r = await runArcTool("chord_facts", { topic: "what are the fees?" });
    expect((r.data as string[]).some((t) => t.includes("5 bps on every other token"))).toBe(true);
    expect(r.citations).toEqual([{ label: "Docs", href: "/docs" }]);
    const fallback = (await runArcTool("chord_facts", { topic: "zzz" })).data as string[];
    expect(fallback.length).toBe(3);
    expect(fx.calls.length).toBe(0);
  });

  it("arc_overview: Chord's rounding and citation, read from /v1/arc/overview with a browser User-Agent", async () => {
    fx = mockFetch({ "/v1/arc/overview": { chain: 5042, last24h: { volUsd: 1234.5, swaps: 10, tokens: 3, sinceHour: 0 }, venues24h: [{ dex: "uniswap_v3", volUsd: 999.6, trades: 7, tokens: 2, sharePct: 66.666 }], coverage: { stale: false }, updatedAt: 42 } });
    const r = await runArcTool("arc_overview", {});
    expect(r.data).toEqual({ last24h: { volUsd: 1234.5, swaps: 10, tokens: 3, sinceHour: 0 }, venues24h: [{ dex: "uniswap_v3", volUsd: 1000, trades: 7, sharePct: 66.7 }], stale: false, updatedAt: 42 });
    expect(r.citations).toEqual([{ label: "Arc data", href: "/data" }]);
    expect(fx.calls[0].url.endsWith("/v1/arc/overview")).toBe(true);
    expect(String((fx.calls[0].init?.headers as Record<string, string>)["User-Agent"])).toContain("Mozilla/5.0");
  });

  it("arc_token: exact symbol + listed wins the resolve; hourly, venue split and pools from the token routes", async () => {
    const real = A("b"), copy = A("a");
    fx = mockFetch({
      "/v1/arc/tokens/search": (u) => { expect(u).toContain("q=zorbx"); expect(u).toContain("limit=8"); return { tokens: [row(copy, "ZORBX", { volume24h: 9000 }), row(real, "ZORBX", { listed: true }), row(A("c"), "ZORBXX", { listed: true })] }; },
      [`/v1/arc/token/${real}/pools`]: { pools: [{ pool: A("d"), dex: "uniswap_v3", kind: "clmm", fee: 3000, token0: real, token1: USDC, createdBlock: 1 }] },
      [`/v1/arc/token/${real}?hours=24`]: { series: Array.from({ length: 30 }, (_, i) => ({ hour: i, volUsd: 10.4 + i, buyUsd: 0, sellUsd: 0, trades: i, buys: 0, sells: 0, priceLast: 1 })), byDex: [{ dex: "uniswap_v3", volUsd: 500, trades: 5, sharePct: 100 }] },
    });
    const r = await runArcTool("arc_token", { token: "ZORBX" });
    const d = r.data as any;
    expect(d.found).toBe(true);
    expect(d.token.address).toBe(real);
    expect(d.token.buySharePct).toBe(60);
    expect(d.last24hHourly.length).toBe(24);
    expect(d.last24hHourly[0]).toEqual({ hour: 6, volUsd: 16, trades: 6, priceLast: 1 });
    expect(d.byDex).toEqual([{ dex: "uniswap_v3", volUsd: 500, trades: 5, sharePct: 100 }]);
    expect(d.pools).toEqual([{ dex: "uniswap_v3", kind: "clmm", fee: 3000, hooks: null }]);
    expect(r.addresses).toEqual([real]);
    expect(r.citations).toEqual([{ label: "ZORBX on Arc", href: `/arc/token/${real}` }]);
  });

  it("arc_token: no match = Chord's not-found note", async () => {
    fx = mockFetch({ "/v1/arc/tokens/search": { tokens: [] } });
    expect((await runArcTool("arc_token", { token: "NOSUCHTOKEN" })).data).toEqual({ found: false, note: "No token on Arc matches that. Say so; do not guess an address." });
  });

  it("arc_holders: 503 HOLDERS_PENDING = 'still being built', a 200 maps the top holders", async () => {
    const t1 = A("e"), t2 = A("f");
    fx = mockFetch({
      "q=holdpend": { tokens: [row(t1, "HOLDPEND", { listed: true })] },
      "q=holdok": { tokens: [row(t2, "HOLDOK", { listed: true })] },
      [`/v1/arc/token/${t1}/holders`]: json({ error: "HOLDERS_PENDING", message: "holder ledger for this token is being built — retry in a few minutes" }, 503),
      [`/v1/arc/token/${t2}/holders`]: { holders: 321, complete: true, heldByWalletsPct: 40.5, concentration: { top1: 10, top5: 30, top10: 45 }, top: [{ holder: A("9"), balance: "1", amount: 1, sharePct: 10, kind: "wallet" }] },
    });
    const pending = await runArcTool("arc_holders", { token: "HOLDPEND" });
    expect((pending.data as any).note).toBe("The holder ledger for this token is still being built. Say it is not available yet; do not estimate.");
    const ok = await runArcTool("arc_holders", { token: "HOLDOK", limit: 5 });
    expect(ok.data).toEqual({ token: "HOLDOK", holders: 321, complete: true, heldByWalletsPct: 40.5, concentration: { top1: 10, top5: 30, top10: 45 }, top: [{ holder: A("9"), sharePct: 10, kind: "wallet" }] });
    expect(ok.addresses).toEqual([t2, A("9")]);
    expect(fx.calls.some((c) => c.url.includes(`/holders?limit=5`))).toBe(true);
  });

  it("arc_depth: buy with USDC, sell the tokens back, round-trip loss; a size with no route says so", async () => {
    const tok = A("7");
    fx = mockFetch({
      "q=depthx": { tokens: [row(tok, "DEPTHX", { listed: true, priceUsd: 2 })] },
      "/v1/quote": (u) => {
        const q = new URL(u).searchParams;
        expect(q.get("chain")).toBe("5042");
        expect(q.get("slippageBps")).toBe("100");
        const amt = BigInt(q.get("amount")!);
        if (q.get("inputMint") === USDC) {
          if (amt === 10_000n * 1_000_000n) return { routePlan: [], outputAmount: "0", noRouteReason: "INSUFFICIENT_LIQUIDITY" };
          return { routePlan: [{ swapInfo: { dex: "uniswap_v3" } }], outputAmount: ((amt * 10n ** 12n) / 2n).toString(), priceImpactPct: "0.5" }; // $2 a token
        }
        return { routePlan: [{ swapInfo: { dex: "uniswap_v3" } }], outputAmount: (((amt / 10n ** 12n) * 2n * 99n) / 100n).toString(), priceImpactPct: "0.5" }; // 1 % lost back
      },
    });
    const r = await runArcTool("arc_depth", { token: "DEPTHX", sizes_usdc: [100, 10000] });
    const d = r.data as any;
    expect(d.ladder[0]).toEqual({ usdc: 100, buy: { tokensOut: 50, effectivePriceUsd: 2, impactPct: 0.5, venues: ["uniswap_v3"] }, sellBack: { usdcOut: 99, roundTripLossPct: 1, impactPct: 0.5 } });
    expect(d.ladder[1]).toEqual({ usdc: 10000, buy: { ok: false, reason: "INSUFFICIENT_LIQUIDITY" } });
    expect((r.viz?.[0] as any).rows).toEqual([[100, 50, 0.5, 0.5, 1], [10000, "no route", null, null, null]]);
    expect(r.addresses).toEqual([tok, USDC]);
  });

  it("arc_top_wallets: a dark board is Chord's note; a live one maps the ranked rows", async () => {
    fx = mockFetch({ "window=24h": json({ error: "CHAIN_NOT_ENABLED", message: "chain 5042 leaderboard not enabled" }, 503), "window=7d": { wallets: [{ wallet: A("8"), pnlUsd: 1234.4, realizedUsd: 1000.6, volumeUsd: 5e4, trades: 33, winRate: 0.555, archetype: "degen", topToken: { symbol: "ZZ" } }] } });
    expect((await runArcTool("arc_top_wallets", { window: "24h" })).data).toEqual({ note: "The Arc wallet board is not published on this deployment yet." });
    const r = await runArcTool("arc_top_wallets", {});
    expect(r.data).toEqual([{ rank: 1, wallet: A("8"), pnlUsd: 1234, realizedUsd: 1001, volumeUsd: 50000, trades: 33, winRatePct: 56, archetype: "degen", topToken: "ZZ" }]);
    expect(fx.calls.at(-1)!.url).toContain("source=onchain");
  });

  it("wallet tools refuse a non-address without a call; an empty portfolio answer is flagged as possibly a failed read", async () => {
    fx = mockFetch({ [`/v1/portfolio/${A("4")}/pnl`]: { tokens: [], realized: 0, unrealized: 0, total: 0 } });
    expect((await runArcTool("arc_wallet_trades", { wallet: "vitalik.eth" })).data).toEqual({ error: "wallet must be a 0x address" });
    expect(fx.calls.length).toBe(0);
    const r = await runArcTool("arc_wallet_pnl", { wallet: A("4") });
    expect((r.data as any).totalUsd).toBe(0);
    expect((r.data as any).note).toContain("could not be confirmed right now");
    expect(fx.calls[0].url).toContain("chain=5042");
  });

  it("lp_flow for a token: the /v1/lp/token summary with Chord's providers table", async () => {
    const tok = A("6");
    fx = mockFetch({
      "q=lpflowx": { tokens: [row(tok, "LPFLOWX", { listed: true })] },
      [`/v1/lp/token/${tok}`]: { adds: 3, addUsd: 1500.4, removes: 1, removeUsd: 200, netUsd: 1300.4, providers: 2, jitTxs: 0, jitUsd: 0, tokenOnlyAdds: 1, top: [{ wallet: A("5"), netUsd: 1300.4, addedUsd: 1500.4, removedUsd: 200, events: 4, lastTs: 1_760_000_000 }], pools: [{ pool: A("3"), dex: "uniswap_v3", netUsd: 1300.4, events: 4 }] },
    });
    const r = await runArcTool("lp_flow", { token: "LPFLOWX", hours: 48 });
    const d = r.data as any;
    expect(d.hours).toBe(48);
    expect(d.netUsd).toBe(1300);
    expect(d.topProviders[0]).toMatchObject({ wallet: A("5"), netUsd: 1300, addedUsd: 1500, removedUsd: 200, events: 4 });
    expect(r.addresses).toEqual([tok, A("5"), A("3")]);
    expect(fx.calls.at(-1)!.url).toContain("hours=48");
  });

  it("arc_price_analysis: structure only — the ladder, invalidation and targets never leave the tool", async () => {
    const tok = A("d"), whale = A("c");
    const now = Math.floor(Date.now() / 1000);
    const c1h: Candle[] = Array.from({ length: 48 }, (_, i) => { const p = 1 + i * 0.01; return { t: now - (48 - i) * 3600, o: p * 0.99, h: p * 1.02, l: p * 0.98, c: p, v: 1000 + i * 10 }; });
    const win = { change: 1, txns: 10, buys: 6, sells: 4, buyVol: 600, sellVol: 400, buyers: 5, sellers: 3, makers: 8 };
    fx = mockFetch({
      "q=paxx": { tokens: [row(tok, "PAXX", { listed: true })] },
      "/v1/tokens/chart/": (u) => ({ candles: u.includes("tf=1h") ? c1h : [], tf: "1h", source: "db" }),
      [`/v1/tokens/stats/${tok}`]: { priceUsd: 1.47, windows: { m5: win, h1: win, h6: win, h24: win }, range24h: { high: 1.5, low: 1.2 }, ath: { priceUsd: 2, ts: now - 7200 } },
      [`/v1/tokens/trades/${tok}`]: (u) => { expect(u).toContain("min=300"); expect(u).toContain("limit=60"); return { trades: [{ side: "buy", usd: 500, priceUsd: 1.4, ts: now - 600, wallet: whale }], total: 1, stats24h: {} }; },
      "/holders": json({ error: "HOLDERS_PENDING" }, 503),
    });
    const r = await runArcTool("arc_price_analysis", { token: "PAXX" });
    const d = r.data as any;
    expect(d.found).toBe(true);
    expect(d.priceUsd).toBe(1.47);
    expect(d.whales[0]).toMatchObject({ side: "buy", usd: 500, wallet: whale });
    expect(d.holders).toBeNull();
    for (const k of ["ladder", "invalidation", "targets", "note"]) expect(k in d.plan).toBe(false);
    expect(r.addresses).toEqual([tok, whale]);
    expect(r.viz?.map((v) => v.kind)).toEqual(["bar", "table"]);
    expect((r.viz?.[1] as any).title).toBe("PAXX · key levels on the tape");
  });

  it("priceAnalysis / analysisForModel stay Chord's: too few candles = null; the model copy drops the plan levels", () => {
    expect(priceAnalysis({ c5: [], c1h: [], stats: null, whales: [], holders: null })).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    const c1h: Candle[] = Array.from({ length: 30 }, (_, i) => ({ t: now - (30 - i) * 3600, o: 1, h: 1.1, l: 0.9, c: 1 + (i % 5) * 0.01, v: 100 }));
    const a = priceAnalysis({ c5: [], c1h, stats: { priceUsd: 1.02 }, whales: [], holders: null })!;
    expect(a.window.tf).toBe("1h");
    expect(Object.keys(analysisForModel(a).plan).sort()).toEqual(["thinTape"]);
  });

  it("arc_picks: the public board filtered by side, the move since each pick from 1h candles", async () => {
    const now = Math.floor(Date.now() / 1000);
    const pa = A("1"), pb = A("2");
    fx = mockFetch({
      "/v1/ask/picks": { chain: 5042, computedAt: now - 600, picks: [
        { token: pa, symbol: "PKA", side: "bullish", score: 70, confidence: "medium", priceUsd: 1, ts: now - 7200, why: ["a"], against: ["b"], facts: { buyShare1h: 60, realBuyerPct: 40 } },
        { token: pb, chain: 8453, symbol: "PKB", side: "bearish", score: 30, confidence: "low", priceUsd: 1, ts: now - 7200, why: [], against: [], facts: { buyShare1h: 20, realBuyerPct: 10 } },
      ], trackRecord7d: { graded: 10, open: 2, rightWayPct: 60, avgMovePct: 3.2 }, coverage: [] },
      [`/v1/tokens/chart/${pa}`]: (u) => { expect(u).not.toContain("chain="); return { candles: [{ t: now - 3600, o: 1, h: 1.2, l: 0.9, c: 1.1, v: 10 }], tf: "1h", source: "db" }; },
    });
    const r = await runArcTool("arc_picks", { side: "bullish" });
    const d = r.data as any;
    expect(d.computedMinutesAgo).toBe(10);
    expect(d.picks.length).toBe(1);
    expect(d.picks[0]).toMatchObject({ token: pa, chain: "Arc", sinceMovePct: 10 });
    expect(d.trackRecord7d).toEqual({ graded: 10, open: 2, rightWayPct: 60, avgMovePct: 3.2 });
    expect(d.note).toContain("never with an entry, a stop, a target or a size");
    expect(r.addresses).toEqual([pa]);
  });

  it("a source failure becomes an answer the model can repeat; an unknown tool says so", async () => {
    fx = mockFetch({ "/v1/arc/trending": new Response("{}", { status: 500 }) });
    expect((await runArcTool("arc_trending", { limit: 3 })).data).toEqual({ error: "Chord API /v1/arc/trending answered 500", note: "The source did not answer just now. Say the data is unavailable; do not guess numbers." });
    expect((await runArcTool("arc_sql", {})).data).toEqual({ error: "unknown tool arc_sql" });
  });

  it("arc_index_status keeps a failed read as the rollup error, like Chord's own catch", async () => {
    fx = mockFetch({ "/v1/arc/status": new Response("{}", { status: 503 }) });
    const d = (await runArcTool("arc_index_status", {})).data as any;
    expect(String(d.rollup.error)).toContain("answered 503");
    expect(d.poolIndex).toBeNull();
    expect(d.holders).toBeNull();
    expect(typeof d.now).toBe("number");
  });
});
