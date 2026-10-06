// Words → strategy (POST /v1/strategies/compile, Ask's bot_build): the app's model reads a description (English or
// Vietnamese) with a system prompt that holds the schema (compact), the six templates as examples and the rules (paper only;
// never invent addresses — named groups map to smartTraders; ask back when a needed value is missing). Its JSON is validated
// by the same Zod schema; one repair round sends the errors back. Addresses the strategy names must appear in the description
// (or be a well-known mint): a model that "remembers" a wallet or a mint is caught here, not trusted.
import { chat as appChat, type ChatFn, type ChatMessage } from "../llm";
import { KNOWN_MINTS } from "../solana/tokens";
import { explainStrategy } from "./explain";
import {
  FILTER_FIELDS, LIMIT_DEFAULTS, SAFETY_CHECKS, SCHEDULE_EVERY, StrategyInputError, strategyAddresses, validateStrategy, type Strategy,
} from "./schema";
import { TEMPLATES } from "./templates";

export interface CompileResult {
  strategy: Strategy | null;
  /** one plain line per block (empty without a strategy) */
  explanation: string[];
  warnings: string[];
  /** what the person must answer before a strategy can be built */
  questions: string[];
}

export const MAX_DESCRIPTION = 2_000;

const SCHEMA = `type Wallets = { list: string[] /* 1–10 Solana wallet addresses, copied exactly from the description */ }
  | { smartTraders: { top: number /* 1–50 */; days: 1 | 3 | 7 } }   // Chord's smart-traders board
type Trigger =
  | { type: "wallet_trade"; wallets: Wallets; side?: "buy" | "sell" | "any" /* default "buy" */; minUsd?: number }
  | { type: "confluence"; wallets: Wallets; minWallets: number /* 2–10 */; windowMin: number /* 1–240 */; side: "buy" | "sell" }
  | { type: "new_token"; source: "launch" | "graduation" | "any" }          // pump.fun / launchpad launches, bonding-curve graduations
  | { type: "price"; mint: string /* a mint address, or "trending" (Chord's trending Solana tokens), or "held" (tokens the bot holds) */;
      op: "above" | "below" | "change_pct"; value: number /* above/below: USD price; change_pct: % (+15 = rise of 15 %, -20 = drop of 20 %) */;
      windowMin?: number /* change_pct window, 1–1440, default 60 */ }
  | { type: "schedule"; every: ${SCHEDULE_EVERY.map((x) => `"${x}"`).join(" | ")}; mint: string }   // DCA and timed buys
  | { type: "lp_event"; pools?: string[]; mints?: string[] /* neither = the tokens you hold */; event: "exodus" | "large_remove" | "large_add";
      minUsd?: number /* exodus: withdrawals > 2 × deposits in an hour, at least minUsd (default 1000); large_*: one event ≥ minUsd (default 10000) */ };
type Filter = { field: ${FILTER_FIELDS.map((x) => `"${x}"`).join(" | ")};
                op: ">" | ">=" | "<" | "<=" | "between"; value: number | [number, number] /* the pair only with "between" */ }
  | { safety: ${SAFETY_CHECKS.map((x) => `"${x}"`).join(" | ")} };
  // USD fields: liquidityUsd, marketCapUsd, fdvUsd, volume24hUsd · ageMin = minutes since the first pool · holders · top10Pct = % held by the
  // top 10 · priceChange*Pct in % · organicScore 0–100 (Jupiter) · buyShare1hPct = % of the last hour's volume that was buys ·
  // smartBuyers1h = smart traders that bought in the last hour
type Action = { type: "buy"; usd: number /* 1–1000 */ } | { type: "sell"; pct: number /* 1–100 */ } | { type: "alert" } | { type: "webhook"; url: string /* public https */ };
type Exits = { takeProfitPct?: number; stopLossPct?: number /* 1–99 */; trailingPct?: number /* 1–99, from the peak */; maxHoldMin?: number;
               sellWhen?: "followed_sells" /* only with wallet_trade / confluence */ };
type Limits = { maxOpenPositions?: number /* default ${LIMIT_DEFAULTS.maxOpenPositions} */; maxPerTokenUsd?: number /* default 3 × buy usd */;
                dailyBudgetUsd?: number /* default ${LIMIT_DEFAULTS.dailyBudgetUsd}, ≥ buy usd */; cooldownMin?: number /* default ${LIMIT_DEFAULTS.cooldownMin}, per token */;
                maxTradesPerDay?: number /* default ${LIMIT_DEFAULTS.maxTradesPerDay} */ };
interface Strategy { version: 1; name: string /* ≤ 60 characters */; description?: string; trigger: Trigger; filters: Filter[]; action: Action; exits?: Exits; limits?: Limits }`;

