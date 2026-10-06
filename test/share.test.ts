import { describe, expect, it } from "bun:test";
import { cleanShare } from "../src/share";

describe("share", () => {
  it("keeps plain data, drops non-https links and empty turns", () => {
    const s = cleanShare({ title: "t", turns: [
      { q: "q1", a: { text: "a1", sources: [{ label: "ok", url: "https://solscan.io/tx/x" }, { label: "bad", url: "javascript:alert(1)" }], followUps: ["f"], steps: [{ label: "s", ok: true }] } },
      { q: "q2", a: null },
    ] })!;
    expect(s.turns.length).toBe(1);
    const a = (s.turns[0] as any).a;
    expect(a.sources.map((x: any) => x.url)).toEqual(["https://solscan.io/tx/x", null]);
    expect(cleanShare({ turns: [] })).toBeNull();
  });
});
