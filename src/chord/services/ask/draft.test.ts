import { describe, expect, test } from "bun:test";
import { AnswerDraft } from "./draft";

const A = "0x" + "ab".repeat(20);
const B = "0x" + "cd".repeat(20);

describe("AnswerDraft", () => {
  test("releases only complete lines, never half an address", () => {
    const out: string[] = [];
    const d = new AnswerDraft((t) => out.push(t), new Set([A]), 0);
    d.push("Top wallet: ");
    d.push(A.slice(0, 20));
    expect(out).toEqual([]);
    d.push(A.slice(20) + " made $12k.\nSecond: ");
    expect(out).toEqual([`Top wallet: ${A} made $12k.`]);
  });

  test("an address no tool returned is masked in the draft too", () => {
    const out: string[] = [];
    const d = new AnswerDraft((t) => out.push(t), new Set([A]), 0);
    d.push(`Send to ${B} now\n`);
    expect(out.at(-1)).toBe("Send to (unverified address) now");
  });

  test("stops at FOLLOW-UPS and at DSML markup", () => {
    const out: string[] = [];
    const d = new AnswerDraft((t) => out.push(t), new Set(), 0);
    d.push("Answer line.\nFOLLOW-UPS:\n- next?\n");
    d.push("more\n");
    expect(out).toEqual(["Answer line."]);
    const out2: string[] = [];
    const d2 = new AnswerDraft((t) => out2.push(t), new Set(), 0);
    d2.push("Checking <｜｜DSML｜｜ invoke name=\"x\">\n");
    expect(out2).toEqual(["Checking"]);
  });

  test("reset clears a preamble; final flush releases the unterminated tail", () => {
    const out: string[] = [];
    const d = new AnswerDraft((t) => out.push(t), new Set(), 0);
    d.push("Let me check.\n");
    d.reset();
    d.push("BTC is at $83,800");
    d.flush(true);
    expect(out).toEqual(["Let me check.", "", "BTC is at $83,800"]);
  });
});
