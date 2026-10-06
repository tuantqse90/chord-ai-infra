import { describe, expect, it } from "bun:test";
import {
  YIELD_TOOL_META, YIELD_TOOL_NAMES, YIELD_TOOL_SCHEMAS, assetTargets, fromWei, isYieldTool, matchAssets, mergeVaults, morphoMarketRow,
  morphoMarketUrl, morphoPositionRows, morphoPositionsQuery, morphoVaultRow, morphoVaultUrl, parsePendleQuery, parseYieldChain,
  pendleHistory, pendleMarketUrl, pendleOpenPositions, pendleRow, pickPendleMarket, ptPriceInAsset, runYieldTool, screenPendle,
} from "./yieldTools";

const NOW = Date.parse("2026-10-03T00:00:00Z");

// Trimmed from api-v2.pendle.finance/core/v2/markets/all?isActive=true (2026-10-03).
const PENDLE_MARKETS = [
  { name: "wstETH", protocol: "Lido", address: "0x34280882267ffa6383b363e278b027be083bbe3b", expiry: "2027-12-30T00:00:00.000Z", chainId: 1, pt: "1-0xb253eff1104802b97ac7e3ac9fdd73aece295a2c", yt: "1-0x04b7fa1e727d7290d6e24fa9b426d0c940283a95", sy: "1-0xcbc72d92b2dc8187414f6734718563898740c0bc", underlyingAsset: "1-0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", categoryIds: ["eth", "blue-chips", "lido"], points: [], details: { liquidity: 5469291.381667378, totalTvl: 6007667.266790732, tradingVolume: 0, underlyingApy: 0.022696769372047232, impliedApy: 0.021134522630000818, aggregatedApy: 0.02358207350462902, maxBoostedApy: 0.024980078689637277, ptRoi: 0.026306314431696398 } },
  { name: "sUSDe", protocol: "Ethena", address: "0x2142267022ecde6745de9f577e3ba4549ad23abc", expiry: "2026-10-22T00:00:00.000Z", chainId: 143, pt: "143-0xd236e83c563f888f540ca997c3ddf00e82d68c45", yt: "143-0x758119e49319b91332eebd6fcbecd9e0387de16b", sy: "143-0x06fc2568fa3c8a9862d8f35bc6758355b3a32f51", underlyingAsset: "143-0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", categoryIds: ["stables", "ethena", "points", "rwa", "blue-chips", "lp-with-no-il"], points: [{ key: "Ethena sats" }], details: { liquidity: 21417220.528295305, totalTvl: 21475531.683432326, tradingVolume: 277163.4699429182, underlyingApy: 0.05108701782213099, impliedApy: 0.051959380425253165, aggregatedApy: 0.11299951314466086, maxBoostedApy: 0.20543491373488923, ptRoi: 0.0026636494754608275 } },
  { name: "sNET", protocol: "NetNet", address: "0xd5d418f95715bc0fadb35923d389fe3f627df80a", expiry: "2026-10-15T00:00:00.000Z", chainId: 4663, pt: "4663-0xc50f040f9a38f7cd94fe87be56325eaac48e770e", yt: "4663-0x3d9e0f83834e015d25d07444de0296359ebfb6e3", sy: "4663-0x5d446a2be952f4f9ba241b382a73ad3b1819aaf5", underlyingAsset: "4663-0x53176cadd446700fa6b89f840357ac586d7e33db", categoryIds: ["rwa"], points: [], details: { liquidity: 191390.2544567908, totalTvl: 220694.8030017916, tradingVolume: 29406.742698310696, underlyingApy: 4.841317019742522, impliedApy: 39.165808407864276, aggregatedApy: 10.725852845117776, maxBoostedApy: 10.725852845117776, ptRoi: 0.1310120287242953 } },
];

