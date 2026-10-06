// Ask tools for the LP agent (src/botTools.ts lp_*) over the fake LP world (src/bots/_lpkit.ts), the agent wording of the
// copy-trading tools, and the router offering lp_* + sol_lp_* to LP questions. Offline: no network.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { addr, useTempDb } from "../src/bots/_testkit";
import { hourly, lpWorld, meteoraPool, safeInfo } from "../src/bots/_lpkit";
import { _resetLpData } from "../src/bots/lpData";
import { SOL_MINT, USDC_MINT } from "../src/bots/market";
import { botTools, BOT_PLAYBOOK, LP_PLAYBOOK } from "../src/botTools";
import { chordTools } from "../src/chord/adapter";
import { pickPlaybook, playbookTools } from "../src/skills";
import { activeTools } from "../src/tools";
import { ToolInputError, type Tool } from "../src/types";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("../src/bots");
beforeAll(() => { E._resetBots(); tmp = useTempDb("lp-tools"); });
afterAll(() => { E._resetBots(); tmp.restore(); });

const NOW = 1_800_000_000_000, NOW_S = NOW / 1000;
const GOOD = addr(601), RUG = addr(602), PUMP = addr(603), BT = addr(604), SHORT = addr(605);
const TG = addr(611), TR = addr(612), TP = addr(613), TB = addr(614), TS = addr(615);
const DLMM = (p: string) => `https://dlmm.datapi.meteora.ag/pools/${p}`;
const wave = (n: number, base: number) => Array.from({ length: n }, (_, i) => base * Math.exp(i % 2 ? 0.01 : 0));
const from168 = NOW_S - 167 * 3600;
const tool = (name: string): Tool => botTools.find((t) => t.name === name)!;
const ctx = { session: "sess-lp-1" };

let w: ReturnType<typeof lpWorld>;
beforeEach(() => {
  _resetLpData();
  w = lpWorld({
    nowMs: NOW,
    pools: [
      { pool: GOOD, dex: "meteora_dlmm", mintA: TG, mintB: USDC_MINT, symbolA: "GOOD", symbolB: "USDC", token: TG, priceUsd: 2, lastHour: { depositsUsd: 5000, withdrawalsUsd: 1000 },
        list: { lps: 120, depositsUsd: 50_000, withdrawalsUsd: 20_000, netFlowUsd: 30_000, feesClaimedUsd: 4000, openPositions: 80 } },
      { pool: RUG, dex: "meteora_dlmm", mintA: TR, mintB: SOL_MINT, symbolA: "RUG", symbolB: "SOL", token: TR, priceUsd: 0.001, lastHour: { depositsUsd: 100, withdrawalsUsd: 5000 }, list: { lps: 300 } },
      { pool: PUMP, dex: "pumpswap", mintA: TP, mintB: SOL_MINT, symbolA: "PUMPY", symbolB: "SOL", token: TP, priceUsd: 0.01, tvlUsd: 80_000, list: { lps: 3 } },
      { pool: BT, dex: "meteora_dlmm", mintA: TB, mintB: USDC_MINT, symbolA: "BT", symbolB: "USDC", token: TB, priceUsd: 1.2 },
      { pool: SHORT, dex: "meteora_dlmm", mintA: TS, mintB: USDC_MINT, symbolA: "NEWT", symbolB: "USDC", token: TS, priceUsd: 1 },
    ],
    candles: {
      [`${TG}@${GOOD}`]: hourly(from168, wave(168, 2)),
      [`${TR}@${RUG}`]: hourly(from168, wave(168, 0.001)),
      [`${TP}@${PUMP}`]: hourly(NOW_S - 4 * 3600, [0.01, 0.011, 0.012, 0.011, 0.01]),
      [SOL_MINT]: hourly(from168, Array(168).fill(150)),
      [`${TB}@${BT}`]: hourly(NOW_S - 24 * 3600, Array.from({ length: 25 }, (_, i) => (i <= 5 ? 1 : 1.2))),
      [`${TS}@${SHORT}`]: hourly(NOW_S - 3600, [1, 1.01]),
    },
    venue: {
      [DLMM(GOOD)]: meteoraPool({ tvl: 500_000, fees24h: 5500, protocol24h: 500, volume24h: 1_800_000, createdAtMs: NOW - 30 * 86_400_000, tokenX: TG }),
      [DLMM(RUG)]: meteoraPool({ tvl: 6000, fees24h: 900, protocol24h: 90, volume24h: 30_000, createdAtMs: NOW - 2 * 3_600_000, tokenX: TR }),
      [DLMM(BT)]: meteoraPool({ tvl: 100_000, fees24h: 1100, protocol24h: 100, volume24h: 1100 / 0.003, createdAtMs: NOW - 30 * 86_400_000, tokenX: TB }),
      [DLMM(SHORT)]: meteoraPool({ tvl: 100_000, fees24h: 1100, protocol24h: 100, volume24h: 1100 / 0.003, createdAtMs: NOW - 30 * 86_400_000, tokenX: TS }),
    },
    prices: { [TG]: 2, [USDC_MINT]: 1, [SOL_MINT]: 150, [TB]: 1.2 },
    info: { [TR]: safeInfo(TR, { mintAuthorityDisabled: false }), [TP]: null },
  });
  E._setBotDeps({ exec: { now: () => w.world.nowMs }, lp: w.deps });
});

