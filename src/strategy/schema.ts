// Strategy v1: the one format the custom bot builder speaks (ask2049-notes/PROMPT-bot-builder.md). A strategy is plain JSON,
// validated here and never code. This Zod schema is the source of truth: the compiler's prompt, the page's blocks, the runner
// and the backtest all read the type it produces, with every default filled. Every validation message names the block and
// the field ("Filters › liquidityUsd: value must be a number"). Solana addresses are trimmed, never lower-cased (base58 is
// case-sensitive).
import { z } from "zod";
import { isPublicHttpsUrl } from "../chord/utils/safeFetchUrl";
import { isPubkey } from "../solana/tokens";

export const MAX_LIST_WALLETS = 10;
export const MAX_FILTERS = 12;
export const MAX_LP_TARGETS = 10;
/** price.mint keywords: Chord's trending Solana tokens, or the tokens the bot holds. */
export const PRICE_MINT_KEYWORDS = ["trending", "held"] as const;

export const TRIGGER_TYPES = ["wallet_trade", "confluence", "new_token", "price", "schedule", "lp_event"] as const;
export const FILTER_FIELDS = [
  "liquidityUsd", "marketCapUsd", "fdvUsd", "volume24hUsd", "ageMin", "holders", "top10Pct",
  "priceChange5mPct", "priceChange1hPct", "priceChange24hPct", "organicScore", "buyShare1hPct", "smartBuyers1h",
] as const;
export const FILTER_OPS = [">", ">=", "<", "<=", "between"] as const;
export const SAFETY_CHECKS = ["no_mint_authority", "no_freeze_authority", "verified", "not_flagged"] as const;
export const ACTION_TYPES = ["buy", "sell", "alert", "webhook"] as const;
export const SCHEDULE_EVERY = ["15m", "1h", "4h", "1d", "1w"] as const;
export const EVERY_MS: Record<(typeof SCHEDULE_EVERY)[number], number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000 };
export const LP_EVENTS = ["exodus", "large_remove", "large_add"] as const;
/** lp_event minUsd when none is given: exodus = the hour's withdrawals, large_* = one event. */
export const LP_MIN_USD_DEFAULT: Record<(typeof LP_EVENTS)[number], number> = { exodus: 1_000, large_remove: 10_000, large_add: 10_000 };
export const LIMIT_DEFAULTS = { maxOpenPositions: 5, dailyBudgetUsd: 100, cooldownMin: 10, maxTradesPerDay: 20 } as const;

// ── building blocks ──────────────────────────────────────────────────────────────────────────────────────────────────
/** A finite number; a numeric string ("30000", "1.5") is accepted (models and forms send both). */
const numeric = (v: unknown) => (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v);
const num = (min: number, max: number) => z.preprocess(numeric, z.number().finite().min(min).max(max));
const int = (min: number, max: number) => z.preprocess(numeric, z.number().int().min(min).max(max));

const ADDRESS_MSG = "must be a Solana address (base58, 32–44 characters, case-sensitive)";
export const AddressSchema = z.string().trim().refine((s) => isPubkey(s), ADDRESS_MSG);

const addressList = (max: number, min: number) =>
  z.array(AddressSchema).min(min).max(max).transform((xs) => [...new Set(xs)]);

const Days = z.preprocess(numeric, z.number()).refine((n): n is 1 | 3 | 7 => n === 1 || n === 3 || n === 7, "must be 1, 3 or 7");
const ListWallets = z.object({ list: addressList(MAX_LIST_WALLETS, 1) }).strict();
const SmartWallets = z.object({ smartTraders: z.object({ top: int(1, 50), days: Days }).strict() }).strict();
const WALLETS_SHAPES = `must be { "list": [Solana addresses] } or { "smartTraders": { "top": 1–50, "days": 1 | 3 | 7 } }`;
/** `{ list }` or `{ smartTraders }`, picked by shape so the errors speak about the right one. */
export const WalletsSchema = z.unknown().transform((v, ctx): z.infer<typeof ListWallets> | z.infer<typeof SmartWallets> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    ctx.addIssue({ code: "custom", message: v === undefined ? "is required" : WALLETS_SHAPES });
    return z.NEVER;
  }
  const r = ("smartTraders" in v ? SmartWallets : ListWallets).safeParse(v, { errorMap });
  if (!r.success) {
    for (const i of r.error.issues) ctx.addIssue({ code: "custom", path: i.path, message: i.message });
    return z.NEVER;
  }
  return r.data;
});

