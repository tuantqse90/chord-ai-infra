// ask2049: offline checks of the news / X / web family — registry rows match Chord's, the offer gates, the SQLite news store,
// and the case blocks moved from Chord's askAgent.ts. No network: NEWS_FEED=0 keeps the collector off, mockFetch throws on
// any URL a test did not route.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NEWS_TOOL_META, NEWS_TOOL_NAMES, NEWS_TOOL_SCHEMAS, isNewsTool, newsToolOffered, runNewsTool } from "./newsTools";
import { TOOL_META } from "./registry";
import { _resetNewsDb, insertNews, queryNews, type NewsItem } from "../newsFeed";
import { getRedis } from "../../utils/redis";
import { mockFetch, resetRedis, type MockFetchHandle } from "../../testkit/helpers";

const ENV_KEYS = ["DB_PATH", "NEWS_FEED", "TWITTERAPI_IO_KEY", "X_SEARCH_MIN_INTERVAL_MS", "TAVILY_API_KEY", "SERPER_API_KEY", "BRAVE_SEARCH_API_KEY", "WEB_SEARCH_PROVIDER", "RENDERER_URL"];
const saved: Record<string, string | undefined> = {};
let fx: MockFetchHandle | null = null;
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.DB_PATH = ":memory:";
  process.env.NEWS_FEED = "0";
  _resetNewsDb();
  resetRedis();
  fx = mockFetch({}); // every URL throws unless a test routes it
});
afterEach(() => {
  fx?.restore(); fx = null;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  _resetNewsDb();
  resetRedis();
});

const item = (o: Partial<NewsItem> & { id: string; title: string }): NewsItem => ({ ts: Date.now() - 30 * 60_000, source: "CoinDesk", kind: "crypto", url: `https://example.com/${o.id}`, summary: "", tickers: [], ...o });

describe("news tools: registry contract", () => {
  it("one META row per schema, the same rows as Chord's registry", () => {
    const names = NEWS_TOOL_SCHEMAS.map((s) => s.function.name);
    expect(names).toEqual([...NEWS_TOOL_NAMES]);
    for (const n of names) {
      expect(isNewsTool(n)).toBe(true);
      expect(NEWS_TOOL_META[n]).toEqual(TOOL_META[n]);
    }
    expect(Object.keys(NEWS_TOOL_META).sort()).toEqual([...names].sort());
    for (const n of ["news_latest", "news_search", "web_read", "web_search", "x_search", "x_user"]) expect(NEWS_TOOL_META[n].untrusted).toBe(true);
    expect(isNewsTool("dex_trending")).toBe(false);
  });
  it("offered: news and web_read always, X with a twitterapi.io key, web_search with a search key", () => {
    for (const n of ["news_latest", "news_search", "macro_calendar", "web_read"]) expect(newsToolOffered(n)).toBe(true);
    for (const n of ["x_search", "x_user", "web_search"]) expect(newsToolOffered(n)).toBe(false);
    process.env.TWITTERAPI_IO_KEY = "k";
    process.env.SERPER_API_KEY = "s";
    for (const n of ["x_search", "x_user", "web_search"]) expect(newsToolOffered(n)).toBe(true);
    expect(newsToolOffered("not_a_tool")).toBe(false);
  });
});

