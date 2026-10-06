import { describe, expect, it } from "bun:test";
import {
  DEX_TOOL_META, DEX_TOOL_NAMES, DEX_TOOL_SCHEMAS, STABLE_SYMBOL, ageLabel, dexLabel, aliasNetwork, chartSummary, clean, deepestPoolFor, dsChainId, dsMarkets, gtChip,
  gtPools, gtTrades, goplusChainId, goplusEvm, goplusPage, goplusSolana, isAddressLike, isDexTool, matchNetwork, normAddr, ohlcvCandles,
  pickBySymbol, poolRow, promoRows, rankMovers, sig, summarizeTrades, tokenInfo, tokenPoolsSummary, usd,
} from "./dexTools";

// Fixtures trimmed from live responses, 2026-10-03.
const NOW = Date.parse("2026-10-02T20:00:00Z");
const tx = (b: number, s: number) => ({ buys: b, sells: s, buyers: Math.round(b / 2), sellers: Math.round(s / 2) });
const poolJson = (o: { id: string; name: string; base: string; quote: string; dex: string; price: string; qprice?: string; reserve: string | null; vol24: string; h1: string; h24: string; created: string; net?: string; locked?: string }) => ({
  id: o.id, type: "pool",
  attributes: {
    base_token_price_usd: o.price, quote_token_price_usd: o.qprice ?? "2666.68", address: o.id.slice(o.id.lastIndexOf("_") + 1), name: o.name, pool_created_at: o.created,
    fdv_usd: "40593370.4665951", market_cap_usd: "27694745.4220187", price_change_percentage: { m5: "0", m15: "0", m30: "0.074", h1: o.h1, h6: "23.783", h24: o.h24 },
    transactions: { h1: tx(88, 96), h24: tx(2279, 1518) }, volume_usd: { h1: "122796.79", h6: "1561904.61", h24: o.vol24 }, reserve_in_usd: o.reserve,
    ...(o.locked ? { locked_liquidity_percentage: o.locked } : {}),
  },
  relationships: {
    base_token: { data: { id: o.base, type: "token" } }, quote_token: { data: { id: o.quote, type: "token" } }, dex: { data: { id: o.dex, type: "dex" } },
    ...(o.net ? { network: { data: { id: o.net, type: "network" } } } : {}),
  },
});
const EDEL = "0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95", WETH = "0x4200000000000000000000000000000000000006";
const TRENDING = {
  data: [
    poolJson({ id: "base_0x566bee7ef7b39f29d150ab3be6b6242c17cc5a31", name: "EDEL / WETH", base: `base_${EDEL}`, quote: `base_${WETH}`, dex: "aerodrome-base", price: "0.0405933730189309", reserve: "1337094.3764", vol24: "1806479.81587469", h1: "9.159", h24: "20.436", created: "2025-11-12T17:00:57Z", net: "base", locked: "93.43" }),
    poolJson({ id: "polygon_pos_0x91e9823a895a2d05a2c853fbd1619da089b36054", name: "ROO / WETH", base: "polygon_pos_0x3458e003f6ed93df0f537b8acac6fbe08e41247f", quote: "polygon_pos_0x0000000000000000000000000000000000000000", dex: "uniswap-v4", price: "0.000152713474499962", reserve: "23019.246", vol24: "502026.92", h1: "12.336", h24: "128", created: "2026-10-02T14:00:40Z", net: "polygon_pos" }),
  ],
  included: [
    { id: `base_${EDEL}`, type: "token", attributes: { address: EDEL, name: "Edel", symbol: "EDEL", decimals: 18, image_url: "https://coin-images.coingecko.com/coins/images/70661/large/edel.png?1790067790" } },
    { id: `base_${WETH}`, type: "token", attributes: { address: WETH, name: "Wrapped Ether", symbol: "WETH", image_url: null } },
    { id: "aerodrome-base", type: "dex", attributes: { name: "Aerodrome" } },
    { id: "base", type: "network", attributes: { name: "Base", coingecko_asset_platform_id: "base" } },
  ],
};

