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

import { readEventFrames } from "../src/chord/services/ask/bedrock";
function frame(headers: Record<string, string>, payload: string): Uint8Array {
  const enc = new TextEncoder();
  const hs = Object.entries(headers).map(([k, v]) => { const kb = enc.encode(k), vb = enc.encode(v); const b = new Uint8Array(1 + kb.length + 1 + 2 + vb.length); b[0] = kb.length; b.set(kb, 1); b[1 + kb.length] = 7; b[2 + kb.length] = vb.length >> 8; b[3 + kb.length] = vb.length & 255; b.set(vb, 4 + kb.length); return b; });
  const hlen = hs.reduce((a, b) => a + b.length, 0), pb = enc.encode(payload), total = 12 + hlen + pb.length + 4;
  const out = new Uint8Array(total); const dv = new DataView(out.buffer); dv.setUint32(0, total); dv.setUint32(4, hlen);
  let o = 12; for (const h of hs) { out.set(h, o); o += h.length; } out.set(pb, o);
  return out;
}
describe("bedrock event stream", () => {
  it("splits frames, keeps a partial one for the next chunk", () => {
    const a = frame({ ":event-type": "contentBlockDelta", ":message-type": "event" }, '{"contentBlockIndex":0,"delta":{"text":"po"}}');
    const b = frame({ ":event-type": "messageStop", ":message-type": "event" }, '{"stopReason":"end_turn"}');
    const both = new Uint8Array(a.length + b.length - 5); both.set(a); both.set(b.subarray(0, b.length - 5), a.length);
    const r = readEventFrames(both);
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].headers[":event-type"]).toBe("contentBlockDelta");
    expect(JSON.parse(new TextDecoder().decode(r.frames[0].payload)).delta.text).toBe("po");
    expect(r.rest.length).toBe(b.length - 5);
  });
});
