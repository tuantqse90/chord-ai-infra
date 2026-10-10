import { describe, expect, it } from "bun:test";
import { addr } from "../bots/_testkit";
import type { ChatFn, ChatMessage } from "../llm";
import { compileStrategy, extractJson, SYSTEM_PROMPT } from "./compile";
import { StrategyInputError } from "./schema";

const W1 = addr(41), W2 = addr(42), M1 = addr(43);

/** A model that answers from a script, and remembers what it was sent. */
function scripted(...replies: (string | ((msgs: ChatMessage[]) => string))[]) {
  const calls: ChatMessage[][] = [];
  const chat: ChatFn = async (messages, tools, toolChoice) => {
    expect(tools).toEqual([]);
    expect(toolChoice).toBe("none");
    calls.push(messages.map((m) => ({ ...m })) as ChatMessage[]);
    const r = replies[calls.length - 1];
    if (r === undefined) throw new Error("the model was called more often than scripted");
    return { content: typeof r === "function" ? r(messages) : r, toolCalls: [], tokens: 100 };
  };
  return { chat, calls };
}

const confluence = {
  version: 1, name: "Smart crowd",
  trigger: { type: "confluence", wallets: { smartTraders: { top: 20, days: 1 } }, minWallets: 3, windowMin: 15, side: "buy" },
  filters: [{ field: "liquidityUsd", op: ">=", value: 30000 }], action: { type: "buy", usd: 20 }, exits: { stopLossPct: 30, takeProfitPct: 100 },
};

