import { afterEach, describe, expect, it } from "bun:test";
import { cmc, historyCmc, matchCategory, pickFromMap, shapeCoin, shapeRow, type CmcCategory } from "./cmc";
import { mockFetch, resetRedis, type MockFetchHandle } from "../testkit/helpers";
import { getRedis } from "../utils/redis";

// id, symbol, name, slug, rank — as cmc:map:v1 stores the top-5,000 map
const MAP: [number, string, string, string, number | null][] = [
  [24478, "PEPE", "Pepe", "pepe", 49], [31616, "PEPE", "Pepe", "pepe-solana", 4392], [30890, "PEPE", "PEPE 0x69 ON BASE", "pepe-0x69-on-base", 4464],
  [3773, "FET", "Artificial Superintelligence Alliance", "artificial-superintelligence-alliance", 86], [99999, "FETCHR", "Fetchr", "fetchr", null],
  [6535, "NEAR", "NEAR Protocol", "near-protocol", 18], [22974, "TAO", "Bittensor", "bittensor", 29],
];

describe("cmc — coin choice (coingecko.pickCoin's rule)", () => {
  it("a ticker shared by many coins picks the best-ranked one", () => {
    expect(pickFromMap("PEPE", MAP)?.cmcId).toBe(24478);
    expect(pickFromMap("$fet", MAP)?.cmcId).toBe(3773);
  });
  it("names and slugs resolve; partial text does not", () => {
    expect(pickFromMap("NEAR Protocol", MAP)?.cmcId).toBe(6535);
    expect(pickFromMap("bittensor", MAP)?.cmcId).toBe(22974);
    expect(pickFromMap("near-protocol", MAP)?.cmcId).toBe(6535);
    expect(pickFromMap("fetch", MAP)).toBeNull();
    expect(pickFromMap("", MAP)).toBeNull();
  });
});

describe("cmc — shapes match coingecko's", () => {
  it("coin detail from quotes + info", () => {
    const q = { symbol: "TAO", name: "Bittensor", cmc_rank: 29, circulating_supply: 11554801, total_supply: 21000000, max_supply: 21000000,
      quote: { USD: { price: 412.5, market_cap: 4.76e9, fully_diluted_market_cap: 8.66e9, volume_24h: 1.9e8, percent_change_1h: 0.12, percent_change_24h: -2.345, percent_change_7d: 5, percent_change_30d: 12, percent_change_60d: 20, percent_change_90d: -3, market_cap_dominance: 0.16, cex_volume_24h: 1.8e8, dex_volume_24h: 1e7 } } };
    const info = { description: "Bittensor is an open-source protocol.", "tag-names": ["AI & Big Data", "Distributed Computing"], urls: { website: ["https://bittensor.com"], twitter: ["https://twitter.com/opentensor"] }, contract_address: [] };
    const c = shapeCoin({ id: "bittensor", cmcId: 22974, symbol: "TAO", name: "Bittensor", rank: 29, thumb: null }, q, info, 0);
    expect(c.rank).toBe(29);
    expect(c.change).toEqual({ h1: 0.12, h24: -2.35, d7: 5, d30: 12, y1: null });
    expect(c.supply).toEqual({ circulating: 11554801, total: 21000000, max: 21000000 });
    expect(c.categories).toEqual(["AI & Big Data", "Distributed Computing"]);
    expect(c.image).toBe("https://s2.coinmarketcap.com/static/img/coins/64x64/22974.png");
    expect(c.fromAthPct).toBeNull();
    expect(c.links.homepage).toBe("https://bittensor.com");
  });
  it("a listings / category row, rank from the map when the row has none", () => {
    const r = shapeRow({ id: 24478, slug: "pepe", symbol: "pepe", name: "Pepe", quote: { USD: { price: 0.00001, market_cap: 4.2e9, volume_24h: 6e8, percent_change_24h: 3.456 } } }, () => 49);
    expect(r).toMatchObject({ id: "pepe", symbol: "PEPE", rank: 49, h24: 3.46, image: "https://s2.coinmarketcap.com/static/img/coins/64x64/24478.png" });
  });
  it("categories match by CMC id, name, or a CoinGecko-style id", () => {
    const cats: CmcCategory[] = [
      { id: "6051a82566fc1b42617d6dc6", name: "Memes", marketCapUsd: 5e10, h24: 1, volume24hUsd: 1, top: [], tokens: 900 },
      { id: "aa", name: "AI & Big Data", marketCapUsd: 2.6e10, h24: 0.75, volume24hUsd: 1, top: [], tokens: 945 },
      { id: "bb", name: "Generative AI", marketCapUsd: 7.9e9, h24: 4.4, volume24hUsd: 1, top: [], tokens: 102 },
    ];
    expect(matchCategory("6051a82566fc1b42617d6dc6", cats)?.name).toBe("Memes");
    expect(matchCategory("meme-token", cats)?.name).toBe("Memes");
    expect(matchCategory("artificial-intelligence", cats)?.name).toBe("AI & Big Data");
    expect(matchCategory("generative-ai", cats)?.name).toBe("Generative AI");
    expect(matchCategory("zzz", cats)).toBeNull();
  });
});

