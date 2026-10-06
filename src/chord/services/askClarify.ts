// ask2049: Chord's services/askClarify.ts, copied unchanged (2026-10-06). services/ask/accountTools.ts registers the tool.
// Ask the person back (owner 2026-09-25, from a Minara screenshot: "thiếu phần hỏi lại users"). When a question
// has two or more readings that lead to DIFFERENT answers — a ticker on several chains (SATS: Ordinals BRC-20 vs an
// ERC-20), a size the plan depends on, "my wallet" with none connected — the agent calls `ask_user` instead of
// guessing. The call ENDS the turn: the page shows the question as a card (options + "type your own"), the pick
// comes back as the next question, and the history line below tells the model what that pick answers.
//
// Contract (the harness registers the tool; this file owns its shape):
//   · tool name ASK_USER_TOOL, schema ASK_USER_TOOL_DEF — add the def to the tool list;
//   · when the model calls it: normalizeClarify(args) → emit the answer with `clarify` set, text = the model's
//     lead-in (may be empty), no follow-ups; do not run other calls of that round; the turn costs 0 credits;
//   · append CLARIFY_RULES to the system prompt;
//   · the page (and any client) replays the assistant turn as clarifyHistoryText(text, clarify).
// Never reject a call for length (Minara's own card showed "header: Too big: expected <=12 characters") — trim.

export const ASK_USER_TOOL = "ask_user";

export interface ClarifyOption { label: string; detail: string | null }
export interface AskClarify {
  /** Stable per question so the page can mark it answered. */
  id: string;
  question: string;
  options: ClarifyOption[];
  /** "Or type your own answer" box. */
  allowOther: boolean;
  /** Several options may be picked (sent back joined by ", "). */
  multi: boolean;
}

export const ASK_USER_TOOL_DEF = {
  type: "function" as const,
  function: {
    name: ASK_USER_TOOL,
    description: "Ask the person ONE short question before answering, with 2–4 options they can tap (plus their own text). Use ONLY when the question has readings that lead to different answers and no tool can tell which they mean: a ticker that is several different assets (SATS = Ordinals BRC-20 or an ERC-20; a symbol on Arc AND Robinhood Chain with different prices), an amount or a risk the plan depends on, 'my wallet / my position' with no wallet connected, a trade whose side or size is unclear. Never for things a tool can look up, never to confirm what they already said, at most once per question. Calling it ends your turn — write one sentence before it saying why you ask.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "the question, in the person's language, under 120 characters" },
        options: {
          type: "array", minItems: 2, maxItems: 4,
          items: { type: "object", properties: { label: { type: "string", description: "short, under 40 characters" }, detail: { type: "string", description: "one line: what this choice means or where it trades" } }, required: ["label"] },
        },
        allow_other: { type: "boolean", description: "show 'type your own' (default true)" },
        multi: { type: "boolean", description: "several options may be picked (default false)" },
      },
      required: ["question", "options"],
    },
  },
};

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** Model args → a card, leniently: trims every field, drops empty / duplicate options, caps at 4. Null when there is
 *  nothing askable (no question, fewer than 2 options and no free text) — the harness then lets the model answer. */
export function normalizeClarify(args: unknown): AskClarify | null {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const question = clip(a.question ?? a.header ?? a.title, 200);
  const raw = Array.isArray(a.options) ? a.options : Array.isArray(a.choices) ? a.choices : [];
  const seen = new Set<string>();
  const options: ClarifyOption[] = [];
  for (const o of raw) {
    const label = clip(typeof o === "string" ? o : (o as Record<string, unknown>)?.label ?? (o as Record<string, unknown>)?.title, 60);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const d = typeof o === "object" && o ? clip((o as Record<string, unknown>).detail ?? (o as Record<string, unknown>).description, 160) : "";
    options.push({ label, detail: d || null });
    if (options.length === 4) break;
  }
  const allowOther = a.allow_other !== false && a.allowOther !== false;
  if (!question || (options.length < 2 && !allowOther)) return null;
  return { id: hash(`${question}|${options.map((o) => o.label).join("|")}`), question, options, allowOther, multi: a.multi === true };
}

/** How the assistant turn is replayed in history, so "1000SATS" next turn is read as the answer to this question. */
export function clarifyHistoryText(leadIn: string, c: AskClarify): string {
  const opts = c.options.map((o) => o.label).join(" / ");
  return `${leadIn ? `${leadIn.trim()}\n\n` : ""}[I asked: ${c.question}${opts ? ` — options: ${opts}` : ""}. The next message is the person's answer.]`;
}

export const CLARIFY_RULES = `ASKING BACK (ask_user): when a question has readings that lead to different answers and no tool can decide — a ticker that is several different assets or chains, an amount / risk / side the plan depends on, "my wallet" with none connected — call ask_user once with 2–4 concrete options (the likely one first, each with one line of what it means) instead of guessing, after a one-sentence reason. Look things up first when a tool can settle it (search the symbol, then ask only if the hits are genuinely different assets). Never ask to confirm what they said, never ask twice in a row, never ask for a lookup-style question you can answer. When the previous turn shows "[I asked: …]", the new message is the answer: act on it without asking again.`;
