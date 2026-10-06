// Number check (docs/ask-harness-plan.md, phase 4). Rule one of the prompt is "never state a number a tool did not
// return" — until now only addresses were checked. Every number in the answer is traced to the tool outputs of the
// turn (or to the person's own words: their question, earlier turns, their profile), tolerant to how people write
// numbers: $12.4k, 1.2M, 3.2 %, 83,800 for 83,768, 0.12 as 12 %. What cannot be traced is counted in telemetry and,
// with ASK_VERIFY=repair, sent back once for a rewrite.
//
// Not checked (they are not claims about the market): years, dates, times, list numbers, small counts (≤ 10 without
// $ or %), numbers inside tickers or addresses (XYZ100, 0x…), windows like 24h / 7d / 4h.

export interface NumberCheck { total: number; unverified: string[] }

const ADDR = /0x[0-9a-fA-F]{6,}/g;
const MIXED = /\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+\b/g; // XYZ100, USDC0, 24h, 4h, 1D
const DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
// $12.4k · −3.2% · 1,204 · 0.0031 · 83,800 · 4.5M · 2.1B
const NUM = /(?<![\w.])([-−+]?)(\$?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k|K|m|M|b|B|bn|%|thousand|million|billion|trillion|mn|tn)?(?![A-Za-z0-9])/gi;

const WINDOW_AFTER = /^\s?-?(?:day|days|hour|hours|hr|hrs|week|weeks|month|months|year|years|min|mins|minute|minutes|second|seconds|candles?|bars?|sessions?|tranches?|rungs?|steps?|trades|wallets|holders|traders|tokens|pools|posts|times|rows|periods?|ngày|giờ|tuần|tháng|phút|nến|lệnh|ví)\b/i;
const WINDOW_BEFORE = /(?:\btop|\blast|\bpast|\bnext|\bfirst|\bRSI|\bMA|\bEMA|\bSMA|\bATR)\s?-?$/i;

interface Parsed { raw: string; value: number; money: boolean; pct: boolean; tol: number }

function parseAll(text: string): Parsed[] {
  const clean = text.replace(ADDR, " ").replace(DATE, " ").replace(MIXED, (m) => (/^\d+(?:\.\d+)?[kKmMbB]$/.test(m) ? m : " "));
  const out: Parsed[] = [];
  for (const m of clean.matchAll(NUM)) {
    const [raw, sign, dollar, int, frac = "", suf = ""] = m;
    // a window or a count, not a market number: "30-day", "90 days", "20 candles", "top 10", "3 tranches", "RSI 14"
    const after = clean.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 14);
    const before = clean.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0);
    if (!dollar && !suf && (WINDOW_AFTER.test(after) || WINDOW_BEFORE.test(before))) continue;
    const mult = /^(k|thousand)$/i.test(suf) ? 1e3 : /^(m|mn|million)$/i.test(suf) ? 1e6 : /^(b|bn|billion)$/i.test(suf) ? 1e9 : /^(tn|trillion)$/i.test(suf) ? 1e12 : 1;
    // a year on its own ("in 2026", "since 2025") is a date, not a market number
    if (!dollar && !suf && !frac && !int.includes(",") && /^(19|20)\d\d$/.test(int)) continue;
    const base = Number(int.replace(/,/g, "") + frac);
    if (!Number.isFinite(base)) continue;
    const value = (sign === "-" || sign === "−" ? -1 : 1) * base * mult;
    const decimals = frac ? frac.length - 1 : 0;
    // the precision the writer used: half a unit of the last printed digit, at least 1 % (rounded levels)
    const tol = Math.max(0.5 * 10 ** -decimals * mult, Math.abs(value) * 0.01);
    out.push({ raw: raw.trim(), value, money: !!dollar, pct: suf === "%", tol });
  }
  return out;
}

/** Every number in a tool output (numeric leaves + numbers written inside strings). */
export function numbersIn(data: unknown, into: number[] = []): number[] {
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || into.length > 50_000) return;
    if (typeof v === "number" && Number.isFinite(v)) into.push(v);
    else if (typeof v === "string") { if (/\d/.test(v) && v.length < 400) for (const p of parseAll(v)) into.push(p.value); }
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  return into;
}

function traced(p: Parsed, pool: Float64Array): boolean {
  const cands = [p.value, Math.abs(p.value)];
  if (p.pct) cands.push(p.value / 100, Math.abs(p.value) / 100); // 12 % written for a 0.12 fraction
  for (const c of cands) {
    // binary search the sorted pool for anything within tolerance
    let lo = 0, hi = pool.length - 1;
    const want = c - p.tol;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid] < want) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < pool.length && pool[i] <= c + p.tol; i++) if (Math.abs(pool[i] - c) <= p.tol) return true;
  }
  return false;
}

/** Numbers in `answer` that no tool output and nothing the person wrote accounts for. */
export function checkNumbers(answer: string, toolData: unknown[], personText: string[]): NumberCheck {
  const nums = parseAll(answer).filter((p) => p.money || p.pct || Math.abs(p.value) > 10);
  if (!nums.length) return { total: 0, unverified: [] };
  const pool: number[] = [];
  for (const d of toolData) numbersIn(d, pool);
  for (const t of personText) for (const p of parseAll(t)) pool.push(p.value);
  // negatives: a "−12%" answer against a -12 change is the same number; keep both signs available
  const all = new Float64Array(pool.length * 2);
  pool.forEach((v, i) => { all[2 * i] = v; all[2 * i + 1] = Math.abs(v); });
  all.sort();
  const unverified = [...new Set(nums.filter((p) => !traced(p, all)).map((p) => p.raw))];
  return { total: nums.length, unverified };
}

export type VerifyMode = "off" | "log" | "repair";
export const verifyMode = (): VerifyMode => (process.env.ASK_VERIFY === "off" ? "off" : process.env.ASK_VERIFY === "repair" ? "repair" : "log");
/** Worth a rewrite: several untraceable numbers and a real share of the answer's numbers. */
export const needsRepair = (c: NumberCheck): boolean => c.unverified.length >= 3 && c.unverified.length / Math.max(1, c.total) >= 0.25;

export function repairPrompt(c: NumberCheck): string {
  return `These numbers in your answer do not appear in any tool result of this conversation: ${c.unverified.slice(0, 12).join(", ")}. Rewrite the whole answer (same language, same structure, FOLLOW-UPS included) using only numbers from the tool results. If a number is your own arithmetic on tool numbers, keep it and show the inputs next to it (e.g. "risk $100 = 2 % × $5,000"). Do not apologise or mention this check.`;
}