describe("dex tools: registry contract", () => {
  it("every schema has a META row in a parity group, and the dispatcher knows every name", () => {
    const names = DEX_TOOL_SCHEMAS.map((s) => s.function.name);
    expect(names).toEqual([...DEX_TOOL_NAMES]);
    for (const n of names) {
      expect(DEX_TOOL_META[n]).toBeDefined();
      expect(["dexscan", "safety"]).toContain(DEX_TOOL_META[n].group);
      expect(DEX_TOOL_META[n].untrusted).toBe(true);
      expect(isDexTool(n)).toBe(true);
      expect((DEX_TOOL_META[n].timeoutMs ?? 15_000) <= 60_000).toBe(true);
    }
    expect(Object.keys(DEX_TOOL_META).sort()).toEqual([...names].sort());
    expect(isDexTool("dex_search")).toBe(false);
    expect(isDexTool("arc_token_risk")).toBe(false);
  });
  it("schema text is model-facing English with no em dashes", () => {
    const text = JSON.stringify(DEX_TOOL_SCHEMAS) + JSON.stringify(DEX_TOOL_META);
    expect(text.includes("—")).toBe(false);
    expect(/you should|stop-loss|take-profit/i.test(text)).toBe(false);
  });
});

describe("dex tools: networks", () => {
  it("maps friendly names and chain ids to GeckoTerminal ids", () => {
    expect(aliasNetwork("SOL")).toBe("solana");
    expect(aliasNetwork("eth")).toBe("eth");
    expect(aliasNetwork("BNB Chain")).toBe("bsc");
    expect(aliasNetwork("bnb")).toBe("bsc");
    expect(aliasNetwork("arb")).toBe("arbitrum");
    expect(aliasNetwork("polygon")).toBe("polygon_pos");
    expect(aliasNetwork("avax")).toBe("avax");
    expect(aliasNetwork("Robinhood Chain")).toBe("robinhood");
    expect(aliasNetwork(4663)).toBe("robinhood");
    expect(aliasNetwork("hyperevm")).toBe("hyperevm");
    expect(aliasNetwork("sui")).toBe("sui-network");
    expect(aliasNetwork("Monad Mainnet")).toBe("monad");
    expect(aliasNetwork("plutonium")).toBeNull();
    expect(aliasNetwork("")).toBeNull();
  });
  it("falls back to GeckoTerminal's /networks rows by id, name or platform", () => {
    const rows = [
      { id: "kaia", name: "Kaia", platform: "kaia" },
      { id: "x-layer", name: "X Layer", platform: "x-layer" },
      { id: "sei-evm", name: "Sei V2", platform: "sei-v2" },
      { id: "polygon_pos", name: "Polygon POS", platform: "polygon-pos" },
    ];
    expect(matchNetwork("x layer", rows)?.id).toBe("x-layer");
    expect(matchNetwork("Sei V2", rows)?.id).toBe("sei-evm");
    expect(matchNetwork("polygon pos", rows)?.id).toBe("polygon_pos");
    expect(matchNetwork("kaia network", rows)?.id).toBe("kaia");
    expect(matchNetwork("nowhere", rows)).toBeNull();
  });
});

