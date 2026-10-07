import { afterEach, describe, expect, it } from "bun:test";
import { swr, _resetSwr } from "../src/swr";

afterEach(() => _resetSwr());

describe("stale-while-revalidate", () => {
  it("first ask waits; later asks answer at once; an old value refreshes once in the background; a failed refresh keeps the value", async () => {
    let n = 0;
    const run = async () => { n++; if (n === 3) throw new Error("Chord slow"); return n; };
    expect(await swr("k", 0, run)).toBe(1);          // first run
    expect(await swr("k", 0, run)).toBe(1);          // stale (ttl 0): answered at once, refresh started
    await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
    expect(await swr("k", 60_000, run)).toBe(2);     // the refresh landed
    expect(await swr("k", 0, run)).toBe(2);          // refresh 3 fails in the background
    await new Promise((r) => setTimeout(r, 0));
    expect(await swr("k", 60_000, run)).toBe(2);     // last good value kept
    const [a, b] = await Promise.all([swr("j", 0, run), swr("j", 0, run)]);
    expect(a).toBe(b);                               // one first run shared
  });
});
