// Tool output → what the model reads (docs/ask-harness-plan.md, phase 1). Before: `JSON.stringify(data).slice(0, 9000)`
// — a board of 150 rows was cut mid-object, the model read broken JSON and never knew rows were missing. Now the output
// is shrunk STRUCTURALLY until it fits: long arrays keep their first rows and say how many were dropped, long strings are
// clipped, and the result is always valid JSON. Order of work: the biggest array first, halving, then strings.

// 7,000 since 2026-09-26 (was 9,000): every round re-sends all earlier tool output, and board tools filled the budget.
export const TOOL_OUTPUT_BUDGET = 7_000;

/** 1.2295e-8 → 0.000000012295 (self-test 2026-09-26: JSON writes numbers under 1e-6 in exponent form and the model copied
 *  "$1.2295e-8" into answers). Exact digit shifting, no float maths; still a valid JSON number. Only negative exponents. */
export function expandSci(text: string): string {
  return text.replace(/(?<![\w.])(-?)(\d+)(?:\.(\d+))?[eE](-\d+)(?![\w.])/g, (_m, sign: string, int: string, frac = "", exp: string) => {
    const digits = (int + frac).replace(/^0+(?=\d)/, "");
    const lead = int.replace(/^0+/, "").length || 0;
    const point = (int === "0" ? 0 : lead) + Number(exp);
    const body = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : `${digits.slice(0, point)}.${digits.slice(point)}`;
    return sign + body.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  });
}
const NOTE = "_more";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function size(v: unknown): number { try { return JSON.stringify(v)?.length ?? 4; } catch { return Infinity; } }

/** Deep copy through JSON (drops functions / undefined, converts dates) — the shrinker edits the copy. */
function plain(v: unknown): Json {
  try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return { error: "tool output could not be serialised" }; }
}

/** Every array in the tree with a setter, biggest first. */
function arrays(root: Json): { len: number; bytes: number; set: (a: Json[]) => void; get: () => Json[] }[] {
  const out: { len: number; bytes: number; set: (a: Json[]) => void; get: () => Json[] }[] = [];
  const walk = (v: Json, set: (x: Json) => void) => {
    if (Array.isArray(v)) {
      const holder = { v };
      out.push({ len: v.length, bytes: size(v), get: () => holder.v, set: (a) => { holder.v = a; set(a); } });
      v.forEach((x, i) => walk(x, (y) => { holder.v[i] = y; }));
    } else if (v && typeof v === "object") {
      for (const k of Object.keys(v)) walk(v[k], (y) => { (v as Record<string, Json>)[k] = y; });
    }
  };
  walk(root, () => {});
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** The longest string anywhere in the tree, with a setter. */
function longestString(root: Json): { len: number; get: () => string; set: (s: string) => void } | null {
  let best: { len: number; get: () => string; set: (s: string) => void } | null = null;
  const walk = (v: Json, set: (x: Json) => void) => {
    if (typeof v === "string") { if (!best || v.length > best.len) best = { len: v.length, get: () => v, set }; return; }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, (y) => { v[i] = y; }));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], (y) => { (v as Record<string, Json>)[k] = y; });
  };
  walk(root, () => {});
  return best;
}

function clipStrings(v: Json, max: number): Json {
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…` : v;
  if (Array.isArray(v)) return v.map((x) => clipStrings(x, max));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipStrings(x, max)]));
  return v;
}

/** Shrinks `data` to at most `budget` chars of JSON. Returns the text the model reads and whether anything was dropped. */
export function shrinkForModel(data: unknown, budget = TOOL_OUTPUT_BUDGET): { text: string; truncated: boolean; bytes: number } {
  const full = JSON.stringify(data ?? null) ?? "null";
  if (full.length <= budget) return { text: expandSci(full), truncated: false, bytes: full.length };
  let root = plain(data);
  // 1) halve the biggest arrays (keeping at least 3 rows), noting how many rows were dropped
  for (let pass = 0; pass < 40 && size(root) > budget; pass++) {
    const isNote = (x: Json) => !!x && typeof x === "object" && !Array.isArray(x) && NOTE in x;
    const arr = arrays(root).find((a) => a.get().filter((x) => !isNote(x)).length > 3);
    if (!arr) break;
    const cur = arr.get();
    const realRows = cur.filter((x) => !isNote(x));
    const prevNote = cur.find(isNote) as { [NOTE]: string } | undefined;
    const dropped = Number(prevNote?.[NOTE]?.match(/\d+/)?.[0] ?? 0);
    const keep = Math.max(3, Math.floor(realRows.length / 2));
    const next: Json[] = [...realRows.slice(0, keep), { [NOTE]: `${dropped + realRows.length - keep} more rows not shown` }];
    if (Array.isArray(root) && arr.get() === root) root = next; else arr.set(next);
  }
  // 2) one long string over the budget (a web page's text) is cut just enough to fit, keeping ≥ 1,000 characters — clipping
  //    every string to 600 turned a 9k-character page into its first paragraph (live 2026-09-26, HIP-3 docs).
  for (let pass = 0; pass < 4 && size(root) > budget; pass++) {
    const longest = longestString(root);
    if (!longest || longest.len <= 1_000) break;
    const over = size(root) - budget;
    longest.set(`${longest.get().slice(0, Math.max(1_000, longest.len - over - 40))}…`);
  }
  // 3) clip long strings
  for (const max of [600, 240, 120, 60]) { if (size(root) <= budget) break; root = clipStrings(root, max); }
  let text = expandSci(JSON.stringify(root));
  // 4) last resort: a valid wrapper around a clipped preview (never a cut mid-token)
  if (text.length > budget) text = JSON.stringify({ [NOTE]: "output too large — narrow the question (a smaller limit, one token, a shorter window)", preview: text.slice(0, Math.max(0, budget - 200)) });
  return { text, truncated: true, bytes: full.length };
}