describe("lp_scan", () => {
  it("every pool's flags ride in the summary and the data; best is the unflagged pool; table with a Flags column", async () => {
    const t = tool("lp_scan");
    expect(t).toMatchObject({ via: "ext", group: "bots", provider: "Chord · Solana tape + Meteora / Raydium / Jupiter", label: "Scanning Solana LP pools" });
    expect(t.description).toContain("SAY EACH FLAG OF A POOL BEFORE NAMING");
    const r = await t.run({ limit: 3 }, ctx);
    const d = r.data as any;
    expect(d.best).toBe(GOOD);
    expect(d.bestPair).toBe("GOOD-USDC");
    const by = Object.fromEntries(d.rows.map((x: any) => [x.pair, x]));
    expect(by["GOOD-USDC"].flags).toEqual([]);
    expect(by["RUG-SOL"].flags.map((f: any) => f.flag)).toEqual(["thin TVL", "new pool", "LP exodus", "live mint authority"]);
    expect(by["RUG-SOL"].flags[2].why).toMatch(/\$5,000 withdrawn vs \$100 deposited/);
    expect(by["PUMPY-SOL"].flags.map((f: any) => f.flag)).toEqual(["no fee APR", "safety unknown", "short price history"]);
    expect(r.summary).toMatch(/^3 pools, best GOOD-USDC\. Flags: /);
    expect(r.summary).toContain("GOOD-USDC none");
    expect(r.summary).toContain("RUG-SOL thin TVL, new pool, LP exodus, live mint authority");
    expect(r.summary).toContain("PUMPY-SOL no fee APR, safety unknown, short price history");
    expect(d.note).toMatch(/say each of its flags/);
    expect(d.note).toMatch(/ESTIMATE/);
    const v = r.viz![0] as any;
    expect(v.kind).toBe("table");
    expect(v.columns.at(-1)).toBe("Flags");
    expect(v.rows.find((x: any[]) => x[0] === "RUG-SOL").at(-1)).toBe("thin TVL, new pool, LP exodus, live mint authority");
    expect(v.links[0]).toBe(`https://solscan.io/account/${d.rows[0].pool}`);
    expect(r.addresses).toEqual(expect.arrayContaining([GOOD, RUG, PUMP, TG, TR, TP, USDC_MINT, SOL_MINT]));
  });
  it("filters by venue; a bad option is the model's to fix (ToolInputError)", async () => {
    const r = await tool("lp_scan").run({ dex: "pumpswap" }, ctx);
    expect((r.data as any).best).toBeNull();
    expect(r.summary).toMatch(/^1 pool, every pool flagged\. Flags: PUMPY-SOL /);
    const e = await tool("lp_scan").run({ dex: "orca" }, ctx).catch((x) => x);
    expect(e).toBeInstanceOf(ToolInputError);
    expect(e.message).toMatch(/dex must be/);
  });
});

describe("lp_range", () => {
  it("tight / balanced / wide in a table with bins; the summary names the balanced band", async () => {
    const r = await tool("lp_range").run({ pool: GOOD }, ctx);
    const d = r.data as any;
    expect(d.presets.map((p: any) => p.preset)).toEqual(["tight", "balanced", "wide"]);
    expect(d.note).toMatch(/past volatility, not a forecast/);
    expect(r.summary).toMatch(/^GOOD-USDC at 2: balanced 1\.\d+ to 2\.\d+, 100% of past windows in range$/);
    const v = r.viz![0] as any;
    expect(v.title).toBe("Range presets · GOOD-USDC · 24 h");
    expect(v.columns).toEqual(["Preset", "Lower", "Upper", "Lower USD", "Upper USD", "Down", "Up", "Time in range", "Bins"]);
    expect(v.rows.map((x: any[]) => x[0])).toEqual(["tight", "balanced", "wide"]);
    expect(r.addresses).toEqual([GOOD, TG, USDC_MINT]);
  });
  it("a full-range venue has nothing to set; an unknown pool or a bad horizon is a ToolInputError named with this tool's arguments", async () => {
    const r = await tool("lp_range").run({ pool: PUMP }, ctx);
    expect(r.summary).toBe("PUMPY-SOL: full range (no range to set)");
    expect(r.viz).toEqual([]);
    await expect(tool("lp_range").run({ pool: addr(699) }, ctx)).rejects.toThrow(ToolInputError);
    const e = await tool("lp_range").run({ pool: GOOD, hours: 500 }, ctx).catch((x) => x);
    expect(e).toBeInstanceOf(ToolInputError);
    expect(e.message).toMatch(/^hours must be between 1 and 168/);
  });
});

