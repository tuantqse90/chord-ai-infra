// LP agents (bot type "lp"), PAPER mode, on Monad pools from Chord's LP index. Started, the agent adds `amountUsd` to the
// pool in a range centred on the price (a fill), then each new hour of the pool's data: accrues the hour's fee share while
// in range (src/lp/sim.ts, the same math as the backtest), marks the position (value + fees kept aside), and after 6 hours
// out of range re-centres it when rebalancing is on (a closing fill with its PnL, then an opening one). The range, liquidity,
// fees and last hour live in lp_agent_state, so a restart picks up where it was. Every filled fill is committed on-chain.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { emit } from "../bots/bus";
import { botRow, insertFill, setBotName, setBotStatus, setPosition } from "../bots/store";
import { logEvent, publishStats } from "../bots/executor";
import type { Fill } from "../bots/types";
import { anchorOf, isConcentrated, pairOf, sideOf, supportReason, type LpPool } from "./data";
import { feeShare, inRange, openRange, PRESETS, REBALANCE_AFTER_H, valueAt, type Hour, type Preset, type Range } from "./sim";

export interface LpRules { pool: string; amountUsd: number; preset: Preset; rebalance: boolean }
export interface LpDeps { now: () => number; pool: (address: string) => Promise<LpPool>; poolHours: (p: LpPool, fromS: number) => Promise<Hour[]> }
interface State {
  pool: string; pair: string; side: string; anchor: string; dex: string; feeBps: number; tvlUsd: number; concentrated: boolean; width: number | null;
  range: Range; costUsd: number; feesUsd: number; lastHour: number; outHours: number; rebalances: number; openedAt: number; inside: number; seen: number;
}

let db: Database | null = null;
function store(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS lp_agent_state (bot_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL)");
  return db;
}
export function _closeLpStore(): void { db?.close(); db = null; }
const load = (id: string): State | null => { const r = store().query("SELECT state FROM lp_agent_state WHERE bot_id = ?").get(id) as { state: string } | null; return r ? JSON.parse(r.state) : null; };
const save = (id: string, s: State, now: number) => store().run("INSERT INTO lp_agent_state (bot_id, state, updated) VALUES (?, ?, ?) ON CONFLICT (bot_id) DO UPDATE SET state = excluded.state, updated = excluded.updated", [id, JSON.stringify(s), now]);
export const lpStateOf = (id: string) => load(id);
export function dropLpState(id: string): void { store().run("DELETE FROM lp_agent_state WHERE bot_id = ?", [id]); }

export const lpMint = (pool: string) => `lp:${pool.toLowerCase()}`;
const newId = () => randomBytes(6).toString("hex");
const r2 = (v: number) => Math.round(v * 100) / 100;
const px = (v: number | null) => (v == null ? "∞" : v >= 1 ? v.toPrecision(5) : v.toPrecision(4));
const TICK_MS = 300_000;
let seq = 0;

