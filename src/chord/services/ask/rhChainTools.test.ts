import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetChordApi } from "../chordApi";
import { _resetRhRollup } from "../rhRollup";
beforeEach(() => { _resetChordApi(); _resetRhRollup(); });
import { RHCHAIN_TOOL_META, RHCHAIN_TOOL_NAMES, RHCHAIN_TOOL_SCHEMAS, isRhChainTool, parseKeyedChain, rhChainToolOffered, runRhChainTool, venueLabel } from "./rhChainTools";
import { TOOL_META } from "./registry";
import { mockFetch, resetRedis, type MockFetchHandle } from "../../testkit/helpers";

const PORTED = [
  "monad_tokens", "monad_token", "monad_token_trades", "monad_token_traders", "monad_wallet_pnl", "monad_top_wallets",
  "rh_stocks", "rh_tokens", "rh_token", "rh_token_trades", "rh_wallet_pnl", "rh_overview", "rh_venues", "rh_search", "rh_token_flow",
  "rh_candles", "rh_wallet_trades", "rh_wallet_pnl_calendar", "rh_top_wallets", "rh_compare", "rh_holders",
  "chain_overview", "chain_tokens", "chain_token", "chain_token_trades", "chain_wallet",
  "sol_tape_market", "sol_tape_token", "sol_tape_trades", "sol_tape_wallet",
];
const SKIPPED = ["rh_quote", "chain_quote", "rh_token_traders", "rh_price_analysis", "rh_wallet_profile", "rh_largest_trades", "rh_tx"];
// Chord's services/ask/solTapeTools.ts SOL_TAPE_TOOL_META (not in this app's registry.ts: Chord's extTools spreads it there).
const SOL_TAPE_META = {
  sol_tape_market: { group: "solana", label: "Reading Chord's Solana tape", market: true, untrusted: true, timeoutMs: 15_000 },
  sol_tape_token: { group: "solana", label: "Looking up the Solana token on the tape", untrusted: true, timeoutMs: 20_000 },
  sol_tape_trades: { group: "solana", label: "Reading Solana prints", untrusted: true, timeoutMs: 15_000 },
  sol_tape_wallet: { group: "solana", label: "Reading the Solana wallet on the tape", untrusted: true, timeoutMs: 25_000 },
};

let fx: MockFetchHandle | null = null;
afterEach(() => { fx?.restore(); fx = null; _resetChordApi(); _resetRhRollup(); resetRedis(); });
const status = (code: number, body: object) => () => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const d = (r: { data: unknown }) => r.data as any;
const now = () => Math.floor(Date.now() / 1000);

const NVDA = "0x1111111111111111111111111111111111111111";
const MEME = "0x2222222222222222222222222222222222222222";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const RH_LIST = { tokens: [
  { address: NVDA, symbol: "NVDA", name: "NVIDIA • Robinhood Token", decimals: 18, tags: ["stock"], logoURI: null },
  { address: USDG, symbol: "USDG", name: "Global Dollar", decimals: 6, tags: ["stablecoin"], logoURI: null },
] };
const rhRow = (address: string, symbol: string, extra: object = {}) => ({
  address, symbol, name: symbol, decimals: 18, logoURI: null, tags: [], listed: true, priceUsd: 180, change24hPct: 1.234, liquidityUsd: 50_000,
  volume24h: 100_000, buyVolume24h: 60_000, sellVolume24h: 40_000, trades24h: 300, buys24h: 180, sells24h: 120, traders: 40, lastTradeTs: now(), ...extra,
});
const STOCKS = { stocks: [rhRow(NVDA, "NVDA", { name: "NVIDIA • Robinhood Token", tags: ["stock"], navUsd: 179, basisPct: 0.5586, offHours7d: { volUsd: 1, sharePct: 41.234, trades: 3 } })] };
const W = (change: number) => ({ change, txns: 10, buys: 6, sells: 4, buyVol: 6000, sellVol: 4000, makers: 7, buyers: 5, sellers: 3 });
const STATS = { priceUsd: 181, windows: { m5: W(0.1), h1: W(0.5), h6: W(1), h24: W(2) }, liquidityUsd: 55_555, ath: { priceUsd: 200, ts: 1 }, range24h: { high: 185, low: 175 }, firstTradeTs: now() - 3600, totalTxns: 999 };