const WalletTrade = z.object({
  type: z.literal("wallet_trade"),
  wallets: WalletsSchema,
  side: z.enum(["buy", "sell", "any"]).default("buy"),
  minUsd: num(0, 1e9).default(0),
}).strict();
const Confluence = z.object({
  type: z.literal("confluence"),
  wallets: WalletsSchema,
  minWallets: int(2, 10),
  windowMin: num(1, 240),
  side: z.enum(["buy", "sell"]).default("buy"),
}).strict();
const NewToken = z.object({
  type: z.literal("new_token"),
  source: z.enum(["launch", "graduation", "any"]).default("any"),
}).strict();
const PriceMint = z.string().trim().refine((s) => (PRICE_MINT_KEYWORDS as readonly string[]).includes(s) || isPubkey(s), `must be a Solana mint address, "trending" or "held"`);
const Price = z.object({
  type: z.literal("price"),
  mint: PriceMint,
  op: z.enum(["above", "below", "change_pct"]),
  value: num(-99, 1e12),
  windowMin: num(1, 1440).optional(),
}).strict();
const Schedule = z.object({
  type: z.literal("schedule"),
  every: z.enum(SCHEDULE_EVERY),
  mint: AddressSchema,
}).strict();
const LpEvent = z.object({
  type: z.literal("lp_event"),
  pools: addressList(MAX_LP_TARGETS, 0).optional(),
  mints: addressList(MAX_LP_TARGETS, 0).optional(),
  event: z.enum(LP_EVENTS),
  minUsd: num(0, 1e12).optional(),
}).strict();

export const TriggerSchema = z.discriminatedUnion("type", [WalletTrade, Confluence, NewToken, Price, Schedule, LpEvent]);

/** A number, or a [low, high] pair for "between". */
const FilterValue = z.unknown().transform((raw, ctx): number | [number, number] => {
  const v = Array.isArray(raw) ? raw.map(numeric) : numeric(raw);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x))) return [v[0] as number, v[1] as number];
  ctx.addIssue({ code: "custom", message: v === undefined ? "is required" : Array.isArray(v) ? "must be a pair of numbers [low, high]" : "must be a number" });
  return z.NEVER;
});
const FieldFilter = z.object({
  field: z.enum(FILTER_FIELDS),
  op: z.enum(FILTER_OPS),
  value: FilterValue,
}).strict().superRefine((f, ctx) => {
  if (f.op === "between") {
    if (!Array.isArray(f.value)) ctx.addIssue({ code: "custom", path: ["value"], message: `must be a pair [low, high] for "between"` });
    else if (f.value[0] > f.value[1]) ctx.addIssue({ code: "custom", path: ["value"], message: "low must not be above high" });
  } else if (Array.isArray(f.value)) {
    ctx.addIssue({ code: "custom", path: ["value"], message: `must be a number for "${f.op}" (a pair only goes with "between")` });
  }
});
const SafetyFilter = z.object({ safety: z.enum(SAFETY_CHECKS) }).strict();

/** One filter: `{ safety }` or `{ field, op, value }`, picked by shape so the errors speak about the right one. */
export const FilterSchema = z.unknown().transform((v, ctx) => {
  const schema = v && typeof v === "object" && !Array.isArray(v) && "safety" in v ? SafetyFilter : FieldFilter;
  const r = schema.safeParse(v, { errorMap });
  if (!r.success) {
    for (const i of r.error.issues) ctx.addIssue({ code: "custom", path: i.path, message: i.message });
    return z.NEVER;
  }
  return r.data as FieldFilterT | SafetyFilterT;
});

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("buy"), usd: num(1, 1000) }).strict(),
  z.object({ type: z.literal("sell"), pct: num(1, 100) }).strict(),
  z.object({ type: z.literal("alert") }).strict(),
  z.object({ type: z.literal("webhook"), url: z.string().trim().max(500).refine((u) => isPublicHttpsUrl(u), "must be a public https URL (no http, no private or internal hosts, default port)") }).strict(),
]);

