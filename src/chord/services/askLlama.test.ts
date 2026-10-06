import { afterEach, describe, expect, it } from "bun:test";
import { findChain, findFlow, findProtocol, flowOf, pickPools, protocols, rankFlows, rankTvl, resolveProtocol, slimPools, slimProtocols, slimStables, type AskLlamaProtocol, type LlamaFlow } from "./askLlama";
import { mockFetch, resetRedis, type MockFetchHandle } from "../testkit/helpers";

const P: AskLlamaProtocol[] = slimProtocols([
  { name: "Aave V3", slug: "aave-v3", symbol: "AAVE", category: "Lending", tvl: 30e9, change_1d: 0.5, change_7d: 2, mcap: 4e9, parentProtocol: "parent#aave", chainTvls: { Ethereum: 20e9, "Ethereum-borrowed": 9e9, Arbitrum: 3e9, borrowed: 1, staking: 2 } },
  { name: "Aave V2", slug: "aave-v2", symbol: "AAVE", category: "Lending", tvl: 1e9, chainTvls: { Ethereum: 1e9 } },
  { name: "Hyperliquid Bridge", slug: "hyperliquid-bridge", symbol: "HYPE", category: "Bridge", tvl: 5e9, chainTvls: { Arbitrum: 5e9 } },
  { name: "Binance CEX", slug: "binance-cex", symbol: "BNB", category: "CEX", tvl: 179e9, chainTvls: { Ethereum: 50e9 } },
  { name: "GMX", slug: "gmx", symbol: "GMX", category: "Derivatives", tvl: 4e8, chainTvls: { Arbitrum: 3e8, Avalanche: 1e8 } },
]);

describe("askLlama picking", () => {
  it("protocols: exact slug / name first, then ticker (biggest TVL), then a name prefix; chain TVL without borrowed/staking", () => {
    expect(findProtocol("aave-v2", P)?.slug).toBe("aave-v2");
    expect(findProtocol("AAVE", P)?.slug).toBe("aave-v3");
    expect(findProtocol("Hyperliquid", P)?.slug).toBe("hyperliquid-bridge");
    expect(findProtocol("zz", P)).toBeNull();
    expect(P[0].chains).toEqual([{ chain: "Ethereum", tvl: 20e9 }, { chain: "Arbitrum", tvl: 3e9 }]);
  });
  it("TVL ranking skips CEXes and ranks by the chain's TVL when a chain is given", () => {
    expect(rankTvl(P, {}).map((p) => p.slug)).toEqual(["aave-v3", "hyperliquid-bridge", "aave-v2", "gmx"]);
    expect(rankTvl(P, { chain: "arbitrum" }).map((p) => p.slug)).toEqual(["hyperliquid-bridge", "aave-v3", "gmx"]);
    expect(rankTvl(P, { category: "lending", limit: 1 }).map((p) => p.slug)).toEqual(["aave-v3"]);
  });
  it("fees / revenue: match a protocol, rank with filters", () => {
    const F: LlamaFlow[] = [
      { name: "Aave V3", slug: "aave-v3", category: "Lending", d24: 2e6, d7: 14e6, d30: 60e6, change1d: 1, change7d: 3, chains: ["Ethereum"], parent: null },
      { name: "Hyperliquid Perps", slug: "hyperliquid-perps", category: "Derivatives", d24: 5e6, d7: 30e6, d30: 120e6, change1d: -2, change7d: 5, chains: ["Hyperliquid L1"], parent: null },
    ];
    expect(findFlow({ name: "Aave V3", slug: "aave-v3" }, F)?.d24).toBe(2e6);
    expect(findFlow({ name: "Hyperliquid", slug: "hyperliquid-bridge" }, F)?.slug).toBe("hyperliquid-perps");
    expect(rankFlows(F, {}).map((f) => f.slug)).toEqual(["hyperliquid-perps", "aave-v3"]);
    expect(rankFlows(F, { category: "lending" }).map((f) => f.slug)).toEqual(["aave-v3"]);
  });
  it("yields: TVL floor, no absurd APY, token / chain / stable filters", () => {
    const pools = slimPools({ data: [
      { chain: "Arbitrum", project: "aave-v3", symbol: "USDC", tvlUsd: 80e6, apy: 6.1, apyBase: 6.1, stablecoin: true, ilRisk: "no", exposure: "single" },
      { chain: "Arbitrum", project: "gmx-v2", symbol: "WETH-USDC", tvlUsd: 40e6, apy: 18, apyBase: 12, apyReward: 6, stablecoin: false, ilRisk: "yes", exposure: "multi" },
      { chain: "Ethereum", project: "scam", symbol: "USDC", tvlUsd: 9e6, apy: 5000, stablecoin: true },
      { chain: "Base", project: "tiny", symbol: "USDC", tvlUsd: 900_000, apy: 30, stablecoin: true },
    ] });
    expect(pools.length).toBe(3);
    expect(pickPools(pools, {}).map((p) => p.project)).toEqual(["gmx-v2", "aave-v3"]);
    expect(pickPools(pools, { stableOnly: true }).map((p) => p.project)).toEqual(["aave-v3"]);
    expect(pickPools(pools, { token: "weth" }).map((p) => p.project)).toEqual(["gmx-v2"]);
    expect(pickPools(pools, { chain: "ethereum" })).toEqual([]);
  });
  it("stablecoins: supply and 1d / 7d / 30d change", () => {
    const s = slimStables({ peggedAssets: [{ name: "Tether", symbol: "USDT", pegType: "peggedUSD", circulating: { peggedUSD: 110 }, circulatingPrevDay: { peggedUSD: 100 }, circulatingPrevWeek: { peggedUSD: 100 }, circulatingPrevMonth: { peggedUSD: 55 }, price: 0.9998 }] });
    expect(s[0]).toEqual({ name: "Tether", symbol: "USDT", peg: "USD", mechanism: null, supply: 110, d1: 10, d7: 10, d30: 100, price: 0.9998 });
  });
});

