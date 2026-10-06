import { describe, expect, test } from "bun:test";
import { aliasFromName, buildAlias, decodeText, parseFeed, tagText } from "./newsFeed";

const RSS = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title><![CDATA[Germany Ifo 89.9 vs 89.1 expected]]></title><pubDate>Thu, 24 Sep 2026 08:01:37 GMT</pubDate>
<guid isPermaLink="true">https://investinglive.com/news/a/</guid><link>https://investinglive.com/news/a/</link>
<description><![CDATA[<ul><li>Prior 88.8</li></ul> &amp; more]]></description></item>
<item><title>No link</title><pubDate>Thu, 24 Sep 2026 08:01:37 GMT</pubDate></item>
</channel></rss>`;
const ATOM = `<feed><entry><title>8-K - NVIDIA CORP (0001045810) (Filer)</title><link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/x-index.htm"/><updated>2026-09-24T08:00:00-04:00</updated><summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-09-24</summary></entry></feed>`;

describe("news: feed parsing", () => {
  test("RSS 2.0 with CDATA and html in the description", () => {
    const [a, ...rest] = parseFeed(RSS);
    expect(rest).toHaveLength(0); // the item without a link is dropped
    expect(a.title).toBe("Germany Ifo 89.9 vs 89.1 expected");
    expect(a.url).toBe("https://investinglive.com/news/a/");
    expect(a.ts).toBe(Date.parse("2026-09-24T08:01:37Z"));
    expect(a.summary).toBe("Prior 88.8 & more");
  });
  test("Atom with an href link and escaped html summary", () => {
    const [e] = parseFeed(ATOM);
    expect(e.url).toBe("https://www.sec.gov/Archives/x-index.htm");
    expect(e.summary).toBe("Filed: 2026-09-24");
    expect(e.ts).toBe(Date.parse("2026-09-24T12:00:00Z"));
  });
  test("entities", () => expect(decodeText("AT&amp;T &#8217;s &#x2014; ok")).toBe("AT&T ’s — ok"));
});

describe("news: tagging", () => {
  const aliases = [buildAlias("NVDA", "NVIDIA Corporation • Robinhood Token"), buildAlias("NET", "Cloudflare, Inc. • Robinhood Token"), buildAlias("F", "Ford Motor Company"), buildAlias("TGT", "Target Corporation")];
  test("ticker and company word", () => {
    expect(tagText("Nvidia's new chip lifts shares", aliases)).toContain("NVDA");
    expect(tagText("NVDA up 3% premarket", aliases)).toContain("NVDA");
    expect(tagText("Cloudflare outage hits websites", aliases)).toContain("NET");
  });
  test("no false hits on everyday words", () => {
    expect(tagText("Net income rose; the net effect", aliases)).not.toContain("NET");
    expect(tagText("Fed hits its inflation target", aliases)).not.toContain("TGT");
    expect(tagText("F-16 deliveries resume", aliases)).not.toContain("F");
    expect(tagText("Shares of $F rally", aliases)).toContain("F");
  });
  test("FX pairs, currencies and commodities", () => {
    const t = tagText("EUR/USD slips as the dollar firms; gold steady, ECB's Lagarde speaks", aliases);
    expect(t).toEqual(expect.arrayContaining(["EUR/USD", "EUR", "USD", "XAU"]));
    expect(tagText("USDJPY pops above 150 after BoJ", aliases)).toEqual(expect.arrayContaining(["USD/JPY", "JPY"]));
  });
  test("aliases skip generic first words", () => {
    expect(aliasFromName("Vanguard Morningstar Total Stock Market ETF • Robinhood Token")).toBeNull();
    expect(aliasFromName("Johnson & Johnson • Robinhood Token")).toBe("Johnson");
    expect(aliasFromName("AMC Entertainment Holdings, Inc.")).toBeNull();
  });
});

describe("news: crypto tagging", () => {
  test("unambiguous coin names tag any feed", () => {
    expect(tagText("Solana ETF filing moves ahead as Dogecoin rallies", [])).toEqual(expect.arrayContaining(["SOL", "DOGE"]));
    expect(tagText("Hyperliquid volume hits a record", [])).toContain("HYPE");
  });
  test("ambiguous names, bare tickers and cashtags only count on a crypto desk", () => {
    const text = "Optimism and Jupiter rally; OP up 9%, $WIF flat, ARB lags";
    const plain = tagText(text, []);
    expect(plain).not.toContain("OP");
    expect(plain).not.toContain("JUP");
    expect(plain).not.toContain("WIF");
    const desk = tagText(text, [], true);
    expect(desk).toEqual(expect.arrayContaining(["OP", "JUP", "WIF", "ARB"]));
  });
  test("ticker look-alikes inside words and op-eds are not coins", () => {
    const t = tagText("OP-ED: SOLAR stocks and the TONNAGE of ETHICS", [], true);
    expect(t).not.toContain("OP");
    expect(t).not.toContain("SOL");
    expect(t).not.toContain("TON");
    expect(t).not.toContain("ETH");
  });
  test("dollar amounts and blocked words are not cashtags", () => {
    const t = tagText("Fund raises $50M; $CEO token scam, $PEPE jumps", [], true);
    expect(t).toContain("PEPE");
    expect(t).not.toContain("CEO");
    expect(t.some((x) => /^\d/.test(x))).toBe(false);
  });
});
