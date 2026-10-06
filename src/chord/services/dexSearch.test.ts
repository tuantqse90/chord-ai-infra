import { describe, expect, it } from "bun:test";
import { chainNameOf, chipHref, groupPairs } from "./dexSearch";

const pair = (o: Record<string, unknown>) => ({
  chainId: "solana", dexId: "raydium", url: "https://dexscreener.com/solana/p1", priceUsd: "0.00001999", priceChange: { h24: 6.24 },
  volume: { h24: 0.67 }, liquidity: { usd: 19562 }, marketCap: 19876, fdv: 19876, pairCreatedAt: 1732991433000, txns: { h24: { buys: 1, sells: 0 } },
  baseToken: { address: "9n1A8UtMXnnNqq9PxNkfGTqJpK1pNhbd8gF6ZUrf8ivc", symbol: "PEARL", name: "Girl With A Pearl Earring" }, info: { imageUrl: "https://dd.dexscreener.com/pearl.png" },
  ...o,
});

describe("dexSearch — which pairs count, grouped per token", () => {
  it("keeps tokens whose symbol or name matches, drops pairs that only match the DEX name", () => {
    const out = groupPairs("$PEARL", [
      pair({}),
      pair({ chainId: "polygon", dexId: "pearl", baseToken: { address: "0x40379a439D4F6795B6fc9aa5687dB461677A2dBa", symbol: "USDR", name: "Real USD" }, liquidity: { usd: 90000 } }),
      pair({ chainId: "abstract", dexId: "kona", baseToken: { address: "0x792CF0A64aAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", symbol: "PEARL", name: "Kona Pearl" }, liquidity: { usd: 16495 }, volume: { h24: 211.84 }, marketCap: 11636 }),
      pair({ chainId: "ink", dexId: "inkyswap", baseToken: { address: "0x75e7A5316eBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", symbol: "PRL", name: "Pearl" }, liquidity: { usd: 10162 } }),
    ], 1_790_000_000_000);
    expect(out.map((t) => `${t.chainName}:${t.symbol}`)).toEqual(["Solana:PEARL", "Abstract:PEARL", "Ink:PRL"]);
    expect(out[0]).toMatchObject({ name: "Girl With A Pearl Earring", priceUsd: 0.00001999, change24hPct: 6.24, marketCapUsd: 19876, image: "https://dd.dexscreener.com/pearl.png", pairs: 1 });
    expect(out[0].ageDays).toBeGreaterThan(600);
  });
  it("sums volume / liquidity over a token's pairs; the deepest pair gives price and market cap", () => {
    const a = "0x1111111111111111111111111111111111111111";
    const out = groupPairs("DOG", [
      pair({ chainId: "base", baseToken: { address: a, symbol: "DOG", name: "Dog" }, liquidity: { usd: 1000 }, volume: { h24: 50 }, priceUsd: "1.0", marketCap: 100 }),
      pair({ chainId: "base", baseToken: { address: a.toUpperCase().replace("0X", "0x"), symbol: "DOG", name: "Dog" }, liquidity: { usd: 9000 }, volume: { h24: 10 }, priceUsd: "1.1", marketCap: 110, url: "https://dexscreener.com/base/deep" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ pairs: 2, liquidityUsd: 10000, volume24hUsd: 60, priceUsd: 1.1, marketCapUsd: 110, url: "https://dexscreener.com/base/deep" });
  });
  it("an address query keeps only that token", () => {
    const out = groupPairs("9n1A8UtMXnnNqq9PxNkfGTqJpK1pNhbd8gF6ZUrf8ivc", [pair({}), pair({ baseToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "Wrapped SOL" } })]);
    expect(out.map((t) => t.symbol)).toEqual(["PEARL"]);
  });
  it("names and links", () => {
    expect(chainNameOf("robinhood")).toBe("Robinhood Chain");
    expect(chainNameOf("new-chain")).toBe("New Chain");
    expect(chipHref({ chain: "robinhood", address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD", url: "u" })).toBe("/ask/trade/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    expect(chipHref({ chain: "solana", address: "x", url: "https://dexscreener.com/solana/p" })).toBe("https://dexscreener.com/solana/p");
  });
});