describe("askLlama cache", () => {
  let fx: MockFetchHandle | null = null;
  afterEach(() => { fx?.restore(); fx = null; resetRedis(); });
  it("one fetch for concurrent callers; the slim list is cached", async () => {
    let n = 0;
    fx = mockFetch({ "api.llama.fi/protocols": () => { n++; return [{ name: "GMX", slug: "gmx", tvl: 4e8, chainTvls: { Arbitrum: 4e8 } }]; } });
    const [a, b] = await Promise.all([protocols(), protocols()]);
    const c = await protocols();
    expect(a.data[0].slug).toBe("gmx");
    expect(b.data[0].slug).toBe("gmx");
    expect(c.data[0].slug).toBe("gmx");
    expect(n).toBe(1);
  });
});

describe("askLlama families", () => {
  it("a parent id sums its members (TVL, chains, weighted change); an exact name stays one protocol", () => {
    const L = slimProtocols([
      { name: "Uniswap V3", slug: "uniswap-v3", symbol: "UNI", category: "Dexs", tvl: 300, change_1d: 50, parentProtocol: "parent#uniswap", chainTvls: { Ethereum: 200, Base: 100 } },
      { name: "Uniswap V2", slug: "uniswap-v2", symbol: "UNI", category: "Dexs", tvl: 100, change_1d: 0, parentProtocol: "parent#uniswap", chainTvls: { Ethereum: 100 } },
      { name: "GMX", slug: "gmx", tvl: 50, chainTvls: { Arbitrum: 50 } },
    ]);
    const u = resolveProtocol("uniswap", L)!;
    expect(u.family).toBe(true);
    expect(u.name).toBe("Uniswap");
    expect(u.tvl).toBe(400);
    expect(u.change1d).toBe(33.33); // 400 now vs 200 + 100 before
    expect(u.chains).toEqual([{ chain: "Ethereum", tvl: 300 }, { chain: "Base", tvl: 100 }]);
    expect(resolveProtocol("uniswap-v2", L)!.family).toBe(false);
    expect(resolveProtocol("UNI", L)!.slug).toBe("uniswap-v3");
    const F: LlamaFlow[] = [
      { name: "Uniswap V3", slug: "uniswap-v3", category: "Dexs", d24: 10, d7: 70, d30: 300, change1d: 0, change7d: null, chains: [], parent: "parent#uniswap" },
      { name: "Uniswap V4", slug: "uniswap-v4", category: "Dexs", d24: 20, d7: 140, d30: 600, change1d: 100, change7d: null, chains: [], parent: "parent#uniswap" },
    ];
    expect(flowOf(u, F)).toEqual({ d24: 30, d7: 210, d30: 900, change1d: 50, members: ["Uniswap V3", "Uniswap V4"] });
  });
});

describe("askLlama chains", () => {
  it("names as people write them, aliases, TVL-sorted prefix", () => {
    const C = [{ name: "Ethereum" }, { name: "Solana" }, { name: "BSC" }, { name: "Hyperliquid L1" }, { name: "Base" }];
    expect(findChain("eth", C)?.name).toBe("Ethereum");
    expect(findChain("hyperliquid", C)?.name).toBe("Hyperliquid L1");
    expect(findChain("BNB", C)?.name).toBe("BSC");
    expect(findChain("base", C)?.name).toBe("Base");
    expect(findChain("zz", C)).toBeNull();
  });
  it("fees ranking leaves L1 gas rows out unless asked", () => {
    const F: LlamaFlow[] = [
      { name: "Ethereum", slug: "ethereum", category: "Chain", d24: 9e6, d7: null, d30: null, change1d: null, change7d: null, chains: ["Ethereum"], parent: null },
      { name: "Aave V3", slug: "aave-v3", category: "Lending", d24: 2e6, d7: null, d30: null, change1d: null, change7d: null, chains: ["Ethereum"], parent: null },
    ];
    expect(rankFlows(F, {}).map((f) => f.slug)).toEqual(["aave-v3"]);
    expect(rankFlows(F, { category: "chain" }).map((f) => f.slug)).toEqual(["ethereum"]);
  });
});