export const ExitsSchema = z.object({
  takeProfitPct: num(1, 100_000).optional(),
  stopLossPct: num(1, 99).optional(),
  trailingPct: num(1, 99).optional(),
  maxHoldMin: num(1, 43_200).optional(),
  sellWhen: z.literal("followed_sells").optional(),
}).strict();

export const LimitsSchema = z.object({
  maxOpenPositions: int(1, 50).default(LIMIT_DEFAULTS.maxOpenPositions),
  /** default 3 × the buy size (0 = not used, for strategies that do not buy) */
  maxPerTokenUsd: num(0, 100_000).optional(),
  dailyBudgetUsd: num(1, 100_000).default(LIMIT_DEFAULTS.dailyBudgetUsd),
  cooldownMin: num(0, 10_080).default(LIMIT_DEFAULTS.cooldownMin),
  maxTradesPerDay: int(1, 500).default(LIMIT_DEFAULTS.maxTradesPerDay),
}).strict();

const TRIGGER_NAMES: Record<(typeof TRIGGER_TYPES)[number], string> = {
  wallet_trade: "Wallet trade bot", confluence: "Confluence bot", new_token: "New token bot", price: "Price bot", schedule: "Scheduled buys", lp_event: "LP watch bot",
};

export const StrategySchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().trim().max(60).optional(),
  description: z.string().trim().max(500).optional(),
  trigger: TriggerSchema,
  filters: z.array(FilterSchema).max(MAX_FILTERS).default([]),
  action: ActionSchema,
  exits: ExitsSchema.optional(),
  limits: LimitsSchema.default({}),
}).strict().superRefine((s, ctx) => {
  // Runs on a partly invalid strategy too (a block that failed is undefined here): every read is guarded.
  const t = s.trigger as Trigger | undefined, a = s.action as Action | undefined, limits = s.limits as Partial<Limits> | undefined;
  // (only values that passed their own range: a field that failed already has its message)
  if (t?.type === "confluence" && t.wallets && Number.isInteger(t.minWallets) && t.minWallets >= 2 && t.minWallets <= 10) {
    const pool = "list" in t.wallets ? t.wallets.list?.length : t.wallets.smartTraders?.top;
    if (typeof pool === "number" && t.minWallets > pool) ctx.addIssue({ code: "custom", path: ["trigger", "minWallets"], message: `${t.minWallets} wallets needed but only ${pool} are followed` });
  }
  if (t?.type === "price" && typeof t.value === "number") {
    if ((t.op === "above" || t.op === "below") && !(t.value > 0)) ctx.addIssue({ code: "custom", path: ["trigger", "value"], message: `must be a USD price above 0 for "${t.op}"` });
    if (t.op === "change_pct" && t.value === 0) ctx.addIssue({ code: "custom", path: ["trigger", "value"], message: "must not be 0 for change_pct (+15 = a 15 % rise, −20 = a 20 % drop)" });
  }
  if (s.exits?.sellWhen === "followed_sells" && t && t.type !== "wallet_trade" && t.type !== "confluence") {
    ctx.addIssue({ code: "custom", path: ["exits", "sellWhen"], message: "followed_sells needs a wallet_trade or confluence trigger (wallets to follow)" });
  }
  if (a?.type === "buy" && typeof a.usd === "number" && a.usd >= 1 && a.usd <= 1000 && limits) {
    const cap = limits.maxPerTokenUsd;
    if (typeof cap === "number" && cap < a.usd) ctx.addIssue({ code: "custom", path: ["limits", "maxPerTokenUsd"], message: `must be at least the buy size ($${a.usd})` });
    if (typeof limits.dailyBudgetUsd === "number" && limits.dailyBudgetUsd < a.usd) ctx.addIssue({ code: "custom", path: ["limits", "dailyBudgetUsd"], message: `must be at least the buy size ($${a.usd}), or the bot can never buy` });
  }
}).transform((s) => {
  const t = s.trigger;
  const trigger = t.type === "price" && t.op === "change_pct" && t.windowMin === undefined ? { ...t, windowMin: 60 }
    : t.type === "lp_event" && t.minUsd === undefined ? { ...t, minUsd: LP_MIN_USD_DEFAULT[t.event] }
      : t;
  const maxPerTokenUsd = s.limits.maxPerTokenUsd ?? (s.action.type === "buy" ? 3 * s.action.usd : 0);
  return {
    ...s,
    name: s.name || TRIGGER_NAMES[t.type],
    trigger,
    limits: { ...s.limits, maxPerTokenUsd },
  };
});

