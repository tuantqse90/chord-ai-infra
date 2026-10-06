import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { addr, useTempDb } from "./_testkit";
import { lpWorld, meteoraPool, safeInfo } from "./_lpkit";
import { USDC_MINT } from "./market";
import { validateLpParams } from "./validate";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("./index");
beforeAll(() => { E._resetBots(); tmp = useTempDb("bots-lp"); });
afterAll(() => { E._resetBots(); tmp.restore(); });

const T0 = 1_800_000_000_000;
const PL = addr(401), TL = addr(411);
const YEAR = 365 * 86_400_000;
let w: ReturnType<typeof lpWorld>;
beforeEach(() => {
  w = lpWorld({
    nowMs: T0,
    pools: [{ pool: PL, dex: "meteora_dlmm", mintA: TL, mintB: USDC_MINT, symbolA: "LPT", symbolB: "USDC", token: TL, priceUsd: 1, lastHour: { depositsUsd: 3000, withdrawalsUsd: 500 } }],
    venue: { [`https://dlmm.datapi.meteora.ag/pools/${PL}`]: meteoraPool({ tvl: 100_000, fees24h: 1100, protocol24h: 100, volume24h: 1100 / 0.003, createdAtMs: T0 - 30 * 86_400_000, tokenX: TL }) },
    prices: { [TL]: 1, [USDC_MINT]: 1 },
  });
  E._setBotDeps({ exec: { now: () => w.world.nowMs }, lp: w.deps });
});

const minute = async (n = 1) => { for (let i = 0; i < n; i++) { w.world.nowMs += 60_000; await E._lpTick(); } };
const lp = (owner: string, params: Record<string, unknown>, name?: string) => E.createBot(owner, { type: "lp", name, params: { pool: PL, amountUsd: 1000, rangePct: 10, ...params } });
const view = (owner: string, id: string) => E.getBot(owner, id)!;

describe("LP params", () => {
  it("fills defaults (balanced preset, 30 min / 4 a day, exodus exit on, safety on) and refuses bad input", () => {
    expect(validateLpParams({ pool: PL, amountUsd: "250" })).toEqual({
      pool: PL, amountUsd: 250, preset: "balanced", rangePct: null, rebalance: { outOfRangeMinutes: 30, maxPerDay: 4 },
      exits: { lpExodus: true, tokenDropPct: null, dailyLossStopUsd: null }, safety: true,
    });
    expect(validateLpParams({ pool: PL, amountUsd: 10_000, rangePct: 5, rebalance: { maxPerDay: 0 }, exits: { lpExodus: false, tokenDropPct: 30, dailyLossStopUsd: 50 }, safety: false }))
      .toMatchObject({ preset: null, rangePct: 5, rebalance: { outOfRangeMinutes: 30, maxPerDay: 0 }, exits: { lpExodus: false, tokenDropPct: 30, dailyLossStopUsd: 50 }, safety: false });
    const bad: [unknown, RegExp][] = [
      [{ amountUsd: 100 }, /pool is required/],
      [{ pool: "0xabc", amountUsd: 100 }, /not a Solana address/],
      [{ pool: PL }, /amountUsd is required/],
      [{ pool: PL, amountUsd: 9 }, /amountUsd must be between 10 and 10000/],
      [{ pool: PL, amountUsd: 100, preset: "medium" }, /preset must be "tight", "balanced" or "wide"/],
      [{ pool: PL, amountUsd: 100, preset: "tight", rangePct: 5 }, /preset or rangePct, not both/],
      [{ pool: PL, amountUsd: 100, rangePct: 95 }, /rangePct must be between 1 and 90/],
      [{ pool: PL, amountUsd: 100, rebalance: { outOfRangeMinutes: 1 } }, /rebalance.outOfRangeMinutes must be between 5 and 1440/],
      [{ pool: PL, amountUsd: 100, rebalance: { every: 1 } }, /unknown rebalance field "every"/],
      [{ pool: PL, amountUsd: 100, exits: { tokenDropPct: 2 } }, /exits.tokenDropPct must be between 5 and 95/],
      [{ pool: PL, amountUsd: 100, exits: { dailyLossStopUsd: -1 } }, /exits.dailyLossStopUsd must be more than 0/],
      [{ pool: PL, amountUsd: 100, wallets: [] }, /unknown lp params field "wallets"/],
    ];
    for (const [input, msg] of bad) expect(() => validateLpParams(input)).toThrow(msg);
    expect(() => E.createBot("o-v", { type: "lp", params: { pool: PL } })).toThrow(E.BotInputError);
  });
});

