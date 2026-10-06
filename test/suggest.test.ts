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
    expect((await suggestions("payments")).length).toBe(3);
    spy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("no", { status: 503 })) as any);
    const s = await suggestions("holders");
    expect(s[0].text).toContain("did not load");
  });
});