// ── types ────────────────────────────────────────────────────────────────────────────────────────────────────────────
type FieldFilterT = z.infer<typeof FieldFilter>;
type SafetyFilterT = z.infer<typeof SafetyFilter>;
export type Wallets = z.infer<typeof WalletsSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type FieldFilter = FieldFilterT;
export type SafetyFilter = SafetyFilterT;
export type Filter = FieldFilter | SafetyFilter;
export type FilterField = (typeof FILTER_FIELDS)[number];
export type SafetyCheck = (typeof SAFETY_CHECKS)[number];
export type Action = z.infer<typeof ActionSchema>;
export type Exits = z.infer<typeof ExitsSchema>;
export type Limits = { maxOpenPositions: number; maxPerTokenUsd: number; dailyBudgetUsd: number; cooldownMin: number; maxTradesPerDay: number };
/** A validated strategy, every default filled. */
export type Strategy = z.infer<typeof StrategySchema>;
export type TriggerOf<K extends Trigger["type"]> = Extract<Trigger, { type: K }>;

// ── messages ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const list = (xs: readonly unknown[]) => xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");

/** Plain messages for every Zod issue (the block and field are added by formatIssues). */
function errorMap(issue: z.ZodIssueOptionalMessage, ctx: { defaultError: string }): { message: string } {
  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined") return { message: "is required" };
      if (issue.expected === "integer") return { message: "must be a whole number" };
      if (issue.expected === "number" && issue.received === "nan") return { message: "must be a number" };
      return { message: `must be ${issue.expected === "array" ? "a list" : issue.expected === "object" ? "an object" : `a ${issue.expected}`}` };
    case "invalid_literal":
      return { message: `must be ${JSON.stringify(issue.expected)}` };
    case "invalid_enum_value":
      return { message: `must be one of ${list(issue.options)}` };
    case "invalid_union_discriminator":
      return { message: `must be one of ${list(issue.options)}` };
    case "too_small":
      if (issue.type === "array") return { message: `needs at least ${issue.minimum} item${Number(issue.minimum) === 1 ? "" : "s"}` };
      if (issue.type === "string") return { message: Number(issue.minimum) <= 1 ? "must not be empty" : `must be at least ${issue.minimum} characters` };
      return { message: `must be at least ${issue.minimum}` };
    case "too_big":
      if (issue.type === "array") return { message: `takes at most ${issue.maximum} item${Number(issue.maximum) === 1 ? "" : "s"}` };
      if (issue.type === "string") return { message: `must be at most ${issue.maximum} characters` };
      return { message: `must be at most ${issue.maximum}` };
    case "not_finite":
      return { message: "must be a finite number" };
    case "unrecognized_keys":
      return { message: `unknown field${issue.keys.length > 1 ? "s" : ""} ${issue.keys.map((k) => `"${k}"`).join(", ")}` };
    case "invalid_union":
      return { message: "does not match any allowed shape" };
    default:
      return { message: issue.message ?? ctx.defaultError };
  }
}