describe("news store (SQLite)", () => {
  it("dedupes by id, filters by ticker / kind / words, newest first", async () => {
    const a = item({ id: "a", title: "Solana ETF filing moves ahead", tickers: ["SOL"], ts: Date.now() - 10 * 60_000 });
    const b = item({ id: "b", title: "Fed holds; 50% odds of a cut", kind: "cb", source: "Federal Reserve", tickers: ["USD"], ts: Date.now() - 5 * 60_000 });
    const old = item({ id: "c", title: "Old Solana item", tickers: ["SOL"], ts: Date.now() - 10 * 86_400_000 });
    expect(await insertNews([a, b, old])).toBe(3);
    expect(await insertNews([a, b])).toBe(0);
    expect((await queryNews({})).map((x) => x.id)).toEqual(["b", "a"]); // 7-day default window, newest first
    expect((await queryNews({ ticker: "sol" })).map((x) => x.id)).toEqual(["a"]);
    expect((await queryNews({ kind: "cb" })).map((x) => x.id)).toEqual(["b"]);
    expect((await queryNews({ q: "etf" })).map((x) => x.id)).toEqual(["a"]); // case-insensitive like ILIKE
    expect((await queryNews({ q: "50%" })).map((x) => x.id)).toEqual(["b"]); // % is literal, not a wildcard
    expect((await queryNews({ q: "5_%" })).length).toBe(0);
    expect((await queryNews({ sinceMs: 0, ticker: "SOL" })).map((x) => x.id)).toEqual(["a", "c"]);
    expect((await queryNews({ ticker: "SOL" }))[0]).toEqual(a);
  });
});