describe("dex tools: GeckoTerminal pools", () => {
  const pools = gtPools(TRENDING);
  it("reads symbols from `included`, the network from the relationship, numbers from strings", () => {
    expect(pools).toHaveLength(2);
    const [edel, roo] = pools;
    expect(edel.network).toBe("base");
    expect(edel.chainName).toBe("Base");
    expect(edel.base.symbol).toBe("EDEL");
    expect(edel.quote.symbol).toBe("WETH");
    expect(edel.dex).toBe("Aerodrome");
    expect(dexLabel("Uniswap V3 (Robinhood)", "robinhood", "Robinhood Chain")).toBe("Uniswap V3");
    expect(dexLabel("PancakeSwap V3 (BSC)", "bsc", "BNB Chain")).toBe("PancakeSwap V3");
    expect(dexLabel("QuickSwap (Polygon POS)", "polygon_pos", "Polygon")).toBe("QuickSwap");
    expect(dexLabel("Raydium (CLMM)", "solana", "Solana")).toBe("Raydium (CLMM)");
    expect(edel.liquidityUsd).toBe(1337094.3764);
    expect(edel.lockedLiquidityPct).toBe(93.43);
    expect(edel.url).toBe("https://www.geckoterminal.com/base/pools/0x566bee7ef7b39f29d150ab3be6b6242c17cc5a31");
    // A network id with an underscore and no included token row: symbol from the pair name, address from the token id.
    expect(roo.network).toBe("polygon_pos");
    expect(roo.base.symbol).toBe("ROO");
    expect(roo.base.address).toBe("0x3458e003f6ed93df0f537b8acac6fbe08e41247f");
    expect(roo.dex).toBe("uniswap-v4");
  });
  it("derives the network from the pool id when the endpoint omits the relationship", () => {
    const one = { data: { ...TRENDING.data[1], relationships: { ...TRENDING.data[1].relationships, network: undefined } }, included: [] };
    expect(gtPools(one)[0].network).toBe("polygon_pos");
    expect(gtPools(one, "solana")[0].network).toBe("solana");
  });
  it("rounds rows for the model and builds a chip only for a pool with a real market", () => {
    const r = poolRow(pools[0], NOW);
    expect(r.priceUsd).toBe(0.040593);
    expect(r.change24hPct).toBe(20.44);
    expect(r.volume24hUsd).toBe(1806480);
    expect(r.liquidityUsd).toBe(1337094);
    expect(r.symbol).toBe("EDEL");
    const chip = gtChip(pools[0])!;
    expect(chip.id).toBe(`gt:base:${EDEL}`);
    expect(chip.href).toBe(pools[0].url);
    expect(chip.kind).toBe("crypto");
    expect(chip.hl).toBeNull();
    expect(chip.logo).toContain("coingecko");
    expect(poolRow(pools[1], NOW).ageHours).toBe(6);
  });
});

describe("dex tools: movers", () => {
  const mk = (sym: string, addr: string, liq: number, vol: number, h1: number | null, h24: number) => ({
    ...gtPools(TRENDING)[0], base: { address: addr, symbol: sym, name: sym, image: null }, liquidityUsd: liq,
    volume: { h1: null, h6: null, h24: vol }, change: { m5: null, h1, h6: null, h24 },
  });
  const pools = [
    mk("AAA", "0xa", 2_000_000, 5_000_000, 3, 40), mk("AAA", "0xa", 60_000, 900_000, 9, 55), // same token, shallower pool loses
    mk("BBB", "0xb", 80_000, 30_000, 1, 15), mk("DUST", "0xd", 400, 50_000_000, 0, 900), // dust pool with wash volume
    mk("CCC", "0xc", 500_000, 40_000, -2, -30), mk("LOW", "0xe", 100_000, 10_000, 5, 300),
  ];
  it("applies the floors, keeps one pool per token (the deepest) and ranks by the window", () => {
    const g = rankMovers(pools, { window: "h24", direction: "gainers", minLiquidityUsd: 50_000, minVolumeUsd: 25_000 });
    expect(g.ranked.map((p) => p.base.symbol)).toEqual(["AAA", "BBB"]);
    expect(g.ranked[0].liquidityUsd).toBe(2_000_000);
    expect(g.passed).toBe(4);
    const l = rankMovers(pools, { window: "h24", direction: "losers", minLiquidityUsd: 50_000, minVolumeUsd: 25_000 });
    expect(l.ranked.map((p) => p.base.symbol)).toEqual(["CCC"]);
  });
  it("stablecoins and sub-0.5 % moves are not movers (a quiet hour's losers were USDT -0.03 %, EURC -0.02 %)", () => {
    const quiet = [mk("USDT", "0xu", 2_000_000, 900_000, -0.03, -0.1), mk("EURC", "0xe2", 1_000_000, 500_000, -0.02, 0), mk("POD", "0xp", 3_000_000, 800_000, -1.91, 4), mk("VVV", "0xv", 2_000_000, 700_000, -0.3, 1)];
    expect(rankMovers(quiet, { window: "h1", direction: "losers", minLiquidityUsd: 50_000, minVolumeUsd: 25_000 }).ranked.map((p) => p.base.symbol)).toEqual(["POD"]);
    for (const s of ["USDT", "USDC", "USDe", "sUSDe", "USDG", "FDUSD", "PYUSD", "USD1", "crvUSD", "EURC", "DAI", "USDT0", "AUSD"]) expect(STABLE_SYMBOL.test(s)).toBe(true);
    for (const s of ["SOL", "ETH", "cbBTC", "POD", "USUAL", "SUSHI", "DUSK", "www"]) expect(STABLE_SYMBOL.test(s)).toBe(false);
  });
});