describe("cmc() — credits, plan locks, fallback signal", () => {
  let fx: MockFetchHandle | null = null;
  afterEach(() => { fx?.restore(); fx = null; resetRedis(); delete process.env.CMC_API_KEY; });

  it("counts reported credits and stops at the monthly cap (so the tool falls back to CoinGecko)", async () => {
    process.env.CMC_API_KEY = "k";
    fx = mockFetch({ "listings/latest": { status: { error_code: 0, credit_count: 2 }, data: [{ id: 1 }] } });
    await cmc("/v1/cryptocurrency/listings/latest", { limit: 250 }, 0);
    const k = `cmc:credits:${new Date().toISOString().slice(0, 7)}`;
    expect(Number(await getRedis().get(k))).toBe(2);
    await getRedis().set(k, "999999");
    await getRedis().del(`cmc:v1:/v1/cryptocurrency/listings/latest?limit=5`);
    await expect(cmc("/v1/cryptocurrency/listings/latest", { limit: 5 }, 0)).rejects.toThrow("budget spent");
  });

  it("a plan-locked endpoint says so; a 429 pauses CMC", async () => {
    process.env.CMC_API_KEY = "k";
    fx = mockFetch({ "trending": new Response(JSON.stringify({ status: { error_code: 1006, error_message: "Your API Key subscription plan doesn't support this endpoint." } }), { status: 403 }), "quotes/latest": new Response(JSON.stringify({ status: { error_code: 1008 } }), { status: 429 }) });
    await expect(cmc("/v1/cryptocurrency/trending/latest", {}, 0)).rejects.toThrow("not on the CoinMarketCap plan");
    await expect(cmc("/v2/cryptocurrency/quotes/latest", { id: 1 }, 0)).rejects.toThrow("rate-limited");
    expect(await getRedis().get("cmc:backoff")).toBe("1");
  });
});

describe("historyCmc", () => {
  let fx: MockFetchHandle | null = null;
  afterEach(() => { fx?.restore(); fx = null; resetRedis(); delete process.env.CMC_API_KEY; });
  it("ends on the live quote: a coin above its last daily close is not read as inside the range", async () => {
    process.env.CMC_API_KEY = "k";
    const day = (d: string, price: number) => ({ timestamp: `2026-09-${d}T00:00:00.000Z`, quote: { USD: { price } } });
    fx = mockFetch({
      "quotes/historical": { status: { error_code: 0, credit_count: 1 }, data: { quotes: [day("24", 1.0), day("26", 1.04), day("25", 0.9)] } },
      "quotes/latest": { status: { error_code: 0, credit_count: 1 }, data: { "20947": { quote: { USD: { price: 1.175, last_updated: "2026-09-26T14:40:00.000Z" } } } } },
    });
    const pts = await historyCmc({ id: "sui", symbol: "sui", name: "Sui", cmcId: 20947 } as any, 3);
    expect(pts.map((p) => p[1])).toEqual([1.0, 0.9, 1.04, 1.175]);
  });
});
