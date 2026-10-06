// The one call to the model (moved out of askAgent.ts, docs/ask-harness-plan.md phase 1). Same target as before: the
// hard-coded DeepSeek host (DEEPSEEK_BASE_URL, operator env) — no third-party URL (classInvariants fetch allowlist).
// With `onText` the call streams (SSE) and hands each content chunk over as it arrives, so the page can show the answer
// while it is written; the returned value has the non-streaming shape either way ({choices:[{message,finish_reason}],
// usage}), tool calls re-assembled from their deltas.

import { logger } from "../../utils/logger";
import { bedrockKey, callBedrock, isBedrock } from "./bedrock";

// ask2049: also reads this app's LLM_BASE_URL / LLM_API_KEY (its .env predates the Chord names).
export const MODEL_BASE = process.env.DEEPSEEK_BASE_URL || process.env.LLM_BASE_URL || "https://api.deepseek.com";
const KEY = () => process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY;
// Second hard-coded host: a model id "MiniMax-…" (ASK_MODEL / ASK_MODEL_HEAVY) goes to MiniMax, same OpenAI shape. The global
// `sk-api-…` key only works on api.minimax.io (api.minimaxi.com rejects it). MiniMax writes its thinking inline as
// <think>…</think> at the head of `content`; it is split off here into reasoning_content (DeepSeek's field). NOT their
// `reasoning_split` flag: on M3 it puts the boundary one token late — the answer's first word lands in the reasoning
// ("…per the developer policy.MON" / "is currently priced at…", seen 2026-09-26).
const MINIMAX_BASE = process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1";
const THINK_TAGS = /<\/?think>/g;
export const isMiniMax = (model: string) => /^minimax-/i.test(model);
// Third hard-coded host: "grok-…" → xAI. Same shape as DeepSeek down to reasoning_content (reasoning models), so nothing to split.
const XAI_BASE = process.env.XAI_BASE_URL || "https://api.x.ai/v1";

/** Which host serves a model id: "MiniMax-…" → MiniMax, "grok-…" → xAI, anything else → DeepSeek. */
export function hostFor(model: string): { name: string; base: string; key: string | undefined } {
  if (isBedrock(model)) return { name: "bedrock", base: "", key: bedrockKey() }; // ask2049: Claude on Amazon Bedrock
  if (isMiniMax(model)) return { name: "minimax", base: MINIMAX_BASE, key: process.env.MINIMAX_API_KEY };
  if (/^grok-/i.test(model)) return { name: "xai", base: XAI_BASE, key: process.env.XAI_API_KEY };
  return { name: "deepseek", base: MODEL_BASE, key: KEY() };
}

export interface ChatRequest {
  model: string;
  messages: any[];
  tools: unknown[];
  mode: "auto" | "none";
  maxTokens: number;
  timeoutMs: number;
  /** Stream: called with each content chunk. Returning false stops forwarding (the call still completes). */
  onText?: (chunk: string) => void;
  /** Stream: called once when the first tool-call delta arrives (content streamed before it was a preamble). */
  onToolCall?: () => void;
  /** Stream: called with each reasoning chunk (deepseek reasoning_content) — the page's "Thinking…" line. */
  onReasoning?: (chunk: string) => void;
}

/** MiniMax wants its earlier thinking back in multi-turn tool use: the reasoning we split off goes back inline. */
function toMiniMax(messages: any[]): any[] {
  return messages.map((m) => {
    if (m?.role !== "assistant" || !m.reasoning_content) return m;
    const { reasoning_content, ...rest } = m;
    return { ...rest, content: `<think>\n${reasoning_content}\n</think>\n\n${m.content ?? ""}` };
  });
}

/** "<think>x</think>\n\ny" → { reasoning: "x", content: "y" }; no leading <think> = all content. */
export function splitThink(text: string): { reasoning: string; content: string } {
  const m = /^\s*<think>([\s\S]*?)(?:<\/think>|$)\s*/.exec(text);
  if (!m) return { reasoning: "", content: text };
  return { reasoning: m[1].trim(), content: text.slice(m[0].length).replace(THINK_TAGS, "").replace(/^\s+/, "") };
}