describe("dex tools: token pools", () => {
  const BROKER = "0xce24b51766135fb97d330bdcfabcc03d6ad28222";
  const pools = gtPools({
    data: [
      poolJson({ id: "base_0x566bee7ef7b39f29d150ab3be6b6242c17cc5a31", name: "EDEL / WETH", base: `base_${EDEL}`, quote: `base_${WETH}`, dex: "aerodrome-base", price: "0.04059", reserve: "1337094.37", vol24: "1806479.8", h1: "1", h24: "20", created: "2025-11-12T17:00:57Z" }),
      poolJson({ id: "base_0xe2b182796518e76845f46ccdc522495d81630d14", name: "EDEL / USDC 0.3%", base: `base_${EDEL}`, quote: "base_0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", dex: "aerodrome-slipstream-2", price: "0.04040", reserve: "183963.23", vol24: "1805800.9", h1: "1", h24: "19", created: "2025-11-13T00:00:00Z" }),
      poolJson({ id: "base_0x8a1187fd9da7eca25314eab717a10cebc19ffb319d5ebe8123e60b5565aadf23", name: "BROKER / EDEL 0.3%", base: `base_${BROKER}`, quote: `base_${EDEL}`, dex: "uniswap-v4-base", price: "0.000236", qprice: "0.04049", reserve: "65762.64", vol24: "18290.4", h1: "1", h24: "-5", created: "2026-09-01T00:00:00Z" }),
      poolJson({ id: "base_0x8fc30a4297a69ecdf3b90fee1743393f685152d6d751c40e1a19d54b6006a574", name: "GEDEL / EDEL 2%", base: "base_0x2873648f54c0f23372a3f44c5ab41a599ca65069", quote: `base_${EDEL}`, dex: "uniswap-v4-base", price: "0.0000227", qprice: "0.03", reserve: "21068.1", vol24: "0.0", h1: "0", h24: "0", created: "2026-09-02T00:00:00Z" }),
    ],
    included: [],
  }, "base");
  it("prices the token on whichever side it sits, shares liquidity and flags idle pools", () => {
    const s = tokenPoolsSummary(pools, EDEL);
    expect(s.pools).toHaveLength(4);
    expect(s.pools[0].pool).toBe("0x566bee7ef7b39f29d150ab3be6b6242c17cc5a31");
    expect(s.pools[2].side).toBe("quote");
    expect(s.pools[2].priceUsd).toBe(0.04049);
    expect(s.idlePools).toBe(1);
    expect(s.totalLiquidityUsd).toBe(1607888);
    expect(s.priceSpreadPct).toBe(35.3); // the idle 2% hooked pool prices EDEL at 0.03
    expect(deepestPoolFor(pools, EDEL)?.address).toBe("0x566bee7ef7b39f29d150ab3be6b6242c17cc5a31");
    expect(deepestPoolFor(pools, "0x0000000000000000000000000000000000000001")).toBeNull();
  });
  it("picks a ticker's token by liquidity and keeps the look-alikes", () => {
    const hit = pickBySymbol([...pools, ...gtPools({ data: [poolJson({ id: "base_0x9999999999999999999999999999999999999999", name: "EDEL / WETH", base: "base_0x1111111111111111111111111111111111111111", quote: `base_${WETH}`, dex: "x", price: "1", reserve: "500", vol24: "10", h1: "0", h24: "0", created: "2026-10-01T00:00:00Z" })], included: [] }, "base")], "$edel")!;
    expect(hit.address).toBe(EDEL);
    expect(hit.lookAlikes.map((x) => x.address)).toEqual(["0x1111111111111111111111111111111111111111"]);
    expect(pickBySymbol(pools, "nope")).toBeNull();
  });
});