export function createLpRunner(deps: LpDeps) {
  const agents = new Map<string, { id: string; rules: LpRules; busy: boolean }>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function record(f: Fill): boolean {
    if (!insertFill(f)) return false;
    emit(f.botId, { type: "fill", fill: f });
    return true;
  }
  function fill(id: string, s: State, side: "buy" | "sell", usd: number, pnl: number | null, detail: string, ts: number): boolean {
    const mint = lpMint(s.pool);
    return record({
      id: newId(), botId: id, ts, side, mint, symbol: `${s.pair} LP`, usd: r2(usd), tokenAmount: 1, priceUsd: r2(usd), status: "filled", reason: null, pnlUsd: pnl == null ? null : r2(pnl),
      quote: { provider: "Chord LP index", route: [s.dex, `${s.feeBps / 100}%`], priceImpactPct: null },
      source: { wallet: "", tx: `lp:${id}:${ts}:${++seq}`, side, mint, symbol: `${s.pair} LP`, usd: null, priceUsd: null, ts, via: "strategy", detail },
      mode: "paper",
    });
  }
  const rangeWords = (s: State) => (s.range.pa == null ? "full range" : `${px(s.range.pa)} to ${px(s.range.pb)} ${s.anchor} per ${s.side}`);

  async function open(id: string, rules: LpRules): Promise<void> {
    const p = await deps.pool(rules.pool);
    const why = supportReason(p);
    if (why) { setBotStatus(id, "error", why, deps.now()); logEvent(id, "error", `Cannot provide liquidity here: ${why}.`, deps.now()); publishStats(id); agents.delete(id); return; }
    const hours = await deps.poolHours(p, Math.floor(deps.now() / 1000) - 2 * 86_400);
    const last = hours[hours.length - 1];
    if (!last) { logEvent(id, "warn", `No priced hour for ${pairOf(p)} in Chord's LP index yet; trying again in 5 minutes.`, deps.now()); return; }
    const concentrated = isConcentrated(p), width = concentrated ? PRESETS[rules.preset].width : null;
    const sideUsd = p.priceUsd && p.priceUsd > 0 ? p.priceUsd : last.sideUsd, P = sideUsd / last.anchorUsd;
    const s: State = {
      pool: p.pool.toLowerCase(), pair: pairOf(p), side: sideOf(p).symbol, anchor: anchorOf(p).symbol, dex: p.dex, feeBps: p.feeBps, tvlUsd: p.tvlUsd, concentrated, width,
      range: openRange(P, rules.amountUsd / last.anchorUsd, width), costUsd: rules.amountUsd, feesUsd: 0, lastHour: last.t, outHours: 0, rebalances: 0, openedAt: deps.now(), inside: 0, seen: 0,
    };
    const now = deps.now();
    const label = concentrated ? PRESETS[rules.preset].label : "Full range (constant-product pool)";
    if (!fill(id, s, "buy", rules.amountUsd, null, `Added $${rules.amountUsd.toLocaleString("en-US")} to ${s.pair} on ${s.dex} (${s.feeBps / 100}% fee), ${label}: ${rangeWords(s)}`, now)) return;
    setPosition(id, { mint: lpMint(s.pool), symbol: `${s.pair} LP`, qty: 1, costUsd: rules.amountUsd, priceUsd: rules.amountUsd, openedAt: now, ts: now });
    save(id, s, now);
    const b = botRow(id);
    if (b && /^LP 0x/.test(b.name)) setBotName(id, `LP ${s.pair} ${rules.preset}`.slice(0, 40));
    logEvent(id, "info", `In the pool: ${label} around ${px(P)} ${s.anchor} per ${s.side}. Fees accrue from the next hour of the pool's volume while the price stays in range.`, now);
    publishStats(id);
  }

  async function evaluate(id: string): Promise<void> {
    const a = agents.get(id); if (!a) return;
    const s = load(id);
    if (!s) return open(id, a.rules);
    const p = await deps.pool(s.pool);
    const hours = (await deps.poolHours(p, Math.floor(s.lastHour / 1000))).filter((h) => h.t > s.lastHour);
    const now = deps.now(), fee = s.feeBps / 1e4;
    s.tvlUsd = p.tvlUsd > 0 ? p.tvlUsd : s.tvlUsd;
    let lpUsd = 0;
    for (const h of hours) {
      const P = h.sideUsd / h.anchorUsd;
      lpUsd = valueAt(s.range, P) * h.anchorUsd;
      s.seen++;
      if (inRange(s.range, P)) { s.inside++; s.outHours = 0; s.feesUsd += h.volUsd * fee * feeShare(lpUsd, s.tvlUsd, s.width, s.concentrated); }
      else if (a.rules.rebalance && s.width != null && ++s.outHours >= REBALANCE_AFTER_H) {
        const total = lpUsd + s.feesUsd, cost = (lpUsd / 2) * fee;
        fill(id, s, "sell", total, total - s.costUsd, `Out of range for ${REBALANCE_AFTER_H} hours (${rangeWords(s)}): closed with ${r2(s.feesUsd)} USD of fees`, h.t);
        lpUsd -= cost;
        s.range = openRange(P, lpUsd / h.anchorUsd, s.width); s.costUsd = lpUsd; s.feesUsd = 0; s.outHours = 0; s.rebalances++;
        fill(id, s, "buy", lpUsd, null, `Re-centred on ${px(P)} ${s.anchor} per ${s.side}: ${rangeWords(s)} (paid ${r2(cost)} USD to swap back to an even split)`, h.t);
      }
      s.lastHour = h.t;
    }
    if (hours.length) {
      setPosition(id, { mint: lpMint(s.pool), symbol: `${s.pair} LP`, qty: 1, costUsd: s.costUsd, priceUsd: r2(lpUsd + s.feesUsd), openedAt: s.openedAt, ts: now });
      save(id, s, now);
      publishStats(id);
    }
  }

  async function tick(): Promise<void> {
    for (const a of agents.values()) {
      if (a.busy) continue;
      a.busy = true;
      try { await evaluate(a.id); }
      catch (e) { if (botRow(a.id)) logEvent(a.id, "warn", `Could not read the pool from Chord's LP index: ${String((e as Error)?.message ?? e).slice(0, 160)}`, deps.now()); }
      finally { a.busy = false; }
    }
  }

  return {
    add(id: string, rules: LpRules): void {
      agents.set(id, { id, rules, busy: false });
      const a = agents.get(id)!;
      void (async () => { if (a.busy) return; a.busy = true; try { await evaluate(id); } catch (e) { if (botRow(id)) logEvent(id, "warn", `Could not read the pool from Chord's LP index: ${String((e as Error)?.message ?? e).slice(0, 160)}`, deps.now()); } finally { a.busy = false; } })();
    },
    remove(id: string): void { agents.delete(id); },
    start(): void { if (timer) return; timer = setInterval(() => { void tick(); }, TICK_MS); (timer as any).unref?.(); },
    stop(): void { if (timer) clearInterval(timer); timer = null; agents.clear(); },
    status: () => ({ agents: agents.size }),
    tick, evaluate,
  };
}
export type LpRunner = ReturnType<typeof createLpRunner>;
