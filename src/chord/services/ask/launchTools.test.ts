import { describe, expect, it } from "bun:test";
import {
  LAUNCH_TOOL_META, LAUNCH_TOOL_NAMES, LAUNCH_TOOL_SCHEMAS, VIRTUAL_BASE, agentHref, agentStatus, ageLabel, candlesOf, clean, isLaunchTool,
  lineStats, normAgent, normPad, pairedWith, parseVChain, rankAgentMatches, socialsOf, virtualPriceFrom, virtualsQuery,
} from "./launchTools";

// Trimmed from live api.virtuals.io / api.bankr.bot / DexScreener answers, 2026-10-03.
const RAXOL = {
  id: 95590, name: "RAXOL", symbol: "RAXOL", chain: "ROBINHOOD", status: "AVAILABLE", category: "IP MIRROR",
  mcapInVirtual: 6180754.566057859, fdvInVirtual: 6180754.566057859, volume24h: 130448.33, priceChangePercent24h: -12.09, holderCount: 2611,
  top10HolderPercentage: 59.49, liquidityUsd: 344396.91, virtualTokenValue: "6180509265431277",
  tokenAddress: "0xf44702b17d9abD53815F703e772F35E9c71A53af", lpAddress: "0xA20b68e2e1De71F1426B546ed5514bF253215A48",
  preToken: "0xf44702b17d9abD53815F703e772F35E9c71A53af", preTokenPair: "0x5698eea2b0199Eb779Cac4b29bE9Cfa993DC5D21",
  createdAt: "2026-07-02T12:21:54.425Z", launchedAt: "2026-07-02T12:21:47.000Z", lpCreatedAt: "2026-07-02T12:36:12.555Z",
  socials: { VERIFIED_LINKS: { TWITTER: "https://x.com/axol_io", WEBSITE: "https://axol.io/" }, VERIFIED_USERNAMES: { TWITTER: "axol_io" } },
};
const RENN = {
  id: 143787, name: "RennFinance by Virtuals", symbol: "RENN", chain: "BASE", status: "UNDERGRAD", mcapInVirtual: 8513.77473967, volume24h: 10830.82,
  priceChangePercent24h: 0, holderCount: 6, virtualTokenValue: "8513774739670", tokenAddress: null, lpAddress: null,
  preToken: "0x2C33C693cd072Ed072576073E7B33F537Fb4798D", preTokenPair: "0x7e074eEa97e3D95036ccF3DdD62D955c84D3cE2a", createdAt: "2026-10-02T15:03:46.811Z", launchedAt: null,
};
const MUSEGOD = {
  tokenAddress: "0x0379e228f6887c6f18bf394042ecaf81b308cb2e", poolId: "0x071ee139277688d64b139af1e44f79a9acf12e53", chain: "robinhood", name: "MUSEGOD", symbol: "MUSEGOD",
  deployedAt: "2026-09-23T18:15:40.000Z", lastPriceUsd: 0.0002718875260811545, marketCapUsd: 271887.52608115453, lastTradeAt: "2026-10-02T20:01:26.000Z",
  vol24h: 29956.931622694017, txCount24h: 274, priceChange1h: 1.663637251530172, priceChange24h: 37.09775279677206, pairedAsset: "weth", platform: "poolsfun", holderRewardsMode: "token",
};
const SHT = { ...MUSEGOD, tokenAddress: "0x0FFC70C88CEE5C735890EF7D27C364B1C0440225", symbol: "SH*T", pairedAsset: "stock", pairedStock: { address: "0x6330d8c3178a418788df01a47479c0ce7ccf450b", symbol: "COIN" }, holderRewardsMode: null };
const NOW = Date.parse("2026-10-03T00:00:00Z");

