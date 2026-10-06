// ask2049: Chord's services/askClarify.test.ts, copied unchanged (2026-10-06).
import { describe, expect, it } from "bun:test";
import { clarifyHistoryText, normalizeClarify } from "./askClarify";

describe("askClarify — the ask-back card (Minara's own card failed on a 12-char header limit)", () => {
  it("trims instead of rejecting, drops empty and duplicate options, caps at 4", () => {
    const c = normalizeClarify({
      question: "Bạn của bạn đang nói đến SATS nào? ".repeat(10),
      options: [{ label: "1000SATS", detail: "SATS (Ordinals), BRC-20 on Bitcoin" }, { label: "1000sats" }, { label: "" }, "SATS khác", { label: "Không rõ" }, { label: "Fifth" }, { label: "Sixth" }],
    })!;
    expect(c.question.length).toBeLessThanOrEqual(200);
    expect(c.options.map((o) => o.label)).toEqual(["1000SATS", "SATS khác", "Không rõ", "Fifth"]);
    expect(c.options[0].detail).toBe("SATS (Ordinals), BRC-20 on Bitcoin");
    expect(c.allowOther).toBe(true);
    expect(c.multi).toBe(false);
  });
  it("accepts the shapes models drift into (header/choices/description)", () => {
    const c = normalizeClarify({ header: "Which chain?", choices: [{ title: "Arc", description: "USDC chain" }, { title: "Robinhood" }] })!;
    expect(c.question).toBe("Which chain?");
    expect(c.options).toEqual([{ label: "Arc", detail: "USDC chain" }, { label: "Robinhood", detail: null }]);
  });
  it("nothing askable → null; the same question keeps its id", () => {
    expect(normalizeClarify({ options: [{ label: "a" }, { label: "b" }] })).toBeNull();
    expect(normalizeClarify({ question: "x?", options: [{ label: "a" }], allow_other: false })).toBeNull();
    const a = normalizeClarify({ question: "x?", options: ["a", "b"] })!, b = normalizeClarify({ question: "x?", options: ["a", "b"] })!;
    expect(a.id).toBe(b.id);
  });
  it("history line names the question and the options", () => {
    const c = normalizeClarify({ question: "Which SATS?", options: ["1000SATS", "Other"] })!;
    expect(clarifyHistoryText("SATS is several tokens.", c)).toBe("SATS is several tokens.\n\n[I asked: Which SATS? — options: 1000SATS / Other. The next message is the person's answer.]");
  });
});
