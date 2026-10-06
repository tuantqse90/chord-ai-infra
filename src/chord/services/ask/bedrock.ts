// ask2049: Claude on Amazon Bedrock as a fourth model host next to DeepSeek / MiniMax / xAI. Model ids that name an Anthropic
// model ("global.anthropic.claude-sonnet-5-5", "us.anthropic.…", "anthropic.…") go here. Auth = a Bedrock API key as a
// bearer token (AWS_BEARER_TOKEN_BEDROCK, the name the AWS SDKs read), region BEDROCK_REGION (default ap-southeast-1).
// The loop speaks OpenAI chat completions; this file translates both ways to the Converse API:
//   system → `system`, tool calls → toolUse blocks, tool results → toolResult blocks in a user turn (consecutive turns of
//   one role merged: Converse wants strict user / assistant alternation), schemas → toolConfig.
// Converse has no "tool_choice: none": for the forced final answer the earlier tool turns are rewritten as plain text, so
// the call needs no toolConfig and the model can only write.

export const isBedrock = (model: string) => /(^|\.)anthropic\.claude/i.test(model);
/** Regions to try in order (BEDROCK_REGIONS, comma-separated; BEDROCK_REGION alone works too). A new AWS account opens
 *  region by region with different refusals (06/10: "Operation not allowed", "being verified", "Too many tokens per day"),
 *  so the first region that answers is remembered for 10 minutes and tried first. */
const regions = () => (process.env.BEDROCK_REGIONS || process.env.BEDROCK_REGION || process.env.AWS_REGION || "ap-southeast-1").split(",").map((r) => r.trim()).filter(Boolean);
let goodRegion: { r: string; until: number } | null = null;
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

/** One message of AWS's binary event stream: [total u32][headers u32][prelude crc u32][headers][payload][crc u32]. */
export function readEventFrames(buf: Uint8Array): { frames: { headers: Record<string, string>; payload: Uint8Array }[]; rest: Uint8Array } {
  const frames: { headers: Record<string, string>; payload: Uint8Array }[] = [];
  let off = 0;
  while (buf.length - off >= 12) {
    const dv = new DataView(buf.buffer, buf.byteOffset + off);
    const total = dv.getUint32(0), hlen = dv.getUint32(4);
    if (total < 16 || buf.length - off < total) break;
    const headers: Record<string, string> = {};
    let h = off + 12;
    const hend = h + hlen;
    while (h < hend) {
      const nlen = buf[h]; const name = new TextDecoder().decode(buf.subarray(h + 1, h + 1 + nlen)); h += 1 + nlen;
      const type = buf[h]; h += 1;
      if (type === 7) { const vlen = (buf[h] << 8) | buf[h + 1]; headers[name] = new TextDecoder().decode(buf.subarray(h + 2, h + 2 + vlen)); h += 2 + vlen; }
      else break; // only string headers are used by Bedrock's stream
    }
    frames.push({ headers, payload: buf.subarray(off + 12 + hlen, off + total - 4) });
    off += total;
  }
  return { frames, rest: buf.subarray(off) };
}

/** ConverseStream → the same OpenAI shape as callBedrock, with text handed to onText as it arrives. */
async function readConverseStream(res: Response, onText: (c: string) => void, onToolCall?: () => void): Promise<any> {
  const reader = res.body!.getReader();
  let pending = new Uint8Array(0);
  const blocks = new Map<number, { text?: string; tool?: { id: string; name: string; input: string } }>();
  let stopReason = "end_turn"; let usage: any = {};
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(pending.length + value.length); joined.set(pending); joined.set(value, pending.length);
    const { frames, rest } = readEventFrames(joined);
    pending = new Uint8Array(rest);
    for (const f of frames) {
      const ev = f.headers[":event-type"];
      let j: any = {};
      try { j = JSON.parse(dec.decode(f.payload) || "{}"); } catch { /* keep {} */ }
      if (f.headers[":message-type"] === "exception") throw Object.assign(new Error(`bedrock stream: ${f.headers[":exception-type"] ?? "error"} ${String(j.message ?? "").slice(0, 120)}`), { status: 503 });
      if (ev === "contentBlockStart" && j.start?.toolUse) { blocks.set(j.contentBlockIndex, { tool: { id: j.start.toolUse.toolUseId, name: j.start.toolUse.name, input: "" } }); onToolCall?.(); }
      else if (ev === "contentBlockDelta") {
        const b = blocks.get(j.contentBlockIndex) ?? {}; blocks.set(j.contentBlockIndex, b);
        if (typeof j.delta?.text === "string") { b.text = (b.text ?? "") + j.delta.text; onText(j.delta.text); }
        if (j.delta?.toolUse && b.tool) b.tool.input += j.delta.toolUse.input ?? "";
      } else if (ev === "messageStop") stopReason = j.stopReason ?? stopReason;
      else if (ev === "metadata") usage = j.usage ?? usage;
    }
  }
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  const content = ordered.map((b) => (b.tool ? { toolUse: { toolUseId: b.tool.id, name: b.tool.name, input: parseArgs(b.tool.input) } } : { text: b.text ?? "" }));
  return fromConverse({ output: { message: { content } }, stopReason, usage });
}

export async function callBedrock(req: { model: string; messages: any[]; tools: unknown[]; mode: "auto" | "none"; maxTokens: number; timeoutMs: number; onText?: (c: string) => void; onToolCall?: () => void }): Promise<any> {
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
  const list = regions();
  const order = goodRegion && goodRegion.until > Date.now() && list.includes(goodRegion.r) ? [goodRegion.r, ...list.filter((r) => r !== goodRegion!.r)] : list;
  let lastErr: Error | null = null;
  for (const r of order) {
    const stream = !!req.onText;
    const res = await fetch(`https://bedrock-runtime.${r}.amazonaws.com/model/${encodeURIComponent(req.model)}/${stream ? "converse-stream" : "converse"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: stream ? "application/vnd.amazon.eventstream" : "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    if (res.ok) {
      goodRegion = { r, until: Date.now() + 600_000 };
      return stream ? readConverseStream(res, req.onText!, req.onToolCall) : fromConverse(await res.json());
    }
    const msg = await res.text().catch(() => "");
    let detail = "";
    try { detail = String(JSON.parse(msg)?.message ?? "").slice(0, 120); } catch { /* not JSON */ }
    // Every refusal goes to the fallback host: Bedrock answers account states as 400 / 403 / 429 too ("Operation not
    // allowed", "account is being verified", daily token quota), not only payload errors. The model layer logs each
    // failover with this message, so a real payload bug still shows in the logs.
    lastErr = Object.assign(new Error(`bedrock ${r} ${res.status}${detail ? `: ${detail}` : ""}`), { status: 503 });
  }
  throw lastErr ?? Object.assign(new Error("bedrock: no region"), { status: 503 });
}
