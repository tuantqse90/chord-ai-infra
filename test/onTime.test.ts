import { describe, expect, it } from "bun:test";
import { CLOCK_SKEW_MS, ON_TIME_MS, onTimeCheck } from "../src/trust/validator";

describe("the validator's on-time check", () => {
  it("passes a commit that lands within ten minutes after the fill", () => {
    expect(onTimeCheck(15_000)).toEqual({ pass: true, note: "committed 15 s after the fill (limit 10 min)" });
    expect(onTimeCheck(ON_TIME_MS).pass).toBe(true);
    expect(onTimeCheck(ON_TIME_MS + 1).pass).toBe(false);
  });
  it("allows a minute of clock skew, and reads it as 0 s", () => {
    expect(onTimeCheck(-900)).toEqual({ pass: true, note: "committed 0 s after the fill (limit 10 min)" });
    expect(onTimeCheck(-CLOCK_SKEW_MS).pass).toBe(true);
  });
  it("fails a fill dated after its own commit: it had not happened when it was committed", () => {
    expect(onTimeCheck(-CLOCK_SKEW_MS - 1).pass).toBe(false);
    expect(onTimeCheck(-2_369_000)).toEqual({ pass: false, note: "the fill is dated 2369 s after its commit" });
  });
});
