// Params in, params out with every default filled, or a BotInputError whose message names the field and the rule.
// Solana addresses keep their case (base58 is case-sensitive): they are trimmed, never lower-cased.
import { isPublicHttpsUrl } from "../chord/utils/safeFetchUrl";
import { isPubkey } from "../solana/tokens";
import { BotInputError } from "./errors";
import type { AlertParams, BotMode, BotType, CopyParams, LpPreset } from "./types";

export const MAX_WALLETS = 10;
export const MAX_MINTS = 10;

const COPY_KEYS = ["wallets", "usdPerTrade", "maxPerTokenUsd", "maxOpenPositions", "mirrorSells", "slippageBps", "minLiquidityUsd", "safety", "dailyLossStopUsd"];
const ALERT_KEYS = ["wallets", "mints", "minUsd", "webhook"];
const LP_KEYS = ["pool", "amountUsd", "preset", "rangePct", "rebalance", "exits", "safety"];
const LP_REBALANCE_KEYS = ["outOfRangeMinutes", "maxPerDay"];
const LP_EXIT_KEYS = ["lpExodus", "tokenDropPct", "dailyLossStopUsd"];
export const LP_PRESETS: readonly LpPreset[] = ["tight", "balanced", "wide"];

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BotInputError(`${what} must be an object`);
  return raw as Record<string, unknown>;
}

function noUnknown(o: Record<string, unknown>, allowed: string[], what: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new BotInputError(`unknown ${what} field${extra.length > 1 ? "s" : ""} ${extra.map((k) => `"${k}"`).join(", ")} (${what} take ${allowed.join(", ")})`);
}

/** A finite number from a number or a numeric string (tool calls send both); undefined/null/"" = absent. */
function numberOf(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new BotInputError(`${field} must be a number`);
  return n;
}

function inRange(v: unknown, field: string, min: number, max: number, def: number, integer = false): number {
  const n = numberOf(v, field);
  if (n === undefined) return def;
  if (integer && !Number.isInteger(n)) throw new BotInputError(`${field} must be a whole number`);
  if (n < min || n > max) throw new BotInputError(`${field} must be between ${min} and ${max} (got ${n})`);
  return n;
}

function boolOf(v: unknown, field: string, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "false") return v === "true";
  throw new BotInputError(`${field} must be true or false`);
}

/** A list of Solana addresses: base58, 32–44 characters, case kept, duplicates dropped. */
function addresses(v: unknown, field: string, max: number, min: number, kind: string): string[] {
  if (v === undefined || v === null) {
    if (min > 0) throw new BotInputError(`${field} is required: ${min === 1 ? "at least one" : min} ${kind}`);
    return [];
  }
  const list = typeof v === "string" ? v.split(/[\s,]+/).filter(Boolean) : v;
  if (!Array.isArray(list)) throw new BotInputError(`${field} must be a list of Solana addresses`);
  const out: string[] = [];
  list.forEach((x, i) => {
    const s = typeof x === "string" ? x.trim() : "";
    if (!isPubkey(s)) throw new BotInputError(`${field}[${i}] ${JSON.stringify(typeof x === "string" ? x.slice(0, 60) : x)} is not a Solana ${kind} (base58, 32–44 characters, case-sensitive)`);
    if (!out.includes(s)) out.push(s);
  });
  if (out.length < min) throw new BotInputError(`${field} needs at least ${min} ${kind}`);
  if (out.length > max) throw new BotInputError(`${field} takes at most ${max} ${kind}s (got ${out.length})`);
  return out;
}

export function validateCopyParams(raw: unknown): Required<Omit<CopyParams, "dailyLossStopUsd">> & { dailyLossStopUsd: number | null } {
  const o = asObject(raw, "copy params");
  noUnknown(o, COPY_KEYS, "copy params");
  const wallets = addresses(o.wallets, "wallets", MAX_WALLETS, 1, "wallet");
  const usdPerTrade = inRange(o.usdPerTrade, "usdPerTrade", 1, 1000, NaN);
  if (!Number.isFinite(usdPerTrade)) throw new BotInputError("usdPerTrade is required: USDC per mirrored buy, 1 to 1000");
  const maxPerTokenUsd = inRange(o.maxPerTokenUsd, "maxPerTokenUsd", usdPerTrade, 100_000, 3 * usdPerTrade);
  const maxOpenPositions = inRange(o.maxOpenPositions, "maxOpenPositions", 1, 50, 10, true);
  const mirrorSells = boolOf(o.mirrorSells, "mirrorSells", true);
  const slippageBps = inRange(o.slippageBps, "slippageBps", 1, 5000, 100, true);
  const minLiquidityUsd = inRange(o.minLiquidityUsd, "minLiquidityUsd", 0, 1e9, 20_000);
  const safety = boolOf(o.safety, "safety", true);
  const stop = numberOf(o.dailyLossStopUsd, "dailyLossStopUsd");
  if (stop !== undefined && stop <= 0) throw new BotInputError("dailyLossStopUsd must be more than 0 (or null for no stop)");
  return { wallets, usdPerTrade, maxPerTokenUsd, maxOpenPositions, mirrorSells, slippageBps, minLiquidityUsd, safety, dailyLossStopUsd: stop ?? null };
}