describe("Virtuals normalisers", () => {
  it("reads chain names people use", () => {
    expect(parseVChain("Base")).toBe("BASE");
    expect(parseVChain("rh")).toBe("ROBINHOOD");
    expect(parseVChain("4663")).toBe("ROBINHOOD");
    expect(parseVChain("sol")).toBe("SOLANA");
    expect(parseVChain("eth")).toBe("ETH");
    expect(parseVChain("arc")).toBe("ARC");
    expect(parseVChain("bsc")).toBeNull();
  });
  it("maps statuses: AVAILABLE = sentient, UNDERGRAD = prototype, INITIALIZED = scheduled", () => {
    expect(agentStatus("AVAILABLE")).toBe("sentient");
    expect(agentStatus("UNDERGRAD")).toBe("prototype");
    expect(agentStatus("INITIALIZED")).toBe("scheduled");
  });
  it("prices VIRTUAL from the deepest Base pools (median, VIRTUAL as base token only)", () => {
    const pairs = [
      { baseToken: { address: VIRTUAL_BASE }, priceUsd: "0.7448", liquidity: { usd: 4382382 } },
      { baseToken: { address: VIRTUAL_BASE.toLowerCase() }, priceUsd: "0.7500", liquidity: { usd: 1454823 } },
      { baseToken: { address: VIRTUAL_BASE }, priceUsd: "0.7509", liquidity: { usd: 607896 } },
      { baseToken: { address: "0x0c3b466104545efa096b8f944c1e524E1d0D4888" }, priceUsd: "0.2501", liquidity: { usd: 9_000_000 } },
      { baseToken: { address: VIRTUAL_BASE }, priceUsd: "9.99", liquidity: { usd: 100 } },
    ];
    expect(virtualPriceFrom(pairs)).toBe(0.75);
    expect(virtualPriceFrom([])).toBeNull();
  });
  it("turns a row into USD market cap via VIRTUAL, price from VIRTUAL wei, age and graduation", () => {
    const a = normAgent(RAXOL, 0.7547, NOW);
    expect(a.status).toBe("sentient");
    expect(a.chain).toBe("Robinhood Chain");
    expect(a.mcapUsd).toBe(4_664_615); // 6,180,754.57 VIRTUAL x $0.7547
    expect(a.priceUsd).toBe(0.0046644);
    expect(a.graduatedAt).toBe("2026-07-02T12:36Z");
    expect(a.ageDays).toBe(92.5);
    expect(a.address).toBe(RAXOL.tokenAddress);
    expect(normAgent(RAXOL, null, NOW).mcapUsd).toBeNull(); // no VIRTUAL price: no USD, never a guess
  });
  it("a prototype's token is its curve token and its page is /prototypes", () => {
    const p = normAgent(RENN, 0.75, NOW);
    expect(p.status).toBe("prototype");
    expect(p.address).toBe(RENN.preToken);
    expect(p.graduatedAt).toBeNull();
    expect(agentHref(p)).toBe(`https://app.virtuals.io/prototypes/${RENN.preToken}`);
    expect(agentHref(normAgent(RAXOL, 0.75, NOW))).toBe("https://app.virtuals.io/virtuals/95590");
  });
  it("builds Strapi filters inside $and (a top-level filter is ignored by this API)", () => {
    const q = decodeURIComponent(virtualsQuery({ and: [{ "[chain]": "ROBINHOOD" }, { "[status]": "AVAILABLE" }], sort: "volume24h:desc", pageSize: 5, fields: ["id", "symbol"] }));
    expect(q).toBe("?filters[$and][0][chain]=ROBINHOOD&filters[$and][1][status]=AVAILABLE&sort[0]=volume24h:desc&pagination[pageSize]=5&fields[0]=id&fields[1]=symbol");
  });
  it("ranks symbol matches: exact symbol, then graduated, then volume", () => {
    const rows = [
      { id: 1, symbol: "TIBBIR", status: "UNDERGRAD", volume24h: 50 },
      { id: 2, symbol: "TIBBIR", status: "AVAILABLE", volume24h: 1_393_256 },
      { id: 3, symbol: "TIBBIRX", status: "AVAILABLE", volume24h: 9_000_000 },
    ];
    expect(rankAgentMatches("$tibbir", rows).map((r) => r.id)).toEqual([2, 1, 3]);
  });
  it("keeps https socials only, verified first, at most four", () => {
    const s = socialsOf({ VERIFIED_LINKS: { TWITTER: "https://x.com/axol_io" }, TELEGRAM: "", USER_LINKS: { WEBSITE: "javascript:alert(1)", DOCS: "https://docs.example" } });
    expect(s).toEqual([{ kind: "twitter", url: "https://x.com/axol_io", verified: true }, { kind: "docs", url: "https://docs.example", verified: false }]);
  });
  it("cleans creator text: markdown emphasis and control characters out, length capped", () => {
    expect(clean("**Tldr; All Raxol agent revenue**\n\ngoes back", 200)).toBe("Tldr; All Raxol agent revenue goes back");
    expect(clean("x".repeat(300), 200).length).toBe(200);
  });
});

describe("pools.fun (Bankr) normalisers", () => {
  it("reads a discover row: paired asset, numbers, ages", () => {
    const r = normPad(MUSEGOD, NOW);
    expect(r).toMatchObject({ symbol: "MUSEGOD", pairedWith: "WETH", mcapUsd: 271_888, priceUsd: 0.00027189, volume24hUsd: 29_957, change24hPct: 37.1, trades24h: 274, holderRewards: true });
    expect(r.ageHours).toBe(221.7);
    expect(r.lastTradeMinutesAgo).toBe(240);
    expect(normPad(SHT, NOW).address).toBe("0x0ffc70c88cee5c735890ef7d27c364b1c0440225");
  });
  it("names the stock a launch is paired with", () => {
    expect(pairedWith(SHT)).toBe("COIN");
    expect(pairedWith({ pairedAsset: "usdg" })).toBe("USDG");
  });
  it("reads candles in either order, oldest first, and summarises the line", () => {
    const desc = { ohlcv: [[1790971200, 0.2514, 0.2517, 0.2491, 0.2517, 406.9], [1790967600, 0.2519, 0.2519, 0.2418, 0.2514, 99114.7], [1790964000, 0.2738, 0.2757, 0.2496, 0.2519, 65411.4]] };
    const c = candlesOf(desc);
    expect(c.map((k) => k.t)).toEqual([1790964000, 1790967600, 1790971200]);
    expect(lineStats(c)).toEqual({ firstUsd: 0.2519, lastUsd: 0.2517, changePct: -0.08, highUsd: 0.2519, lowUsd: 0.2514 });
    expect(candlesOf({ ohlcv: [] })).toEqual([]);
  });
  it("labels ages", () => {
    expect(ageLabel(0.5)).toBe("30m");
    expect(ageLabel(18.8)).toBe("19h");
    expect(ageLabel(218)).toBe("9d");
  });
});

describe("launchpad registry surface", () => {
  it("every schema has a META row in group launchpad, marked untrusted, and the dispatcher knows it", () => {
    for (const s of LAUNCH_TOOL_SCHEMAS) {
      expect(LAUNCH_TOOL_META[s.function.name]?.group).toBe("launchpad");
      expect(LAUNCH_TOOL_META[s.function.name]?.untrusted).toBe(true);
      expect(isLaunchTool(s.function.name)).toBe(true);
    }
    expect(LAUNCH_TOOL_SCHEMAS.map((s) => s.function.name)).toEqual([...LAUNCH_TOOL_NAMES]);
    expect(isLaunchTool("rh_token")).toBe(false);
  });
});