describe("chains", () => {
  it("reads chain names, short names and ids", () => {
    expect(parseYieldChain("eth")?.id).toBe(1);
    expect(parseYieldChain("Arbitrum")?.id).toBe(42161);
    expect(parseYieldChain("arb")?.id).toBe(42161);
    expect(parseYieldChain("bsc")?.id).toBe(56);
    expect(parseYieldChain("BNB Chain")?.id).toBe(56);
    expect(parseYieldChain(8453)?.name).toBe("Base");
    expect(parseYieldChain("robinhood")?.id).toBe(4663);
    expect(parseYieldChain("hyperliquid")?.id).toBe(999);
    expect(parseYieldChain("solana")).toBeNull();
    expect(parseYieldChain("")).toBeNull();
    expect(parseYieldChain(12345)).toBeNull();
  });
  it("knows which protocol runs where (BNB: Pendle yes, Morpho no)", () => {
    expect(parseYieldChain("bnb")?.pendle).toBe("bnbchain");
    expect(parseYieldChain("bnb")?.morpho).toBeUndefined();
    expect(parseYieldChain("polygon")?.pendle).toBeUndefined();
    expect(parseYieldChain("op")?.morpho).toBe("opmainnet");
  });
  it("links the real app pages", () => {
    expect(pendleMarketUrl("0x34280882267FFA6383B363E278B027BE083BBE3B", 1)).toBe("https://app.pendle.finance/trade/markets/0x34280882267ffa6383b363e278b027be083bbe3b?chain=ethereum");
    expect(pendleMarketUrl("0x25f241538bc3de8f7130706827b3f6946db51f5d", 4663)).toContain("?chain=robinhood");
    expect(morphoVaultUrl(4663, "0xBeEff033F34C046626B8D0A041844C5d1A5409dd")).toBe("https://app.morpho.org/robinhood-chain/vault/0xBeEff033F34C046626B8D0A041844C5d1A5409dd");
    expect(morphoMarketUrl(8453, "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836")).toBe("https://app.morpho.org/base/market/0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836");
    expect(morphoVaultUrl(56, "0x0000000000000000000000000000000000000001")).toBe("https://app.morpho.org");
  });
});

