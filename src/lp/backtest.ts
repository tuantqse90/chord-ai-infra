// Replay a liquidity position on a Monad pool over its recent hours, every range preset side by side (src/lp/sim.ts does
// the math). Inputs are checked here; the assumptions come back in `notes`.
import { isConcentrated, pairOf, pool as readPool, poolHours, supportReason, type LpPool } from "./data";
import { PRESETS, simulate, type Preset, type SimResult } from "./sim";

/** Chord's pool page answers up to 720 hours (`hours`), so a replay covers up to a month. */
export const LP_DAYS = [1, 3, 7, 30] as const;
export const LP_WINDOWS = [7, 30] as const;
export const LP_MIN_USD = 100, LP_MAX_USD = 10_000;
export class LpInputError extends Error {}
const ADDR = /^0x[0-9a-f]{40}$/;

export function normalizeLp(i: { pool?: unknown; amountUsd?: unknown; preset?: unknown; days?: unknown; rebalance?: unknown }) {
  const pool = String(i.pool ?? "").trim().toLowerCase();
  if (!ADDR.test(pool)) throw new LpInputError("pool: a Monad pool address (0x + 40 hex)");
  const amountUsd = Number(i.amountUsd ?? 1000);
  if (!(amountUsd >= LP_MIN_USD && amountUsd <= LP_MAX_USD)) throw new LpInputError(`amountUsd: ${LP_MIN_USD} to ${LP_MAX_USD.toLocaleString("en-US")}`);
  const preset = (i.preset ?? "balanced") as Preset;
  if (!(preset in PRESETS)) throw new LpInputError(`preset: ${Object.keys(PRESETS).join(", ")}`);
  const days = Number(i.days ?? 7);
  if (!(LP_DAYS as readonly number[]).includes(days)) throw new LpInputError(`days: ${LP_DAYS.join(", ")}`);
  return { pool, amountUsd, preset, days, rebalance: i.rebalance === undefined ? true : !!i.rebalance };
}

export interface LpBacktest {
  pool: string; pair: string; dex: string; feeBps: number; tvlUsd: number; concentrated: boolean; days: number; amountUsd: number; rebalance: boolean;
  from: number; to: number; hours: number; byPreset: Partial<Record<Preset, Omit<SimResult, "equity"> & { equity: SimResult["equity"] }>>; notes: string[];
}
export async function lpBacktest(input: Parameters<typeof normalizeLp>[0], now = Date.now()): Promise<LpBacktest> {
  const n = normalizeLp(input);
  let p: LpPool;
  try { p = await readPool(n.pool); } catch (e) { throw new LpInputError(`Chord has no LP data for ${n.pool}: ${String((e as Error).message).slice(0, 120)}`); }
  const why = supportReason(p);
  if (why) throw new LpInputError(why);
  const fromS = Math.floor(now / 1000) - n.days * 86_400;
  const hours = await poolHours(p, fromS);
  if (hours.length < 12) throw new LpInputError(`Chord has ${hours.length} priced hours for ${pairOf(p)} in the last ${n.days} days: not enough to replay`);
  const concentrated = isConcentrated(p);
  const presets = (concentrated ? Object.keys(PRESETS) : ["full"]) as Preset[];
  const byPreset: LpBacktest["byPreset"] = {};
  for (const preset of presets) byPreset[preset] = simulate({ hours, amountUsd: n.amountUsd, preset, feeBps: p.feeBps, tvlUsd: p.tvlUsd, concentrated, rebalance: n.rebalance });
  const covered = (hours[hours.length - 1].t - hours[0].t) / 86_400_000;
  const notes = [
    `Hourly volume and price of ${pairOf(p)} from Chord's LP index; ${hours.length} priced hours (${covered.toFixed(1)} days).`,
    `Fees: each hour's volume × the ${p.feeBps / 100}% pool fee × your share of the pool's $${Math.round(p.tvlUsd).toLocaleString("en-US")} TVL (today's TVL, held constant)${concentrated ? ", scaled by how concentrated your range is against a ±15% range" : ""}; only while in range; not reinvested.`,
    n.rebalance && concentrated ? "Rebalance: after 6 hours out of range, close, pay the pool fee on half the value, reopen centred on the price." : "No rebalancing: an out-of-range position waits for the price to come back.",
    "Gas is not counted; paper only.",
  ];
  if (!concentrated) notes.push(`${p.dex} pools are full range (constant product): one preset.`);
  if (covered < n.days - 0.5) notes.push(`The pool has ${covered.toFixed(1)} days of history in Chord's index, less than the ${n.days} asked.`);
  return { pool: p.pool, pair: pairOf(p), dex: p.dex, feeBps: p.feeBps, tvlUsd: p.tvlUsd, concentrated, days: n.days, amountUsd: n.amountUsd, rebalance: n.rebalance, from: hours[0].t, to: hours[hours.length - 1].t, hours: hours.length, byPreset, notes };
}
