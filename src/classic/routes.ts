// /v1/classic: the classic strategies over HTTP.
//   GET  /strategies   the catalog: id, title, one line, timeframe and window it is tuned for, params with ranges, the rule
//   GET  /symbols      Perpl's live markets (max leverage, taker fee), the Monad spot tokens, the data sources
//   POST /backtest     { strategy, params?, symbol, tf?, days?, source: binance | okx | hyperliquid | perpl | all, venue?, sizeUsd?, leverage? }
//   GET  /templates    every strategy's headline: BTC on its own timeframe and window, Perpl, $100, on all four sources (6 h)
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { longJob, StillRunning } from "../longJob";
import { backtest, backtestAll, SPOT_TOKENS, VENUE_FEE_BPS, type AcrossSources, type BacktestInput } from "./backtest";
import { SOURCE_NAMES, SOURCES, type Source } from "./data";
import { CLASSIC, ClassicInputError, paramsFor } from "./strategies";
import * as perpl from "../perpl/client";

const jobKey = (input: unknown) => `classic:${createHash("sha1").update(JSON.stringify(input ?? null)).digest("hex")}`;
export const catalog = () => CLASSIC.map((s) => ({ id: s.id, title: s.title, line: s.line, tf: s.tf, days: s.days, sides: s.sides, needsFunding: !!s.needsFunding, params: s.params, rule: s.rule(paramsFor(s, {})) }));

function fail(c: any, e: unknown): Response {
  if (e instanceof ClassicInputError) return c.json({ error: "bad_request", message: e.message }, 400);
  if (e instanceof StillRunning) return c.json({ error: e.code, message: e.message }, 503);
  return c.json({ error: "classic_error", message: String((e as Error)?.message ?? e).slice(0, 200) }, 502);
}

// ── template headlines (BTC, each strategy's own tf / window, Perpl, $100 at 1x, all four sources) ─────────────────────
type Headline = { id: string; symbol: string; tf: string; days: number; bySource: Partial<Record<Source, { returnPct: number; pnlUsd: number; trades: number; maxDrawdownPct: number; winRate: number | null }>>; buyHoldPct: number | null; agree: boolean | null; errors: Partial<Record<Source, string>> };
let headlines: { at: number; rows: Headline[] } | null = null, building: Promise<void> | null = null;
export const HEADLINE_SYMBOL = "BTC";
async function buildHeadlines(): Promise<void> {
  const rows: Headline[] = [];
  for (const s of CLASSIC) {
    const r: AcrossSources = await backtestAll({ strategy: s.id, symbol: HEADLINE_SYMBOL, venue: "perpl", sizeUsd: 100, leverage: 1 }).catch((e) => ({ results: {}, errors: { binance: (e as Error).message }, agree: null, spreadPct: null, note: null }));
    const bySource: Headline["bySource"] = {};
    for (const [k, v] of Object.entries(r.results)) if (v) bySource[k as Source] = { returnPct: v.returnPct, pnlUsd: v.pnlUsd, trades: v.tradeCount, maxDrawdownPct: v.maxDrawdownPct, winRate: v.winRate };
    rows.push({ id: s.id, symbol: HEADLINE_SYMBOL, tf: s.tf, days: s.days, bySource, buyHoldPct: Object.values(r.results)[0]?.buyHoldPct ?? null, agree: r.agree, errors: r.errors });
  }
  headlines = { at: Date.now(), rows };
}
function refreshHeadlines(): Promise<void> {
  building ??= buildHeadlines().catch(() => {}).finally(() => { building = null; });
  return building;
}
let warm: ReturnType<typeof setInterval> | null = null;
/** On boot and every 6 h: the gallery never waits for a replay. */
export function startClassicWarm(): void {
  if (warm || process.env.NODE_ENV === "test") return;
  void refreshHeadlines();
  warm = setInterval(() => void refreshHeadlines(), 6 * 3_600_000);
  (warm as any).unref?.();
}

export const classic = new Hono();
classic.get("/strategies", (c) => c.json({ strategies: catalog(), sources: SOURCES.map((s) => ({ id: s, name: SOURCE_NAMES[s] })) }, 200, { "Cache-Control": "public, max-age=300" }));
classic.get("/symbols", async (c) => {
  let markets: perpl.PerplMarket[] = [], perplError: string | null = null;
  try { markets = await perpl.markets(); } catch (e) { perplError = (e as Error).message; }
  return c.json({
    perpl: { app: perpl.PERPL_APP, exchange: perpl.PERPL_EXCHANGE, collateral: { symbol: "AUSD", address: perpl.PERPL_COLLATERAL }, error: perplError,
      markets: markets.map((m) => ({ id: m.id, symbol: m.symbol, maxLeverage: m.maxLeverage, takerFeeBps: m.takerFeeBps, makerFeeBps: m.makerFeeBps })) },
    monadSpot: { feeBps: VENUE_FEE_BPS.monad_spot, tokens: Object.entries(SPOT_TOKENS).map(([symbol, t]) => ({ symbol, token: t.symbol, address: t.address })) },
    sources: SOURCES.map((s) => ({ id: s, name: SOURCE_NAMES[s] })),
  }, 200, { "Cache-Control": "public, max-age=60" });
});
classic.post("/backtest", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Omit<BacktestInput, "source"> & { source?: Source | "all" };
  const input = { strategy: body.strategy, params: body.params, symbol: body.symbol, tf: body.tf, days: body.days, venue: body.venue, sizeUsd: body.sizeUsd, leverage: body.leverage };
  try {
    if (body.source === "all" || body.source == null) return c.json(await longJob(jobKey({ ...input, source: "all" }), () => backtestAll(input)));
    return c.json(await longJob(jobKey({ ...input, source: body.source }), () => backtest({ ...input, source: body.source as Source })));
  } catch (e) { return fail(c, e); }
});
classic.get("/templates", async (c) => {
  if (!headlines) { const wait = refreshHeadlines(); await Promise.race([wait, new Promise((r) => setTimeout(r, 20_000))]); }
  const by = new Map((headlines?.rows ?? []).map((h) => [h.id, h]));
  return c.json({ templates: catalog().map((s) => ({ ...s, headline: by.get(s.id) ?? null })), updatedAt: headlines?.at ?? null, building: !headlines });
});
export const _classicTest = { reset() { headlines = null; building = null; if (warm) clearInterval(warm); warm = null; } };