describe("Pendle normalizers", () => {
  it("PT price in the asset: Pendle's ptRoi first, else the implied APY over the days left", () => {
    expect(ptPriceInAsset({ ptRoi: 0.026306314431696398 }, 453)).toBeCloseTo(0.97437, 4);
    // Same market priced from implied APY alone (2.1134 % over 453 days) lands within a basis point.
    expect(ptPriceInAsset({ impliedApy: 0.021134522630000818 }, 453)).toBeCloseTo(0.97437, 3);
    expect(ptPriceInAsset({ ptRoi: 0.5 }, 0)).toBe(1);
    expect(ptPriceInAsset({}, 30)).toBeNull();
  });
  it("one market → the compact row", () => {
    const r = pendleRow(PENDLE_MARKETS[0], NOW)!;
    expect(r).toMatchObject({ market: "wstETH", protocol: "Lido", chain: "Ethereum", chainId: 1, expiry: "2027-12-30", daysLeft: 453, impliedApyPct: 2.11, underlyingApyPct: 2.27, lpApyPct: 2.36, liquidityUsd: 5469291, tvlUsd: 6007667, volume24hUsd: 0 });
    expect(r.ptDiscountPct).toBeCloseTo(2.56, 2);
    expect(pendleRow(PENDLE_MARKETS[1], NOW)!.points).toEqual(["Ethena sats"]);
    expect(pendleRow({ name: "x", chainId: 1, address: "nope" }, NOW)).toBeNull();
  });
  it("screens by chain, asset and category; sorts; drops thin pools", () => {
    const base = { sort: "implied_apy" as const, minLiquidityUsd: 100_000, limit: 10 };
    expect(screenPendle(PENDLE_MARKETS, base, NOW).rows.map((r) => r.market)).toEqual(["sNET", "sUSDe", "wstETH"]);
    expect(screenPendle(PENDLE_MARKETS, { ...base, minLiquidityUsd: 200_000 }, NOW).rows.map((r) => r.market)).toEqual(["sUSDe", "wstETH"]);
    expect(screenPendle(PENDLE_MARKETS, { ...base, chainId: 143 }, NOW).rows.map((r) => r.market)).toEqual(["sUSDe"]);
    // "eth" is a name / category, not a prefix of the Ethena protocol.
    expect(screenPendle(PENDLE_MARKETS, { ...base, asset: "eth" }, NOW).rows.map((r) => r.market)).toEqual(["wstETH"]);
    expect(screenPendle(PENDLE_MARKETS, { ...base, asset: "ethena" }, NOW).rows.map((r) => r.market)).toEqual(["sUSDe"]);
    expect(screenPendle(PENDLE_MARKETS, { ...base, asset: "stablecoins" }, NOW).rows.map((r) => r.market)).toEqual(["sUSDe"]);
    expect(screenPendle(PENDLE_MARKETS, { ...base, sort: "expiry" }, NOW).rows.map((r) => r.market)).toEqual(["sNET", "sUSDe", "wstETH"]);
    expect(screenPendle(PENDLE_MARKETS, { ...base, sort: "tvl", limit: 1 }, NOW)).toMatchObject({ matched: 3, rows: [{ market: "sUSDe" }] });
  });
  it("reads PT / YT names and expiry hints", () => {
    expect(parsePendleQuery("PT-sUSDe-26NOV2026")).toEqual({ name: "sUSDe", expiry: "2026-11-26" });
    expect(parsePendleQuery("yt weETH dec 2026")).toEqual({ name: "weETH", expiry: "2026-12" });
    expect(parsePendleQuery("USDai 2027-02")).toEqual({ name: "USDai", expiry: "2027-02" });
    expect(parsePendleQuery("$wstETH")).toEqual({ name: "wstETH", expiry: null });
  });
  it("picks one market by address or name, the rest as alternatives", () => {
    expect(pickPendleMarket(PENDLE_MARKETS, "0x2142267022ECDE6745DE9F577E3BA4549AD23ABC")?.pick.chainId).toBe(143);
    expect(pickPendleMarket(PENDLE_MARKETS, "PT-sUSDe-22OCT2026")?.pick.chainId).toBe(143);
    expect(pickPendleMarket(PENDLE_MARKETS, "sUSDe", 1)).toBeNull();
    expect(pickPendleMarket(PENDLE_MARKETS, "PT-sUSDe-26NOV2026")).toBeNull();
    expect(pickPendleMarket(PENDLE_MARKETS, "Lido")?.pick.name).toBe("wstETH");
    const two = [...PENDLE_MARKETS, { ...PENDLE_MARKETS[1], address: "0x9cbc42eff240ad2e43bbdc3c0562a9b4ce842a5a", expiry: "2026-12-17T00:00:00.000Z", details: { ...PENDLE_MARKETS[1].details, totalTvl: 1_000 } }];
    const hit = pickPendleMarket(two, "susde")!;
    expect(hit.pick.expiry).toBe("2026-10-22T00:00:00.000Z");
    expect(hit.alternatives.map((m) => m.expiry)).toEqual(["2026-12-17T00:00:00.000Z"]);
  });
  it("history → a sorted daily line in percent", () => {
    const h = pendleHistory([
      { timestamp: "2026-10-02T00:00:00.000Z", underlyingApy: 0.022696769372047232, impliedApy: 0.021134527539016457, tvl: 5469291.381667378 },
      { timestamp: "2026-09-30T00:00:00.000Z", underlyingApy: 0.02285891130912221, impliedApy: 0.021081113403782714, tvl: 5506668.206526583 },
      { timestamp: "2026-10-01T00:00:00.000Z", underlyingApy: 0.022779831426282593, impliedApy: 0.02113452752600109, tvl: 5547726.912514583 },
    ]);
    expect(h).toEqual({ x: ["09-30", "10-01", "10-02"], implied: [2.11, 2.11, 2.11], underlying: [2.29, 2.28, 2.27], tvl: [5506668, 5547727, 5469291] });
  });
  it("positions: open markets by value, non-zero SY, every claim", () => {
    const raw = { positions: [
      { chainId: 1, openPositions: [{ marketId: "1-0x34280882267ffa6383b363e278b027be083bbe3b", pt: { valuation: 0, balance: "0" }, yt: { valuation: 76.72897098124858, balance: "1123090178902078671", claimTokenAmounts: [{ token: "1-0xcbc72d92b2dc8187414f6734718563898740c0bc", amount: "1404775245654917" }] }, lp: { valuation: 65380.80366010716, balance: "11022613586640055420", activeBalance: "4429361484796112080", claimTokenAmounts: [{ token: "1-0x808507121b80c02388fad14726482e061b8da827", amount: "4070590148022494690" }] }, crossPtPositions: [] }], closedPositions: [], syPositions: [{ syId: "1-0x730a5e2acebccaa5e9095723b3cb862739da793c", balance: "54389008130610285" }, { syId: "1-0x253008ba4ae2f3e6488dc998a5321d4eb1a0c905", balance: "0" }] },
      { chainId: 8453, openPositions: [{ marketId: "8453-0x829a0d0b0261a3b96208631c19d5380422e2ca54", pt: { valuation: 0, balance: "0" }, yt: { valuation: 0, balance: "1025638149088447848", claimTokenAmounts: [{ token: "8453-0xe574de45b4ea2c5db7dd6f4074349f270ee97c64", amount: "1136885005552548" }] }, lp: { valuation: 27728.53371103607, balance: "4685020238593292701", claimTokenAmounts: [{ token: "8453-0xa99f6e6785da0f5d6fb42495fe424bce029eeb3e", amount: "344754281716519862" }] }, crossPtPositions: [] }], closedPositions: [], syPositions: [] },
    ] };
    const p = pendleOpenPositions(raw);
    expect(p.open.map((x) => [x.chainId, x.address, Math.round(x.totalUsd)])).toEqual([[1, "0x34280882267ffa6383b363e278b027be083bbe3b", 65458], [8453, "0x829a0d0b0261a3b96208631c19d5380422e2ca54", 27729]]);
    expect(p.open[0].claims.map((c) => c.token)).toEqual(["1-0xcbc72d92b2dc8187414f6734718563898740c0bc", "1-0x808507121b80c02388fad14726482e061b8da827"]);
    expect(p.sy).toEqual([{ id: "1-0x730a5e2acebccaa5e9095723b3cb862739da793c", chainId: 1, balance: "54389008130610285", claims: [] }]);
    expect(pendleOpenPositions({ positions: [] })).toEqual({ open: [], sy: [], chainsSeen: [] });
    expect(fromWei("54389008130610285", 18)).toBeCloseTo(0.054389, 6);
    expect(fromWei("1000", null)).toBeNull();
  });
});

