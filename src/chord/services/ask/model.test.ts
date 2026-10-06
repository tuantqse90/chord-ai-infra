import { describe, expect, test } from "bun:test";
import { hostFor, readStream, splitThink } from "./model";

const sse = (events: unknown[], split = 7) => {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  const enc = new TextEncoder().encode(text);
  // deliver in odd-sized chunks so lines split across reads
  const body = new ReadableStream({ start(c) { for (let i = 0; i < enc.length; i += split) c.enqueue(enc.slice(i, i + split)); c.close(); } });
  return new Response(body);
};

describe("readStream", () => {
  test("content streams chunk by chunk and assembles; usage comes from the last frame", async () => {
    const got: string[] = [];
    const j = await readStream(sse([
      { choices: [{ delta: { reasoning_content: "think" } }] },
      { choices: [{ delta: { content: "BTC sits " } }] },
      { choices: [{ delta: { content: "at $83,800." }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 8 } },
      "[DONE]",
    ]), { onText: (c) => got.push(c) });
    expect(got.join("")).toBe("BTC sits at $83,800.");
    expect(j.choices[0].message.content).toBe("BTC sits at $83,800.");
    expect(j.choices[0].finish_reason).toBe("stop");
    expect(j.usage.prompt_cache_hit_tokens).toBe(8);
    expect(j.choices[0].message.tool_calls).toBeUndefined();
  });

  test("tool calls are re-assembled from deltas; text after the first tool delta is not forwarded", async () => {
    const got: string[] = [];
    let toolSignals = 0;
    const j = await readStream(sse([
      { choices: [{ delta: { content: "Let me check." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "a1", function: { name: "arc_", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "token", arguments: '{"sym' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'bol":"X"}' } }, { index: 1, id: "b2", function: { name: "arc_holders", arguments: "{}" } }] } }] },
      { choices: [{ delta: { content: " more" }, finish_reason: "tool_calls" }] },
    ], 5), { onText: (c) => got.push(c), onToolCall: () => toolSignals++ });
    expect(got).toEqual(["Let me check."]);
    expect(toolSignals).toBe(1);
    const calls = j.choices[0].message.tool_calls;
    expect(calls.map((c: any) => c.function.name)).toEqual(["arc_token", "arc_holders"]);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ symbol: "X" });
    expect(calls[1].id).toBe("b2");
  });

  const deltas = (parts: string[]) => parts.map((content) => ({ choices: [{ delta: { content } }] }));

  test("MiniMax inline <think>: split off as reasoning even when the tags straddle deltas", async () => {
    const got: string[] = [];
    const thought: string[] = [];
    const j = await readStream(sse([...deltas(["<thi", "nk>\nThe tool said", " 0.0412.</th", "ink>\n\nMON is", " $0.0412."]), "[DONE]"]),
      { onText: (c) => got.push(c), onReasoning: (c) => thought.push(c) }, true);
    expect(got.join("")).toBe("MON is $0.0412.");
    expect(thought.join("")).toBe("\nThe tool said 0.0412.");
    expect(j.choices[0].message.content).toBe("MON is $0.0412.");
    expect(j.choices[0].message.reasoning_content).toBe("\nThe tool said 0.0412.");
  });

  test("MiniMax think then a tool call: nothing reaches onText, content stays null", async () => {
    const got: string[] = [];
    const j = await readStream(sse([
      ...deltas(["<think>\nI'll use the tool.", "\n</think>\n\n</th", "ink>"]),
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_price", arguments: '{"symbol":"MON"}' } }] } }] },
      { choices: [{ delta: { content: "" }, finish_reason: "tool_calls" }] },
    ]), { onText: (c) => got.push(c) }, true);
    expect(got).toEqual([]);
    expect(j.choices[0].message.content).toBeNull();
    expect(j.choices[0].message.reasoning_content).toBe("\nI'll use the tool.\n");
    expect(j.choices[0].message.tool_calls[0].function.name).toBe("get_price");
  });

  test("inline-think mode leaves an answer without <think> untouched; a length-cut think stays reasoning", async () => {
    const a = await readStream(sse(deltas(["<b>BTC</b>", " is up."])), { onText: () => {} }, true);
    expect(a.choices[0].message.content).toBe("<b>BTC</b> is up.");
    const b = await readStream(sse(deltas(["<think>still thin", "king"])), { onText: () => {} }, true);
    expect(b.choices[0].message.content).toBeNull();
    expect(b.choices[0].message.reasoning_content).toBe("still thinking");
  });

  test("hostFor: MiniMax-… → MiniMax, grok-… → xAI, anything else → DeepSeek", () => {
    expect(hostFor("MiniMax-M2.7-highspeed").name).toBe("minimax");
    expect(hostFor("grok-4.7").name).toBe("xai");
    expect(hostFor("grok-4.20-0309-non-reasoning").base).toBe("https://api.x.ai/v1");
    expect(hostFor("deepseek-v4-flash").name).toBe("deepseek");
  });

  test("splitThink (non-streamed MiniMax reply)", () => {
    expect(splitThink("<think>\nx\n</think>\n\nOK")).toEqual({ reasoning: "x", content: "OK" });
    expect(splitThink("OK")).toEqual({ reasoning: "", content: "OK" });
    expect(splitThink("<think>cut off")).toEqual({ reasoning: "cut off", content: "" });
    expect(splitThink("<think>\ncall it\n</think>\n\n</think>")).toEqual({ reasoning: "call it", content: "" });
  });
});

