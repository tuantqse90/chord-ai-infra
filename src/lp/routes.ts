// /v1/agents/lp: LP agents on Monad over HTTP (data from Chord's LP index).
//   GET  /scan                the pools this app can model: TVL, 24 h volume and fees, Chord's fee APR, flags
//   POST /backtest            { pool, amountUsd?, days?: 3 | 7 | 14 | 30, rebalance? } every range preset side by side
//   GET  /state/:botId        an LP agent's range, fees kept aside, hours in range, re-centres (public, no owner)
//   POST /v1/agents { type: "lp", params: { pool, amountUsd?, preset?, rebalance? } } starts one (src/bots)
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { longJob, StillRunning } from "../longJob";
import { lpBacktest, LpInputError } from "./backtest";
import { anchorOf, isConcentrated, pairOf, pools, sideOf, supportReason } from "./data";
import { PRESETS } from "./sim";
import { lpStateOf } from "./agent";
import { getBot } from "../bots";

const jobKey = (input: unknown) => `lpbt:${createHash("sha1").update(JSON.stringify(input ?? null)).digest("hex")}`;
export async function scan(limit = 40) {
  const list = await pools();
  const rows = list.map((p) => ({
    pool: p.pool, pair: pairOf(p), dex: p.dex, kind: p.kind, concentrated: isConcentrated(p), feeBps: p.feeBps,
    side: { symbol: sideOf(p).symbol, address: sideOf(p).address, logo: sideOf(p).logo ?? null }, anchor: { symbol: anchorOf(p).symbol, address: anchorOf(p).address },
    tvlUsd: Math.round(p.tvlUsd), volume24hUsd: Math.round(p.vol?.h24 ?? 0), volume7dUsd: Math.round(p.vol?.d7 ?? 0), fees24hUsd: Math.round((p.fees?.h24 ?? 0) * 100) / 100,
    feeAprPct: p.aprPct != null ? Math.round(p.aprPct * 10) / 10 : null, trades24h: p.trades24h ?? null, providers24h: p.providers24h ?? null, priceUsd: p.priceUsd ?? null,
    unsupported: supportReason(p),
  }));
  return rows.filter((r) => !r.unsupported).slice(0, limit);
}

export const lp = new Hono();
lp.get("/scan", async (c) => {
  try { return c.json({ chain: 143, presets: PRESETS, pools: await scan(Math.min(40, Number(c.req.query("limit")) || 40)), source: "Chord LP index (GET /v1/lp/pools?chain=143)" }, 200, { "Cache-Control": "public, max-age=60" }); }
  catch (e) { return c.json({ error: "lp_unavailable", message: `Chord's LP index did not answer: ${String((e as Error).message).slice(0, 160)}` }, 503); }
});
lp.post("/backtest", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const input = { pool: b.pool, amountUsd: b.amountUsd, days: b.days, rebalance: b.rebalance };
  try { return c.json(await longJob(jobKey(input), () => lpBacktest(input))); }
  catch (e) {
    if (e instanceof LpInputError) return c.json({ error: "bad_request", message: e.message }, 400);
    if (e instanceof StillRunning) return c.json({ error: e.code, message: e.message }, 503);
    return c.json({ error: "lp_unavailable", message: `Chord's LP index did not answer: ${String((e as Error).message).slice(0, 160)}` }, 503);
  }
});
lp.get("/state/:botId", (c) => {
  const id = c.req.param("botId"), b = getBot(null, id);
  const st = b?.bot.type === "lp" ? lpStateOf(id) : null;
  if (!st) return c.json({ error: "not_found" }, 404);
  const pos = b!.positions[0];
  return c.json({ botId: id, pool: st.pool, pair: st.pair, side: st.side, anchor: st.anchor, dex: st.dex, feeBps: st.feeBps, tvlUsd: st.tvlUsd, concentrated: st.concentrated,
    range: { low: st.range.pa, high: st.range.pb, centre: st.range.p0 }, costUsd: st.costUsd, feesUsd: Math.round(st.feesUsd * 100) / 100, valueUsd: pos?.priceUsd ?? null,
    hoursSeen: st.seen, hoursInRange: st.inside, inRangePct: st.seen ? Math.round((st.inside / st.seen) * 1000) / 10 : null, outHours: st.outHours, rebalances: st.rebalances, lastHour: st.lastHour, openedAt: st.openedAt });
});