const RULES = `Rules:
- Paper trading only: fills are priced by real Jupiter quotes and nothing is ever sent. If the person asks for live trading or real money, build the paper strategy and say so in "warnings".
- NEVER invent a wallet, mint or pool address. Use only addresses that appear verbatim in the description (keep their exact case). A named group ("smart money", "top traders", "best wallets", "cá mập", "ví thông minh", "top trader") means wallets.smartTraders (default top 20, days 1; "this week" = days 7, "3 days" = days 3).
- A token named only by symbol (other than SOL, USDC, USDT, JUP, BONK, WIF, JitoSOL, mSOL, RAY, PYTH) has no address you may use: ask for its mint.
- When a value the strategy cannot work without is missing (the wallet to copy, the token to DCA, the trigger itself), answer "strategy": null and ask for it in "questions" (short questions). Limits, exits and buy sizes may take sensible defaults; name any money default you chose (e.g. "buy size $10") in "warnings".
- Percentages are plain numbers (30 = 30 %), money in USD, "k" = thousand, "m"/"tr" = million. Minutes for windows and holds (2 h = 120).
- One trigger only: when the description has two, build the main one and say in "warnings" what was left out.
- "questions" and "warnings" in the language of the description (English or Vietnamese). "name" short, in English.
- Answer with ONE JSON object and nothing else: {"strategy": Strategy | null, "questions": string[], "warnings": string[]}.`;

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** A template as the model sees it: defaults that the schema fills anyway are left out. */
function compact(s: Strategy): Record<string, unknown> {
  const out: Record<string, unknown> = { version: 1, name: s.name, trigger: s.trigger, filters: s.filters, action: s.action };
  if (s.exits && Object.keys(s.exits).length) out.exits = s.exits;
  const l: Record<string, number> = {};
  const def: Record<string, number> = { ...LIMIT_DEFAULTS, maxPerTokenUsd: s.action.type === "buy" ? 3 * s.action.usd : 0 };
  for (const [k, v] of Object.entries(s.limits)) if (def[k] !== v) l[k] = v as number;
  if (Object.keys(l).length) out.limits = l;
  return out;
}

const EXAMPLES = [
  ...TEMPLATES.map((t) => `${t.title} — ${t.oneLine}\n${JSON.stringify({ strategy: compact(t.strategy), questions: [], warnings: [] })}`),
  `"copy ví này giúp mình" (no address given)\n${JSON.stringify({ strategy: null, questions: ["Bạn muốn copy ví nào? Dán địa chỉ ví Solana vào nhé."], warnings: [] })}`,
].join("\n\n");

export const SYSTEM_PROMPT = `You turn a description of a Solana trading bot into Strategy JSON (version 1) for a paper-trading bot builder.

Strategy v1 (TypeScript):
${SCHEMA}

${RULES}

Examples (description → answer):
${EXAMPLES}`;

/** The first JSON object in a model reply (bare, in a \`\`\`json fence, or inside prose). */
export function extractJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const tryParse = (s: string) => { try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; } };
  const whole = tryParse(text.trim());
  if (whole) return whole;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) { const v = tryParse(fence[1].trim()); if (v) return v; }
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { const v = tryParse(text.slice(start, i + 1)); if (v) return v; break; }
    }
  }
  return null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, 6) : []);