export function validateAlertParams(raw: unknown): Required<Omit<AlertParams, "webhook">> & { webhook: string | null } {
  const o = asObject(raw, "alert params");
  noUnknown(o, ALERT_KEYS, "alert params");
  const wallets = addresses(o.wallets, "wallets", MAX_WALLETS, 0, "wallet");
  const mints = addresses(o.mints, "mints", MAX_MINTS, 0, "mint");
  if (!wallets.length && !mints.length) throw new BotInputError("an alert bot needs wallets to watch, mints to watch, or both");
  const minUsd = inRange(o.minUsd, "minUsd", 0, 1e9, 1000);
  let webhook: string | null = null;
  if (o.webhook !== undefined && o.webhook !== null && o.webhook !== "") {
    if (typeof o.webhook !== "string" || o.webhook.length > 500 || !isPublicHttpsUrl(o.webhook.trim())) {
      throw new BotInputError("webhook must be a public https URL (no http, no private or internal hosts, default port)");
    }
    webhook = o.webhook.trim();
  }
  return { wallets, mints, minUsd, webhook };
}

export interface LpRules {
  pool: string; amountUsd: number; preset: LpPreset | null; rangePct: number | null;
  rebalance: { outOfRangeMinutes: number; maxPerDay: number };
  exits: { lpExodus: boolean; tokenDropPct: number | null; dailyLossStopUsd: number | null };
  safety: boolean;
}

/** LP agent params: a Chord LP pool, $10..$10,000, a preset (default "balanced") OR a custom ±rangePct, rebalance and exit rules. */
export function validateLpParams(raw: unknown): LpRules {
  const o = asObject(raw, "lp params");
  noUnknown(o, LP_KEYS, "lp params");
  const pool = typeof o.pool === "string" ? o.pool.trim() : "";
  if (!pool) throw new BotInputError("pool is required: a Solana pool address from lp_scan");
  if (!isPubkey(pool)) throw new BotInputError(`pool ${JSON.stringify(String(o.pool).slice(0, 60))} is not a Solana address (base58, 32–44 characters, case-sensitive)`);
  const amountUsd = inRange(o.amountUsd, "amountUsd", 10, 10_000, NaN);
  if (!Number.isFinite(amountUsd)) throw new BotInputError("amountUsd is required: the paper deposit in USD, 10 to 10000");
  const pct = numberOf(o.rangePct, "rangePct");
  if (pct !== undefined && (pct < 1 || pct > 90)) throw new BotInputError(`rangePct must be between 1 and 90 (got ${pct}): the range is price × (1 ± rangePct/100)`);
  let preset: LpPreset | null = null;
  if (o.preset !== undefined && o.preset !== null && o.preset !== "") {
    if (!LP_PRESETS.includes(o.preset as LpPreset)) throw new BotInputError(`preset must be "tight", "balanced" or "wide"`);
    if (pct !== undefined) throw new BotInputError("give preset or rangePct, not both");
    preset = o.preset as LpPreset;
  } else if (pct === undefined) preset = "balanced";
  const rb = o.rebalance === undefined || o.rebalance === null ? {} : asObject(o.rebalance, "rebalance");
  noUnknown(rb, LP_REBALANCE_KEYS, "rebalance");
  const ex = o.exits === undefined || o.exits === null ? {} : asObject(o.exits, "exits");
  noUnknown(ex, LP_EXIT_KEYS, "exits");
  const drop = numberOf(ex.tokenDropPct, "exits.tokenDropPct");
  if (drop !== undefined && (drop < 5 || drop > 95)) throw new BotInputError(`exits.tokenDropPct must be between 5 and 95 (got ${drop})`);
  const stop = numberOf(ex.dailyLossStopUsd, "exits.dailyLossStopUsd");
  if (stop !== undefined && stop <= 0) throw new BotInputError("exits.dailyLossStopUsd must be more than 0 (or null for no stop)");
  return {
    pool, amountUsd, preset, rangePct: pct ?? null,
    rebalance: { outOfRangeMinutes: inRange(rb.outOfRangeMinutes, "rebalance.outOfRangeMinutes", 5, 1440, 30, true), maxPerDay: inRange(rb.maxPerDay, "rebalance.maxPerDay", 0, 24, 4, true) },
    exits: { lpExodus: boolOf(ex.lpExodus, "exits.lpExodus", true), tokenDropPct: drop ?? null, dailyLossStopUsd: stop ?? null },
    safety: boolOf(o.safety, "safety", true),
  };
}

export type CleanParams = ReturnType<typeof validateCopyParams> | ReturnType<typeof validateAlertParams> | LpRules;

export function validateParams(type: BotType, raw: unknown): CleanParams {
  return type === "copy" ? validateCopyParams(raw) : type === "lp" ? validateLpParams(raw) : validateAlertParams(raw);
}

export function validateType(v: unknown): BotType {
  if (v === "copy" || v === "alert" || v === "lp") return v;
  throw new BotInputError(`type must be "copy" or "alert" or "lp"`);
}

export function validateMode(v: unknown): BotMode {
  if (v === undefined || v === null || v === "" || v === "paper") return "paper";
  if (v === "live") return "live";
  throw new BotInputError(`mode must be "paper" or "live"`);
}

export function validateDays(v: unknown): 1 | 3 | 7 {
  const n = Number(v);
  if (n === 1 || n === 3 || n === 7) return n;
  throw new BotInputError("days must be 1, 3 or 7");
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** The name the person gave (control characters out, 40 characters max), or one made from what the bot follows. */
export function botName(raw: unknown, type: BotType, p: CleanParams): string {
  const given = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) : "";
  if (given) return given;
  if (type === "lp") {
    const l = p as LpRules;
    return `LP ${short(l.pool)} ${l.preset ?? `±${l.rangePct}%`}`;
  }
  if (type === "copy") {
    const w = (p as ReturnType<typeof validateCopyParams>).wallets;
    return `Copy ${short(w[0])}${w.length > 1 ? ` +${w.length - 1}` : ""}`;
  }
  const a = p as ReturnType<typeof validateAlertParams>;
  const first = a.wallets[0] ?? a.mints[0];
  const more = a.wallets.length + a.mints.length - 1;
  return `Alert ${short(first)}${more > 0 ? ` +${more}` : ""}`;
}