// ── Fallback host (owner 2026-10-02) ──────────────────────────────────────────────────────────────────────────────
// DeepSeek's chat endpoint stopped answering for hours (connection open, no response headers, /models still 200, balance
// fine) and every Ask answer died with it. ASK_MODEL_FALLBACK (e.g. MiniMax-M2.7-highspeed, a different host) takes the
// call when the primary host fails BEFORE anything reached the user: no response headers within
// ASK_MODEL_HEADERS_TIMEOUT_MS on DeepSeek, a streamed DeepSeek reply with headers but no real delta (reasoning, text or
// tool call — keep-alives do not count) within ASK_MODEL_FIRST_TOKEN_TIMEOUT_MS (the 2026-10-02 failure mode: headers,
// then silence until the 75 s round timeout, past the client's 60 s idle cut), a network error, a timeout, or an HTTP
// error other than 400 / 422 (our own payload). After a failover the primary host is skipped for
// ASK_MODEL_FALLBACK_HOLD_MS (10 min) so questions do not pay the wait again; then the next call probes it. Unset = off.
const envMs = (name: string, dflt: number) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
const downUntil = new Map<string, number>();

/** For tests. */
export function _resetModelFallback(): void { downUntil.clear(); }

function fallbackFor(model: string): string | null {
  const fb = (process.env.ASK_MODEL_FALLBACK || "").trim();
  if (!fb) return null;
  const a = hostFor(model), b = hostFor(fb);
  return b.name !== a.name && b.key ? fb : null;
}

export async function chatCompletion(req: ChatRequest): Promise<any> {
  const fb = fallbackFor(req.model);
  const primary = hostFor(req.model).name;
  if (fb && (downUntil.get(primary) ?? 0) > Date.now()) return callModel({ ...req, model: fb });
  let emitted = false;
  const mark = <T extends (...a: any[]) => void>(f: T | undefined) => (f ? ((...a: any[]) => { emitted = true; return f(...a); }) as T : undefined);
  try {
    return await callModel({ ...req, onText: mark(req.onText), onReasoning: mark(req.onReasoning), onToolCall: mark(req.onToolCall) });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (!fb || emitted || status === 400 || status === 422) throw e;
    downUntil.set(primary, Date.now() + envMs("ASK_MODEL_FALLBACK_HOLD_MS", 600_000));
    logger.warn({ primary: req.model, fallback: fb, err: String((e as Error)?.message ?? e).slice(0, 120) }, "ask: model host unavailable — fallback");
    return callModel({ ...req, model: fb });
  }
}

