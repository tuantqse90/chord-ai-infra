// One call to the model through Chord's model layer (src/chord/services/ask/model.ts): DeepSeek by default, "MiniMax-…" and
// "grok-…" ids go to their own hosts, and ASK_MODEL_FALLBACK takes over when the primary host does not answer.
import { config } from "./config";
import { chatCompletion } from "./chord/services/ask/model";

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatReply = { content: string | null; toolCalls: ToolCall[]; tokens: number; reasoning?: string };
/** `onText` streams the content as it is written (the page's draft), `onReasoning` the model's thinking, `onToolCall` fires
 *  when the round turns out to call tools (whatever streamed before was a preamble). Hosts without streaming ignore them. */
export type ChatOpts = { model?: string; onText?: (chunk: string) => void; onReasoning?: (chunk: string) => void; onToolCall?: () => void };
export type ChatFn = (messages: ChatMessage[], tools: unknown[], toolChoice: "auto" | "none", opts?: ChatOpts) => Promise<ChatReply>;

export const chat: ChatFn = async (messages, tools, toolChoice, opts = {}) => {
  if (!config.llmKey() && !process.env.DEEPSEEK_API_KEY) throw new Error("LLM_API_KEY is not set");
  const j = await chatCompletion({ model: opts.model ?? config.llmModel(), messages, tools, mode: toolChoice, maxTokens: Number(process.env.ASK_MAX_TOKENS) || 4000, timeoutMs: 90_000, onText: opts.onText, onReasoning: opts.onReasoning, onToolCall: opts.onToolCall });
  const m = j?.choices?.[0]?.message ?? {};
  return { content: m.content ?? null, toolCalls: m.tool_calls ?? [], tokens: j?.usage?.total_tokens ?? 0, reasoning: typeof m.reasoning_content === "string" ? m.reasoning_content : undefined };
};