describe("paper LP bot", () => {
  it("opens at Jupiter's price, accrues fees in range, rebalances after 30 min out, exits on an LP exodus, re-enters on resume", async () => {
    const b = lp("o-lp", {});
    await E._drain();
    let d = view("o-lp", b.id);
    expect(d.bot).toMatchObject({ type: "lp", status: "running", name: "LP LPT-USDC ±10%" });
    expect(d.fills[0]).toMatchObject({ kind: "open", side: "buy", status: "filled", usd: 1000, mint: PL, symbol: "LPT-USDC", priceUsd: 1, pnlUsd: null, mode: "paper" });
    expect(d.fills[0].source.via).toBe("lp");
    expect(d.positions).toEqual([expect.objectContaining({ mint: PL, symbol: "LPT-USDC LP", qty: 1000, costUsd: 1000, priceUsd: 1, valueUsd: 1000, pnlUsd: 0 })]);
    expect(d.lp!.state).toMatchObject({ status: "open", pair: "LPT-USDC", venue: "Meteora DLMM", inRange: true, feeApr: { pct: 365 }, range: { lower: 0.9, upper: expect.closeTo(1.1, 9), full: false, rangePct: 10 } });
    expect(d.lp!.points.length).toBe(1);
    expect(d.events[0].msg).toMatch(/Opened a paper LP position: \$1,000 in LPT-USDC \(Meteora DLMM\).*Fee APR 365%/);

    // 10 minutes in range at fee APR 365 %: 10 × $1000 × 3.65 × 1 min / 1 year
    await minute(10);
    d = view("o-lp", b.id);
    const fees10 = 10 * 1000 * 3.65 * 60_000 / YEAR;
    expect(d.lp!.state!.leg!.feesUsd).toBeCloseTo(fees10, 6);
    expect(d.lp!.state!.timeInRangeMs).toBe(600_000);
    expect(d.positions[0].valueUsd!).toBeCloseTo(1000 + fees10, 6);
    expect(d.bot.stats).toMatchObject({ trades: 1, buys: 1, investedUsd: 1000, unrealizedUsd: 0.07, openPositions: 1 });
    expect(d.lp!.points.length).toBe(2);

    // the price leaves the range: an event, no rebalance before 30 minutes
    w.world.prices[TL] = 1.2;
    await minute();
    d = view("o-lp", b.id);
    expect(d.lp!.state!.inRange).toBe(false);
    expect(d.events[0]).toMatchObject({ level: "warn" });
    expect(d.events[0].msg).toMatch(/Out of range: LPT-USDC at 1\.2 is above 1\.1; no fees while out\. Rebalance if it stays out 30 min/);
    // value is now all USDC: L (√1.1 − √0.9) = 1023.21
    expect(d.lp!.state!.mark!.valueUsd).toBeCloseTo(1023.21, 1);
    w.world.nowMs += 28 * 60_000;
    await minute();
    expect(view("o-lp", b.id).lp!.state!.rebalances).toBe(0);
    await minute();
    d = view("o-lp", b.id);
    const st = d.lp!.state!;
    expect(st.rebalances).toBe(1);
    expect(st.range).toMatchObject({ lower: expect.closeTo(1.08, 9), upper: expect.closeTo(1.32, 9) });
    expect(st.inRange).toBe(true);
    const rb = d.fills[0];
    expect(rb).toMatchObject({ kind: "rebalance", side: "sell", status: "filled", quote: { provider: "Jupiter", priceImpactPct: 0.2 } });
    // the swap: 47.56 % of what came out, quoted 0.2 % worse than the mid
    expect(st.rebalanceCostUsd).toBeCloseTo(rb.usd * 0.475577 * 0.002, 3);
    expect(rb.pnlUsd!).toBeCloseTo(rb.usd - st.rebalanceCostUsd - 1000, 6);
    expect(w.world.calls.some((c) => c.startsWith(`quote ${USDC_MINT}>${TL} `))).toBe(true);
    expect(d.positions[0]).toMatchObject({ qty: expect.closeTo(rb.usd - st.rebalanceCostUsd, 6), priceUsd: 1 });
    expect(d.events[0].msg).toMatch(/^Rebalanced \(1 of 4 today\): the price sat above/);

    // an LP exodus on Chord's tape: exit at the next 5-minute check, the bot stops
    w.world.pools[0].lastHour = { depositsUsd: 100, withdrawalsUsd: 20_000 };
    await minute(5);
    d = view("o-lp", b.id);
    expect(d.bot.status).toBe("stopped");
    expect(d.fills[0]).toMatchObject({ kind: "close", side: "sell", status: "filled" });
    expect(d.fills[0].reason).toMatch(/^Exit, LP exodus: \$20,000 withdrawn vs \$100 deposited in the last hour/);
    expect(d.positions).toEqual([]);
    expect(d.lp!.state).toMatchObject({ status: "closed" });
    expect(d.events[0].msg).toMatch(/^Exited: LP exodus.*The bot stopped; resume it to re-enter with \$1,000/);
    expect(d.bot.stats).toMatchObject({ trades: 3, buys: 1, sells: 2, openPositions: 0, unrealizedUsd: 0 });
    expect(d.bot.stats.realizedUsd).toBeCloseTo(d.fills[0].pnlUsd! + rb.pnlUsd!, 1);
    // a stopped bot is not ticked
    const n = E.getBot("o-lp", b.id)!.fills.length;
    await minute(3);
    expect(view("o-lp", b.id).fills.length).toBe(n);

    // resume = re-enter with the same deposit
    w.world.pools[0].lastHour = { depositsUsd: 100, withdrawalsUsd: 0 };
    expect(E.setStatus("o-lp", b.id, "running")!.status).toBe("running");
    await E._drain();
    d = view("o-lp", b.id);
    expect(d.fills[0]).toMatchObject({ kind: "open", usd: 1000, priceUsd: 1.2 });
    expect(d.bot.stats.investedUsd).toBe(2000);
    expect(d.lp!.state!.range).toMatchObject({ lower: expect.closeTo(1.08, 9), upper: expect.closeTo(1.32, 9) });
    expect(d.events.map((e) => e.msg)).toContain("Resumed: re-entering the pool with $1000.");
  });

  it("a paused bot's position is still marked but never rebalanced; maxPerDay caps rebalances", async () => {
    const p = lp("o-pause", {});
    await E._drain();
    E.setStatus("o-pause", p.id, "paused");
    expect(view("o-pause", p.id).events[0].msg).toMatch(/^Paused: the LP position stays in the pool and is still marked/);
    w.world.prices[TL] = 1.2;
    await minute(40);
    let d = view("o-pause", p.id);
    expect(d.lp!.state).toMatchObject({ inRange: false, rebalances: 0 });
    expect(d.lp!.state!.mark!.valueUsd).toBeCloseTo(1023.21, 1);
    expect(d.events.some((e) => /The bot is paused: no rebalance/.test(e.msg))).toBe(true);
    E.setStatus("o-pause", p.id, "running");
    expect(view("o-pause", p.id).events[0].msg).toBe("Resumed: the agent manages the LP position again.");

    w.world.prices[TL] = 1;
    const c = lp("o-cap", { rebalance: { maxPerDay: 1 } });
    await E._drain();
    w.world.prices[TL] = 1.2;
    await minute(31);
    expect(view("o-cap", c.id).lp!.state!.rebalances).toBe(1);
    w.world.prices[TL] = 1.5;
    await minute(40);
    d = view("o-cap", c.id);
    expect(d.lp!.state).toMatchObject({ rebalances: 1, inRange: false });
    expect(d.events.some((e) => /the 1 rebalances of today \(UTC\) are used/.test(e.msg))).toBe(true);
  });

  it("exits on a token drop and on the daily loss stop", async () => {
    const a = lp("o-drop", { exits: { tokenDropPct: 20 } });
    await E._drain();
    w.world.prices[TL] = 0.75;
    await minute();
    let d = view("o-drop", a.id);
    expect(d.bot.status).toBe("stopped");
    expect(d.fills[0].reason).toMatch(/^Exit, token drop: LPT is down 25\.0% from the open \(stop at 20%\)/);

    w.world.prices[TL] = 1;
    const s = lp("o-loss", { exits: { dailyLossStopUsd: 5, lpExodus: false } });
    await E._drain();
    w.world.prices[TL] = 0.9; // the lower edge: value = L (1/√0.9 − 1/√1.1) × 0.9 = 925.5
    await minute();
    d = view("o-loss", s.id);
    expect(d.bot.status).toBe("stopped");
    expect(d.fills[0].reason).toMatch(/^Exit, daily loss stop: today's loss \$74\.\d+ reached the \$5 stop/);
    expect(d.fills[0].pnlUsd!).toBeCloseTo(925.53 - 1000, 0);
  });

  it("refuses an unsafe token or an unknown pool, without a fill", async () => {
    w.world.info[TL] = safeInfo(TL, { mintAuthorityDisabled: false });
    const a = lp("o-safe", {});
    await E._drain();
    let d = view("o-safe", a.id);
    expect(d.bot.status).toBe("stopped");
    expect(d.bot.error).toMatch(/live mint authority/);
    expect(d.lp!.state).toMatchObject({ status: "closed", closeReason: expect.stringMatching(/^Not opened, safety: LPT still has a live mint authority/) });
    expect(d.fills).toEqual([]);
    expect(d.positions).toEqual([]);

    const u = E.createBot("o-unknown", { type: "lp", params: { pool: addr(499), amountUsd: 100, rangePct: 5 } });
    await E._drain();
    d = view("o-unknown", u.id);
    expect(d.bot.status).toBe("stopped");
    expect(d.events[0].msg).toMatch(/Cannot open: pool .* is not on Chord's Solana LP tape/);
  });

  it("LP positions stay out of the copy bots' marking and the copy leaderboard; delete removes the LP state", async () => {
    const b = lp("o-del", {});
    await E._drain();
    await E._markTick();
    expect(view("o-del", b.id).positions[0].priceUsd).toBe(1);
    expect(E.leaderboard(500).some((x) => x.id === b.id)).toBe(false);
    expect(E.deleteBot("o-del", b.id)).toBe(true);
    expect(E.getBot(null, b.id)).toBeNull();
    await minute();
  });
});
