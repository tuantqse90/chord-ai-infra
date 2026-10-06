import { afterEach, describe, expect, it } from "bun:test";
import { decodeEntities, extractPage, isPublicIp, normalizeUrl, readUrl, searchProvider, shapeHits, xTarget } from "./webRead";
import { mockFetch, resetRedis, type MockFetchHandle } from "../testkit/helpers";

describe("webRead — which URLs the server may open", () => {
  it("public https only; http upgraded, bare domains accepted, fragments dropped", () => {
    expect(normalizeUrl("https://pearlresearch.ai/")).toBe("https://pearlresearch.ai/");
    expect(normalizeUrl("pearlresearch.ai")).toBe("https://pearlresearch.ai/");
    expect(normalizeUrl("http://example.com/a#b")).toBe("https://example.com/a");
    expect(normalizeUrl("https://example.com/x).")).toBe("https://example.com/x");
    for (const bad of ["https://localhost/", "https://redis/", "https://10.0.0.5/", "https://169.254.169.254/latest", "https://192.168.1.1/", "https://example.com:6379/", "file:///etc/passwd", "https://user:pw@example.com/", "https://[::1]/", "https://engine.internal/"]) {
      expect(normalizeUrl(bad)).toBeNull();
    }
  });
  it("resolved addresses: public v4 and v6 pass (Cloudflare AAAA), private / loopback / link-local / mapped-private fail", () => {
    for (const ok of ["104.18.30.61", "136.69.18.254", "2606:4700::6812:1f3d", "2a06:98c1:310d::6812:282f", "::ffff:8.8.8.8"]) expect(isPublicIp(ok)).toBe(true);
    for (const bad of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.5", "192.168.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::5", "fc12::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "2001:db8::1", "not-an-ip"]) expect(isPublicIp(bad)).toBe(false);
  });
  it("entities", () => {
    expect(decodeEntities("MoE&#x27;s core &amp; &quot;fast&quot; &mdash; 5&#8364;")).toBe(`MoE's core & "fast" — 5€`);
  });
});

describe("webRead — page text", () => {
  const html = `<!doctype html><html><head><title>Pearl Research Labs - Making Inference Smarter</title>
    <meta name="description" content="Faster inference &amp; lower cost"><meta property="og:site_name" content="Pearl"><meta name="twitter:site" content="@prlnet">
    <style>.a{color:red}</style><script>window.secret = "never";</script></head>
    <body><nav><a href="/research">Research</a><a href="/pricing">Pricing</a><a href="https://platform.pearlresearch.ai/docs">Docs</a></nav>
    <h1>Making Inference Smarter</h1><p>Pearl builds infrastructure &mdash; more tokens, faster.</p>
    <ul><li>DeepSeek-V4</li><li>DeepSeek-V4</li></ul><noscript>enable js</noscript>
    <a href="https://x.com/prlnet">Follow us</a><a href="#top">Top</a></body></html>`;
  it("title, description, body text without scripts / styles / repeats, useful links", async () => {
    const p = await extractPage(html, "https://pearlresearch.ai/");
    expect(p.title).toBe("Pearl Research Labs - Making Inference Smarter");
    expect(p.description).toBe("Faster inference & lower cost");
    expect(p.xHandle).toBe("@prlnet");
    expect(p.text).toContain("Pearl builds infrastructure — more tokens, faster.");
    expect(p.text).not.toContain("secret");
    expect(p.text).not.toContain("color:red");
    expect(p.text).not.toContain("enable js");
    expect(p.text.match(/DeepSeek-V4/g)?.length).toBe(1);
    expect(p.text).toContain("Research Pricing Docs");
    expect(p.links.map((l) => l.url)).toEqual(["https://pearlresearch.ai/research", "https://pearlresearch.ai/pricing", "https://platform.pearlresearch.ai/docs", "https://x.com/prlnet"]);
    expect(p.links[3].text).toBe("Follow us");
  });
});

