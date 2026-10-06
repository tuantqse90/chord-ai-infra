import { describe, expect, it } from "bun:test";
import { coinSpotHref, coinTradeHrefFromPlatforms } from "./ask/marketTools"; // ask2049: the helpers moved with cg_coin
import { byRoutedChain } from "./coingecko";

describe("coin chips open a trade frame (board #62)", () => {
  const a = "0x420fca0121dc28039145009570975747295f2329";
  it("maps CoinGecko platforms to the chain's trade frame inside Ask", () => {
    expect(coinTradeHrefFromPlatforms([{ chain: "avalanche", address: a }])).toBe(`/ask/trade/${a}?chain=43114`);
    expect(coinTradeHrefFromPlatforms([{ chain: "base", address: a }])).toBe(`/ask/trade/${a}?chain=8453`);
    expect(coinTradeHrefFromPlatforms([{ chain: "binance-smart-chain", address: a }])).toBe(`/ask/trade/${a}?chain=56`);
    expect(coinTradeHrefFromPlatforms([{ chain: "robinhood-chain", address: a }])).toBe(`/ask/trade/${a}`);
    expect(coinTradeHrefFromPlatforms([{ chain: "arc", address: a }])).toBe(`/arc/token/${a}`);
  });
  it("skips chains with no frame in Ask and non-EVM addresses", () => {
    expect(coinTradeHrefFromPlatforms([{ chain: "ethereum", address: a }, { chain: "solana", address: "So11111111111111111111111111111111111111112" }])).toBeNull();
    expect(coinTradeHrefFromPlatforms([{ chain: "monad", address: a }])).toBeNull();
    expect(coinTradeHrefFromPlatforms(undefined)).toBeNull();
  });
});

describe("a coin's spot link goes to an address that really trades (2026-10-02, AAVE on Avalanche)", () => {
  const dead = "0x8ce2dee54bb9921a2ae0a63dbb2df8ed88b91dd9", live = "0x63a72806098bd3d9520cc43356dd78afe5d386d9";
  const vol = (m: Record<string, number>) => async (_c: number, a: string) => m[a] ?? 0;
  it("skips CoinMarketCap's dead Avalanche AAVE for one the index sees trading", async () => {
    // CMC lists 0x8ce2… (no trades, quoted ~20 % over the market); the liquid AAVE.e 0x63a7… traded $38.7k that day.
    expect(await coinSpotHref([{ chain: "Avalanche C-Chain", address: dead }], vol({ [live]: 38_722 }))).toBeNull();
    expect(await coinSpotHref([{ chain: "Avalanche C-Chain", address: dead }, { chain: "avalanche", address: live }], vol({ [live]: 38_722 }))).toBe(`/ask/trade/${live}?chain=43114`);
  });
  it("needs $1k of 24h volume; an unreadable index is no link; Robinhood Chain / Arc go as before", async () => {
    expect(await coinSpotHref([{ chain: "base", address: live }], vol({ [live]: 999 }))).toBeNull();
    expect(await coinSpotHref([{ chain: "base", address: live }], async () => { throw new Error("pg down"); })).toBeNull();
    expect(await coinSpotHref([{ chain: "robinhood-chain", address: live }], vol({}))).toBe(`/ask/trade/${live}`);
    expect(await coinSpotHref([{ chain: "ethereum", address: live }], vol({ [live]: 1e9 }))).toBeNull();
  });
});

describe("the six platforms kept are the ones Chord can use", () => {
  it("routed chains first, CoinGecko keys and CoinMarketCap names", () => {
    const ps = ["ethereum", "polygon-pos", "arbitrum-one", "optimistic-ethereum", "fantom", "harmony-shard-0", "Avalanche C-Chain", "base", "BNB Smart Chain (BEP20)"].map((chain) => ({ chain, address: "0x" }));
    expect(byRoutedChain(ps).slice(0, 3).map((p) => p.chain)).toEqual(["Avalanche C-Chain", "base", "BNB Smart Chain (BEP20)"]);
    expect(byRoutedChain(ps).length).toBe(ps.length);
  });
});