describe("compileStrategy", () => {
  it("a canned model reply becomes a validated strategy with its explanation", async () => {
    const m = scripted(`Sure!\n\`\`\`json\n${JSON.stringify({ strategy: confluence, questions: [], warnings: ["Buy size $20 is a default."] })}\n\`\`\``);
    const r = await compileStrategy("buy $20 when 3 of the top smart traders buy the same token within 15 min, liquidity over 30k, TP 100% SL 30%", { chat: m.chat });
    expect(r.questions).toEqual([]);
    expect(r.strategy).toMatchObject({ name: "Smart crowd", trigger: { type: "confluence", minWallets: 3 }, limits: { maxPerTokenUsd: 60, dailyBudgetUsd: 100 } });
    expect(r.explanation).toHaveLength(5);
    expect(r.explanation[0]).toMatch(/^Trigger: when 3 or more of the top 20 smart traders/);
    expect(r.warnings).toEqual(["Buy size $20 is a default."]);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0][0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(m.calls[0][1].role).toBe("user");
  });

  it("a broken reply gets one repair round with the Zod errors, then passes", async () => {
    const broken = { ...confluence, filters: [{ field: "liquidity", op: ">=", value: "30k" }], exits: { takeProfit: 100 } };
    const m = scripted(JSON.stringify({ strategy: broken, questions: [], warnings: [] }), (msgs) => {
      const last = msgs[msgs.length - 1].content as string;
      expect(last).toContain("Filters › liquidity: field must be one of");
      expect(last).toContain('Exits: unknown field "takeProfit" (takes takeProfitPct');
      return JSON.stringify({ strategy: confluence, questions: [], warnings: [] });
    });
    const r = await compileStrategy("smart money confluence bot", { chat: m.chat });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1].map((x) => x.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(r.strategy?.exits).toEqual({ stopLossPct: 30, takeProfitPct: 100 });
  });

  it("an unreadable reply is repaired once; a second failure becomes a question, never a guess", async () => {
    const ok = scripted("I think you want a copy bot.", JSON.stringify({ strategy: confluence, questions: [], warnings: [] }));
    expect((await compileStrategy("copy the smart money crowd", { chat: ok.chat })).strategy).not.toBeNull();
    expect(ok.calls[1].at(-1)!.content).toMatch(/That was not a JSON object/);

    const bad = scripted("nope", "still nope");
    const r = await compileStrategy("something", { chat: bad.chat });
    expect(r).toMatchObject({ strategy: null, explanation: [], warnings: ["The model did not answer with readable JSON."] });
    expect(r.questions).toHaveLength(1);

    const invalidTwice = scripted(JSON.stringify({ strategy: { ...confluence, action: { type: "buy", usd: 5000 } } }), JSON.stringify({ strategy: { ...confluence, action: { type: "buy", usd: 5000 } } }));
    const r2 = await compileStrategy("buy 5000 dollars on every smart money confluence", { chat: invalidTwice.chat });
    expect(r2.strategy).toBeNull();
    expect(r2.warnings[0]).toBe("The model's strategy did not validate: Action › usd: must be at most 1000");
  });

  it("missing values come back as questions (English and Vietnamese)", async () => {
    const en = scripted(JSON.stringify({ strategy: null, questions: ["Which wallet should the bot copy?"], warnings: [] }));
    expect(await compileStrategy("copy this wallet for me", { chat: en.chat })).toEqual({ strategy: null, explanation: [], warnings: [], questions: ["Which wallet should the bot copy?"] });
    const vi = scripted(JSON.stringify({ strategy: null, questions: [], warnings: [] }));
    const r = await compileStrategy("mua token này mỗi ngày giúp mình", { chat: vi.chat });
    expect(r.strategy).toBeNull();
    expect(r.questions[0]).toMatch(/^Bot nên hành động khi nào/);
  });

  it("addresses the description does not contain are refused (the model never invents a wallet)", async () => {
    const s = { ...confluence, trigger: { type: "wallet_trade", wallets: { list: [W1, W2] }, side: "buy" } };
    const m = scripted(JSON.stringify({ strategy: s, questions: [], warnings: [] }));
    const r = await compileStrategy(`copy ${W1} and that other whale`, { chat: m.chat });
    expect(r.strategy).toBeNull();
    expect(r.questions).toEqual(["Which wallets should the bot follow? Paste their Monad addresses (addresses are never guessed)."]);
    expect(r.warnings[0]).toBe(`Dropped addresses that are not in your description: ${W2.slice(0, 6)}…${W2.slice(-4)}`);

    // pasted addresses (case kept) and well-known mints pass
    const both = { ...s, trigger: { type: "wallet_trade", wallets: { list: [W1, W2] }, side: "buy" } };
    const ok = await compileStrategy(`copy ${W1} and ${W2}`, { chat: scripted(JSON.stringify({ strategy: both })).chat });
    expect(ok.strategy?.trigger).toMatchObject({ wallets: { list: [W1, W2] } });
    const dca = { version: 1, name: "DCA", trigger: { type: "schedule", every: "1d", mint: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" }, filters: [], action: { type: "buy", usd: 10 }, limits: { dailyBudgetUsd: 10, maxPerTokenUsd: 1000 } };
    expect((await compileStrategy("DCA $10 into WMON every day", { chat: scripted(JSON.stringify({ strategy: dca })).chat })).strategy?.trigger).toMatchObject({ type: "schedule" });
    const invented = { ...dca, trigger: { type: "schedule", every: "1d", mint: M1 } };
    const vi = await compileStrategy("mua 10$ token XYZ mỗi ngày", { chat: scripted(JSON.stringify({ strategy: invented })).chat });
    expect(vi.strategy).toBeNull();
    expect(vi.questions).toEqual(["Token nào? Dán địa chỉ token 0x… của nó."]);
  });

  it("adds the paper-mode and no-stop-loss warnings; a bare strategy object is accepted", async () => {
    const s = { ...confluence, exits: { takeProfitPct: 100 } };
    const r = await compileStrategy("run this live with real money: smart money confluence", { chat: scripted(JSON.stringify(s)).chat });
    expect(r.strategy).not.toBeNull();
    expect(r.warnings).toEqual(["Agents run in paper mode only: fills are priced by real router quotes on Monad and nothing is sent; every fill is committed on-chain.", "No exit limits a loss: a position is held until you sell it."]);
    const v = await compileStrategy("chạy thật bằng tiền thật nhé: cá mập cùng mua thì mua", { chat: scripted(JSON.stringify({ strategy: s })).chat });
    expect(v.warnings).toEqual(["Agent chỉ chạy paper (giá khớp theo quote router thật trên Monad, không gửi giao dịch nào; mỗi fill được commit on-chain).", "Không có điểm cắt lỗ: vị thế được giữ cho tới khi bạn bán."]);
  });

  it("refuses an empty or overlong description before calling the model", async () => {
    const m = scripted();
    await expect(compileStrategy("   ", { chat: m.chat })).rejects.toThrow(StrategyInputError);
    await expect(compileStrategy("x".repeat(2001), { chat: m.chat })).rejects.toThrow(/too long/);
    expect(m.calls).toHaveLength(0);
  });

  it("extractJson reads bare, fenced and embedded objects", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('text ```json\n{"a":{"b":"}"}}\n``` more')).toEqual({ a: { b: "}" } });
    expect(extractJson('Here: {"a": "x { y"} and {"b": 2}')).toEqual({ a: "x { y" });
    expect(extractJson("[1,2]")).toBeNull();
    expect(extractJson(null)).toBeNull();
  });
});

describe("default exits (the model leaves them out at random)", () => {
  it("a buy strategy with no exit gets the defaults and a warning; 'hold' keeps it exit-less; sells and schedules are untouched", async () => {
    const { withDefaultExits, DEFAULT_EXITS } = await import("./compile");
    const { TEMPLATES } = await import("./templates");
    const base = structuredClone(TEMPLATES.find((t) => t.id === "smart-money-confluence")!.strategy) as any;
    delete base.exits;
    const a = withDefaultExits(base, "Buy $15 when 3 smart traders buy the same token");
    expect(a.added).toBe(true);
    expect(a.strategy.exits).toMatchObject(DEFAULT_EXITS);
    expect(withDefaultExits(base, "Buy $15 when 3 smart traders buy, hold forever").added).toBe(false);
    expect(withDefaultExits({ ...base, action: { type: "alert" } }, "alert me").added).toBe(false);
    const withSl = { ...base, exits: { stopLossPct: 10 } };
    expect(withDefaultExits(withSl, "buy with a 10% stop").strategy.exits).toEqual({ stopLossPct: 10 });
  });
});
