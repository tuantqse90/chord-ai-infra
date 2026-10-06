// One call to an OpenAI-compatible chat completions endpoint (DeepSeek by default, as Chord Ask uses).
import { config } from "./config";

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatReply = { content: string | null; toolCalls: ToolCall[]; tokens: number };
export type ChatFn = (messages: ChatMessage[], tools: unknown[], toolChoice: "auto" | "none") => Promise<ChatReply>;

export const chat: ChatFn = async (messages, tools, toolChoice) => {
  const key = config.llmKey();
  if (!key) throw new Error("LLM_API_KEY is not set");
  const res = await fetch(`${config.llmBaseUrl().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: config.llmModel(), messages, tools: tools.length ? tools : undefined, tool_choice: tools.length ? toolChoice : undefined, max_tokens: 3000, temperature: 0.2 }),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`model HTTP ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  const m = j.choices?.[0]?.message ?? {};
  return { content: m.content ?? null, toolCalls: m.tool_calls ?? [], tokens: j.usage?.total_tokens ?? 0 };
};