describe("rh / monad / chains / Solana-tape family", () => {
  it("one schema and one registry row per ported tool, rows equal to Chord's registry", () => {
    expect([...RHCHAIN_TOOL_NAMES].sort()).toEqual([...PORTED].sort());
    expect(new Set(RHCHAIN_TOOL_NAMES).size).toBe(RHCHAIN_TOOL_NAMES.length);
    expect(Object.keys(RHCHAIN_TOOL_META).sort()).toEqual([...PORTED].sort());
    for (const n of PORTED.filter((x) => !x.startsWith("sol_tape_"))) expect(RHCHAIN_TOOL_META[n]).toEqual(TOOL_META[n]!);
    for (const [n, m] of Object.entries(SOL_TAPE_META)) expect(RHCHAIN_TOOL_META[n]).toEqual(m as any);
    for (const s of RHCHAIN_TOOL_SCHEMAS) expect(s.function.parameters.type).toBe("object");
  });

  it("knows its own tools only: skipped Chord tools and this app's existing names are not redefined", () => {
    for (const n of PORTED) { expect(isRhChainTool(n)).toBe(true); expect(rhChainToolOffered(n)).toBe(true); }
    for (const n of [...SKIPPED, "wallet_balances", "chain_tx", "calc", "sol_tokens", "sol_quote", "sol_lend_rates", "make_clip", ""]) {
      expect(isRhChainTool(n)).toBe(false);
      expect(rhChainToolOffered(n)).toBe(false);
    }
  });

  it("parses the keyed chains and labels venues like Chord", () => {
    expect(parseKeyedChain("Base")).toBe(8453);
    expect(parseKeyedChain("bsc")).toBe(56);
    expect(parseKeyedChain("avax")).toBe(43114);
    expect(parseKeyedChain("arc")).toBeNull();
    expect(venueLabel("pharaoh_dlmm")).toBe("Pharaoh DLMM");
    expect(venueLabel("uniswap_v3")).toBe("Uniswap V3");
  });

  it("an unknown name answers an error, never throws", async () => {
    expect(d(await runRhChainTool("rh_quote", {})).error).toContain("unknown tool");
  });
});

