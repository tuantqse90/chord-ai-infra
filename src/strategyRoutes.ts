// /v1/strategies: the custom agent builder over HTTP (ask2049-notes/PROMPT-bot-builder.md). Words → Strategy JSON (the app's
// model), validation with block-named errors, the template gallery, a backtest on real history. Starting a strategy agent is
// POST /v1/agents { type: "custom", params: { strategy } }.
//   POST /compile  { text, answers?: [{ question, answer }] } → { strategy, explanation, warnings, questions }
//   POST /validate { strategy } → 200 { ok, strategy, explanation } | 422 { ok: false, errors }
//   GET  /templates → { templates: [{ id, title, oneLine, risk, strategy, explanation }] }
//   POST /backtest { strategy, days } → StrategyBacktest
// GET /v1/agents/templates (templatesWithHeadline) adds each template's own 3-day backtest, recomputed hourly in the background.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import { config } from "./config";
import { createHash } from "node:crypto";
import { longJob, StillRunning } from "./longJob";
import { backtestStrategy, compileStrategy, explainStrategy, listTemplates, StrategyInputError, validateStrategy, type StrategyBacktest } from "./strategy";

const fail = (c: any, e: unknown) => {
  if (e instanceof StillRunning) return c.json({ error: e.code, message: e.message }, 503);
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
  const key = `sbt:${createHash("sha1").update(JSON.stringify([b.strategy ?? null, b.days ?? 3])).digest("hex")}`;
  try { return c.json(await longJob(key, () => backtestStrategy(b.strategy, b.days ?? 3))); } catch (e) { return fail(c, e); }
});

// ── template headlines: each template's own backtest over 3 days, one at a time, every hour ─────────────────────────────
type Headline = { days: number; pnlUsd: number; investedUsd: number; trades: number; winRate: number | null; signals: number; at: number;
  coveredHours?: number; walletsRead?: number; unreadWallets?: string[] };
const headlines = new Map<string, Headline | null>();
// kept in the app DB so a restart does not blank the cards (QA 07/10: "0 trades" / missing right after a deploy)
let hdb: Database | null = null;
function hstore(): Database | null {
  if (hdb) return hdb;
  if (process.env.NODE_ENV === "test") return null;
  try {
    const path = config.dbPath();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    hdb = new Database(path, { create: true });
    hdb.run("CREATE TABLE IF NOT EXISTS template_headlines (id TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL)");
    for (const r of hdb.query("SELECT id, json FROM template_headlines").all() as { id: string; json: string }[]) {
      try { headlines.set(r.id, JSON.parse(r.json)); } catch { /* a bad row is recomputed */ }
    }
  } catch { hdb = null; }
  return hdb;
}
/** A replay that could not read its data (wallets unread, Chord timeouts) is not a result: it never replaces a good one. */
const degraded = (bt: StrategyBacktest) => (bt.unreadWallets?.length ?? 0) > 0 || (bt.notes ?? []).some((n) => /could not be read|timed out|answered 5\d\d/i.test(n));
let headlineTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
const r2 = (n: number) => Math.round(n * 100) / 100;
export function headlineOf(bt: StrategyBacktest, at = Date.now()): Headline {
  return { days: bt.days, pnlUsd: r2(bt.realizedUsd + bt.unrealizedUsd), investedUsd: r2(bt.investedUsd), trades: bt.trades, winRate: bt.winRate, signals: bt.signals, at,
    ...(bt.coveredHours != null ? { coveredHours: bt.coveredHours } : {}), ...(bt.walletsRead != null ? { walletsRead: bt.walletsRead, unreadWallets: bt.unreadWallets ?? [] } : {}) };
}
async function refreshHeadlines(run: typeof backtestStrategy = backtestStrategy): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const t of listTemplates()) {
      try {
        const bt = await run(t.strategy, 3);
        if (degraded(bt) && headlines.get(t.id)) continue; // keep the last clean replay
        const h = headlineOf(bt);
        headlines.set(t.id, h);
        hstore()?.run("INSERT OR REPLACE INTO template_headlines (id, json, at) VALUES (?, ?, ?)", [t.id, JSON.stringify(h), h.at]);
      } catch { if (!headlines.has(t.id)) headlines.set(t.id, null); }
    }
  } finally { running = false; }
}
export function startHeadlines(): void {
  if (headlineTimer || process.env.NODE_ENV === "test") return;
  hstore(); // the last kept headlines show at once
  setTimeout(() => void refreshHeadlines(), 20_000);
  // a template with no headline yet (its replay failed) is tried again every 5 min, not an hour later
  const retry = setInterval(() => { if (listTemplates().some((t) => !headlines.get(t.id))) void refreshHeadlines(); }, 300_000);
  (retry as any).unref?.();
  headlineTimer = setInterval(() => void refreshHeadlines(), 3_600_000);
  (headlineTimer as any).unref?.();
}
/** The gallery for the Agents page: templates + their backtest headline (null until computed) + how many agents run each. */
export function templatesWithHeadline(runningOf: (id: string) => number = () => 0) {
  return listTemplates().map((t) => ({ ...t, explanation: explainStrategy(t.strategy), running: runningOf(t.id), headline: headlines.get(t.id) ?? null }));
}
export const _strategyRoutesTest = { refreshHeadlines, headlines, hits };
