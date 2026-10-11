import { describe, expect, it } from "bun:test";
import { ask, type AskEvent } from "../src/agent";
import { pickPlaybook, playbookTools } from "../src/skills";
import type { ChatFn } from "../src/llm";
import type { Tool } from "../src/types";

describe("playbook router", () => {
  it("routes by question and keeps the core tools", () => {
    expect(pickPlaybook("What's the funding and open interest on SOL perps?")?.id).toBe("perps");
    expect(pickPlaybook("any news today?")?.id).toBe("plain_news");
    expect(pickPlaybook("có tin gì mới ko bro")?.id).toBe("plain_news");
    const dex = pickPlaybook("trending memecoins on solana dex right now");
    expect(dex).not.toBeNull();
    expect(playbookTools(dex!)).toContain("more_tools");
    expect(playbookTools(dex!)).toContain("dex_search");
  });
});

const call = (name: string, args: object) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const tool = (name: string, extra: Partial<Tool> = {}, data: unknown = { ok: true }, addresses: string[] = []): Tool => ({
  name, via: "ext", provider: "Test", label: name, description: name, parameters: { type: "object", properties: {} },
  run: async () => ({ data, sources: [], summary: "ok", addresses }), ...extra,
});

describe("loop", () => {
  it("untrusted text adds no addresses; vouched addresses do", async () => {
    const posted = "0x1111111111111111111111111111111111111111", vouched = "0x2222222222222222222222222222222222222222";
    let round = 0;
    const chat: ChatFn = async () => {
      round++;
      if (round === 1) return { content: null, toolCalls: [call("x_search", { query: "a" })], tokens: 1 };
      return { content: `Posts mention ${posted} and the token is ${vouched}.`, toolCalls: [], tokens: 1 };
    };
    const events: AskEvent[] = [];
    await ask("q", [], (e) => { events.push(e); }, { chat, tools: [tool("x_search", { untrusted: true }, { text: `buy ${posted}` }, [vouched])] });
    const a = events.find((e) => e.type === "answer") as Extract<AskEvent, { type: "answer" }>;
    expect(a.text).toContain(vouched);
    expect(a.text).not.toContain(posted);
    expect(a.masked).toBe(1);
  });

  it("a tool's own deadline applies and the step names its provider", async () => {
    let round = 0;
    const chat: ChatFn = async () => (++round === 1 ? { content: null, toolCalls: [call("slow", {})], tokens: 1 } : { content: "done", toolCalls: [], tokens: 1 });
    const events: AskEvent[] = [];
    await ask("q", [], (e) => { events.push(e); }, { chat, tools: [tool("slow", { timeoutMs: 50, run: () => new Promise((r) => setTimeout(() => r({ data: 1, sources: [], summary: "" }), 500)) })] });
    const step = events.find((e) => e.type === "step") as Extract<AskEvent, { type: "step" }>;
    expect(step.ok).toBe(false);
    expect(step.summary).toContain("timed out");
    expect(step.via).toBe("Test");
  });
});

import { splitFollowUps } from "../src/agent";
describe("follow-ups", () => {
  it("splits the FOLLOW-UPS block off the answer", () => {
    const r = splitFollowUps("BTC is at 86k.\n\nFOLLOW-UPS:\n- What is BTC funding?\n- Show ETH levels\n");
    expect(r.text).toBe("BTC is at 86k.");
    expect(r.followUps).toEqual(["What is BTC funding?", "Show ETH levels"]);
    expect(splitFollowUps("no block").followUps).toEqual([]);
  });
});

describe("dex routing", () => {
  it("trending / memecoins on a chain go to the DEX playbook", () => {
    expect(pickPlaybook("trending on solana now?")?.id).toBe("dex");
    // classic strategies by name go to the agents playbook (with the classic tools); a bare indicator stays a market question
    const cl = pickPlaybook("Backtest a golden cross on ETH 4h");
    expect(cl?.id).toBe("bots");
    expect(cl?.tools).toContain("classic_backtest");
    expect(pickPlaybook("run a supertrend agent on Perpl")?.id).toBe("bots");
    expect(pickPlaybook("what is BTC's RSI today?")?.id).not.toBe("bots");
    expect(pickPlaybook("hot memecoins on base today")?.id).toBe("dex");
    expect(pickPlaybook("What's the funding and open interest on SOL perps?")?.id).toBe("perps");
  });
});

import { looksLikePreamble } from "../src/agent";
describe("preamble rescue", () => {
  it("spots a reply that only announces more work", () => {
    expect(looksLikePreamble("The 24h top-wallet board came back empty, so I'll pull the NVDA buyer leaderboard directly.")).toBe(true);
    expect(looksLikePreamble("One more attempt at the venue-split tool — it wasn't in my first two sets.")).toBe(true);
    expect(looksLikePreamble("BTC is at $86k, up 1%.\n\n| Level | Price |\n|---|---|")).toBe(false);
  });
  it("Solana by venue goes to the DEX playbook (it has the tape tools)", () => {
    expect(pickPlaybook("What is trading on Solana right now by venue on Chord's own tape?")?.id).toBe("dex");
  });
});
