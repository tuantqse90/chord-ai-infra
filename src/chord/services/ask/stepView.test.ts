import { describe, expect, test } from "bun:test";
import { stepDetail, stepView, thinkingTail } from "./stepView";

describe("stepDetail", () => {
  test("the argument the lookup is about", () => {
    expect(stepDetail("dex_search", { query: "Pearl Useful Proof Of Work" })).toBe("Pearl Useful Proof Of Work");
    expect(stepDetail("web_read", { url: "https://pearlresearch.ai/" })).toBe("pearlresearch.ai");
    expect(stepDetail("arc_wallet_pnl", { wallet: "0x1234567890abcdef1234567890abcdef12345678" })).toBe("0x1234…5678");
    expect(stepDetail("macro_snapshot", { assets: ["GOLD", "BTC"] })).toBe("GOLD, BTC");
    expect(stepDetail("arc_overview", {})).toBeNull();
  });
});

describe("stepView", () => {
  test("token cards from chips, sources deduped", () => {
    const v = stepView("dex_search", {
      data: {}, citations: [{ label: "A", href: "https://dexscreener.com/a" }, { label: "A again", href: "https://dexscreener.com/a" }],
      chipCandidates: [
        { symbol: "POGAI", label: "Proof of Gains AI", price: 0.000000423, change24hPct: null, href: "https://dexscreener.com/a", liquidityUsd: 1_590_000, fdvUsd: 856_110, marketCapUsd: 856_110, volume24hUsd: 3.96, chainName: "Solana" },
      ],
    });
    expect(v.sources).toHaveLength(1);
    expect(v.cards[0]).toMatchObject({ kind: "token", symbol: "POGAI", liquidityUsd: 1_590_000, chainName: "Solana" });
  });
  test("post cards for X, link cards for web search / read / news", () => {
    expect(stepView("x_search", { data: { posts: [{ url: "https://x.com/a/status/1", text: "gm  $PEARL", likes: 12, author: { userName: "a", name: "A" } }] }, citations: [] }).cards[0]).toEqual({ kind: "post", name: "A", handle: "a", text: "gm $PEARL", url: "https://x.com/a/status/1", likes: 12 });
    // the author's picture comes from the tool's feed (viz), matched by handle — `data` is what the model reads and has none
    expect(stepView("x_search", { data: { posts: [{ url: "https://x.com/Ab/status/1", text: "gm", likes: 1, author: { userName: "Ab", name: "A" } }] }, citations: [], viz: [{ kind: "table", posts: { items: [{ handle: "ab", avatar: "https://pbs.twimg.com/profile_images/1/a_x96.jpg" }, { handle: "zz", avatar: null }] } }] }).cards[0]).toMatchObject({ kind: "post", handle: "Ab", avatar: "https://pbs.twimg.com/profile_images/1/a_x96.jpg" });
    expect(stepView("web_search", { data: { results: [{ title: "Pearl", url: "https://www.pearlresearch.ai/", snippet: "inference", host: "pearlresearch.ai" }] }, citations: [] }).cards[0]).toMatchObject({ kind: "link", host: "pearlresearch.ai" });
    expect(stepView("web_read", { data: { opened: true, url: "https://docs.arc.io/x", title: "Gas", description: "USDC" }, citations: [] }).cards[0]).toMatchObject({ kind: "link", host: "docs.arc.io", snippet: "USDC" });
    expect(stepView("web_read", { data: { opened: false, url: "https://x.io" }, citations: [] }).cards).toEqual([]);
  });
});

describe("thinkingTail", () => {
  test("masks addresses the tools did not return, sends the tail from a word boundary", () => {
    const ok = "0x1111111111111111111111111111111111111111";
    expect(thinkingTail(`check ${ok} and 0x2222222222222222222222222222222222222222`, new Set([ok]))).toBe(`check ${ok} and (address)`);
    const long = `${"alpha ".repeat(300)}omega`;
    const t = thinkingTail(long, new Set(), 100);
    expect(t.startsWith("…alpha")).toBe(true);
    expect(t.endsWith("omega")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(102);
  });
});