describe("lp_backtest", () => {
  it("LP vs HODL vs all in the quote token as a line chart from the equity (ms timestamps); fees said to be an estimate", async () => {
    const t = tool("lp_backtest");
    expect(t.label).toBe("Backtesting the LP agent");
    const r = await t.run({ pool: BT, amount_usd: 1000, range_pct: 10, days: 1 }, ctx);
    const d = r.data as any;
    expect(d).toMatchObject({ pool: BT, pair: "BT-USDC", days: 1, rebalances: 1, equityPoints: 25 });
    expect(d.equity).toBeUndefined();
    expect(d.note).toMatch(/ESTIMATE/);
    expect(d.note).toMatch(/impermanent loss/);
    expect(r.summary).toMatch(/^BT-USDC 1d: LP \$1,031 vs HODL \$1,095, fees \$9\.\d+ \(estimate\), IL .*1 rebalance$/);
    const v = r.viz![0] as any;
    expect(v).toMatchObject({ kind: "line", title: "LP vs HODL · BT-USDC · 1d", unit: "usd" });
    expect(v.series.map((s: any) => s.name)).toEqual(["LP", "HODL", "All in USDC"]);
    expect(v.series[0].values.length).toBe(25);
    expect(v.series[0].values[0]).toBe(1000);
    expect(v.series[2].values.every((x: number) => x === 1000)).toBe(true);
    expect(v.x[0]).toBe(new Date((NOW_S - 24 * 3600) * 1000).toISOString().slice(5, 16).replace("T", " "));
  });
  it("fewer than 3 hourly prices: history is too short (ToolInputError), never a bare failure", async () => {
    const e = await tool("lp_backtest").run({ pool: SHORT, amount_usd: 500, range_pct: 5, days: 1 }, ctx).catch((x) => x);
    expect(e).toBeInstanceOf(ToolInputError);
    expect(e.message).toMatch(/^History is too short to backtest: only 2 hourly prices for NEWT-USDC .*Try days 7, or another pool from lp_scan\.$/);
  });
  it("engine input errors name this tool's arguments", async () => {
    const e = await tool("lp_backtest").run({ pool: BT, amount_usd: 1000, range_pct: 10, preset: "wide", days: 1 }, ctx).catch((x) => x);
    expect(e).toBeInstanceOf(ToolInputError);
    expect(e.message).toBe("give preset or range_pct, not both");
    const e2 = await tool("lp_backtest").run({ pool: BT, amount_usd: 5 }, ctx).catch((x) => x);
    expect(e2.message).toMatch(/^amount_usd must be between 10 and 10000/);
    const e3 = await tool("lp_backtest").run({ pool: BT, amount_usd: 100, token_drop_pct: 2 }, ctx).catch((x) => x);
    expect(e3.message).toMatch(/^token_drop_pct must be between 5 and 95/);
  });
});

describe("lp_agent_create", () => {
  it("starts a PAPER LP agent for the asking session; the open lands in the engine", async () => {
    const t = tool("lp_agent_create");
    expect(t).toMatchObject({ provider: "Agents", label: "Starting the paper LP agent" });
    await expect(t.run({ pool: BT, amount_usd: 500, range_pct: 10 }, {})).rejects.toThrow("agents need a session");
    const r = await t.run({ pool: BT, amount_usd: 500, range_pct: 10, max_rebalances_per_day: 2, lp_exodus: false, token_drop_pct: 30 }, ctx);
    const a = (r.data as any).agent;
    expect(a).toMatchObject({ type: "lp", mode: "paper", status: "running", params: { pool: BT, amountUsd: 500, rangePct: 10, preset: null, rebalance: { maxPerDay: 2, outOfRangeMinutes: 30 }, exits: { lpExodus: false, tokenDropPct: 30 } } });
    expect(r.summary).toMatch(/started \(paper\)$/);
    expect(r.addresses).toEqual([BT]);
    await E._drain();
    const v = E.getBot(ctx.session, a.id)!;
    expect(v.lp!.state).toMatchObject({ status: "open", pair: "BT-USDC" });
    // agent_status hands the model the LP state with a short tail of chart points
    const s = await tool("agent_status").run({ id: a.id }, ctx);
    expect((s.data as any).lp.state.status).toBe("open");
    expect((s.data as any).lp.points.length).toBeLessThanOrEqual(24);
    // an input error or the per-person limit is the model's to read, not a failure
    await expect(t.run({ pool: BT, amount_usd: 500, preset: "tight", range_pct: 3 }, ctx)).rejects.toThrow("give preset or range_pct, not both");
    for (let i = 0; i < 4; i++) await t.run({ pool: BT, amount_usd: 100, range_pct: 10 }, ctx);
    const e = await t.run({ pool: BT, amount_usd: 100, range_pct: 10 }, ctx).catch((x) => x);
    expect(e).toBeInstanceOf(ToolInputError);
    expect(e.message).toMatch(/^at most 5 /);
    await E._drain();
  });
});