describe("webRead — docs sites", () => {
  it("the page's <main> wins over a long sidebar", async () => {
    const side = Array.from({ length: 400 }, (_, i) => `<li><a href="/p${i}">Page number ${i}</a></li>`).join("");
    const body = "HIP-3 lets builders deploy perps. ".repeat(20);
    const p = await extractPage(`<html><body><aside><ul>${side}</ul></aside><main><h1>HIP-3</h1><p>${body}</p></main></body></html>`, "https://docs.example.com/hip3");
    expect(p.text.startsWith("HIP-3\nHIP-3 lets builders deploy perps.")).toBe(true);
    expect(p.text).not.toContain("Page number 7");
    const short = await extractPage(`<html><body><nav>Home Docs</nav><main><p>Hi</p></main></body></html>`, "https://x.example.com/");
    expect(short.text).toContain("Home Docs");
  });
});

describe("webRead — fetching", () => {
  let fx: MockFetchHandle | null = null;
  afterEach(() => { fx?.restore(); fx = null; resetRedis(); });
  // IP literals skip DNS, so these tests never leave the box.
  it("reads a page and caches it", async () => {
    let n = 0;
    fx = mockFetch({ "93.184.216.34": () => { n++; return new Response("<title>Hi</title><p>" + "word ".repeat(80) + "</p>", { headers: { "content-type": "text/html; charset=utf-8" } }); } });
    const a = await readUrl("https://93.184.216.34/page");
    const b = await readUrl("https://93.184.216.34/page");
    expect(a.ok && a.title).toBe("Hi");
    expect(b.ok).toBe(true);
    expect(n).toBe(1);
  });
  it("re-checks every redirect: a hop into the private network is refused", async () => {
    fx = mockFetch({ "93.184.216.34": new Response(null, { status: 302, headers: { location: "https://10.0.0.7/admin" } }) });
    const r = await readUrl("https://93.184.216.34/go");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("redirects");
  });
  it("refuses non-page content and reports blocks plainly", async () => {
    fx = mockFetch({
      "93.184.216.34/file.zip": new Response("PK", { headers: { "content-type": "application/zip" } }),
      "93.184.216.34/cf": new Response("x", { status: 403, headers: { "content-type": "text/html" } }),
    });
    const z = await readUrl("https://93.184.216.34/file.zip");
    expect(!z.ok && z.error).toContain("not a web page");
    const c = await readUrl("https://93.184.216.34/cf");
    expect(!c.ok && c.error).toContain("403");
    const priv = await readUrl("https://127.0.0.1/");
    expect(priv.ok).toBe(false);
  });
});

describe("webRead — search providers", () => {
  afterEach(() => { delete process.env.BRAVE_SEARCH_API_KEY; delete process.env.TAVILY_API_KEY; delete process.env.SERPER_API_KEY; delete process.env.WEB_SEARCH_PROVIDER; });
  it("the first provider with a key, or the one asked for", () => {
    expect(searchProvider()).toBeNull();
    process.env.TAVILY_API_KEY = "t";
    expect(searchProvider()).toBe("tavily");
    process.env.BRAVE_SEARCH_API_KEY = "b";
    expect(searchProvider()).toBe("brave");
    process.env.WEB_SEARCH_PROVIDER = "tavily";
    expect(searchProvider()).toBe("tavily");
  });
  it("one hit shape for Brave, Tavily and Serper; https only, no duplicates", () => {
    const brave = shapeHits("brave", { news: { results: [{ title: "News <b>one</b>", url: "https://n.com/1", description: "d", age: "2 hours ago" }] }, web: { results: [{ title: "Pearl", url: "https://pearlresearch.ai/", description: "Making &amp; inference" }, { title: "dup", url: "https://n.com/1" }, { title: "plain", url: "http://x.com" }] } });
    expect(brave).toEqual([
      { title: "News one", url: "https://n.com/1", snippet: "d", published: "2 hours ago", host: "n.com" },
      { title: "Pearl", url: "https://pearlresearch.ai/", snippet: "Making & inference", published: null, host: "pearlresearch.ai" },
    ]);
    expect(shapeHits("tavily", { results: [{ title: "T", url: "https://www.t.com/a", content: "c", published_date: "2026-09-26" }] })[0]).toEqual({ title: "T", url: "https://www.t.com/a", snippet: "c", published: "2026-09-26", host: "t.com" });
    expect(shapeHits("serper", { organic: [{ title: "S", link: "https://s.com", snippet: "x", date: "Sep 26" }] })[0].host).toBe("s.com");
  });
});