async function callModel(req: ChatRequest): Promise<any> {
  const host = hostFor(req.model);
  if (host.name === "bedrock") return callBedrock(req); // ask2049: no streaming on this host (the loop does not stream)
  const mm = host.name === "minimax";
  // No tools at all (the last-resort answer) = no tools / tool_choice fields.
  const body = { model: req.model, messages: mm ? toMiniMax(req.messages) : req.messages, ...(req.tools.length ? { tools: req.tools, tool_choice: req.mode } : {}), max_tokens: req.maxTokens, temperature: 0.2 };
  const stream = !!req.onText;
  // DeepSeek answers with headers immediately (then keep-alives while queued), so silence past this is a dead endpoint.
  // Other hosts send headers only with a non-streamed reply — no headers timer there.
  const headers = new AbortController();
  const hTimer = host.name === "deepseek" ? setTimeout(() => headers.abort(new Error(`${host.name}: no response headers`)), envMs("ASK_MODEL_HEADERS_TIMEOUT_MS", 12_000)) : null;
  let res: Response;
  try {
    res = await fetch(`${host.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(stream ? { ...body, stream: true, stream_options: { include_usage: true } } : body),
      signal: AbortSignal.any([AbortSignal.timeout(req.timeoutMs), headers.signal]),
    });
  } finally {
    if (hTimer) clearTimeout(hTimer);
  }
  if (!res.ok) throw Object.assign(new Error(`${host.name} ${res.status}`), { status: res.status });
  // Headers in, but no real delta yet: on DeepSeek, silence past the first-token budget aborts the read (→ fallback).
  let fTimer: ReturnType<typeof setTimeout> | null = null;
  if (stream && host.name === "deepseek") {
    fTimer = setTimeout(() => headers.abort(new Error(`${host.name}: no first token`)), envMs("ASK_MODEL_FIRST_TOKEN_TIMEOUT_MS", 20_000));
    const seen = () => { if (fTimer) { clearTimeout(fTimer); fTimer = null; } };
    const onText = req.onText, onReasoning = req.onReasoning, onToolCall = req.onToolCall;
    req = { ...req, onText: (c: string) => { seen(); onText?.(c); }, onReasoning: (c: string) => { seen(); onReasoning?.(c); }, onToolCall: () => { seen(); onToolCall?.(); } };
  }
  if (!stream) {
    const j = await res.json();
    const m = j?.choices?.[0]?.message;
    if (mm && typeof m?.content === "string") {
      const s = splitThink(m.content);
      m.content = s.content || null;
      if (s.reasoning) m.reasoning_content = s.reasoning;
    }
    return j;
  }
  try {
    return await readStream(res, req, mm);
  } finally {
    if (fTimer) clearTimeout(fTimer);
  }
}

/** Streaming splitter for an inline <think>…</think> head: holds back only what could still be part of a tag. */
function thinkSplitter(onThink: (s: string) => void, onText: (s: string) => void) {
  const OPEN = "<think>", CLOSE = "</think>";
  let state: "head" | "think" | "text" = "head";
  let pend = "";
  let started = false;
  const text = (s: string) => {
    if (!started) { s = s.replace(/^\s+/, ""); if (s) started = true; }
    if (s) onText(s);
  };
  /** Length of the longest tail of `s` that is a prefix of `tag`. */
  const partial = (s: string, tag: string) => { for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n; return 0; };
  const push = (chunk: string) => {
    pend += chunk;
    if (state === "head") {
      const lead = pend.replace(/^\s+/, "");
      if (lead.length < OPEN.length && OPEN.startsWith(lead)) return;
      if (lead.startsWith(OPEN)) { state = "think"; pend = lead.slice(OPEN.length); } else state = "text";
    }
    if (state === "think") {
      const i = pend.indexOf(CLOSE);
      if (i < 0) {
        const keep = partial(pend, CLOSE);
        if (pend.length > keep) onThink(pend.slice(0, pend.length - keep));
        pend = pend.slice(pend.length - keep);
        return;
      }
      if (i > 0) onThink(pend.slice(0, i));
      pend = pend.slice(i + CLOSE.length);
      state = "text";
    }
    // M3 doubles the close tag on a tool round ("…\n</think>\n\n</think>"): stray tags never reach the answer.
    pend = pend.replace(THINK_TAGS, "");
    const keep = Math.max(partial(pend, CLOSE), partial(pend, OPEN));
    text(pend.slice(0, pend.length - keep));
    pend = pend.slice(pend.length - keep);
  };
  /** Stream ended: an unterminated think stays thinking (length cut), anything else is text. */
  const end = () => { if (!pend) return; if (state === "think") onThink(pend); else text(pend); pend = ""; };
  return { push, end };
}

/** SSE → the non-streaming response shape. Exported for the unit test (fed a canned stream). `inlineThink` = MiniMax. */
export async function readStream(res: Response, req: Pick<ChatRequest, "onText" | "onToolCall" | "onReasoning">, inlineThink = false): Promise<any> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finish: string | null = null;
  let usage: any = null;
  let sawTool = false;
  const calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  const think = (s: string) => { reasoning += s; req.onReasoning?.(s); };
  const text = (s: string) => { content += s; if (!sawTool) req.onText?.(s); };
  const split = inlineThink ? thinkSplitter(think, text) : null;
  const line = (l: string) => {
    if (!l.startsWith("data:")) return;
    const data = l.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    if (j.usage) usage = j.usage;
    const ch = j.choices?.[0];
    if (!ch) return;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta ?? {};
    if (typeof d.reasoning_content === "string" && d.reasoning_content) think(d.reasoning_content);
    if (Array.isArray(d.tool_calls)) {
      if (!sawTool) { sawTool = true; req.onToolCall?.(); }
      for (const tc of d.tool_calls) {
        const i = Number(tc.index ?? calls.length);
        calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
    if (typeof d.content === "string" && d.content) {
      if (split) split.push(d.content);
      else text(d.content);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) { line(buf.slice(0, nl).replace(/\r$/, "")); buf = buf.slice(nl + 1); }
  }
  if (buf) line(buf);
  split?.end();
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  const message: any = { role: "assistant", content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning_content = reasoning;
  return { choices: [{ message, finish_reason: finish }], usage };
}