describe("Robinhood Chain (offline)", () => {
  it("rh_stocks: Chord's rows, basis vs NAV and the table, from GET /v1/rh/stocks", async () => {
    fx = mockFetch({ "/v1/rh/stocks": STOCKS });
    const r = await runRhChainTool("rh_stocks", { sort: "volume" });
    const row = d(r).rows[0];
    expect(row).toMatchObject({ symbol: "NVDA", name: "NVIDIA", priceUsd: 180, change24hPct: 1.23, volume24hUsd: 100_000, navUsd: 179, basisPct: 0.56, offHoursSharePct: 41.23 });
    expect(r.addresses).toEqual([NVDA]);
    expect(r.citations[0]).toEqual({ label: "NVDA on Robinhood Chain", href: `/ask/trade/${NVDA}` });
    expect((r.viz?.[0] as any).columns).toContain("vs NAV");
    expect(fx.calls.every((c) => c.url.includes("/v1/rh/stocks"))).toBe(true);
  });

  it("rh_token: stats + hourly + NAV + candles from the public routes", async () => {
    const t0 = 1_760_000_400;
    fx = mockFetch({
      "/v1/tokens?chain=4663": RH_LIST,
      [`/v1/tokens/stats/${NVDA}`]: STATS,
      [`/v1/rh/token/${NVDA}?hours=168`]: { series: [{ hour: t0, volUsd: 10 }, { hour: t0 + 3600, volUsd: 5 }], byDex: [{ dex: "uniswap_v3", volUsd: 15, sharePct: 100 }] },
      "/v1/rh/stocks": STOCKS,
      "/v1/candles?chain=4663": { candles: [0, 1, 2].map((i) => ({ t: t0 + i * 3600, o: 1, h: 2, l: 1, c: 180 + i, v: 10 })) },
    });
    const r = await runRhChainTool("rh_token", { token: "nvda" });
    expect(d(r)).toMatchObject({ found: true, chain: 4663, priceUsd: 181, liquidityUsd: 55_555, navUsd: 179, basisPct: 1.12 });
    expect(d(r).token).toMatchObject({ symbol: "NVDA", name: "NVIDIA", stock: true });
    expect(d(r).venues7d).toEqual([{ dex: "uniswap_v3", volumeUsd: 15, sharePct: 100 }]);
    expect(d(r).volume7dByDay.reduce((s: number, x: any) => s + x.volumeUsd, 0)).toBe(15);
    expect((r.viz?.[0] as any).chart).toEqual({ chain: 4663, address: NVDA, tf: "1h" });
    expect(fx.calls.some((c) => c.url.includes(`/v1/candles?chain=4663&token=${NVDA}&tf=1h&limit=24`))).toBe(true);
  });

  it("rh_token: an unknown symbol answers found false without guessing", async () => {
    fx = mockFetch({ "/v1/tokens?chain=4663": RH_LIST });
    expect(d(await runRhChainTool("rh_token", { token: "ZZZZ" }))).toMatchObject({ found: false });
  });

  it("rh_holders: 503 HOLDERS_PENDING with 'being built' = queued, said as not available yet", async () => {
    fx = mockFetch({
      "/v1/tokens?chain=4663": RH_LIST,
      [`/v1/rh/token/${NVDA}/holders`]: status(503, { error: "HOLDERS_PENDING", message: "holder ledger for this token is being built — retry in a few minutes" }),
    });
    const r = await runRhChainTool("rh_holders", { token: "NVDA" });
    expect(d(r).note).toContain("just queued");
    expect(d(r).holders).toBeUndefined();
  });

  it("rh_top_wallets: the board switch off (503 CHAIN_NOT_ENABLED) is said as not published", async () => {
    fx = mockFetch({ "/v1/smart-money/top": status(503, { error: "CHAIN_NOT_ENABLED", message: "chain 4663 leaderboard not enabled" }) });
    const r = await runRhChainTool("rh_top_wallets", { window: "7d" });
    expect(d(r).note).toContain("not published");
  });

  it("rh_wallet_pnl: an empty portfolio answer is flagged, never a $0 result; curValue is what the wallet still holds", async () => {
    const A = "0x3333333333333333333333333333333333333333", B = "0x4444444444444444444444444444444444444444";
    fx = mockFetch({
      [`/v1/portfolio/${A}/pnl?chain=4663`]: { tokens: [], realized: 0, unrealized: 0, total: 0 },
      [`/v1/portfolio/${B}/pnl?chain=4663`]: { tokens: [{ token: NVDA, symbol: "NVDA", realizedUsd: 10, unrealizedUsd: 5, totalUsd: 15, curValue: 99.6, roiPct: 3 }], realized: 10, unrealized: 5, total: 15 },
    });
    expect(d(await runRhChainTool("rh_wallet_pnl", { wallet: A })).note).toContain("do not report $0");
    const r = await runRhChainTool("rh_wallet_pnl", { wallet: B });
    expect(d(r).tokens[0]).toEqual({ symbol: "NVDA", realizedUsd: 10, unrealizedUsd: 5, totalUsd: 15, stillHoldsUsd: 100 });
    expect(d(r).note).toBeUndefined();
    expect(d(await runRhChainTool("rh_wallet_pnl", { wallet: "nope" })).error).toContain("0x address");
  });

  it("rh_token_trades: min_usd ≥ 1000 keeps the last 24 h of the rows the route returns", async () => {
    fx = mockFetch({
      "/v1/tokens?chain=4663": RH_LIST,
      [`/v1/tokens/trades/${NVDA}`]: { trades: [
        { tx: "0xa", dex: "uniswap_v3", token: NVDA, side: "buy", tokenAmt: 10, usd: 5000, priceUsd: 180, ts: now() - 600, wallet: MEME },
        { tx: "0xb", dex: "uniswap_v3", token: NVDA, side: "sell", tokenAmt: 10, usd: 5000, priceUsd: 180, ts: now() - 3 * 86_400, wallet: null },
      ], total: 2, stats24h: { buys: 1, sells: 0, buyUsd: 5000, sellUsd: 0 } },
    });
    const r = await runRhChainTool("rh_token_trades", { token: "NVDA", min_usd: 2000 });
    expect(d(r).trades.map((x: any) => x.tx)).toEqual(["0xa"]);
    expect(d(r).window).toContain("last 24 h");
    expect(fx.calls.find((c) => c.url.includes("/v1/tokens/trades/"))!.url).toContain("min=2000");
    expect(r.addresses).toEqual([NVDA, MEME]);
  });

  it("a route that cannot be read answers {error, note}, never a thrown error", async () => {
    fx = mockFetch({ "/v1/rh/overview": status(503, { error: "RH_DATA_UNAVAILABLE", message: "rh data unavailable: boom" }) });
    const r = await runRhChainTool("rh_overview", {});
    expect(d(r).error).toContain("rh data unavailable");
    expect(d(r).note).toContain("do not guess");
  });
});

