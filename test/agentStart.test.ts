import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { useTempDb } from "../src/bots/_testkit";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("../src/bots");
const { botTools } = await import("../src/botTools");
const { ToolInputError } = await import("../src/types");
beforeAll(() => { E._resetBots(); tmp = useTempDb("agent-start"); });
afterAll(() => { E._resetBots(); tmp.restore(); });
const create = botTools.find((t) => t.name === "agent_create")!;

describe("starting an agent from Ask needs the person's words", () => {
  it("'build … then backtest it' does not start one; 'start it' and a short yes do", async () => {
    const s = "sess-start-test-1";
    const e = await create.run({ template_id: "dca" }, { session: s, question: "Build me an agent that buys when 3 smart traders buy the same token, then backtest it" }).catch((x) => x);
    expect(e).toBeInstanceOf(ToolInputError);
    expect(E.listBots(s)).toHaveLength(0);
    await create.run({ template_id: "dca" }, { session: s, question: "Looks good, start it in paper" });
    await create.run({ template_id: "dca", name: "Second" }, { session: s, question: "yes" });
    expect(E.listBots(s)).toHaveLength(2);
  });
});
