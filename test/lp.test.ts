import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { useTempDb } from "../src/bots/_testkit";
import { amounts, ce, feeShare, inRange, openRange, simulate, valueAt, type Hour } from "../src/lp/sim";
import type { LpPool } from "../src/lp/data";

const H = 3_600_000;
const hours = (prices: number[], vol = 10_000, t0 = 1_800_000_000_000): Hour[] => prices.map((p, i) => ({ t: t0 + i * H, volUsd: vol, sideUsd: p, anchorUsd: 1 }));

describe("LP math", () => {
  it("a range holds exactly the deposit at its centre, all side token below it, all anchor above it", () => {
    expect(ce(null)).toBe(1);
    expect(ce(0.15)).toBeCloseTo(13.7, 1);
    const r = openRange(2, 1000, 0.1);
    expect(valueAt(r, 2)).toBeCloseTo(1000, 6);
    expect(amounts(r, 1).y).toBeCloseTo(0, 9); // below pa: only the side token
    expect(amounts(r, 3).x).toBeCloseTo(0, 9); // above pb: only the anchor
    expect(inRange(r, 2)).toBe(true);
    expect(inRange(r, 2.3)).toBe(false);
    const full = openRange(4, 1000, null);
    expect(valueAt(full, 4)).toBeCloseTo(1000, 6);
    expect(valueAt(full, 16)).toBeCloseTo(2000, 6); // 2·L·√P: price ×4 → value ×2
  });
  it("fee share: value over TVL, scaled by concentration against ±15%, capped at half the pool", () => {
    expect(feeShare(1000, 100_000, 0.15, true)).toBeCloseTo(0.01, 9);
    expect(feeShare(1000, 100_000, 0.05, true)).toBeCloseTo(0.01 * (ce(0.05) / ce(0.15)), 9);
    expect(feeShare(1000, 100_000, null, false)).toBeCloseTo(0.01, 9);
    expect(feeShare(90_000, 100_000, 0.05, true)).toBe(0.5);
  });
  it("a flat price earns fees with no impermanent loss; a move costs IL against HODL", () => {
    const flat = simulate({ hours: hours(Array(24).fill(1)), amountUsd: 1000, preset: "balanced", feeBps: 30, tvlUsd: 100_000, concentrated: true, rebalance: false });
    expect(flat.inRangePct).toBe(100);
    expect(flat.ilUsd).toBeCloseTo(0, 6);
    expect(flat.feesUsd).toBeCloseTo(24 * 10_000 * 0.003 * 0.01, 4); // 24 h × $10k × 0.3% × 1% share
    expect(flat.pnlUsd).toBeCloseTo(flat.feesUsd, 4);
    const up = simulate({ hours: hours([1, 1.05, 1.1]), amountUsd: 1000, preset: "balanced", feeBps: 30, tvlUsd: 100_000, concentrated: true, rebalance: false });
    expect(up.ilUsd).toBeLessThan(0);
    expect(up.lpValueUsd).toBeLessThan(up.hodlUsd);
  });
  it("out of range earns nothing; rebalancing after 6 hours re-centres once and pays the swap", () => {
    const prices = [1, 1, ...Array(10).fill(1.5)];
    const stay = simulate({ hours: hours(prices), amountUsd: 1000, preset: "tight", feeBps: 30, tvlUsd: 100_000, concentrated: true, rebalance: false });
    const moved = simulate({ hours: hours(prices), amountUsd: 1000, preset: "tight", feeBps: 30, tvlUsd: 100_000, concentrated: true, rebalance: true });
    expect(stay.rebalances).toBe(0);
    expect(stay.inRangePct).toBeCloseTo((2 / 12) * 100, 0);
    expect(moved.rebalances).toBe(1);
    expect(moved.feesUsd).toBeGreaterThan(stay.feesUsd); // back in range after re-centring
    expect(moved.range.p0).toBeCloseTo(1.5, 9);
  });
});

