import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { suggestions } from "../src/suggest";

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => { spy?.mockRestore(); spy = null; });

describe("suggestions", () => {
  it("crypto: BTC / ETH line, the biggest liquid mover and the hottest funding from Hyperliquid", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation((async () => json([
      { universe: [{ name: "BTC" }, { name: "ETH" }, { name: "TAO" }] },
      [{ markPx: "101", prevDayPx: "100", dayNtlVlm: "9e9", funding: "0.00001" }, { markPx: "98", prevDayPx: "100", dayNtlVlm: "5e9", funding: "0.00001" }, { markPx: "120", prevDayPx: "100", dayNtlVlm: "6e7", funding: "0.0005" }],
    ])) as any);
    const s = await suggestions("crypto");
    expect(s[0].text).toBe("BTC is up 1.0% and ETH down 2.0% today. Trend, support and resistance for both?");
    expect(s.some((x) => x.text.startsWith("TAO is up 20.0% in 24h"))).toBe(true);
    expect(s.some((x) => x.text.startsWith("Funding on TAO is 438% a year"))).toBe(true);
  });
  it("static sets and a failed source fall back to a line, never throw", async () => {
    expect((await suggestions("agents")).length).toBe(5);
    spy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("no", { status: 503 })) as any);
    const s = await suggestions("tokens");
    expect(s[0].text).toContain("did not load");
  });
  it("monad: MON line, the biggest liquid mover (no stables, no MON forms), the top wallet", async () => {
    const list = { tokens: [
      { address: "0x0000000000000000000000000000000000000000", symbol: "MON", name: "Monad", logoURI: "m.svg" },
      { address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", symbol: "WMON", name: "Wrapped MON" },
      { address: "0xAAAA000000000000000000000000000000000001", symbol: "mUSD", name: "mUSD" },
      { address: "0xAAAA000000000000000000000000000000000002", symbol: "aprMON", name: "aPriori MON" },
      { address: "0xAAAA000000000000000000000000000000000003", symbol: "CHOG", name: "Chog", logoURI: "c.svg", tags: ["meme"] },
      { address: "0xAAAA000000000000000000000000000000000004", symbol: "FLING", name: "Fling" },
    ] };
    const market = { market: {
      "0x0000000000000000000000000000000000000000": { priceUsd: 0.025, change24h: 0.05, volume24h: 1_018_218 },
      "0x3bd359c1119da7da1d913d1c4d2b7c461115433a": { priceUsd: 0.025, change24h: 0.05, volume24h: 1_018_218 },
      "0xaaaa000000000000000000000000000000000001": { priceUsd: 1, change24h: -40, volume24h: 8_000_000 },
      "0xaaaa000000000000000000000000000000000002": { priceUsd: 0.027, change24h: -60, volume24h: 70_000 },
      "0xaaaa000000000000000000000000000000000003": { priceUsd: 0.0017, change24h: 4.24, volume24h: 13_297 },
      "0xaaaa000000000000000000000000000000000004": { priceUsd: 0.0001, change24h: -30.12, volume24h: 10_676 },
    } };
    const top = { wallets: [{ wallet: "0x430cb07f841dc54fe0f3344e51d45d939b07ebaf", pnlUsd: 94.8, volumeUsd: 20_165, trades: 32, topToken: { symbol: "WETH" } }] };
    spy = spyOn(globalThis, "fetch").mockImplementation((async (u: string) => json(String(u).includes("/v1/tokens/market") ? market : String(u).includes("/v1/tokens?") ? list : top)) as any);
    const s = await suggestions("monad");
    expect(s[0].pill?.symbol).toBe("MON");
    expect(s[0].text).toBe("is up 0.05% on $1.0M traded on Monad DEXes today. Who is buying, and where?");
    expect(s[1].pill?.symbol).toBe("FLING");
    expect(s[1].text).toStartWith("is down 30% in 24h on $11k of volume.");
    expect(s[2].text).toBe("The top-ranked Monad wallet today is up $94.80 on $20k traded, mostly WETH. What is it doing?");
    expect(s[2].q).toContain("0x430cb07f841dc54fe0f3344e51d45d939b07ebaf");
  });
});