describe("Morpho normalizers", () => {
  it("resolves a symbol to exact matches only (case-insensitive, chain-scoped)", () => {
    expect(assetTargets("eth")).toEqual(["eth", "WETH"]);
    expect(assetTargets("$USDC")).toEqual(["USDC"]);
    const resp = {
      e0: { items: [{ symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chain: { id: 1 } }, { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: { id: 8453 } }] },
      f0: { items: [{ symbol: "sUSDC", address: "0x0000000000000000000000000000000000000abc", chain: { id: 8453 } }, { symbol: "usdc", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: { id: 8453 } }] },
    };
    expect(matchAssets(resp, 0, ["USDC"], 8453)).toEqual(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]);
    expect(matchAssets(resp, 0, ["USDC"]).length).toBe(2);
  });
  // Trimmed from api.morpho.org/graphql vaults + vaultV2s, Base USDC (2026-10-03).
  const VAULTS = {
    v1: { items: [{ address: "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F", name: "Steakhouse High Yield USDC v1.1", chain: { id: 8453 }, asset: { symbol: "USDC" }, state: { totalAssetsUsd: 1039836.5022248757, apy: 0.052767839445897594, netApy: 0.052767839445897594, fee: 0, curators: [{ name: "Steakhouse Financial" }], allRewards: [] }, liquidity: { usd: 986120.7231354224 }, warnings: [] }] },
    v2: { items: [
      { address: "0x8B12106a70FE2F8bB255F691f1CF9a9ccfB278AF", name: "Noon Ecosystem Vault", chain: { id: 8453 }, asset: { symbol: "USDC" }, totalAssetsUsd: 3042890.309679933, liquidityUsd: 330123.31073004415, apy: 0.035402864932504455, netApy: 0.08001359748351798, performanceFee: 0.15, managementFee: 0, curators: { items: [{ name: "Clearstar" }] }, rewards: [{ asset: { symbol: "USDC" }, supplyApr: 0.05000000000102474 }], warnings: [] },
      { address: "0x392B3CCf36C8adB8094F45573346B457414cD752", name: "KPK USDC Yield", chain: { id: 8453 }, asset: { symbol: "USDC" }, totalAssetsUsd: 3801517.980600779, liquidityUsd: 1116974.8187542162, apy: 0.060948457168500364, netApy: 0.07205064759530934, performanceFee: 0, managementFee: 0, curators: { items: [{ name: "KPK" }] }, rewards: [{ asset: { symbol: "USDC" }, supplyApr: 0.011102190426808973 }], warnings: [{ type: "short_timelock", level: "YELLOW" }] },
    ] },
  };
  it("V1 and V2 vaults → one row shape", () => {
    expect(morphoVaultRow(VAULTS.v1.items[0], "V1")).toMatchObject({ name: "Steakhouse High Yield USDC v1.1", version: "V1", curator: "Steakhouse Financial", chain: "Base", asset: "USDC", netApyPct: 5.28, tvlUsd: 1039837, liquidityUsd: 986121, performanceFeePct: 0, warnings: [] });
    expect(morphoVaultRow(VAULTS.v2.items[0], "V2")).toMatchObject({ version: "V2", curator: "Clearstar", netApyPct: 8, apyPct: 3.54, rewards: [{ token: "USDC", aprPct: 5 }], performanceFeePct: 15, managementFeePct: 0 });
    expect(morphoVaultRow(VAULTS.v2.items[1], "V2")!.warnings).toEqual(["short timelock (yellow)"]);
    expect(morphoVaultRow({ address: "bad" }, "V1")).toBeNull();
  });
  it("merges both versions and sorts by net APY or TVL", () => {
    expect(mergeVaults(VAULTS, "apy", 10).map((v) => v.name)).toEqual(["Noon Ecosystem Vault", "KPK USDC Yield", "Steakhouse High Yield USDC v1.1"]);
    expect(mergeVaults(VAULTS, "tvl", 2).map((v) => v.name)).toEqual(["KPK USDC Yield", "Noon Ecosystem Vault"]);
  });
  it("a market → pair, LLTV in percent, rates", () => {
    const m = { marketId: "0x3a4048c64ba1b375330d376b1ce40e4047d03b47ab4d48af484edec9fec801ba", lltv: "945000000000000000", chain: { id: 8453 }, loanAsset: { symbol: "WETH" }, collateralAsset: { symbol: "wstETH" }, state: { supplyApy: 0.015116349154176577, borrowApy: 0.016832039307651404, netSupplyApy: 0.015116349154176577, netBorrowApy: 0.016832039307651404, utilization: 0.8988306492454066, supplyAssetsUsd: 7970042.923378437, borrowAssetsUsd: 7163718.855334, liquidityAssetsUsd: 806433.4507721029, collateralAssetsUsd: 8007548.033839775, rewards: [] }, warnings: [] };
    const r = morphoMarketRow(m)!;
    expect(r).toMatchObject({ pair: "wstETH/WETH", chain: "Base", lltvPct: 94.5, supplyApyPct: 1.51, borrowApyPct: 1.68, utilizationPct: 89.88, suppliedUsd: 7970043, liquidityUsd: 806433 });
    expect("netSupplyApyPct" in r).toBe(false); // same as the base rate: not repeated
    expect(morphoMarketRow({ ...m, marketId: "0x12" })).toBeNull();
  });
  it("positions: dust dropped, health factor and distance to liquidation, < 1.1 flagged", () => {
    const pos = (hf: number) => ({
      c1: { marketPositions: [], vaultPositions: [], vaultV2Positions: [] },
      c8453: {
        marketPositions: [
          { healthFactor: null, priceVariationToLiquidationPrice: null, market: { marketId: "0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109", lltv: "625000000000000000", loanAsset: { symbol: "USDC" }, collateralAsset: { symbol: "cbXRP" }, state: { borrowApy: 0.0618, supplyApy: 0.0554 } }, state: { collateralUsd: 0, borrowAssetsUsd: 0, supplyAssetsUsd: 0 } },
          { healthFactor: hf, priceVariationToLiquidationPrice: -0.397496045892746, market: { marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836", lltv: "860000000000000000", loanAsset: { symbol: "USDC" }, collateralAsset: { symbol: "cbBTC" }, state: { borrowApy: 0.049687397714664745, supplyApy: 0.04465600849421896 } }, state: { collateralUsd: 9932091.001711147, borrowAssetsUsd: 5148450.327779598, supplyAssetsUsd: 0 } },
        ],
        vaultPositions: [],
        vaultV2Positions: [{ vault: { address: "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9", name: "Steakhouse Prime USDC", asset: { symbol: "USDC" }, netApy: 0.044 }, assetsUsd: 7063945.7 }, { vault: { address: "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9", name: "dust", asset: { symbol: "USDC" }, netApy: 0.04 }, assetsUsd: 0.2 }],
      },
    });
    const r = morphoPositionRows(pos(1.6597401447459816));
    expect(r.markets).toEqual([{ chain: "Base", chainId: 8453, pair: "cbBTC/USDC", lltvPct: 86, collateralUsd: 9932091, borrowedUsd: 5148450, suppliedUsd: 0, healthFactor: 1.66, priceDropToLiquidationPct: 39.75, borrowApyPct: 4.97, supplyApyPct: 4.47, nearLiquidation: false, marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" }]);
    expect(r.vaults).toEqual([{ chain: "Base", chainId: 8453, vault: "Steakhouse Prime USDC", version: "V2", asset: "USDC", usd: 7063946, netApyPct: 4.4, address: "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9" }]);
    expect(morphoPositionRows(pos(1.05)).markets[0].nearLiquidation).toBe(true);
    expect(morphoPositionsQuery([1, 8453])).toContain("c8453: userByAddress(address: $a, chainId: 8453)");
  });
});

describe("yield tool wiring", () => {
  it("every tool has a schema, a registry row in group 'yield' and is recognised", () => {
    const names = YIELD_TOOL_SCHEMAS.map((s) => s.function.name);
    expect(names).toEqual([...YIELD_TOOL_NAMES]);
    for (const n of YIELD_TOOL_NAMES) {
      expect(YIELD_TOOL_META[n]?.group).toBe("yield");
      expect(YIELD_TOOL_META[n]?.label.length).toBeGreaterThan(5);
      expect(isYieldTool(n)).toBe(true);
    }
    expect(Object.keys(YIELD_TOOL_META).sort()).toEqual([...YIELD_TOOL_NAMES].sort());
    for (const s of YIELD_TOOL_SCHEMAS) expect(s.function.description).toContain("Use for");
    expect(isYieldTool("llama_yields")).toBe(false);
  });
  it("bad input answers an error without calling anything", async () => {
    expect((await runYieldTool("pendle_positions", { wallet: "vitalik.eth" })).data).toMatchObject({ error: expect.stringContaining("0x address") });
    expect((await runYieldTool("morpho_positions", { wallet: "0x12" })).data).toMatchObject({ error: expect.any(String) });
    expect((await runYieldTool("morpho_vaults", { chain: "bnb" })).data).toMatchObject({ error: expect.stringContaining("Morpho is not on") });
    expect((await runYieldTool("pendle_markets", { chain: "polygon" })).data).toMatchObject({ error: expect.stringContaining("Pendle is not on") });
    expect((await runYieldTool("pendle_market", {})).data).toMatchObject({ error: expect.any(String) });
    expect((await runYieldTool("no_such_tool", {})).data).toMatchObject({ error: "unknown tool no_such_tool" });
  });
});