let tmp: ReturnType<typeof useTempDb>;
const E = await import("../src/bots");
const S = await import("../src/bots/store");
const { lpStateOf, _closeLpStore } = await import("../src/lp/agent");
const { poolHours } = await import("../src/lp/data");
const { _closeTrustDb } = await import("../src/trust/registry");
const POOL = "0x" + "ab".repeat(20), BAD = "0x" + "cd".repeat(20);
let now = 1_800_000_000_000 + 30 * 60_000;
let series: { hour: number; vol: number; price: number }[] = [];
const mkPool = (address: string, anchorSym: string): LpPool => ({
  pool: address, dex: "uniswap_v3", kind: "clmm", feeBps: 30, tokenSide: 0, tvlUsd: 100_000, vol: { h24: 240_000 }, priceUsd: series.at(-1)?.price,
  token0: { address: "0x" + "11".repeat(20), symbol: "CHOG" }, token1: { address: "0x" + "22".repeat(20), symbol: anchorSym }, hourly: series,
});
beforeAll(() => {
  E._resetBots(); _closeTrustDb(); _closeLpStore(); tmp = useTempDb("lp-agent");
  E._setBotDeps({ lp: { now: () => now, pool: async (a: string) => (a === BAD ? mkPool(BAD, "FOO") : mkPool(POOL, "USDC")), poolHours: (p: LpPool, fromS: number) => poolHours({ ...p, hourly: series }, fromS) } });
});
afterAll(() => { E._resetBots(); _closeLpStore(); _closeTrustDb(); tmp.restore(); });
const settle = () => Bun.sleep(30);

describe("LP agents", () => {
  it("opens in range at the price, accrues fees hour by hour, re-centres after 6 hours out, keeps its state", async () => {
    const h0 = Math.floor(now / 1000 / 3600) * 3600 - 3600;
    series = [{ hour: h0 - 3600, vol: 10_000, price: 1 }, { hour: h0, vol: 10_000, price: 1 }];
    const b = E.createBot("owner-lp-1", { type: "lp", params: { pool: POOL, amountUsd: 1000, preset: "tight" } });
    expect(b.type).toBe("lp");
    await settle();
    let fills = S.fillsOf(b.id).filter((f) => f.status === "filled");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ side: "buy", mint: `lp:${POOL}`, symbol: "CHOG/USDC LP", usd: 1000, quote: { provider: "Chord LP index" } });
    expect(E.getBot(null, b.id)!.bot.name).toBe("LP CHOG/USDC tight");
    // three more hours at the same price: fees only
    series.push(...[1, 2, 3].map((i) => ({ hour: h0 + i * 3600, vol: 10_000, price: 1 })));
    now += 3 * H;
    await E._lps().evaluate(b.id);
    let st = lpStateOf(b.id)!;
    const share = (1000 / 100_000) * (ce(0.05) / ce(0.15));
    expect(st.feesUsd).toBeCloseTo(3 * 10_000 * 0.003 * share, 4);
    let pos = S.positionOf(b.id, `lp:${POOL}`)!;
    expect(pos.priceUsd).toBeCloseTo(1000 + st.feesUsd, 1);
    // the price leaves the ±5% range for 6 hours: one re-centre (a closing fill with PnL, then an opening one)
    series.push(...[4, 5, 6, 7, 8, 9].map((i) => ({ hour: h0 + i * 3600, vol: 10_000, price: 1.2 })));
    now += 6 * H;
    await E._lps().evaluate(b.id);
    fills = S.fillsOf(b.id).filter((f) => f.status === "filled").sort((x, y) => x.ts - y.ts || (x.side === "sell" ? -1 : 1));
    expect(fills.map((f) => f.side)).toEqual(["buy", "sell", "buy"]);
    expect(fills[1].pnlUsd).not.toBeNull();
    st = lpStateOf(b.id)!;
    expect(st.rebalances).toBe(1);
    expect(st.range.p0).toBeCloseTo(1.2, 9);
    expect(st.feesUsd).toBe(0);
    pos = S.positionOf(b.id, `lp:${POOL}`)!;
    expect(pos.costUsd).toBeLessThan(1000 + 50);
    E.deleteBot("owner-lp-1", b.id);
    expect(lpStateOf(b.id)).toBeNull();
  });
  it("a pool this app cannot model stops the agent with the reason", async () => {
    const b = E.createBot("owner-lp-2", { type: "lp", params: { pool: BAD, amountUsd: 500 } });
    await settle();
    const row = E.getBot(null, b.id)!.bot;
    expect(row.status).toBe("error");
    expect(row.error).toContain("not modelled");
    expect(() => E.createBot("owner-lp-2", { type: "lp", params: { pool: "nope" } })).toThrow("pool: a Monad pool address");
    expect(() => E.createBot("owner-lp-2", { type: "lp", params: { pool: POOL, amountUsd: 50 } })).toThrow("amountUsd: 100 to 10,000");
  });
});
