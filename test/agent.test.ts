import { describe, expect, it } from "bun:test";
import { ask, type AskEvent } from "../src/agent";
import type { ChatFn } from "../src/llm";
import { sanitizeAnswer, collectIds } from "../src/sanitize";
import type { Tool } from "../src/types";

const WALLET = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const FAKE = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const fakeTool: Tool = {
  name: "sol_wallet", via: "solana", label: "Reading the wallet", description: "d",
  parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
  run: async (a) => ({ data: { address: a.address, sol: 12.5 }, sources: [{ kind: "account", id: a.address, label: "Wallet", url: null }], summary: "12.5 SOL" }),
};
const brokenTool: Tool = { ...fakeTool, name: "sol_tx", run: async () => { throw new Error("HTTP 503"); } };

function scripted(replies: Awaited<ReturnType<ChatFn>>[]): ChatFn {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)];
}

describe("the tool loop", () => {
  it("runs tool calls, streams steps, answers, and masks an address no tool returned", async () => {
    const events: AskEvent[] = [];
    const chat = scripted([
      { content: null, tokens: 10, toolCalls: [{ id: "1", type: "function", function: { name: "sol_wallet", arguments: JSON.stringify({ address: WALLET }) } },
        { id: "2", type: "function", function: { name: "sol_tx", arguments: "{}" } }] },
      { content: `Wallet ${WALLET} holds 12.5 SOL. It also sent to ${FAKE}.`, tokens: 20, toolCalls: [] },
    ]);
    await ask("How much SOL does this wallet hold?", [], (e) => { events.push(e); }, { chat, tools: [fakeTool, brokenTool] });
    const steps = events.filter((e) => e.type === "step") as any[];
    expect(steps.map((s) => [s.tool, s.ok])).toEqual([["sol_wallet", true], ["sol_tx", false]]);
    const ans = events.find((e) => e.type === "answer") as any;
    expect(ans.text).toContain(WALLET);
    expect(ans.text).not.toContain(FAKE);
    expect(ans.masked).toBe(1);
    expect(ans.tokens).toBe(30);
    expect(ans.sources[0].id).toBe(WALLET);
  });

  it("a model failure is an error event, not a crash", async () => {
    const events: AskEvent[] = [];
    await ask("q", [], (e) => { events.push(e); }, { chat: async () => { throw new Error("HTTP 500"); }, tools: [fakeTool] });
    expect(events).toEqual([{ type: "error", code: "model", message: "The model did not answer: HTTP 500" }]);
  });

  it("the same call twice in a turn reads once", async () => {
    let runs = 0;
    const counting: Tool = { ...fakeTool, run: async (a) => { runs++; return fakeTool.run(a); } };
    const call = { id: "x", type: "function" as const, function: { name: "sol_wallet", arguments: JSON.stringify({ address: WALLET }) } };
    const chat = scripted([{ content: null, tokens: 1, toolCalls: [call] }, { content: null, tokens: 1, toolCalls: [{ ...call, id: "y" }] }, { content: "done", tokens: 1, toolCalls: [] }]);
    await ask("q", [], () => {}, { chat, tools: [counting] });
    expect(runs).toBe(1);
  });
});

describe("sanitizer", () => {
  it("keeps ids from tools and the question, masks others, leaves ordinary words alone", () => {
    const allowed = collectIds({ a: WALLET, tx: "0x" + "ab".repeat(20) });
    const { text, masked } = sanitizeAnswer(`ok ${WALLET} 0x${"AB".repeat(20)} bad ${FAKE} and Supercalifragilisticexpialidocious words`, allowed);
    expect(text).toContain(WALLET);
    expect(text).toContain("0x" + "AB".repeat(20));
    expect(text).not.toContain(FAKE);
    expect(text).toContain("Supercalifragilisticexpialidocious");
    expect(masked).toBe(1);
  });
});

describe("a final answer that opens by announcing a lookup", () => {
  it("drops that first line and keeps the answer; leaves a real first line and a bare preamble alone", async () => {
    const { dropLeadingPreamble } = await import("../src/agent");
    const body = "CHOG and emo on Monad show different trading patterns today: CHOG has higher volume ($23,418) while emo has stronger buy pressure.\n| Metric | CHOG | emo |";
    expect(dropLeadingPreamble(`Let me use the Chord's Monad index tool to get current price data for both tokens.\n${body}`)).toBe(body);
    expect(dropLeadingPreamble(`I'll check the latest trades first.\n\n${body}`)).toBe(body);
    expect(dropLeadingPreamble(body)).toBe(body);
    expect(dropLeadingPreamble("Let me explain what a track record is.\nIt is a chain of hashes, one per fill, that anyone can rebuild from the documents and compare with Monad.")).toContain("Let me explain");
    expect(dropLeadingPreamble("Let me check the tool.\nShort.")).toContain("Let me check");
  });
});
