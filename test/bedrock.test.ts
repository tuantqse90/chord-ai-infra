import { describe, expect, it } from "bun:test";
import { fromConverse, isBedrock, toConverse } from "../src/chord/services/ask/bedrock";
import { hostFor } from "../src/chord/services/ask/model";

const turn = [
  { role: "system", content: "rules" },
  { role: "user", content: "q" },
  { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "a", arguments: '{"x":1}' } }, { id: "t2", type: "function", function: { name: "b", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "t1", content: '{"ok":1}' },
  { role: "tool", tool_call_id: "t2", content: '{"ok":2}' },
];

describe("bedrock", () => {
  it("routes Claude ids to Bedrock", () => {
    expect(isBedrock("global.anthropic.claude-sonnet-5-5")).toBe(true);
    expect(hostFor("us.anthropic.claude-opus-5-5").name).toBe("bedrock");
    expect(hostFor("deepseek-flash").name).toBe("deepseek");
  });
  it("tool turns become toolUse / toolResult, consecutive tool results share one user turn", () => {
    const c = toConverse(turn, false);
    expect(c.system).toEqual([{ text: "rules" }]);
    expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect((c.messages[1].content[0] as any).toolUse).toEqual({ toolUseId: "t1", name: "a", input: { x: 1 } });
    expect(c.messages[2].content.length).toBe(2);
  });
  it("forced answer: tool turns as plain text, no tool blocks", () => {
    const c = toConverse(turn, true);
    expect(JSON.stringify(c.messages)).not.toContain("toolUse");
    expect(JSON.stringify(c.messages)).toContain("Result of a");
  });
  it("answers back in the OpenAI shape", () => {
    const r = fromConverse({ output: { message: { content: [{ text: "hi" }, { toolUse: { toolUseId: "u", name: "n", input: { a: 1 } } }] } }, stopReason: "tool_use", usage: { totalTokens: 9 } });
    expect(r.choices[0].message.content).toBe("hi");
    expect(r.choices[0].message.tool_calls[0].function).toEqual({ name: "n", arguments: '{"a":1}' });
    expect(r.usage.total_tokens).toBe(9);
  });
});