describe("agent wording", () => {
  it("labels, providers and descriptions say agent, never bot (tool names agent_*); no em dashes", () => {
    for (const t of botTools) {
      expect(`${t.label} ${t.provider} ${t.description}`).not.toMatch(/\bbots?\b/i);
      expect(`${t.label} ${t.description}`).not.toContain("—");
    }
    expect(botTools.map((t) => t.name)).toEqual(["agent_traders", "agent_backtest", "agent_create", "agent_list", "agent_status", "agent_pause", "agent_resume", "agent_templates", "agent_build", "agent_backtest_strategy", "lp_scan", "lp_range", "lp_backtest", "lp_agent_create"]);
    expect(tool("agent_create").label).toBe("Starting the paper agent");
    expect(BOT_PLAYBOOK.replace("Call them agents, not bots.", "")).not.toMatch(/\bbots?\b/i);
    expect(LP_PLAYBOOK).toMatch(/lp_scan, lp_range and lp_backtest FIRST/);
    expect(LP_PLAYBOOK).toMatch(/ESTIMATE/);
    expect(LP_PLAYBOOK).toMatch(/impermanent loss/);
    expect(LP_PLAYBOOK).toMatch(/PAPER mode only/);
  });
});

describe("router", () => {
  const names = new Set(activeTools().map((t) => t.name));
  it("LP questions get the LP playbook with lp_* and sol_lp_* offered; sol_lp_* are no longer 'not in this app'", () => {
    for (const q of ["where do LPs earn fees on Solana?", "best DLMM pools to provide liquidity", "what range should I set for this pool?", "backtest an LP agent on that pool", "how is my LP agent doing?", "who is pulling liquidity from this pool?"]) {
      const b = pickPlaybook(q, [], names)!;
      expect(b.id).toBe("lp");
      const offered = playbookTools(b);
      for (const n of ["lp_scan", "lp_range", "lp_backtest", "lp_agent_create", "sol_lp_pools", "sol_lp_pool", "sol_lp_wallet", "sol_lp_top", "lp_pools", "agent_status"]) expect(offered).toContain(n);
      expect(b.playbook).toContain("PLAYBOOK — LP agent");
      expect(b.playbook).toContain("Solana LP (Meteora DLMM / DAMM v2, Raydium CLMM, PumpSwap), when sol_lp_* is in your list");
      expect(b.playbook.match(/Not in this app[^\n]*/)?.[0] ?? "").not.toMatch(/sol_lp_|lp_scan|lp_range|lp_backtest|lp_agent_create/);
    }
  });
  it("a yield question keeps Chord's LP playbook without the agent; a short follow-up of an LP question keeps the agent", () => {
    const y = pickPlaybook("best USDC APY on Base", [], names)!;
    expect(y.id).toBe("lp");
    expect(y.tools).not.toContain("lp_scan");
    expect(y.tools).toContain("sol_lp_pools");
    const f = pickPlaybook("and over 7 days?", [{ role: "user", content: "backtest an LP on the GOOD pool" }], names)!;
    expect(f.id).toBe("lp");
    expect(f.tools).toContain("lp_backtest");
  });
  it("agents vs tokens vs liquidity depth", () => {
    expect(pickPlaybook("how is my agent doing?", [], names)?.id).toBe("bots");
    expect(pickPlaybook("copy the top 3 smart traders", [], names)?.id).toBe("bots");
    expect(pickPlaybook("AI agent tokens on virtuals trending", [], names)?.id).toBe("dex");
    expect(pickPlaybook("what is the liquidity of BONK?", [], names)?.id).not.toBe("lp");
    // without the LP agent on this server the LP words fall through to Chord's router
    const noAgent = new Set([...names].filter((n) => n !== "lp_scan"));
    expect(pickPlaybook("best DLMM pools to provide liquidity", [], noAgent)?.tools).not.toContain("lp_scan");
  });
  it("Chord's Solana LP tools are labeled as Chord's Solana tape, not Jupiter", () => {
    const t = chordTools().filter((x) => x.name.startsWith("sol_lp_"));
    expect(t.map((x) => x.name).sort()).toEqual(["sol_lp_pool", "sol_lp_pools", "sol_lp_top", "sol_lp_wallet"]);
    for (const x of t) expect(x.provider).toBe("Chord · Solana tape");
  });
});