describe("dex tools: OHLCV + trades", () => {
  it("turns GT's newest-first ohlcv_list into oldest-first candles and a window summary", () => {
    const c = ohlcvCandles({ data: { attributes: { ohlcv_list: [
      [1790967600, 0.0376741812077218, 0.0418683571196955, 0.0371524262793253, 0.0405933730189309, 122796.79],
      [1790964000, 0.0385907584197368, 0.0389752612208375, 0.0366109454288546, 0.0376741812077218, 105962.87],
      [1790960400, 0.0394207414681517, 0.0405038005099754, 0.0385907584197368, 0.0385907584197368, 54761.42],
    ] } } });
    expect(c.map((x) => x.ts)).toEqual([1790960400, 1790964000, 1790967600]);
    const s = chartSummary(c)!;
    expect(s.firstUsd).toBe(0.039421);
    expect(s.lastUsd).toBe(0.040593);
    expect(s.changePct).toBe(2.97);
    expect(s.highUsd).toBe(0.041868);
    expect(s.volumeUsd).toBe(283521);
    expect(ohlcvCandles({})).toEqual([]);
    expect(chartSummary([])).toBeNull();
  });
  it("sums buys vs sells and ranks prints and wallets", () => {
    const t = (kind: string, usdV: string, from: string, ts: string) => ({ attributes: { block_timestamp: ts, tx_hash: `0x${ts.length}${usdV}`, tx_from_address: from, kind, from_token_amount: "10", to_token_amount: "250", price_from_in_usd: "0.04", price_to_in_usd: "0.0406", volume_in_usd: usdV } });
    const trades = gtTrades({ data: [
      t("buy", "99.83", "0x93BB867FD3ADADAC5E20AA5F7FD995CA03564F10", "2026-10-02T19:40:33Z"),
      t("sell", "5000", "0x2222222222222222222222222222222222222222", "2026-10-02T19:35:51Z"),
      t("buy", "1200", "0x93bb867fd3adadac5e20aa5f7fd995ca03564f10", "2026-10-02T18:34:59Z"),
      t("weird", "1", "0x3", "2026-10-02T18:00:00Z"),
    ] });
    expect(trades).toHaveLength(3);
    expect(trades[0].priceUsd).toBe(0.0406); // a buy prices the bought (base) token
    expect(trades[1].priceUsd).toBe(0.04);
    const s = summarizeTrades(trades, NOW, 2);
    expect(s.buys).toBe(2);
    expect(s.buyUsd).toBe(1300); // whole dollars from $1k up
    expect(s.sellUsd).toBe(5000);
    expect(s.buySharePct).toBe(20.63);
    expect(s.windowMinutes).toBe(66);
    expect(s.newestMinutesAgo).toBe(19);
    expect(s.largest.map((x) => x.usd)).toEqual([5000, 1200]);
    expect(s.topBuyers[0]).toEqual({ wallet: "0x93bb867fd3adadac5e20aa5f7fd995ca03564f10", boughtUsd: 1300, soldUsd: 0, netUsd: 1300, trades: 2 });
    expect(s.uniqueWallets).toBe(2);
  });
});

describe("dex tools: token info", () => {
  it("keeps the facts, trims third-party text and drops non-https links", () => {
    const i = tokenInfo({ gt_score: 91.04477611940298, gt_verified: true, holders: { count: 32805, distribution_percentage: { top_10: "45.0734" } }, is_honeypot: false,
      mint_authority: null, freeze_authority: null, websites: ["https://edel.finance", "javascript:alert(1)", "http://x.y"], twitter_handle: "edeldotfinance", telegram_handle: "edelfinance",
      description: `Edel Finance is the global lending network for tokenized stocks.\n${"x".repeat(400)}`, categories: [] })!;
    expect(i.gtScore).toBe(91);
    expect(i.holders).toBe(32805);
    expect(i.top10HoldersPct).toBe(45.07);
    expect(i.websites).toEqual(["https://edel.finance"]);
    expect(i.socials).toEqual(["x.com/edeldotfinance", "t.me/edelfinance"]);
    expect(i.description!.length).toBeLessThanOrEqual(200);
    expect(i.description!.includes("\n")).toBe(false);
    expect(tokenInfo(null)).toBeNull();
  });
});

