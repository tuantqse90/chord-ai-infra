// /v1/strategies: the custom agent builder over HTTP (ask2049-notes/PROMPT-bot-builder.md). Words → Strategy JSON (the app's
// model), validation with block-named errors, the template gallery, a backtest on real history. Starting a strategy agent is
// POST /v1/agents { type: "custom", params: { strategy } }.
//   POST /compile  { text, answers?: [{ question, answer }] } → { strategy, explanation, warnings, questions }
//   POST /validate { strategy } → 200 { ok, strategy, explanation } | 422 { ok: false, errors }
//   GET  /templates → { templates: [{ id, title, oneLine, risk, strategy, explanation }] }
//   POST /backtest { strategy, days } → StrategyBacktest
// GET /v1/agents/templates (templatesWithHeadline) adds each template's own 3-day backtest, recomputed hourly in the background.
import { Hono } from "hono";
import { backtestStrategy, compileStrategy, explainStrategy, listTemplates, StrategyInputError, validateStrategy, type StrategyBacktest } from "./strategy";

const fail = (c: any, e: unknown) => {
  if (e instanceof StrategyInputError) return c.json({ error: "bad_strategy", message: e.message, errors: e.errors }, 400);
  return c.json({ error: "strategy_unavailable", message: String((e as Error)?.message ?? e).slice(0, 200) }, 503);
};

// The compiler calls the model: a small per-caller budget (session header, else the address) keeps one page from looping it.
const COMPILE_PER_MIN = 12;
const hits = new Map<string, number[]>();
function allowCompile(who: string): boolean {
  const now = Date.now(), list = (hits.get(who) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= COMPILE_PER_MIN) { hits.set(who, list); return false; }
  list.push(now); hits.set(who, list);
  if (hits.size > 5_000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  return true;
}
const callerOf = (c: any) => c.req.header("x-session") || c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "anon";

export const strategies = new Hono();
strategies.post("/compile", async (c) => {
  if (!allowCompile(callerOf(c))) return c.json({ error: "rate_limited", message: `${COMPILE_PER_MIN} generations a minute` }, 429);
  const b = await c.req.json().catch(() => ({}));
  const answers = Array.isArray(b.answers) ? b.answers.filter((a: any) => a && String(a.answer ?? "").trim()).slice(0, 10) : [];
  const text = [String(b.text ?? ""), ...answers.map((a: any) => `${String(a.question ?? a.id ?? "").slice(0, 200)} → ${String(a.answer).slice(0, 300)}`)].join("\n").trim();
  try { return c.json(await compileStrategy(text)); } catch (e) { return fail(c, e); }
});
strategies.post("/validate", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = validateStrategy(b.strategy);
  return r.ok ? c.json({ ok: true, strategy: r.strategy, explanation: explainStrategy(r.strategy) }) : c.json({ ok: false, errors: r.errors }, 422);
});
strategies.get("/templates", (c) => c.json({ templates: listTemplates().map((t) => ({ ...t, explanation: explainStrategy(t.strategy) })) }));
strategies.post("/backtest", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  try { return c.json(await backtestStrategy(b.strategy, b.days ?? 3)); } catch (e) { return fail(c, e); }
});

// ── template headlines: each template's own backtest over 3 days, one at a time, every hour ─────────────────────────────
type Headline = { days: number; pnlUsd: number; investedUsd: number; trades: number; winRate: number | null; signals: number; at: number };
const headlines = new Map<string, Headline | null>();
let headlineTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
const r2 = (n: number) => Math.round(n * 100) / 100;
export function headlineOf(bt: StrategyBacktest, at = Date.now()): Headline {
  return { days: bt.days, pnlUsd: r2(bt.realizedUsd + bt.unrealizedUsd), investedUsd: r2(bt.investedUsd), trades: bt.trades, winRate: bt.winRate, signals: bt.signals, at };
}
async function refreshHeadlines(run: typeof backtestStrategy = backtestStrategy): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const t of listTemplates()) {
      try { headlines.set(t.id, headlineOf(await run(t.strategy, 3))); } catch { if (!headlines.has(t.id)) headlines.set(t.id, null); }
    }
  } finally { running = false; }
}
export function startHeadlines(): void {
  if (headlineTimer || process.env.NODE_ENV === "test") return;
  setTimeout(() => void refreshHeadlines(), 20_000);
  headlineTimer = setInterval(() => void refreshHeadlines(), 3_600_000);
  (headlineTimer as any).unref?.();
}
/** The gallery for the Agents page: templates + their backtest headline (null until computed) + how many agents run each. */
export function templatesWithHeadline(runningOf: (id: string) => number = () => 0) {
  return listTemplates().map((t) => ({ ...t, explanation: explainStrategy(t.strategy), running: runningOf(t.id), headline: headlines.get(t.id) ?? null }));
}
export const _strategyRoutesTest = { refreshHeadlines, headlines, hits };