describe("Monad (offline)", () => {
  const CHOG = "0x5555555555555555555555555555555555555555";
  it("monad_tokens: list × market map, priced rows only, by volume", async () => {
    fx = mockFetch({
      "/v1/tokens?chain=143": { tokens: [
        { address: CHOG, symbol: "CHOG", name: "Chog", decimals: 18, tags: ["meme"], verified: true },
        { address: MEME, symbol: "DUST", name: "Dust", decimals: 18 },
      ] },
      "/v1/tokens/market?chain=143": { market: { [CHOG]: { priceUsd: 0.01, change24h: 5.55, volume24h: 1234.4 } } },
    });
    const r = await runRhChainTool("monad_tokens", {});
    expect(d(r)).toEqual({ chain: 143, tokens: [{ symbol: "CHOG", name: "Chog", address: CHOG, priceUsd: 0.01, change24hPct: 5.55, volume24hUsd: 1234, tags: ["meme"], verified: true }] });
  });

  it("monad_top_wallets: GET /v1/smart-money/top source=onchain chain=143", async () => {
    fx = mockFetch({ "/v1/smart-money/top": { wallets: [{ wallet: CHOG, pnlUsd: 1000.4, realizedUsd: 900, volumeUsd: 50_000, trades: 40, winRate: 0.625, archetype: "degen", topToken: { symbol: "CHOG" } }] } });
    const r = await runRhChainTool("monad_top_wallets", { window: "24h", limit: 3 });
    expect(d(r).wallets[0]).toEqual({ rank: 1, wallet: CHOG, pnlUsd: 1000, realizedUsd: 900, volumeUsd: 50_000, trades: 40, winRatePct: 63, archetype: "degen", topToken: "CHOG" });
    expect(fx.calls[0]!.url).toContain("window=24h&source=onchain&chain=143&limit=3");
  });
});