/** The model's answer split into its parts: a strategy candidate (or null), its questions and warnings. */
function answerOf(obj: Record<string, unknown> | null): { candidate: unknown; questions: string[]; warnings: string[] } | null {
  if (!obj) return null;
  if ("trigger" in obj && "action" in obj) return { candidate: obj, questions: [], warnings: [] };
  return { candidate: obj.strategy ?? null, questions: strings(obj.questions), warnings: strings(obj.warnings) };
}

const vi = (text: string) => /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text);

/** Addresses the strategy names that the description does not contain (well-known mints excepted). */
function inventedAddresses(s: Strategy, text: string): { wallets: string[]; mints: string[]; pools: string[] } {
  const a = strategyAddresses(s);
  return {
    wallets: a.wallets.filter((w) => !text.includes(w)),
    mints: a.mints.filter((m) => !text.includes(m) && !KNOWN_MINTS[m]),
    pools: a.pools.filter((p) => !text.includes(p)),
  };
}

/** The model sometimes leaves Exits out for the same sentence it filled them for a minute earlier (measured 07/10: the same text
 *  gave TP / SL / trailing / max hold once and nothing the next time, and the exit-less replay lost $72 holding 5 memes). A buy
 *  strategy with no exit at all gets the gallery's default exits, said in a warning, unless the person asked to hold. */
export const DEFAULT_EXITS = { takeProfitPct: 100, stopLossPct: 30, trailingPct: 25, maxHoldMin: 1440 } as const;
const HOLD_RE = /\b(no exits?|without (?:an? )?(?:exit|stop)|never sell|hold (?:forever|it|them|until)|hodl|diamond hands?)\b|không bán|giữ mãi|không cắt lỗ/i;
export function withDefaultExits(s: Strategy, text: string): { strategy: Strategy; added: boolean } {
  const e = s.exits ?? {};
  const none = e.takeProfitPct == null && e.stopLossPct == null && e.trailingPct == null && e.maxHoldMin == null && e.sellWhen == null;
  if (s.action.type !== "buy" || !none || s.trigger.type === "schedule" || HOLD_RE.test(text)) return { strategy: s, added: false };
  const r = validateStrategy({ ...s, exits: { ...DEFAULT_EXITS } });
  return r.ok ? { strategy: r.strategy, added: true } : { strategy: s, added: false };
}

function deterministicWarnings(s: Strategy, text: string): string[] {
  const out: string[] = [];
  const v = vi(text);
  if (/\b(live|real money|mainnet|for real)\b|tiền thật|chạy thật|ví thật/i.test(text)) {
    out.push(v ? "Bot chỉ chạy paper (giá khớp theo quote Jupiter thật, không gửi giao dịch nào)." : "Bots run in paper mode only: fills are priced by real Jupiter quotes and nothing is sent.");
  }
  const e = s.exits ?? {};
  if (s.action.type === "buy" && e.stopLossPct == null && e.trailingPct == null && e.maxHoldMin == null && e.sellWhen == null && s.trigger.type !== "schedule") {
    out.push(v ? "Không có điểm cắt lỗ: vị thế được giữ cho tới khi bạn bán." : "No exit limits a loss: a position is held until you sell it.");
  }
  return out;
}

/** Words in, a validated strategy (or questions) out. Throws StrategyInputError for an empty or overlong description, and
 *  whatever the model call throws (no key, timeout) so the route can answer 503. */
