// Params in, params out with every default filled, or a BotInputError whose message names the field and the rule.
// Monad (EVM) addresses: 0x + 40 hex, trimmed and lower-cased (the engine compares them in lower case).
import { normalizeInput, type Venue } from "../classic/backtest";
import type { Source, Tf } from "../classic/data";
import { ClassicInputError, strategyById } from "../classic/strategies";
import { isPublicHttpsUrl } from "../chord/utils/safeFetchUrl";
import { isAddress } from "../monad/chain";
import { validateStrategy, type Strategy } from "../strategy/schema";
import { BotInputError } from "./errors";
import type { AlertParams, BotMode, BotType, CopyParams } from "./types";

export const MAX_WALLETS = 10;
export const MAX_MINTS = 10;

const COPY_KEYS = ["wallets", "usdPerTrade", "maxPerTokenUsd", "maxOpenPositions", "mirrorSells", "slippageBps", "minLiquidityUsd", "safety", "dailyLossStopUsd"];
const ALERT_KEYS = ["wallets", "mints", "minUsd", "webhook"];
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

/** A list of Monad addresses: 0x + 40 hex, lower-cased, duplicates dropped. */
function addresses(v: unknown, field: string, max: number, min: number, kind: string): string[] {
  if (v === undefined || v === null) {
    if (min > 0) throw new BotInputError(`${field} is required: ${min === 1 ? "at least one" : min} ${kind}`);
    return [];
  }
  const list = typeof v === "string" ? v.split(/[\s,]+/).filter(Boolean) : v;
  if (!Array.isArray(list)) throw new BotInputError(`${field} must be a list of Monad addresses`);
  const out: string[] = [];
  list.forEach((x, i) => {
    const s = typeof x === "string" ? x.trim().toLowerCase() : "";
    if (!isAddress(s)) throw new BotInputError(`${field}[${i}] ${JSON.stringify(typeof x === "string" ? x.slice(0, 60) : x)} is not a Monad ${kind} address (0x + 40 hex characters)`);
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
  const mints = addresses(o.mints, "mints", MAX_MINTS, 0, "token");
  if (!wallets.length && !mints.length) throw new BotInputError("an alert agent needs wallets to watch, tokens to watch (mints), or both");
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

export interface CustomRules { strategy: Strategy; templateId: string | null }
/** A custom agent: { strategy, templateId? }; the strategy goes through the builder's schema (errors name block and field). */
export function validateCustomParams(raw: unknown): CustomRules {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BotInputError("params must be { strategy, templateId? }");
  const o = raw as Record<string, unknown>;
  const unknownKey = Object.keys(o).find((k) => k !== "strategy" && k !== "templateId" && k !== "explanation");
  if (unknownKey) throw new BotInputError(`params: unknown field "${unknownKey}" (takes strategy, templateId)`);
  const r = validateStrategy(o.strategy);
  if (!r.ok) throw new BotInputError(r.errors.join("; "));
  const t = typeof o.templateId === "string" && /^[a-z0-9-]{1,40}$/.test(o.templateId) ? o.templateId : null;
  return { strategy: r.strategy, templateId: t };
}

export interface ClassicRules { strategy: string; params: Record<string, number>; symbol: string; tf: Tf; venue: Venue; sizeUsd: number; leverage: number; signalSource: Source; templateId: string | null }
const CLASSIC_KEYS = ["strategy", "params", "symbol", "tf", "venue", "sizeUsd", "leverage", "signalSource", "templateId"];
/** A classic agent: { strategy, symbol, params?, tf?, venue?, sizeUsd?, leverage?, signalSource? } checked like a backtest of it. */
export function validateClassicParams(raw: unknown): ClassicRules {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BotInputError("params must be { strategy, symbol, params?, tf?, venue?, sizeUsd?, leverage?, signalSource? }");
  const o = raw as Record<string, unknown>;
  const unknownKey = Object.keys(o).find((k) => !CLASSIC_KEYS.includes(k));
  if (unknownKey) throw new BotInputError(`params: unknown field "${unknownKey}" (takes ${CLASSIC_KEYS.join(", ")})`);
  let n: ReturnType<typeof normalizeInput>;
  try { n = normalizeInput({ strategy: String(o.strategy ?? ""), params: o.params, symbol: String(o.symbol ?? ""), tf: o.tf as Tf | undefined, venue: o.venue as Venue | undefined, sizeUsd: o.sizeUsd as number | undefined, leverage: o.leverage as number | undefined, source: (o.signalSource ?? "binance") as Source }); }
  catch (e) { if (e instanceof ClassicInputError) throw new BotInputError(e.message); throw e; }
  const t = typeof o.templateId === "string" && /^[a-z0-9-]{1,40}$/.test(o.templateId) ? o.templateId : null;
  return { strategy: n.s.id, params: n.params, symbol: n.symbol, tf: n.tf, venue: n.venue, sizeUsd: n.sizeUsd, leverage: n.leverage, signalSource: n.source, templateId: t };
}

export type CleanParams = ReturnType<typeof validateCopyParams> | ReturnType<typeof validateAlertParams> | CustomRules | ClassicRules;

export function validateParams(type: BotType, raw: unknown): CleanParams {
  return type === "copy" ? validateCopyParams(raw) : type === "custom" ? validateCustomParams(raw) : type === "classic" ? validateClassicParams(raw) : validateAlertParams(raw);
}

export function validateType(v: unknown): BotType {
  if (v === "copy" || v === "alert" || v === "custom" || v === "classic") return v;
  throw new BotInputError(`type must be "copy", "alert", "custom" or "classic"`);
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

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The name the person gave (control characters out, 40 characters max), or one made from what the bot follows. */
export function botName(raw: unknown, type: BotType, p: CleanParams): string {
  const given = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) : "";
  if (given) return given;
  if (type === "custom") return (p as CustomRules).strategy.name.slice(0, 40);
  if (type === "classic") { const c = p as ClassicRules; return `${strategyById(c.strategy)?.title ?? c.strategy} ${c.symbol} ${c.tf}`.slice(0, 40); }
  if (type === "copy") {
    const w = (p as ReturnType<typeof validateCopyParams>).wallets;
    return `Copy ${short(w[0])}${w.length > 1 ? ` +${w.length - 1}` : ""}`;
  }
  const a = p as ReturnType<typeof validateAlertParams>;
  const first = a.wallets[0] ?? a.mints[0];
  const more = a.wallets.length + a.mints.length - 1;
  return `Alert ${short(first)}${more > 0 ? ` +${more}` : ""}`;
}