describe("Avalanche / Base / BNB Chain (offline)", () => {
  const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
  it("chain_overview base: Chord's fields, the ingest floor note and both charts", async () => {
    fx = mockFetch({ "/v1/chains/8453/overview": {
      last24h: { volUsd: 1_000_000.4, swaps: 5000, tokens: 300, venues: 6 }, wallets: { today: 100, yesterday: 900 },
      venues24h: [{ dex: "slipstream_fork", volUsd: 600_000, trades: 3000, sharePct: 60 }],
      daily: [{ day: 1_759_968_000, swaps: 10, volUsd: 20, tokens: 3, wallets: 4 }], coverage: { stale: false }, ingestFloor: { minTradeUsd: 100 },
    } });
    const r = await runRhChainTool("chain_overview", { chain: "base" });
    expect(d(r)).toMatchObject({ chain: "Base", chainId: 8453, last24h: { volumeUsd: 1_000_000, swaps: 5000, tokensTraded: 300, venues: 6 }, walletsToday: 100 });
    expect(d(r).venues24h[0]).toEqual({ dex: "Aero", volumeUsd: 600_000, trades: 3000, sharePct: 60 });
    expect(d(r).note).toContain("skips trades under $100");
    expect(r.viz?.map((v) => v.kind)).toEqual(["bar", "donut"]);
  });

  it("a chain Chord serves dark (400 UNSUPPORTED_CHAIN) is said as not available; a bad chain argument is the model's to fix", async () => {
    fx = mockFetch({ "/v1/chains/43114/overview": status(400, { error: "UNSUPPORTED_CHAIN", message: "chain 43114 is not served yet" }) });
    expect(d(await runRhChainTool("chain_overview", { chain: "avalanche" })).error).toContain("not available on Chord");
    expect(d(await runRhChainTool("chain_overview", { chain: "arc" })).error).toContain("must be one of");
  });

  it("chain_token: listed symbol wins, look-alikes travel with the answer", async () => {
    const FAKE = "0x6666666666666666666666666666666666666666";
    fx = mockFetch({
      "/v1/tokens?chain=56": { tokens: [{ address: AERO, symbol: "CAKE", name: "PancakeSwap Token", decimals: 18 }] },
      "/v1/chains/56/tokens?limit=200&sort=volume": { total: 2, ingestFloor: { minTradeUsd: 0 }, tokens: [
        { address: FAKE, symbol: "CAKE", name: "Cake copy", decimals: 18, priceUsd: 1, change24hPct: 0, volume24h: 9_999_999, buyVolume24h: 1, trades24h: 1, dominantDex: "uniswap_v2", lastTradeTs: now() },
        { address: AERO, symbol: "CAKE", name: "PancakeSwap Token", decimals: 18, priceUsd: 2.5, change24hPct: 1, volume24h: 500_000, buyVolume24h: 300_000, trades24h: 900, dominantDex: "pancake_v3", lastTradeTs: now() },
      ] },
      [`/v1/chains/56/token/${AERO}?hours=168`]: {
        token: { address: AERO, symbol: "CAKE", name: "PancakeSwap Token", decimals: 18 },
        stats24h: { volUsd: 500_000, buyUsd: 300_000, trades: 900, buys: 500, sells: 400, lastTs: now() - 120, priceUsd: 2.5, change24hPct: 1.004 },
        series: [{ hour: 1_759_968_000, volUsd: 1, priceLast: 2 }, { hour: 1_759_971_600, volUsd: 2, priceLast: 2.4 }, { hour: 1_759_975_200, volUsd: 3, priceLast: 2.5 }],
        byDex: [{ dex: "pancake_v3", volUsd: 6, sharePct: 100 }], ingestFloor: { minTradeUsd: 100 },
      },
    });
    const r = await runRhChainTool("chain_token", { chain: "bnb", token: "$CAKE" });
    expect(d(r)).toMatchObject({ found: true, chainId: 56, priceUsd: 2.5, change24hPct: 1, change7dPct: 25, buySharePct: 60, high24h: 2.5, low24h: 2 });
    expect(d(r).token).toMatchObject({ address: AERO, listed: true });
    expect(d(r).lookAlikes).toEqual([{ symbol: "CAKE", address: FAKE, listed: false, volume24hUsd: 9_999_999 }]);
    expect(r.addresses).toEqual([AERO, FAKE]);
    expect(r.citations[0]!.href).toBe(`/ask/trade/${AERO}?chain=56`);
  });

  it("chain_wallet: every public chain read, a dark one skipped, the window line stated", async () => {
    const WAL = "0x7777777777777777777777777777777777777777";
    const pnl = (chain: number) => ({ chain, window: { fromTs: 1_759_968_000, toTs: now(), days: 3 }, history: "raw", trades: 4, truncated: false, realizedUsd: 10.4, unrealizedUsd: 0, totalUsd: 10.4, volumeUsd: 400, soldWithoutBasisUsd: 0,
      tokens: [{ token: AERO, symbol: "AERO", buys: 2, sells: 2, boughtUsd: 200, soldUsd: 210, realizedUsd: 10, unrealizedUsd: 0, holdsUsd: 0, avgCostUsd: 1, lastPriceUsd: 1.05 }], recent: [], ingestFloor: { minTradeUsd: 0 } });
    fx = mockFetch({
      [`/v1/chains/43114/wallet/${WAL}`]: status(400, { error: "UNSUPPORTED_CHAIN", message: "chain 43114 is not served yet" }),
      [`/v1/chains/8453/wallet/${WAL}`]: pnl(8453),
      [`/v1/chains/56/wallet/${WAL}`]: pnl(56),
    });
    const r = await runRhChainTool("chain_wallet", { wallet: WAL });
    expect(d(r).chains.map((c: any) => c.chainId)).toEqual([8453, 56]);
    expect(d(r).chains[0].window).toBe("Base trades since 2025-10-09 (3 days, raw tape)");
    expect(r.addresses).toEqual([WAL, AERO]);
  });
});