describe("dex tools: DexScreener promotions", () => {
  const feed = [
    { url: "https://dexscreener.com/solana/9y4afmw81vqd26i1c9vx3sebaymbtpiffrcyhqvupump", chainId: "solana", tokenAddress: "9Y4afMW81vqd26i1c9vX3SEbaYMbtPifFRCYHqVUpump", description: "Lucas the viral pug", links: [{ type: "twitter", url: "https://x.com/LucasThePugX" }], totalAmount: 600 },
    { url: "https://dexscreener.com/robinhood/0x7859dfc99f4db48e1aecd8cb1a42f1ba0b0a7012", chainId: "robinhood", tokenAddress: "0x7859dfc99F4DB48e1AECD8CB1a42f1Ba0b0a7012", description: "GENIE", links: [{ label: "Website", url: "https://geniebuild.ai" }], amount: 10, totalAmount: 10 },
    { url: "https://dexscreener.com/robinhood/0x7859dfc99f4db48e1aecd8cb1a42f1ba0b0a7012", chainId: "robinhood", tokenAddress: "0x7859dfc99f4db48e1aecd8cb1a42f1ba0b0a7012", amount: 50, totalAmount: 500 },
  ];
  it("one row per token (largest boost kept), chain filter, links reduced to their kind", () => {
    const rows = promoRows(feed, null);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.chainId === "robinhood")!.boostTotal).toBe(500);
    expect(rows[0].links).toEqual(["twitter"]);
    expect(promoRows(feed, "solana")).toHaveLength(1);
    expect(dsChainId("bnb")).toBe("bsc");
    expect(dsChainId("eth")).toBe("ethereum");
    expect(dsChainId("Robinhood Chain")).toBe("robinhood");
    expect(dsChainId("")).toBeNull();
  });
  it("enriches with the deepest pair per base token", () => {
    const m = dsMarkets([
      { chainId: "robinhood", url: "https://dexscreener.com/robinhood/0xcef3", baseToken: { address: "0x7859dfc99F4DB48e1AECD8CB1a42f1Ba0b0a7012", name: "GENIE AI", symbol: "GENIE" }, priceUsd: "0.01186", priceChange: { h24: -4.92 }, liquidity: { usd: 643380.85 }, volume: { h24: 1370464.86 }, fdv: 11860540, marketCap: 11860540, pairCreatedAt: 1790863708000, txns: { h24: { buys: 4009, sells: 4398 } }, info: { imageUrl: "https://cdn.dexscreener.com/cms/images/N0k" } },
      { chainId: "robinhood", url: "https://dexscreener.com/robinhood/0xdust", baseToken: { address: "0x7859dfc99f4db48e1aecd8cb1a42f1ba0b0a7012", symbol: "GENIE" }, priceUsd: "0.02", liquidity: { usd: 50 }, volume: { h24: 1 } },
    ]);
    const g = m.get("0x7859dfc99f4db48e1aecd8cb1a42f1ba0b0a7012")!;
    expect(g.symbol).toBe("GENIE");
    expect(g.liquidityUsd).toBe(643380.85);
    expect(g.txns24h).toBe(8407);
  });
});