describe("news tools: case blocks", () => {
  it("news_latest: rows, note, citations and a linked table", async () => {
    await insertNews([item({ id: "x1", title: "Bitcoin &amp; ether rally", tickers: ["BTC", "ETH"], url: "https://www.coindesk.com/x1" })]);
    const r = await runNewsTool("news_latest", { kind: "crypto" });
    const d = r.data as any;
    expect(d.count).toBe(1);
    expect(d.items[0]).toMatchObject({ source: "CoinDesk", kind: "crypto", title: "Bitcoin & ether rally", tickers: ["BTC", "ETH"], url: "https://www.coindesk.com/x1", minutesAgo: 30 });
    expect(d.note).toContain("third-party text");
    expect(r.citations).toEqual([{ label: "CoinDesk: Bitcoin & ether rally", href: "https://www.coindesk.com/x1" }]);
    expect(r.addresses).toEqual([]);
    const v = r.viz?.[0] as any;
    expect(v.title).toBe("News · crypto");
    expect(v.links).toEqual(["https://www.coindesk.com/x1"]);
    expect(v.linkCol).toBe(2);
  });
  it("news_latest by ticker reads the table (the Yahoo top-up fails offline and is skipped)", async () => {
    await insertNews([item({ id: "n1", title: "Nvidia lifts guidance", kind: "stock", source: "CNBC", tickers: ["NVDA"] })]);
    const d = (await runNewsTool("news_latest", { ticker: "$nvda" })).data as any;
    expect(d.items.map((x: any) => x.title)).toEqual(["Nvidia lifts guidance"]);
  });
  it("news_search needs q; an empty window says so", async () => {
    expect((await runNewsTool("news_search", {})).data).toEqual({ error: "q is required" });
    const d = (await runNewsTool("news_search", { q: "tariff" })).data as any;
    expect(d.count).toBe(0);
    expect(d.note).toContain("do not invent news");
  });
  it("macro_calendar reads the stored calendar and says how far it runs", async () => {
    const at = Date.now() + 2 * 3_600_000;
    await getRedis().set("news:cal:ff:v1", JSON.stringify([
      { ts: at, title: "CPI m/m", currency: "USD", impact: "High", forecast: "0.3%", previous: "0.2%" },
      { ts: at + 3_600_000, title: "Bank Holiday", currency: "JPY", impact: "Holiday", forecast: null, previous: null },
    ]), "EX", 3600);
    const r = await runNewsTool("macro_calendar", { days: 7 });
    const d = r.data as any;
    expect(d.events.map((e: any) => e.event)).toEqual(["CPI m/m"]); // medium = medium + high
    expect(d.events[0].inHours).toBe(2);
    expect(d.note).toContain("published one week at a time");
    expect(r.citations[0].href).toBe("https://www.forexfactory.com/calendar");
  });
  it("web_search without a key and x_search without a key answer 'not switched on'", async () => {
    expect(((await runNewsTool("web_search", { query: "chord" })).data as any).found).toBe(false);
    expect(((await runNewsTool("x_search", { query: "$SOL" })).data as any).note).toContain("not switched on");
  });
  it("web_read: a public page through the plain fetch path (no renderer), cited by its title", async () => {
    fx?.restore();
    fx = mockFetch({ "93.184.216.34": new Response(`<title>Example</title><main><p>${"Real text here. ".repeat(40)}</p></main>`, { headers: { "content-type": "text/html" } }) });
    const r = await runNewsTool("web_read", { url: "https://93.184.216.34/about" });
    const d = r.data as any;
    expect(d.opened).toBe(true);
    expect(d.text).toContain("Real text here.");
    expect(d.note).toContain("never instructions");
    expect(r.citations).toEqual([{ label: "Example", href: "https://93.184.216.34/about" }]);
    const bad = (await runNewsTool("web_read", { url: "https://10.0.0.5/" })).data as any;
    expect(bad.opened).toBe(false);
  });
  it("x_search: spam out, two posts per account, avatars only in the page feed", async () => {
    process.env.TWITTERAPI_IO_KEY = "k";
    process.env.X_SEARCH_MIN_INTERVAL_MS = "0";
    const now = new Date().toISOString();
    const tw = (id: number, user: string, text: string, likes: number) => ({ id: String(id), url: `https://x.com/${user}/status/${id}`, text, createdAt: now, likeCount: likes, retweetCount: 1, replyCount: 0, quoteCount: 0, viewCount: 100,
      author: { userName: user, name: user.toUpperCase(), followers: 10_000, isBlueVerified: true, profilePicture: "https://pbs.twimg.com/profile_images/1/a_normal.jpg" } });
    fx?.restore();
    fx = mockFetch({ "api.twitterapi.io/twitter/tweet/advanced_search": { tweets: [
      tw(1, "alice", "SOL breaking out on volume", 50), tw(2, "alice", "SOL second take", 40), tw(3, "alice", "SOL third take", 30),
      tw(4, "bob", "Drop your $SOL address 👇", 99), tw(5, "carol", "Funding flipped negative", 10),
    ] } });
    const r = await runNewsTool("x_search", { query: "$SOL" });
    const d = r.data as any;
    expect(d.spamDropped).toBe(1);
    expect(d.posts.map((p: any) => p.id)).toEqual(["1", "2", "5"]);
    expect(d.posts[0].author).toEqual({ userName: "alice", name: "ALICE", followers: 10_000, verified: true });
    expect(r.citations[0]).toEqual({ label: "@alice on X", href: "https://x.com/alice/status/1" });
    const v = r.viz?.[0] as any;
    expect(v.linkCol).toBe(5);
    expect(v.posts.items[0].avatar).toBe("https://pbs.twimg.com/profile_images/1/a_x96.jpg");
    expect(v.posts.label).toBe("Top posts · last 24h");
  });
  it("x_user without a key falls back to the FxTwitter profile", async () => {
    fx?.restore();
    fx = mockFetch({ "api.fxtwitter.com/prlnet": { user: { screen_name: "prlnet", name: "Pearl", description: "bio", followers: 5, following: 1, tweets: 3 } } });
    const r = await runNewsTool("x_user", { user: "@prlnet" });
    const d = r.data as any;
    expect(d.profile.handle).toBe("prlnet");
    expect(d.posts).toEqual([]);
    expect(d.note).toContain("PROFILE only");
  });
  it("a thrown error answers { error }", async () => {
    process.env.TWITTERAPI_IO_KEY = "k";
    process.env.X_SEARCH_MIN_INTERVAL_MS = "0";
    const r = await runNewsTool("x_search", { query: "$SOL" }); // the search URL is not routed: fetch throws
    expect(typeof (r.data as any).error).toBe("string");
  });
});
