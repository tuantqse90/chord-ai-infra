import { afterEach, describe, expect, it } from "bun:test";
import { longJob, StillRunning, _resetLongJobs } from "../src/longJob";

afterEach(() => _resetLongJobs());

describe("long replays", () => {
  it("a slow run answers 'still running', keeps going, and the same request later gets the kept result", async () => {
    let runs = 0;
    let finish!: (v: number) => void;
    const run = () => { runs++; return new Promise<number>((r) => { finish = r; }); };
    const e = await longJob("k", run, 20).catch((x) => x);
    expect(e).toBeInstanceOf(StillRunning);
    expect(e).toMatchObject({ status: 503, code: "still_running" });
    const again = longJob("k", run, 1_000); // joins the same run
    finish(42);
    expect(await again).toBe(42);
    expect(await longJob("k", run, 20)).toBe(42); // kept
    expect(runs).toBe(1);
  });
  it("an error is not kept", async () => {
    let n = 0;
    const run = async () => { if (++n === 1) throw new Error("Chord slow"); return n; };
    await expect(longJob("e", run)).rejects.toThrow("Chord slow");
    expect(await longJob("e", run)).toBe(2);
  });
});