const BLOCK: Record<string, string> = { trigger: "Trigger", filters: "Filters", action: "Action", exits: "Exits", limits: "Limits" };
/** The fields each block takes, appended to an "unknown field" message so a repair knows what to use instead. */
const BLOCK_KEYS: Record<string, string[]> = {
  strategy: ["version", "name", "description", "trigger", "filters", "action", "exits", "limits"],
  exits: ["takeProfitPct", "stopLossPct", "trailingPct", "maxHoldMin", "sellWhen"],
  limits: ["maxOpenPositions", "maxPerTokenUsd", "dailyBudgetUsd", "cooldownMin", "maxTradesPerDay"],
  wallet_trade: ["type", "wallets", "side", "minUsd"], confluence: ["type", "wallets", "minWallets", "windowMin", "side"], new_token: ["type", "source"],
  price: ["type", "mint", "op", "value", "windowMin"], schedule: ["type", "every", "mint"], lp_event: ["type", "pools", "mints", "event", "minUsd"],
  buy: ["type", "usd"], sell: ["type", "pct"], alert: ["type"], webhook: ["type", "url"],
};
const takes = (key: string | undefined) => (key && BLOCK_KEYS[key] ? ` (takes ${BLOCK_KEYS[key].join(", ")})` : "");

function pathText(path: (string | number)[]): string {
  let out = "";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : out ? `.${p}` : p;
  return out;
}

/** "Block › field: message" for every issue, the filter named by its field (or safety check, or #n). */
export function formatIssues(issues: z.ZodIssue[], input: unknown): string[] {
  const out: string[] = [];
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const i of issues) {
    const [head, ...rest] = i.path;
    let msg = i.message;
    if (msg.startsWith("unknown field") && i.path.length <= 1) {
      const sub = raw[String(head)] as any;
      msg += takes(head === undefined ? "strategy" : head === "trigger" || head === "action" ? (typeof sub?.type === "string" ? sub.type : undefined) : String(head));
    }
    if (typeof head !== "string" || !(head in BLOCK)) {
      out.push(i.path.length ? `Strategy › ${pathText(i.path)}: ${msg}` : `Strategy: ${msg}`);
      continue;
    }
    const block = BLOCK[head];
    if (head === "filters") {
      if (typeof rest[0] !== "number") { out.push(`${block}: ${msg}`); continue; }
      const f = Array.isArray(raw.filters) ? (raw.filters as any[])[rest[0]] : undefined;
      const label = typeof f?.field === "string" && f.field ? f.field : typeof f?.safety === "string" && f.safety ? `safety ${f.safety}` : `filter ${rest[0] + 1}`;
      const field = pathText(rest.slice(1));
      out.push(`${block} › ${label}: ${field ? `${field} ` : ""}${msg}`);
      continue;
    }
    const field = pathText(rest);
    out.push(field ? `${block} › ${field}: ${msg}` : `${block}: ${msg}`);
  }
  return [...new Set(out)];
}

export type ValidateResult = { ok: true; strategy: Strategy } | { ok: false; errors: string[] };

/** A strategy in (from the model, the page or the API), the strategy out with every default filled, or the errors. */
export function validateStrategy(input: unknown): ValidateResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["Strategy: must be a JSON object"] };
  const r = StrategySchema.safeParse(input, { errorMap });
  if (r.success) return { ok: true, strategy: r.data };
  return { ok: false, errors: formatIssues(r.error.issues, input) };
}

/** The validated strategy, or an Error whose message lists every problem. */
export function parseStrategy(input: unknown): Strategy {
  const r = validateStrategy(input);
  if (!r.ok) throw new StrategyInputError(r.errors);
  return r.strategy;
}

export class StrategyInputError extends Error {
  readonly status = 400;
  readonly code = "bad_strategy";
  constructor(readonly errors: string[]) {
    super(errors.join("; "));
    this.name = "StrategyInputError";
  }
}

export const isFieldFilter = (f: Filter): f is FieldFilter => "field" in f;
/** Every wallet address a strategy names (list wallets only; smartTraders resolve at run time). */
export function strategyAddresses(s: Strategy): { wallets: string[]; mints: string[]; pools: string[] } {
  const t = s.trigger;
  const wallets = (t.type === "wallet_trade" || t.type === "confluence") && "list" in t.wallets ? t.wallets.list : [];
  const mints = t.type === "price" && !(PRICE_MINT_KEYWORDS as readonly string[]).includes(t.mint) ? [t.mint]
    : t.type === "schedule" ? [t.mint] : t.type === "lp_event" ? t.mints ?? [] : [];
  const pools = t.type === "lp_event" ? t.pools ?? [] : [];
  return { wallets, mints, pools };
}