describe("chatCompletion — fallback host (DeepSeek hung 2026-10-02)", () => {
  const { spyOn, afterEach, beforeEach } = require("bun:test") as typeof import("bun:test");
  const req = (over: Record<string, unknown> = {}) => ({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], tools: [], mode: "auto" as const, maxTokens: 50, timeoutMs: 5_000, ...over });
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }), { status: 200 });
  const hang = (_u: unknown, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["ASK_MODEL_FALLBACK", "ASK_MODEL_HEADERS_TIMEOUT_MS", "ASK_MODEL_FALLBACK_HOLD_MS", "MINIMAX_API_KEY", "DEEPSEEK_API_KEY"];
  let spy: ReturnType<typeof spyOn> | null = null;
  beforeEach(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { ASK_MODEL_FALLBACK: "MiniMax-M2.7-highspeed", ASK_MODEL_HEADERS_TIMEOUT_MS: "30", ASK_MODEL_FALLBACK_HOLD_MS: "60000", MINIMAX_API_KEY: "mm", DEEPSEEK_API_KEY: "ds" });
    (await import("./model"))._resetModelFallback();
  });
  afterEach(() => { spy?.mockRestore(); spy = null; for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const hosts = () => (spy!.mock.calls as unknown[][]).map((c) => new URL(String(c[0])).host);

  test("DeepSeek sends no headers → the same call goes to MiniMax; the next call skips DeepSeek (hold)", async () => {
    const { chatCompletion } = await import("./model");
    spy = spyOn(globalThis, "fetch").mockImplementation(((u: string, init?: RequestInit) => (String(u).includes("deepseek") ? hang(u, init) : Promise.resolve(reply("ok from minimax")))) as unknown as typeof fetch);
    const a = await chatCompletion(req());
    expect(a.choices[0].message.content).toBe("ok from minimax");
    expect(hosts()).toEqual(["api.deepseek.com", "api.minimax.io"]);
    await chatCompletion(req());
    expect(hosts()).toEqual(["api.deepseek.com", "api.minimax.io", "api.minimax.io"]);
  });

  test("DeepSeek sends headers then only keep-alives → no first token → MiniMax answers the same call", async () => {
    process.env.ASK_MODEL_FIRST_TOKEN_TIMEOUT_MS = "40";
    const { chatCompletion } = await import("./model");
    const enc = new TextEncoder();
    spy = spyOn(globalThis, "fetch").mockImplementation(((u: string, init?: RequestInit) => {
      if (!String(u).includes("deepseek")) return Promise.resolve(new Response(new ReadableStream({ start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "from minimax" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)); c.close(); } })));
      const body = new ReadableStream({ start(c) {
        c.enqueue(enc.encode(": keep-alive\n\n"));
        init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
      } });
      return Promise.resolve(new Response(body));
    }) as unknown as typeof fetch);
    const got: string[] = [];
    const r = await chatCompletion(req({ onText: (c: string) => got.push(c) }));
    expect(got.join("")).toBe("from minimax");
    expect(r.choices[0].message.content).toBe("from minimax");
    expect(hosts()).toEqual(["api.deepseek.com", "api.minimax.io"]);
    delete process.env.ASK_MODEL_FIRST_TOKEN_TIMEOUT_MS;
  });

  test("HTTP 402 (balance) / 503 fail over; 400 (our payload) does not", async () => {
    const { chatCompletion, _resetModelFallback } = await import("./model");
    for (const status of [402, 503]) {
      _resetModelFallback();
      spy?.mockRestore();
      spy = spyOn(globalThis, "fetch").mockImplementation(((u: string) => Promise.resolve(String(u).includes("deepseek") ? new Response("x", { status }) : reply("fb"))) as unknown as typeof fetch);
      expect((await chatCompletion(req())).choices[0].message.content).toBe("fb");
    }
    _resetModelFallback();
    spy?.mockRestore();
    spy = spyOn(globalThis, "fetch").mockImplementation((() => Promise.resolve(new Response("bad", { status: 400 }))) as unknown as typeof fetch);
    await expect(chatCompletion(req())).rejects.toThrow("deepseek 400");
    expect(hosts()).toEqual(["api.deepseek.com"]);
  });

  test("text shown, then the stream stalls past the timeout → the error surfaces, no fallback", async () => {
    const { chatCompletion } = await import("./model");
    const enc = new TextEncoder();
    spy = spyOn(globalThis, "fetch").mockImplementation(((u: string, init?: RequestInit) => {
      if (!String(u).includes("deepseek")) return Promise.resolve(reply("fb"));
      const body = new ReadableStream({ start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ETH " } }] })}\n\n`));
        init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
      } });
      return Promise.resolve(new Response(body));
    }) as unknown as typeof fetch);
    const got: string[] = [];
    await expect(chatCompletion(req({ timeoutMs: 80, onText: (c: string) => got.push(c) }))).rejects.toThrow();
    expect(got).toEqual(["ETH "]);
    expect(hosts()).toEqual(["api.deepseek.com"]);
  });

  test("ASK_MODEL_FALLBACK unset → the old behaviour (the error surfaces)", async () => {
    delete process.env.ASK_MODEL_FALLBACK;
    const { chatCompletion } = await import("./model");
    spy = spyOn(globalThis, "fetch").mockImplementation((() => Promise.resolve(new Response("x", { status: 503 }))) as unknown as typeof fetch);
    await expect(chatCompletion(req())).rejects.toThrow("deepseek 503");
  });
});
