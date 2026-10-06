import { describe, expect, test } from "bun:test";
import { questionLanguage } from "./lang";

describe("question language", () => {
  test("Vietnamese with or without marks; clear English is pinned too (2026-09-28)", () => {
    expect(questionLanguage("AMD có tin gì mới không?")).toBe("Vietnamese");
    expect(questionLanguage("Phân tích vàng hôm nay")).toBe("Vietnamese");
    expect(questionLanguage("mua dc gi hom nay bro")).toBe("Vietnamese");
    expect(questionLanguage("phan tich btc cho minh")).toBe("Vietnamese");
    expect(questionLanguage("Quick read on BTC today")).toBe("English"); // short: one function word is enough
    expect(questionLanguage("Quick read on BTC and ETH today: trend, key support and resistance.")).toBe("English");
    expect(questionLanguage("Is it altseason? What's BTC dominance and total crypto market cap?")).toBe("English");
    expect(questionLanguage("Is there a ban on BTC in China?")).toBe("English");
    expect(questionLanguage("Analyze NEAR Protocol")).toBe("English");
    expect(questionLanguage("gia btc")).toBeNull(); // bare "gia" alone: not sure either way
    expect(questionLanguage("0x116e7d070f1888b81e1e0324f56d6746b2d7d8f1")).toBeNull();
    expect(questionLanguage("Hello")).toBeNull();
  });
});
