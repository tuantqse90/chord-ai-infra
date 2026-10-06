import { describe, expect, test } from "bun:test";
import { shrinkForModel } from "./shrink";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ rank: i + 1, wallet: `0x${String(i).padStart(40, "a")}`, pnlUsd: i * 1000, note: "x".repeat(40) }));

describe("shrinkForModel", () => {
  test("small output passes through untouched", () => {
    const r = shrinkForModel({ a: 1, b: [1, 2, 3] });
    expect(r).toEqual({ text: '{"a":1,"b":[1,2,3]}', truncated: false, bytes: 19 });
  });

  test("a long board keeps its first rows, says how many were dropped, stays valid JSON under budget", () => {
    const data = { window: "24h", rows: rows(200) };
    const r = shrinkForModel(data, 3000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(3000);
    const back = JSON.parse(r.text);
    expect(back.window).toBe("24h");
    expect(back.rows[0].rank).toBe(1);
    const note = back.rows.at(-1)._more as string;
    const shown = back.rows.length - 1;
    expect(note).toBe(`${200 - shown} more rows not shown`);
  });

  test("a top-level array shrinks too", () => {
    const r = shrinkForModel(rows(300), 2000);
    const back = JSON.parse(r.text);
    expect(Array.isArray(back)).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(back.at(-1)._more).toMatch(/more rows not shown/);
  });

  test("long strings are clipped when arrays are not the problem", () => {
    const r = shrinkForModel({ summary: "y".repeat(20_000), n: 3 }, 1000);
    const back = JSON.parse(r.text);
    expect(back.n).toBe(3);
    expect(back.summary.length).toBeLessThan(700);
  });

  test("an array already at its floor does not block the next one from shrinking", () => {
    // `fat` halves to 3 rows + note and is STILL the biggest array; before the fix it was picked again forever, `rows`
    // never shrank and the fat blobs got clipped instead.
    const fat = Array.from({ length: 8 }, () => ({ blob: "z".repeat(3000) }));
    const data = { fat, rows: rows(60) };
    const r = shrinkForModel(data, 12_000);
    const back = JSON.parse(r.text);
    expect(r.text.length).toBeLessThanOrEqual(12_000);
    expect(back.rows.at(-1)._more).toMatch(/more rows not shown/);
    expect(back.fat[0].blob.length).toBe(3000);
  });

  test("never cuts mid-token even when nothing shrinks enough", () => {
    const big = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, i]));
    const r = shrinkForModel(big, 500);
    expect(() => JSON.parse(r.text)).not.toThrow();
    expect(r.text.length).toBeLessThanOrEqual(500);
  });
});

import { expandSci } from "./shrink";
describe("shrinkForModel — one long text", () => {
  test("a page's text is cut just enough to fit, not clipped to 600 (HIP-3 docs, 2026-09-26)", () => {
    const page = { url: "https://docs.example.com/hip3", title: "HIP-3", text: "word ".repeat(2_400), links: Array.from({ length: 20 }, (_, i) => ({ text: `L${i}`, url: `https://docs.example.com/${i}` })) };
    const r = shrinkForModel(page, 12_000);
    expect(r.text.length).toBeLessThanOrEqual(12_000);
    const j = JSON.parse(r.text);
    expect(j.text.length).toBeGreaterThan(9_000);
    expect(j.title).toBe("HIP-3");
    const small = shrinkForModel(page, 7_000);
    expect(JSON.parse(small.text).text.length).toBeGreaterThan(4_000);
  });
});

describe("expandSci", () => {
  test("tiny prices become plain decimals, in prose and in JSON", () => {
    expect(expandSci("buy under $1.2295e-8, stop $8.75e-9")).toBe("buy under $0.000000012295, stop $0.00000000875");
    expect(expandSci('{"priceUsd":1.2e-7,"n":3}')).toBe('{"priceUsd":0.00000012,"n":3}');
    expect(expandSci("-5e-7 and 12.5e-3")).toBe("-0.0000005 and 0.0125");
    expect(JSON.parse(expandSci(JSON.stringify({ p: 1.2295e-8 }))).p).toBe(1.2295e-8);
  });
  test("leaves everything else alone", () => {
    expect(expandSci("1e21 wei, 0x1e5a, 3.2e+4, version 2e-2b, $12.4k")).toBe("1e21 wei, 0x1e5a, 3.2e+4, version 2e-2b, $12.4k");
  });
  test("shrinkForModel output has no exponent form", () => {
    expect(shrinkForModel({ rows: [{ p: 4.5e-9 }] }).text).toBe('{"rows":[{"p":0.0000000045}]}');
  });
});