export async function compileStrategy(text: string, opts: { chat?: ChatFn; model?: string } = {}): Promise<CompileResult> {
  const desc = typeof text === "string" ? text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim() : "";
  if (!desc) throw new StrategyInputError(["Describe the bot in a sentence or two"]);
  if (desc.length > MAX_DESCRIPTION) throw new StrategyInputError([`The description is too long (at most ${MAX_DESCRIPTION.toLocaleString("en-US")} characters)`]);
  const chat = opts.chat ?? appChat;
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: desc }];
  const ask = async () => (await chat(messages, [], "none", opts.model ? { model: opts.model } : {})).content ?? "";

  let reply = await ask();
  let ans = answerOf(extractJson(reply));
  let errors: string[] = [];
  let strategy: Strategy | null = null;
  const check = () => {
    if (!ans || ans.candidate == null) return;
    const r = validateStrategy(ans.candidate);
    if (r.ok) { strategy = r.strategy; errors = []; } else errors = r.errors;
  };
  check();
  // one repair round: an unreadable reply, or a strategy the schema refused
  if (!ans || (ans.candidate != null && !strategy)) {
    messages.push({ role: "assistant", content: reply.slice(0, 8_000) });
    messages.push({
      role: "user",
      content: !ans
        ? `That was not a JSON object. Answer with ONE JSON object only: {"strategy": Strategy | null, "questions": string[], "warnings": string[]}.`
        : `The strategy failed validation:\n${errors.map((e) => `- ${e}`).join("\n")}\nFix exactly what the errors name (never invent an address) and answer with the same JSON object format only.`,
    });
    reply = await ask();
    const again = answerOf(extractJson(reply));
    if (again) { ans = again; strategy = null; check(); }
  }

  const questions = [...(ans?.questions ?? [])];
  const warnings = [...(ans?.warnings ?? [])];
  const v = vi(desc);
  if (!ans) {
    return { strategy: null, explanation: [], warnings: [v ? "Mô hình không trả về JSON đọc được." : "The model did not answer with readable JSON."], questions: questions.length ? questions : [v ? "Bạn mô tả lại bot rõ hơn được không: khi nào thì nó hành động, và làm gì?" : "Could you describe the bot again: when should it act, and what should it do?"] };
  }
  if (!strategy) {
    if (errors.length) warnings.push(`${v ? "Chiến lược của mô hình không hợp lệ" : "The model's strategy did not validate"}: ${errors.slice(0, 4).join("; ")}`);
    if (!questions.length) questions.push(v ? "Bot nên hành động khi nào, và làm gì (mua bao nhiêu, cảnh báo, bán)?" : "When should the bot act, and what should it do (buy how much, alert, sell)?");
    return { strategy: null, explanation: [], warnings: dedupe(warnings), questions: dedupe(questions) };
  }
  const s: Strategy = strategy;
  const bad = inventedAddresses(s, desc);
  if (bad.wallets.length || bad.mints.length || bad.pools.length) {
    if (bad.wallets.length) questions.push(v ? "Bot nên theo ví nào? Dán địa chỉ ví Solana (mình không tự đoán địa chỉ)." : "Which wallets should the bot follow? Paste their Solana addresses (addresses are never guessed).");
    if (bad.mints.length) questions.push(v ? "Token nào? Dán địa chỉ mint của nó." : "Which token? Paste its mint address.");
    if (bad.pools.length) questions.push(v ? "Pool nào? Dán địa chỉ pool." : "Which pool? Paste its address.");
    warnings.push(`${v ? "Đã bỏ địa chỉ không có trong mô tả" : "Dropped addresses that are not in your description"}: ${[...bad.wallets, ...bad.mints, ...bad.pools].map(short).join(", ")}`);
    return { strategy: null, explanation: [], warnings: dedupe(warnings), questions: dedupe(questions) };
  }
  const { strategy: out, added } = withDefaultExits(s, desc);
  if (added) warnings.push(v ? "Mô tả không có điểm thoát, nên dùng mặc định: chốt lời +100 %, cắt lỗ −30 %, trailing 25 %, giữ tối đa 1 ngày. Sửa ở mục Exits." : "No exits were described, so the defaults are set: take profit +100 %, stop loss −30 %, trailing 25 %, max hold 1 day. Change them under Exits.");
  return { strategy: out, explanation: explainStrategy(out), warnings: dedupe([...warnings, ...deterministicWarnings(out, desc)]), questions: dedupe(questions) };
}

const dedupe = (xs: string[]) => [...new Set(xs)].slice(0, 8);
