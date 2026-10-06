// ask2049: Claude on Amazon Bedrock as a fourth model host next to DeepSeek / MiniMax / xAI. Model ids that name an Anthropic
// model ("global.anthropic.claude-sonnet-5-5", "us.anthropic.…", "anthropic.…") go here. Auth = a Bedrock API key as a
// bearer token (AWS_BEARER_TOKEN_BEDROCK, the name the AWS SDKs read), region BEDROCK_REGION (default ap-southeast-1).
// The loop speaks OpenAI chat completions; this file translates both ways to the Converse API:
//   system → `system`, tool calls → toolUse blocks, tool results → toolResult blocks in a user turn (consecutive turns of
//   one role merged: Converse wants strict user / assistant alternation), schemas → toolConfig.
// Converse has no "tool_choice: none": for the forced final answer the earlier tool turns are rewritten as plain text, so
// the call needs no toolConfig and the model can only write.

export const isBedrock = (model: string) => /(^|\.)anthropic\.claude/i.test(model);
const region = () => process.env.BEDROCK_REGION || process.env.AWS_REGION || "ap-southeast-1";
export const bedrockKey = () => process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.BEDROCK_API_KEY;

type Block = Record<string, unknown>;
type Turn = { role: "user" | "assistant"; content: Block[] };

const parseArgs = (s: unknown): Record<string, unknown> => {
  if (s && typeof s === "object") return s as Record<string, unknown>;
  try { const v = JSON.parse(String(s || "{}")); return v && typeof v === "object" ? v : {}; } catch { return {}; }
};

/** OpenAI messages → Converse { system, messages }. `plain`: tool turns become text (no toolConfig needed). */
export function toConverse(messages: any[], plain: boolean): { system: { text: string }[]; messages: Turn[] } {
  const system: { text: string }[] = [];
  const out: Turn[] = [];
  const push = (role: Turn["role"], blocks: Block[]) => {
    const kept = blocks.filter((b) => !("text" in b) || String(b.text).trim());
    if (!kept.length) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...kept); else out.push({ role, content: kept });
  };
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "system") { if (m.content) system.push({ text: String(m.content) }); continue; }
    if (m.role === "user") { push("user", [{ text: String(m.content ?? "") }]); continue; }
    if (m.role === "assistant") {
      const blocks: Block[] = m.content ? [{ text: String(m.content) }] : [];
      for (const tc of m.tool_calls ?? []) {
        names.set(tc.id, tc.function?.name);
        blocks.push(plain
          ? { text: `[looked up ${tc.function?.name} ${String(tc.function?.arguments ?? "").slice(0, 300)}]` }
          : { toolUse: { toolUseId: tc.id, name: tc.function?.name, input: parseArgs(tc.function?.arguments) } });
      }
      push("assistant", blocks);
      continue;
    }
    if (m.role === "tool") {
      push("user", [plain
        ? { text: `Result of ${names.get(m.tool_call_id) ?? "lookup"}:\n${String(m.content ?? "")}` }
        : { toolResult: { toolUseId: m.tool_call_id, content: [{ text: String(m.content ?? "") || "{}" }] } }]);
    }
  }
  // Converse must start with a user turn.
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: [{ text: "(continue)" }] });
  return { system, messages: out };
}

/** Converse answer → the OpenAI response shape the loop reads. */
export function fromConverse(j: any): any {
  const blocks: any[] = j?.output?.message?.content ?? [];
  const text = blocks.filter((b) => typeof b.text === "string").map((b) => b.text).join("");
  const tool_calls = blocks.filter((b) => b.toolUse).map((b) => ({ id: b.toolUse.toolUseId, type: "function", function: { name: b.toolUse.name, arguments: JSON.stringify(b.toolUse.input ?? {}) } }));
  return {
    choices: [{ message: { role: "assistant", content: text || null, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: j?.stopReason === "tool_use" ? "tool_calls" : j?.stopReason === "max_tokens" ? "length" : "stop" }],
    usage: { prompt_tokens: j?.usage?.inputTokens ?? 0, completion_tokens: j?.usage?.outputTokens ?? 0, total_tokens: j?.usage?.totalTokens ?? 0 },
  };
}

export async function callBedrock(req: { model: string; messages: any[]; tools: unknown[]; mode: "auto" | "none"; maxTokens: number; timeoutMs: number }): Promise<any> {
  const key = bedrockKey();
  if (!key) throw Object.assign(new Error("bedrock: no API key"), { status: 401 });
  const plain = req.mode === "none" || !req.tools.length;
  const { system, messages } = toConverse(req.messages, plain);
  const body: Record<string, unknown> = { messages, inferenceConfig: { maxTokens: req.maxTokens, temperature: 0.2 } };
  if (system.length) body.system = system;
  if (!plain) {
    body.toolConfig = {
      tools: (req.tools as any[]).map((t) => ({ toolSpec: { name: t.function.name, description: String(t.function.description || t.function.name).slice(0, 4000), inputSchema: { json: t.function.parameters ?? { type: "object", properties: {} } } } })),
      toolChoice: { auto: {} },
    };
  }
  const res = await fetch(`https://bedrock-runtime.${region()}.amazonaws.com/model/${encodeURIComponent(req.model)}/converse`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    let detail = "";
    try { detail = String(JSON.parse(msg)?.message ?? "").slice(0, 120); } catch { /* not JSON */ }
    // Every refusal goes to the fallback host: Bedrock answers account states as 400 / 403 too ("Operation not allowed",
    // "account is being verified", model access off — seen 06/10 on a new account), not only payload errors. The model
    // layer logs each failover with this message, so a real payload bug still shows in the logs.
    throw Object.assign(new Error(`bedrock ${res.status}${detail ? `: ${detail}` : ""}`), { status: 503 });
  }
  return fromConverse(await res.json());
}