describe("webRead — X links", () => {
  let fx: MockFetchHandle | null = null;
  afterEach(() => { fx?.restore(); fx = null; resetRedis(); });
  it("profiles and posts, never X's own pages", () => {
    expect(xTarget("https://x.com/prlnet")).toEqual({ user: "prlnet", status: null });
    expect(xTarget("https://twitter.com/prlnet/status/2070169692874899922?s=20")).toEqual({ user: "prlnet", status: "2070169692874899922" });
    expect(xTarget("https://x.com/home")).toBeNull();
    expect(xTarget("https://x.com/prlnet/likes")).toBeNull();
    expect(xTarget("https://example.com/prlnet")).toBeNull();
  });
  it("an X profile link reads through FxTwitter", async () => {
    fx = mockFetch({ "api.fxtwitter.com/prlnet": { code: 200, user: { screen_name: "prlnet", name: "Pearl Research Labs", description: "Pearl redefines the unit economics of AI.", followers: 13958, following: 2, tweets: 58, joined: "Wed Mar 04 14:09:35 +0000 2026", website: { url: "https://pearlresearch.ai/" }, verification: { verified: true, type: "organization" } } } });
    const r = await readUrl("https://x.com/prlnet");
    expect(r.ok && r.title).toBe("Pearl Research Labs (@prlnet)");
    expect(r.ok && r.text).toContain("Followers: 13958");
    expect(r.ok && r.links[0].url).toBe("https://pearlresearch.ai/");
  });
});

describe("webRead — pages drawn by JavaScript go to the renderer", () => {
  let fx: MockFetchHandle | null = null;
  afterEach(() => { fx?.restore(); fx = null; resetRedis(); delete process.env.RENDERER_URL; delete process.env.RENDERER_TOKEN; });
  const shell = `<!doctype html><html><head><title>Minara.fun | Discover, launch, and trade tokens</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>`;
  const rendered = { ok: true, url: "https://93.184.216.34/", title: "Minara.fun", description: "USDC-native launchpad", text: "Trending tokens\nMINARA $0.0000909 -20%\n" + "Launch a token on Arc with USDC liquidity. ".repeat(10), links: [{ text: "Docs", url: "https://docs.minara.fun/" }, { text: "X", url: "https://x.com/minarafun" }], ms: 3100 };
  it("a 1 KB app shell is read through the browser", async () => {
    process.env.RENDERER_URL = "http://renderer:8430"; process.env.RENDERER_TOKEN = "t";
    let auth = "";
    fx = mockFetch({
      "renderer:8430/render": (_u: string, init?: RequestInit) => { auth = String((init?.headers as Record<string, string>)?.Authorization ?? ""); return rendered; },
      "93.184.216.34": new Response(shell, { headers: { "content-type": "text/html" } }),
    });
    const r = await readUrl("https://93.184.216.34/");
    expect(r.ok && r.text).toContain("Launch a token on Arc");
    expect(r.ok && r.note).toContain("Read with a browser");
    expect(r.ok && r.links.map((l) => l.url)).toContain("https://x.com/minarafun");
    expect(auth).toBe("Bearer t");
  });
  it("without a renderer the shell reads as before; a bot wall is retried in the browser", async () => {
    fx = mockFetch({ "93.184.216.34/app": new Response(shell, { headers: { "content-type": "text/html" } }) });
    const plain = await readUrl("https://93.184.216.34/app");
    expect(plain.ok && plain.note).toContain("Almost no text");
    fx.restore(); resetRedis();
    process.env.RENDERER_URL = "http://renderer:8430";
    fx = mockFetch({ "renderer:8430/render": rendered, "93.184.216.34/cf": new Response("blocked", { status: 403, headers: { "content-type": "text/html" } }) });
    const walled = await readUrl("https://93.184.216.34/cf");
    expect(walled.ok && walled.note).toContain("plain fetch was blocked");
  });
});