describe("dex tools: GoPlus token safety", () => {
  it("resolves chains by name or id against GoPlus's supported list", () => {
    const list = [{ id: "1", name: "Ethereum" }, { id: "56", name: "BSC" }, { id: "solana", name: "Solana" }, { id: "4663", name: "Robinhood" }, { id: "5042", name: "Arc" }, { id: "59144", name: "Linea Mainnet" }, { id: "480", name: "World Chain" }];
    expect(goplusChainId("bnb", list)).toEqual({ id: "56", name: "BNB Chain" });
    expect(goplusChainId("Robinhood Chain", list)).toEqual({ id: "4663", name: "Robinhood Chain" });
    expect(goplusChainId("linea", list)?.id).toBe("59144");
    expect(goplusChainId("world chain", list)?.id).toBe("480");
    expect(goplusChainId(5042, list)?.name).toBe("Arc");
    expect(goplusChainId("hyperevm", list)).toBeNull();
    expect(goplusChainId("base", list)).toBeNull(); // not in this (trimmed) list
    expect(goplusChainId("base", null)?.id).toBe("8453"); // list unavailable: alias table
    expect(goplusPage("56", "0xabc")).toBe("https://gopluslabs.io/token-security/56/0xabc");
  });
  it("EVM: a clean token lists its ok checks; unknown tax is unknown, not ok", () => {
    const r = goplusEvm({ anti_whale_modifiable: "0", buy_tax: "", can_take_back_ownership: "0", cannot_buy: "0", creator_address: "0xfe6ac1aa09f1b4e900d6a56dce4910e9a1c1f136", creator_percent: "0.000000", dex: [{}, {}], external_call: "0", hidden_owner: "0", holder_count: "32968",
      holders: [{ address: "0x2cde9919e81b20b4b33dd562a48a84b54c48f00c", is_contract: 1, percent: "0.317752052573367083", is_locked: 0 }, { address: "0x88c4c42ed68584ff02f5a00d5d3d985108a3961c", is_contract: 1, percent: "0.041341453068212000", is_locked: 0 }],
      honeypot_with_same_creator: "0", is_anti_whale: "0", is_blacklisted: "0", is_honeypot: "0", is_in_dex: "1", is_mintable: "0", is_open_source: "1", is_proxy: "0", is_whitelisted: "0", owner_address: "0x0000000000000000000000000000000000000000", owner_change_balance: "0", owner_percent: "0.0", selfdestruct: "0", sell_tax: "", slippage_modifiable: "0", token_name: "Edel", token_symbol: "EDEL", trading_cooldown: "0", transfer_pausable: "0" });
    expect(r.worstFlag).toBe("none");
    expect(r.flags.honeypot).toBe(false);
    expect(r.flags.ownerRenounced).toBe(true);
    expect(r.flags.buyTaxPct).toBeNull();
    expect(r.unknown).toContain("Buy / sell tax could not be simulated.");
    expect(r.ok).toContain("Source code verified.");
    expect(r.ok).not.toContain("No buy or sell tax.");
    expect(r.holders.count).toBe(32968);
    expect(r.holders.top10Pct).toBe(35.91);
    expect(r.owner).toBeNull();
  });
  it("EVM: a missing owner_address is unknown, never 'renounced' (GoPlus's partial scan of a proxy)", () => {
    const r = goplusEvm({ is_proxy: "1", is_open_source: "1", is_in_dex: "1", token_symbol: "SFM" });
    expect(r.flags.ownerRenounced).toBeNull();
    expect(r.ok).not.toContain("No owner (ownership renounced).");
    expect(r.unknown).toContain("The owner could not be read.");
  });
  it("EVM: worst flags first (SafeMoon-style proxy + blacklist + unlocked LP)", () => {
    const r = goplusEvm({ buy_tax: "0.1", sell_tax: "0.6", cannot_buy: "0", is_blacklisted: "1", is_honeypot: "0", is_in_dex: "1", is_open_source: "1", is_proxy: "1", slippage_modifiable: "1", owner_address: "0x678ee23173dce625a90ed651e91ca5138149f590", owner_percent: "0.2", token_symbol: "SFM",
      holders: [{ address: "0x0000000000000000000000000000000000000001", percent: "0.6274", is_locked: 1 }, { address: "0x000000000000000000000000000000000000dead", percent: "0.1098", is_locked: 1 }],
      lp_holder_count: "56", lp_holders: [{ address: "0x069156b1e0dd70c99230b53895199c7cfee15f2c", percent: "0.9953645", is_locked: 0 }, { address: "0x1047d31b175468ef16af7bd7f5679656d7332d21", percent: "0.0042839", is_locked: 0 }] });
    expect(r.worstFlag).toBe("high");
    expect(r.risks[0]).toBe("high: Sell tax 60% (simulated).");
    expect(r.risks.some((x) => x.startsWith("medium: Buy tax 10%"))).toBe(true);
    expect(r.risks.some((x) => x.includes("blacklist"))).toBe(true);
    expect(r.risks.some((x) => x.includes("Only 0% of the main pool's LP"))).toBe(true);
    expect(r.risks.some((x) => x.includes("owner wallet holds 20%"))).toBe(true);
    expect(r.holders.top10ExLockedPct).toBe(0); // the 0x…01 and 0x…dead holders are burn addresses
    expect(r.lp.lockedOrBurnedPct).toBe(0);
    const order = r.risks.map((x) => x.split(":")[0]);
    expect(order).toEqual([...order].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)));
  });
  it("Solana: authorities and transfer fee, revoked ones listed as ok", () => {
    const st = (s: string) => ({ authority: s === "1" ? [{ address: "9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw", malicious_address: 0 }] : [], status: s });
    const bonk = goplusSolana({ balance_mutable_authority: st("0"), closable: st("0"), creators: [], default_account_state: "1", default_account_state_upgradable: st("0"), freezable: st("0"),
      holder_count: "1024442", holders: [{ account: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", percent: "0.0883", is_locked: 0 }, { account: "51yZyDSnec4xnUv7XLRVYcDyV4x3wUtzrDcRaYbmQU5j", percent: "0.0679", is_locked: 0 }],
      metadata: { name: "Bonk", symbol: "Bonk" }, metadata_mutable: { metadata_upgrade_authority: [{ address: "9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw", malicious_address: 0 }], status: "1" }, mintable: st("0"), non_transferable: "0", transfer_fee: {}, transfer_fee_upgradable: st("0"), transfer_hook: [], transfer_hook_upgradable: st("0"), trusted_token: 0 });
    expect(bonk.worstFlag).toBe("low");
    expect(bonk.risks).toEqual(["low: Metadata (name, logo) can still be changed."]);
    expect(bonk.ok).toContain("Mint authority revoked.");
    expect(bonk.ok).toContain("Freeze authority revoked.");
    expect(bonk.holders.top10Pct).toBe(15.62);
    expect(bonk.token.symbol).toBe("Bonk");
    const bad = goplusSolana({ freezable: st("1"), mintable: st("1"), transfer_fee: { current_fee_rate: { fee_rate: "0.12", maximum_fee: "1" } }, transfer_hook: [{ address: "Hook111", malicious_address: 0 }], metadata: { symbol: "RUG" } });
    expect(bad.worstFlag).toBe("high");
    expect(bad.risks[0].startsWith("high:")).toBe(true);
    expect(bad.flags.transferFeePct).toBe(12);
    expect(bad.risks.some((x) => x.includes("Freeze authority is live"))).toBe(true);
    expect(bad.risks.some((x) => x.includes("transfer hook"))).toBe(true);
    expect(bad.authorities.freeze).toEqual(["9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw"]);
  });
});

describe("dex tools: formatting", () => {
  it("rounds and trims the way the brief says", () => {
    expect(sig(0.0000002320301110115)).toBe(2.3203e-7);
    expect(usd(1806479.81587469)).toBe(1806480);
    expect(usd(99.8335)).toBe(99.83);
    expect(ageLabel(0.5)).toBe("30m");
    expect(ageLabel(13.2)).toBe("13h");
    expect(ageLabel(24 * 12)).toBe("12d");
    expect(ageLabel(null)).toBe("n/a");
    expect(clean("a\u2028b\n  c", 200)).toBe("a b c");
    expect(clean("x".repeat(300), 10).length).toBe(10);
    expect(isAddressLike("0x566bee7ef7b39f29d150ab3be6b6242c17cc5a31")).toBe(true);
    expect(isAddressLike("9Y4afMW81vqd26i1c9vX3SEbaYMbtPifFRCYHqVUpump")).toBe(true);
    expect(isAddressLike("PONS")).toBe(false);
    expect(normAddr("0xABC")).toBe("0xabc");
    expect(normAddr("9Y4afMW81vqd")).toBe("9Y4afMW81vqd");
  });
});