describe("Solana tape (offline)", () => {
  const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"; // mixed case: must reach the route untouched
  const OV = { chain: "solana", windowHours: 24, volumeUsd: 2_000_000.6, trades: 1000, buys: 600, tokensTraded: 50, venues: [{ dex: "pumpswap", volumeUsd: 1_500_000, trades: 700, share: 0.75 }], hourly: [{ hour: 1_759_968_000, volumeUsd: 10, trades: 1 }], coverageSince: 1_759_968_000, coverageHours: 72, updatedAt: 1 };

  it("sol_tape_market overview: coverage, buy share and the venue donut", async () => {
    fx = mockFetch({ "/v1/chains/solana/overview": OV });
    const r = await runRhChainTool("sol_tape_market", { view: "overview" });
    expect(d(r)).toMatchObject({ source: "Chord Solana tape", volumeUsd: 2_000_001, trades: 1000, buySharePct: 60, tokensTraded: 50 });
    expect(d(r).coverage.venues).toContain("PumpSwap");
    expect(d(r).venues[0]).toEqual({ venue: "pumpswap", volumeUsd: 1_500_000, sharePct: 75, trades: 700 });
    expect(r.viz?.[0]?.kind).toBe("donut");
  });

  it("sol_tape_market volume board: rows, chips for real markets only, mint case kept", async () => {
    fx = mockFetch({
      "/v1/chains/solana/overview": OV,
      "/v1/chains/solana/tokens?sort=volume&limit=2": { sort: "volume", windowHours: 24, updatedAt: 1, tokens: [
        { token: MINT, symbol: "WIF", name: "dogwifhat", image: "https://x/y.png", priceUsd: 1.23456789, change24hPct: 2.345, volume24hUsd: 50_000, trades24h: 200, buys24h: 120, liquidityUsd: 90_000, marketCapUsd: 1e9, pool: null, dex: "orca", firstSeen: null },
        { token: "DeadDeadDeadDeadDeadDeadDeadDeadDead1", symbol: "DEAD", name: null, image: null, priceUsd: 0.0001, change24hPct: null, volume24hUsd: 5, trades24h: 1, buys24h: 1, liquidityUsd: 10, marketCapUsd: null, pool: null, dex: "pumpswap", firstSeen: null },
      ] },
    });
    const r = await runRhChainTool("sol_tape_market", { view: "volume", limit: 2 });
    expect(d(r).rows[0]).toMatchObject({ symbol: "WIF", mint: MINT, priceUsd: 1.2346, change24hPct: 2.35, buySharePct: 60 });
    expect(r.addresses[0]).toBe(MINT);
    expect(r.chipCandidates?.map((c) => c.id)).toEqual([`sol:${MINT}`]);
  });

  it("sol_tape_token: a mint the tape never saw (404) answers found false; the mint reaches the route with its case", async () => {
    fx = mockFetch({ [`/v1/chains/solana/token/${MINT}?hours=48`]: status(404, { error: "TOKEN_NOT_FOUND", message: "no trades" }) });
    const r = await runRhChainTool("sol_tape_token", { token: MINT });
    expect(d(r)).toMatchObject({ found: false, mint: MINT });
    expect(fx.calls.some((c) => c.url.includes(MINT))).toBe(true);
    expect(fx.calls.some((c) => c.url.includes(MINT.toLowerCase()))).toBe(false);
  });

  it("sol_tape_trades: min_usd filters the last 200 prints, links to Solscan", async () => {
    const T = "8GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
    fx = mockFetch({ [`/v1/chains/solana/token/${T}/trades?limit=200`]: { chain: "solana", token: T, trades: [
      { ts: now() - 30, side: "buy", tokenAmount: 100, quoteAmount: 1, usd: 5000, priceUsd: 50, dex: "orca", pool: null, wallet: "WaLLet1111111111111111111111111111111111", tx: "sigA" },
      { ts: now() - 60, side: "sell", tokenAmount: 1, quoteAmount: 1, usd: 20, priceUsd: 20, dex: "orca", pool: null, wallet: null, tx: "sigB" },
    ] } });
    const r = await runRhChainTool("sol_tape_trades", { token: T, min_usd: 1000 });
    expect(d(r).rows.map((x: any) => x.tx)).toEqual(["sigA"]);
    expect(d(r).summary).toMatchObject({ prints: 1, buys: 1, buyUsd: 5000, uniqueWallets: 1 });
    expect((r.viz?.[0] as any).links).toEqual(["https://solscan.io/tx/sigA"]);
  });

  it("sol_tape_wallet: an EVM address is refused before any call", async () => {
    fx = mockFetch({});
    const r = await runRhChainTool("sol_tape_wallet", { wallet: NVDA });
    expect(d(r).error).toContain("Solana address");
    expect(fx.calls.length).toBe(0);
  });
});
