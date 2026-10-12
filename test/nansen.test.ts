// Nansen's smart money on Monad as an Ask tool: one paid call per view per TTL, the copy survives in SQLite, a refusal serves it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { useTempDb } from "../src/bots/_testkit";
process.env.NANSEN_API_KEY = "test-key";
let tmp: ReturnType<typeof useTempDb>;
const { _closeTrustDb } = await import("../src/trust/registry");
const { nansenTools, nansenRows, nansenCredits } = await import("../src/nansenTools");

const HOLD = [
  { chain: "monad", token_address: "0x81a224f8a62f52bde942dbf23a56df77a10b7777", token_symbol: "EMO", value_usd: 11069.4, balance_24h_percent_change: 0, holders_count: 2, market_cap_usd: 1_000_000, token_age_days: 300 },
  { chain: "monad", token_address: "0x350035555e10d9afaf1566aaebfced5ba6c27777", token_symbol: "CHOG", value_usd: 5306.1, balance_24h_percent_change: 1.234, holders_count: 2, market_cap_usd: 9_000_000, token_age_days: 320 },
];
const TRADES = [{ chain: "monad", block_timestamp: "2026-10-12T05:29:15Z", transaction_hash: "0xb37d", trader_address: "0x3721", trader_address_label: "High Activity", token_bought_address: "0x7547", token_sold_address: "0xad96",
  token_bought_amount: 2.507275, token_sold_amount: 116.6946, token_bought_symbol: "USDC", token_sold_symbol: "DUST", trade_value_usd: 2.4798 }];
let calls: { url: string; body: any; key: string | null }[] = [];
let fail = 0;
const fetcher = async (url: string, init: RequestInit) => {
  calls.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("apiKey") });
  if (fail) return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: fail, headers: { "x-nansen-credits-remaining": "0" } });
  return new Response(JSON.stringify({ data: url.endsWith("holdings") ? HOLD : TRADES }), { status: 200, headers: { "x-nansen-credits-remaining": "75" } });
};
beforeAll(() => { _closeTrustDb(); tmp = useTempDb("nansen"); calls = []; });
afterAll(() => { _closeTrustDb(); tmp.restore(); delete process.env.NANSEN_API_KEY; });

describe("nansen_smart_money", () => {
  it("is offered only with a key; asks Nansen for Monad once, then answers from the saved copy", async () => {
    const [tool] = nansenTools(fetcher);
    expect(tool!.name).toBe("nansen_smart_money");
    const a = await tool!.run({ view: "holdings" });
    expect(calls).toEqual([{ url: "https://api.nansen.ai/api/v1/smart-money/holdings", body: { chains: ["monad"], pagination: { page: 1, per_page: 100 } }, key: "test-key" }]);
    expect((a.data as any).tokens.map((t: any) => [t.symbol, t.smartMoneyValueUsd, t.smartMoneyHolders])).toEqual([["EMO", 11069.4, 2], ["CHOG", 5306.1, 2]]);
    expect(a.sources[0]!.label).toContain("Nansen");
    expect(nansenCredits().remaining).toBe(75);
    const b = await tool!.run({ view: "holdings", token: "$chog" });
    expect(calls.length).toBe(1); // the second answer cost nothing
    expect((b.data as any)).toMatchObject({ source: "Nansen", matched: 1, ofRows: 2 });
    expect((b.data as any).tokens[0]).toMatchObject({ symbol: "CHOG", balanceChange24hPct: 1.23 });
    const none = await tool!.run({ view: "holdings", token: "NOPE" });
    expect((none.data as any).none).toContain("No wallet Nansen labels smart money holds NOPE");
  });
  it("past the TTL it asks again; a refusal serves the last copy marked stale, and with no copy says so", async () => {
    const day = 24 * 3_600_000, t0 = Date.now();
    fail = 402;
    const late = await nansenRows("holdings", fetcher, t0 + day + 1);
    expect(late).toMatchObject({ stale: true });
    expect(late.rows.length).toBe(2);
    expect(calls.length).toBe(2);
    await expect(nansenRows("trades", fetcher)).rejects.toThrow("not available right now");
    fail = 0;
    const [tool] = nansenTools(fetcher);
    const t = await tool!.run({ view: "trades", token: "DUST" });
    expect((t.data as any).trades[0]).toMatchObject({ trader: "0x3721", label: "High Activity", bought: { symbol: "USDC" }, sold: { symbol: "DUST" }, valueUsd: 2.48 });
    expect(t.addresses).toContain("0xb37d");
    delete process.env.NANSEN_API_KEY;
    expect(nansenTools()).toEqual([]);
    process.env.NANSEN_API_KEY = "test-key";
  });
});
