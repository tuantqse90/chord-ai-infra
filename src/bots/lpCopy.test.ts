import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { addr, useTempDb } from "./_testkit";
import { hourly, lpWorld, meteoraPool, tapeEv, tapePos, type FakePool } from "./_lpkit";
import { _resetLpCopy, copyRange, judge, lpCopyBacktest, rangeWords, seeded, smartLps, toMoves } from "./lpCopy";
import { _resetLpData } from "./lpData";
import { SOL_MINT, USDC_MINT } from "./market";
import { validateLpCopyParams, validateParams } from "./validate";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("./index");
beforeAll(() => { E._resetBots(); tmp = useTempDb("bots-lpcopy"); });
afterAll(() => { E._resetBots(); tmp.restore(); });

const NOW = 1_800_000_000_000, NOW_S = NOW / 1000;            // an hour boundary
const COVER_S = NOW_S - 6 * 3600;                               // Chord's LP tape started 6 hours ago
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const P1 = addr(501), P2 = addr(502), P3 = addr(503), P4 = addr(504), P5 = addr(505);
const T1 = addr(511), T2 = addr(512), T3 = addr(513), T4 = addr(514);
const WL = addr(521), WX = addr(522);
const W = { good: addr(531), ok: addr(532), trap: addr(533), launch: addr(534), vault: addr(535), one: addr(536), small: addr(537), few: addr(538) };
const DLMM = (p: string) => `https://dlmm.datapi.meteora.ag/pools/${p}`;
const top = (wallet: string, o: Partial<{ positions: number; pools: number; dep: number; wd: number; fees: number; pnl: number | null; rp: number; wr: number | null }>) => ({
  wallet, positions: o.positions ?? 4, open: 1, pools: o.pools ?? 2, depositedUsd: o.dep ?? 10_000, withdrawnUsd: o.wd ?? 0, feesClaimedUsd: o.fees ?? 0,
  realizedPnlUsd: o.pnl ?? null, realizedPositions: o.rp ?? 0, winRate: o.wr ?? null,
});

function world() {
  const pools: FakePool[] = [
    { pool: P1, dex: "meteora_dlmm", mintA: T1, mintB: USDC_MINT, symbolA: "TOK", symbolB: "USDC", token: T1, priceUsd: 1 },
    { pool: P2, dex: "meteora_damm_v2", mintA: T2, mintB: SOL_MINT, symbolA: "TWO", symbolB: "SOL", token: T2, priceUsd: 2 },
    { pool: P3, dex: "meteora_dlmm", mintA: T3, mintB: USDC_MINT, symbolA: "THIN", symbolB: "USDC", token: T3, priceUsd: 1 },
    { pool: P4, dex: "pumpswap", mintA: T4, mintB: SOL_MINT, symbolA: "PUMP", symbolB: "SOL", token: T4, priceUsd: 0.01, tvlUsd: 80_000 },
  ];
  const w = lpWorld({
    nowMs: NOW, since: COVER_S, pools,
    venue: {
      [DLMM(P1)]: meteoraPool({ tvl: 100_000, fees24h: 1100, protocol24h: 100, volume24h: 1100 / 0.003, createdAtMs: NOW - 30 * 86_400_000, tokenX: T1 }),
      [`https://damm-v2.datapi.meteora.ag/pools/${P2}`]: meteoraPool({ tvl: 300_000, fees24h: 1000, protocol24h: 0, volume24h: 400_000, createdAtMs: NOW - 9 * 86_400_000, tokenX: T2 }),
      [DLMM(P3)]: meteoraPool({ tvl: 10_000, fees24h: 100, protocol24h: 0, volume24h: 30_000, createdAtMs: NOW - 9 * 86_400_000, tokenX: T3 }),
    },
    prices: { [T1]: 1, [T2]: 2, [T3]: 1, [T4]: 0.01, [USDC_MINT]: 1, [SOL_MINT]: 150 },
  });
  return w;
}

describe("ranges", () => {
  const info = { dex: "meteora_dlmm", venue: "Meteora DLMM", fullRange: false, token: T1, mintA: T1, decimalsA: 6, decimalsB: 9 };
  it("DLMM bins → quote-per-token prices through the decimals and bin step; inverted when the token is side B", () => {
    // CHONK-SOL on 06/10: bins −523…−476, bin step 100, decimals 6 / 9 → 5.49e-6 … 8.87e-6 SOL per CHONK (Meteora showed 5.44e-6)
    const r = copyRange(info, 100, -523, -476) as { r: { lower: number; upper: number }; full: boolean };
    expect(r.full).toBe(false);
    expect(r.r.lower).toBeCloseTo(1.01 ** -523 * 1e-3, 12);
    expect(r.r.upper).toBeCloseTo(1.01 ** -475 * 1e-3, 12);
    expect(r.r.lower).toBeCloseTo(5.49e-6, 7);
    const inv = copyRange({ ...info, token: "other" }, 100, -523, -476) as { r: { lower: number; upper: number } };
    expect(inv.r.lower).toBeCloseTo(1 / r.r.upper, 3);
    expect(inv.r.upper).toBeCloseTo(1 / r.r.lower, 3);
    const clmm = copyRange({ ...info, dex: "raydium_clmm", decimalsB: 6 }, null, -100, 200) as { r: { lower: number; upper: number } };
    expect(clmm.r.lower).toBeCloseTo(1.0001 ** -100, 9);
    expect(clmm.r.upper).toBeCloseTo(1.0001 ** 200, 9);
  });
  it("full range on PumpSwap / DAMM v2; unknown bounds, bin step or decimals say why", () => {
    expect(copyRange({ ...info, dex: "pumpswap", fullRange: true }, null, null, null)).toMatchObject({ full: true });
    expect(copyRange(info, 100, null, null)).toEqual({ why: "the wallet's range is not on Chord's tape" });
    expect(copyRange(info, null, 1, 2)).toEqual({ why: "the pool's bin step is unknown (Meteora's API did not answer)" });
    expect(copyRange({ ...info, decimalsA: null }, 100, 1, 2)).toEqual({ why: "the pool's token decimals are unknown" });
  });
  it("words: around the price, or single-sided", () => {
    expect(rangeWords(1, { lower: 0.7, upper: 1.45 }, false)).toBe("−30% / +45%");
    expect(rangeWords(1, { lower: 1.05, upper: 1.4 }, false)).toBe("+5.0% / +40%, all above the price (token only)");
    expect(rangeWords(1, { lower: 0.5, upper: 0.9 }, false)).toBe("−50% / −10%, all below the price (quote only)");
    expect(rangeWords(1, { lower: 0, upper: Infinity }, true)).toBe("full range");
  });
  it("moves group a transaction's events per position, oldest first", () => {
    const m = toMoves(WL, [
      tapeEv({ ts: 20, sig: "s2", kind: "remove", pool: P1, position: "x1", usd: 300 }), tapeEv({ ts: 20, sig: "s2", kind: "close", pool: P1, position: "x1" }),
      tapeEv({ ts: 10, sig: "s1", kind: "open", pool: P1, position: "x1", lower: -5, upper: 5 }), tapeEv({ ts: 10, sig: "s1", kind: "add", pool: P1, position: "x1", usd: 1000, lower: -5, upper: 5 }),
    ] as any);
    expect(m.map((x) => [x.signature, x.kinds.sort().join("+"), x.addUsd, x.removeUsd, x.lower, x.upper])).toEqual([["s1", "add+open", 1000, null, -5, 5], ["s2", "close+remove", null, 300, null, null]]);
  });
  it("a pool seed = two sides, both round or one a launchpad's whole supply (measured on the 07/10 board's top 3)", () => {
    expect(seeded({ depositedA: 20, depositedB: 1_000_000_000 })).toBe(true);
    expect(seeded({ depositedA: 20.01, depositedB: 1_000_000_000 })).toBe(true);
    expect(seeded({ depositedA: 84.99, depositedB: 1_000_000_000 })).toBe(true);
    expect(seeded({ depositedA: 136.382987018, depositedB: 146_645_863.43 })).toBe(false);
    expect(seeded({ depositedA: 10, depositedB: 70_141.608063 })).toBe(false);     // a round SOL amount, the token side from the pool's ratio
    expect(seeded({ depositedA: 0, depositedB: 1_000_000_000 })).toBe(false);      // single-sided
    expect(seeded({ depositedA: 0, depositedB: 85 })).toBe(false);
  });
});

describe("smart-LP board", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    _resetLpCopy(); _resetLpData();
    w = world();
    const t0 = COVER_S + 600;
    const pos = (o: Parameters<typeof tapePos>[0]) => tapePos(o);
    w.world.walletPositions = {
      // 2 closed (+10 %, +4 %), 2 open earning 2 % in claimed fees, 3 pools
      [W.good]: [
        pos({ position: "g1", pool: P1, openedAt: t0, closedAt: t0 + 3600, depositedUsd: 5000, withdrawnUsd: 5400, feesUsd: 100 }),
        pos({ position: "g2", pool: P2, openedAt: t0, closedAt: t0 + 7200, depositedUsd: 5000, withdrawnUsd: 5150, feesUsd: 50 }),
        pos({ position: "g3", pool: P3, openedAt: t0 + 100, depositedUsd: 5000, feesUsd: 100 }),
        pos({ position: "g4", pool: P1, openedAt: t0 + 200, depositedUsd: 5000, feesUsd: 100 }),
        pos({ position: "g0", pool: P1, openedAt: COVER_S - 3600, depositedUsd: 0, withdrawnUsd: 9000, partial: true }),
      ],
      [W.ok]: [
        pos({ position: "o1", pool: P1, openedAt: t0, closedAt: t0 + 3600, depositedUsd: 2000, withdrawnUsd: 1900 }),
        pos({ position: "o2", pool: P2, openedAt: t0, depositedUsd: 2000, feesUsd: 20 }),
        pos({ position: "o3", pool: P2, openedAt: t0, depositedUsd: 2000, feesUsd: 20 }),
      ],
      [W.launch]: [1, 2, 3, 4].map((i) => pos({ position: `l${i}`, pool: addr(560 + i), dex: "meteora_damm_v2", openedAt: t0 + i * 60, closedAt: t0 + i * 60 + 300, depositedUsd: 12_700, withdrawnUsd: 40_000, feesUsd: 100, depositedA: 20, depositedB: 1_000_000_000 })),
      [W.few]: [
        pos({ position: "f1", pool: P1, openedAt: t0, depositedUsd: 3000 }), pos({ position: "f2", pool: P2, openedAt: t0, depositedUsd: 3000 }),
        pos({ position: "f3", pool: P3, openedAt: COVER_S - 600, depositedUsd: 0, partial: true }), pos({ position: "f4", pool: P3, openedAt: COVER_S - 600, depositedUsd: 0, partial: true }),
      ],
    };
    w.world.top = {
      fees: [top(W.vault, { positions: 300, pools: 40, dep: 900_000, fees: 20_000 }), top(W.good, { positions: 5, pools: 3, dep: 20_000, fees: 350, pnl: 550, rp: 2, wr: 1 }),
        top(W.ok, { positions: 3, pools: 2, dep: 6000, fees: 40, pnl: -100, rp: 1, wr: 0 }), top(W.one, { positions: 6, pools: 1, dep: 50_000, fees: 900 }),
        top(W.small, { positions: 3, pools: 2, dep: 300, fees: 30 }), top(W.few, { positions: 4, pools: 3, dep: 6000, fees: 10 })],
      deposits: [top(W.vault, { positions: 300, pools: 40, dep: 900_000 })],
      // Chord's sort=pnl: the trap (a $0 deposit and a $33.5k withdrawal), the launcher, then the honest wallet
      pnl: [top(W.trap, { positions: 1, pools: 1, dep: 0, wd: 33_558, pnl: 33_558, rp: 1, wr: 1 }), top(W.launch, { positions: 4, pools: 4, dep: 50_800, wd: 160_000, fees: 400, pnl: 109_600, rp: 4, wr: 1 }),
        top(W.good, { positions: 5, pools: 3, dep: 20_000, fees: 350, pnl: 550, rp: 2, wr: 1 })],
    };
  });

  it("ranks on positions seen from the first deposit, drops the traps and says why, positions it is built on on every row", async () => {
    const b = await smartLps(3, 10, w.deps);
    expect(b.rows.map((r) => r.wallet)).toEqual([W.good]);
    const g = b.rows[0];
    // seen: g1–g4 (g0 opened before the tape). ROI = (500 + 200) / 10,000 = 7 %, fee yield of open = 200 / 10,000 = 2 %.
    // score = 100 × (0.07 × 2/5 × (0.35 + 0.65 × 3.5/5) + 0.02 × 2/5) = 100 × (0.022540 + 0.008) = 3.05
    expect(g).toMatchObject({ positions: 4, positionsAll: 5, closed: 2, open: 2, pools: 3, depositedUsd: 20_000, feesUsd: 350, feeYieldPct: 1.75, realizedUsd: 700, roiPct: 7, winRate: 1, medianHoldS: 5400 });
    expect(g.score).toBeCloseTo(3.05, 2);
    expect(g.pairs[0]).toBe("TOK-SOL");
    // W.ok: −5 % on its one close, 1 % fee yield on two open = 100 × (−0.05 × 1/4 + 0.01 × 2/5) = −0.85: on no board
    const ok = judge(W.ok, w.world.walletPositions[W.ok].map((x) => x as any), { sinceS: COVER_S, coverageS: COVER_S, nowS: NOW_S, positionsAll: 3 }).row!;
    expect(ok).toMatchObject({ positions: 3, closed: 1, roiPct: -5, winRate: 0, score: -0.85 });
    const drop = Object.fromEntries(b.dropped.map((x) => [x.reason, x.wallets]));
    expect(drop).toMatchObject({
      "only removes or claims on the tape (creators, migrators, LPs from before the tape)": 1, "vault or rebalancing script (more than 40 positions a day)": 1,
      "one pool only (one bet, not a track record)": 1, "under $1,000 put in on positions seen from the first deposit": 1,
      "fewer than 3 positions seen from their first deposit": 1, "pool launcher (opens new pools with a whole token supply or round amounts: it sets the price, a copy cannot)": 1,
      "no edge yet: realized ROI plus fee yield at or below zero on the positions seen": 1,
    });
    expect(b.trap.map((t) => [t.wallet, t.verdict.split(":")[0]])).toEqual([[W.trap, "dropped"], [W.launch, "dropped"], [W.good, "rank 1 here"]]);
    expect(b.trap[0]).toMatchObject({ chordRealizedPnlUsd: 33_558, chordWinRate: 1, chordDepositedUsd: 0, chordWithdrawnUsd: 33_558 });
    expect(b.trap[1].verdict).toMatch(/pool launcher/);
    expect(b.notes.join(" ")).toMatch(/LP tape starts .* this board covers 6\.0 h/);
    expect(b).toMatchObject({ days: 3, candidates: 8, coverageStart: COVER_S * 1000, since: COVER_S * 1000 });
  });

  it("is cached 10 minutes, and a window clipped by the coverage serves the others", async () => {
    await smartLps(1, 10, w.deps);
    const n = w.world.calls.length;
    const b7 = await smartLps(7, 1, w.deps);
    expect(w.world.calls.length).toBe(n);
    expect(b7).toMatchObject({ days: 7 });
    expect(b7.rows.map((r) => r.wallet)).toEqual([W.good]);
    w.world.nowMs += 11 * 60_000;
    await smartLps(7, 10, w.deps);
    expect(w.world.calls.length).toBeGreaterThan(n);
  });

  it("judge: a wallet read without seen deposits is a creator / migrator", () => {
    const v = judge(WX, [tapePos({ position: "p", pool: P1, openedAt: COVER_S - 10, depositedUsd: 0, withdrawnUsd: 33_000, partial: true }) as any], { sinceS: COVER_S, coverageS: COVER_S, nowS: NOW_S, positionsAll: 1 });
    expect(v.drop).toMatch(/only removes or claims/);
  });
});

describe("LP copy params", () => {
  it("fills defaults, accepts the smart-LP form, and re-validates what it stored", () => {
    const c = validateLpCopyParams({ mode: "copy", wallets: [WL], amountUsd: "250" });
    expect(c).toEqual({ mode: "copy", wallets: [WL], smartLps: null, amountUsd: 250, maxOpenPositions: 3, minPoolTvlUsd: 50_000,
      venues: ["meteora_dlmm", "meteora_damm_v2", "raydium_clmm", "pumpswap"], followRemoves: true, exits: { lpExodus: true, tokenDropPct: null, dailyLossStopUsd: null }, safety: true });
    const s = validateLpCopyParams({ mode: "copy", wallets: { smartLps: { top: 3 } }, amountUsd: 100, venues: ["meteora_dlmm"] });
    expect(s).toMatchObject({ wallets: [], smartLps: { top: 3, days: 3 }, venues: ["meteora_dlmm"] });
    expect(validateParams("lp", s)).toEqual(s);
    expect(validateParams("lp", { pool: P1, amountUsd: 100 })).toMatchObject({ pool: P1, preset: "balanced" });
    const bad: [unknown, RegExp][] = [
      [{ mode: "copy", amountUsd: 100 }, /wallets is required/],
      [{ mode: "copy", wallets: [WL], amountUsd: 5000 }, /amountUsd must be between 10 and 2000/],
      [{ mode: "copy", wallets: [WL], amountUsd: 100, maxOpenPositions: 11 }, /maxOpenPositions must be between 1 and 10/],
      [{ mode: "copy", wallets: [WL], amountUsd: 100, venues: ["orca"] }, /venues: "orca" is not one of/],
      [{ mode: "copy", wallets: [WL], smartLps: { top: 2 }, amountUsd: 100 }, /wallets or smartLps, not both/],
      [{ mode: "copy", wallets: { smartLps: { top: 20 } }, amountUsd: 100 }, /smartLps.top must be between 1 and 10/],
      [{ mode: "copy", wallets: [WL], amountUsd: 100, pool: P1 }, /unknown lp copy params field "pool"/],
    ];
    for (const [input, msg] of bad) expect(() => validateLpCopyParams(input)).toThrow(msg);
    expect(() => validateParams("lp", { mode: "range", pool: P1, amountUsd: 100 })).toThrow(/mode must be "single"/);
  });
});

describe("paper LP copy agent", () => {
  let w: ReturnType<typeof world>;
  const minute = async (n = 1) => { for (let i = 0; i < n; i++) { w.world.nowMs += 60_000; await E._lpTick(); } };
  const view = (o: string, id: string) => E.getBot(o, id)!;
  const ev = (o: Parameters<typeof tapeEv>[0]) => (w.world.walletEvents[WL] ??= []).push(tapeEv(o));
  beforeEach(() => {
    E._resetBots(); // each test's agents leave the running set (their rows stay in the file)
    w = world();
    E._setBotDeps({ exec: { now: () => w.world.nowMs }, lp: w.deps });
  });

  it("copies an add with the wallet's range, skips with the check that said no, closes on the wallet's remove, keeps copying after an exit rule", async () => {
    // an add from before the agent started: never copied
    ev({ ts: NOW_S - 600, sig: "old", kind: "add", pool: P1, position: "x0", usd: 5000, lower: -10, upper: 10 });
    const b = E.createBot("o-copy", { type: "lp", params: { mode: "copy", wallets: [WL], amountUsd: 500, maxOpenPositions: 2, exits: { tokenDropPct: 50 } } });
    expect(b.name).toBe(`Copy LP ${short(WL)}`);
    await E._drain();
    let d = view("o-copy", b.id);
    expect(d.lp!.copy!.follow).toMatchObject({ wallets: [WL], from: "given", since: NOW });
    expect(d.events[0].msg).toMatch(/^Following 1 wallet: .*Each LP add from now on opens a \$500 paper position/);
    await minute();
    expect(view("o-copy", b.id).fills).toEqual([]);

    // its add: DLMM bins −36…+36 around 1 (bin step 100, decimals 6 / 6) = 0.6989 … 1.4450 USDC per TOK; a second position in
    // the same transaction is the same move
    ev({ ts: NOW_S + 90, sig: "S1", kind: "open", pool: P1, position: "x1", lower: -36, upper: 36 });
    ev({ ts: NOW_S + 90, sig: "S1", kind: "add", pool: P1, position: "x1", usd: 20_867, lower: -36, upper: 36 });
    ev({ ts: NOW_S + 90, sig: "S1", kind: "add", pool: P1, position: "x2", usd: 3000, lower: 37, upper: 60 });
    await minute();
    d = view("o-copy", b.id);
    expect(d.fills.length).toBe(1);
    const f = d.fills[0];
    expect(f).toMatchObject({ kind: "open", side: "buy", status: "filled", usd: 500, mint: P1, symbol: "TOK-USDC", pnlUsd: null });
    expect(f.source).toEqual({ wallet: WL, tx: "S1", side: "buy", mint: P1, symbol: "TOK-USDC", usd: 20_867, priceUsd: 1, ts: (NOW_S + 90) * 1000, via: "lp",
      detail: `copied LP ${short(WL)}: added $20,867 to TOK-USDC (range −30% / +45%)` });
    expect(f.ts - f.source.ts).toBe(30_000); // the reaction time: the next minute's poll
    expect(f.reason).toMatch(/^Copied .*: open TOK-USDC on Meteora DLMM, 0\.6989–1\.445\d* USDC per TOK \(−30% \/ \+45%\), at 1 USDC per TOK, 30 s after its add$/);
    expect(d.positions).toEqual([expect.objectContaining({ mint: P1, symbol: "TOK-USDC LP", qty: 500, costUsd: 500 })]);
    const st = d.lp!.copy!.positions[0];
    expect(st).toMatchObject({ pool: P1, status: "open", inRange: true, copied: { wallet: WL, position: "x1", tx: "S1", usd: 20_867, removedUsd: 0 }, feeApr: { pct: 365 } });
    expect(st.range!.lower).toBeCloseTo(1.01 ** -36, 9);
    expect(st.range!.upper).toBeCloseTo(1.01 ** 37, 9);

    // a thin pool, then a full-range DAMM v2 add (opens), then one more (max open)
    ev({ ts: NOW_S + 150, sig: "S2", kind: "add", pool: P3, position: "x3", usd: 900, lower: -5, upper: 5 });
    ev({ ts: NOW_S + 155, sig: "S3", kind: "add", pool: P2, position: "x4", usd: 4000 });
    ev({ ts: NOW_S + 160, sig: "S4", kind: "add", pool: P4, position: "x5", dex: "pumpswap", usd: 800 });
    await minute();
    d = view("o-copy", b.id);
    const byTx = Object.fromEntries(d.fills.map((x) => [x.source.tx, x]));
    expect(byTx.S2).toMatchObject({ status: "skipped", kind: "open", reason: "pool TVL $10,000 is under the $50,000 floor", source: { wallet: WL, detail: `copied LP ${short(WL)}: added $900 to THIN-USDC` } });
    expect(byTx.S3).toMatchObject({ status: "filled", kind: "open", mint: P2, symbol: "TWO-SOL" });
    expect(byTx.S3.source.detail).toBe(`copied LP ${short(WL)}: added $4,000 to TWO-SOL (full range)`);
    expect(byTx.S4).toMatchObject({ status: "skipped", reason: "max open positions (2) reached" });
    expect(d.bot.stats).toMatchObject({ trades: 2, buys: 2, skipped: 2, investedUsd: 1000, openPositions: 2 });

    // fees accrue on the DLMM position (fee APR 365 % in range); another wallet's remove and a partial remove do not close it
    await minute(4);
    d = view("o-copy", b.id);
    expect(d.lp!.copy!.positions.find((p) => p.pool === P1)!.feesTotalUsd).toBeGreaterThan(0);
    ev({ ts: NOW_S + 400, sig: "R0", kind: "remove", pool: P1, position: "x2", usd: 3000 });
    ev({ ts: NOW_S + 410, sig: "R1", kind: "remove", pool: P1, position: "x1", usd: 6260 });
    await minute();
    d = view("o-copy", b.id);
    expect(d.positions.map((p) => p.mint).sort()).toEqual([P1, P2].sort());
    expect(d.events.some((e) => /took \$6,260 out of TOK-USDC \(30\.0% of its deposit so far\): the copy stays/.test(e.msg))).toBe(true);
    ev({ ts: NOW_S + 470, sig: "R2", kind: "remove", pool: P1, position: "x1", usd: 5300 });
    await minute();
    d = view("o-copy", b.id);
    const cl = d.fills.find((x) => x.source.tx === "R2")!;
    expect(cl).toMatchObject({ kind: "close", side: "sell", status: "filled", mint: P1, source: { wallet: WL, side: "sell", via: "lp", usd: 5300, detail: `copied LP ${short(WL)}: removed $5,300 from TOK-USDC` } });
    expect(cl.reason).toMatch(/^Copied .*: close TOK-USDC, \d+ s after it took out \$11,560 of its \$20,867$/);
    expect(cl.pnlUsd!).toBeGreaterThan(0); // the price never moved: the estimated fees
    expect(d.positions.map((p) => p.mint)).toEqual([P2]);

    // an exit rule closes one position and the agent keeps copying
    w.world.prices[T2] = 0.9;
    await minute();
    d = view("o-copy", b.id);
    expect(d.bot.status).toBe("running");
    expect(d.fills[0]).toMatchObject({ kind: "close", mint: P2 });
    expect(d.fills[0].reason).toMatch(/^Exit, token drop: TWO is down 55\.0% from the open \(stop at 50%\)/);
    expect(d.fills[0].source.wallet).toBe(P2);
    expect(d.positions).toEqual([]);
    expect(d.bot.stats).toMatchObject({ trades: 4, buys: 2, sells: 2, openPositions: 0 });
    // the kind survives the store (copied fills carry the wallet's signature, not "lp:<kind>:…")
    expect(E.getBot(null, b.id)!.fills.filter((x) => x.status === "filled").map((x) => x.kind)).toEqual(["close", "close", "open", "open"]);
    expect(E.getBot(null, b.id)!.lp!.copy!.follow!.copied).toBe(2);
  });

  it("paused: nothing is copied, positions stay marked; resumed: adds made while paused are not copied", async () => {
    const b = E.createBot("o-pause", { type: "lp", params: { mode: "copy", wallets: [WL], amountUsd: 200 } });
    await E._drain();
    ev({ ts: NOW_S + 30, sig: "A1", kind: "add", pool: P2, position: "y1", usd: 1000 });
    await minute();
    expect(view("o-pause", b.id).positions.length).toBe(1);
    E.setStatus("o-pause", b.id, "paused");
    expect(view("o-pause", b.id).events[0].msg).toMatch(/^Paused: the copied LP positions stay in their pools and are still marked/);
    ev({ ts: NOW_S + 100, sig: "A2", kind: "add", pool: P1, position: "y2", usd: 1000, lower: -5, upper: 5 });
    await minute(2);
    expect(view("o-pause", b.id).fills.length).toBe(1);
    expect(view("o-pause", b.id).lp!.copy!.positions[0].mark!.ts).toBe(w.world.nowMs);
    E.setStatus("o-pause", b.id, "running");
    await minute();
    expect(view("o-pause", b.id).fills.length).toBe(1);
    // the wallet's close of the position copied before the pause is still followed; Chord's close events can carry no pool
    ev({ ts: Math.floor(w.world.nowMs / 1000) - 5, sig: "C1", kind: "close", pool: null as unknown as string, position: "y1" });
    await minute();
    expect(view("o-pause", b.id).fills[0]).toMatchObject({ kind: "close", source: { tx: "C1", detail: `copied LP ${short(WL)}: closed its position in TWO-SOL` } });
  });

  it("the smart-LP form follows the board's top wallets; the daily loss stop closes every position and stops", async () => {
    w.world.top = { fees: [top(WL, { positions: 4, pools: 3, dep: 20_000, fees: 300 })], deposits: [], pnl: [] };
    const t0 = COVER_S + 600;
    w.world.walletPositions[WL] = [1, 2, 3].map((i) => tapePos({ position: `z${i}`, pool: addr(570 + i), openedAt: t0, depositedUsd: 5000, feesUsd: 100 }));
    const b = E.createBot("o-smart", { type: "lp", params: { mode: "copy", wallets: { smartLps: { top: 2, days: 1 } }, amountUsd: 300, exits: { dailyLossStopUsd: 20 } } });
    expect(b.name).toBe("Copy top 2 smart LPs (1 d)");
    await E._drain();
    let d = view("o-smart", b.id);
    expect(d.lp!.copy!.follow).toMatchObject({ wallets: [WL], from: "smart", picked: [{ wallet: WL, positions: 3 }] });
    expect(d.events[0].msg).toMatch(/^Following the top 1 wallet of the smart-LP board \(1 d\): .*\(score [\d.]+, 3 positions\)/);
    ev({ ts: NOW_S + 30, sig: "B1", kind: "add", pool: P2, position: "q1", usd: 1000 });
    await minute();
    w.world.prices[T2] = 1.6; // full range: value × √0.8 = 268.3 → −$31.7, over the $20 stop
    await minute();
    d = view("o-smart", b.id);
    expect(d.bot.status).toBe("stopped");
    expect(d.fills[0]).toMatchObject({ kind: "close", mint: P2 });
    expect(d.fills[0].reason).toMatch(/^Exit, daily loss stop/);
    expect(d.events[0].msg).toMatch(/^Exited every copied position: daily loss stop/);
  });
});

describe("LP copy backtest", () => {
  it("replays the wallets' moves with the copy rules: one copy opened and closed by the wallet, the skips counted", async () => {
    _resetLpCopy(); _resetLpData();
    const w = world();
    const t0 = COVER_S + 3600;                                    // the wallet's add, 5 hours ago
    // 15-minute candles: TOK at 1.0 the whole window
    w.world.candles[`${T1}@${P1}`] = Array.from({ length: 6 * 4 + 1 }, (_, i) => ({ t: COVER_S + i * 900, c: 1 }));
    w.world.candles[`${T3}@${P3}`] = hourly(COVER_S, [1, 1, 1, 1, 1, 1, 1]);
    w.world.walletEvents[WL] = [
      tapeEv({ ts: t0, sig: "A1", kind: "add", pool: P1, position: "x1", usd: 10_000, lower: -20, upper: 20 }),
      tapeEv({ ts: t0 + 600, sig: "A2", kind: "add", pool: P3, position: "x2", usd: 900, lower: -5, upper: 5 }),
      tapeEv({ ts: t0 + 700, sig: "A3", kind: "add", pool: P5, position: "x3", usd: 900, dex: "orca_whirlpool" }),
      tapeEv({ ts: t0 + 7200, sig: "C1", kind: "remove", pool: P1, position: "x1", usd: 10_100 }),
      tapeEv({ ts: t0 + 7200, sig: "C1", kind: "close", pool: P1, position: "x1" }),
    ];
    const bt = await lpCopyBacktest({ wallets: [WL], amountUsd: 500, days: 1 }, w.deps);
    expect(bt).toMatchObject({ days: 1, windowHours: 6, wallets: [WL], walletsFrom: "1 wallet given", moves: 4, entries: 3, copied: 1, investedUsd: 500 });
    expect(bt.skipped).toEqual(expect.arrayContaining([{ reason: "pool TVL under the $50,000 floor at the time (estimate)", n: 1 }, { reason: "unsupported venue (orca_whirlpool)", n: 1 }]));
    expect(bt.fills.map((f) => [f.kind, f.tx])).toEqual([["open", "A1"], ["close", "C1"]]);
    expect(bt.fills[1].reason).toMatch(/it closed its position/);
    // 2 hours in range at fee APR 365 %: $500 × 3.65 × 2 / 8,760 = $0.4167, no IL (the price never moved)
    const p = bt.positions[0];
    expect(p).toMatchObject({ pool: P1, pair: "TOK-USDC", wallet: WL, tx: "A1", openedAt: t0 * 1000, closedAt: (t0 + 7200) * 1000, timeInRangePct: 100 });
    expect(p.feesUsd).toBe(0.42);
    expect(p.ilUsd).toBeCloseTo(0, 6);
    expect(bt.realizedUsd).toBeCloseTo(0.42, 2);
    expect(bt.pnlUsd).toBeCloseTo(0.42, 2);
    expect(bt.winRate).toBe(1);
    expect(bt.equity.length).toBeGreaterThan(5);
    expect(bt.equity[bt.equity.length - 1]).toMatchObject({ usd: 0.42, deployedUsd: 0 });
    expect(bt.notes.join(" ")).toMatch(/LP tape starts .* 6\.0 h replayed, not 24 h/);
    expect(bt.notes.join(" ")).toMatch(/Fees are an ESTIMATE/);
    await expect(lpCopyBacktest({ wallets: [WL], amountUsd: 500, days: 2 }, w.deps)).rejects.toThrow(/days must be 1, 3 or 7/);
  });
  it("a wallet Chord cannot read (twice) is named, never a silent zero; none readable = an error", async () => {
    _resetLpCopy(); _resetLpData();
    const w = world();
    w.world.walletEvents[WL] = [];
    w.world.fail[`/v1/chains/solana/lp/wallet/${WX}/events?limit=200`] = new Error("The operation timed out.");
    const bt = await lpCopyBacktest({ wallets: [WL, WX], amountUsd: 100, days: 1 }, w.deps);
    expect(bt.unread).toEqual([WX]);
    expect(bt.notes.join(" ")).toMatch(/its LP events could not be read on Chord \(The operation timed out\.\), so its moves are not in this replay/);
    expect(w.world.calls.filter((x) => x.includes(`${WX}/events`)).length).toBe(2);
    await expect(lpCopyBacktest({ wallets: [WX], amountUsd: 100, days: 1 }, w.deps)).rejects.toThrow(/could not be read for the wallet .*nothing to replay/);
  });
});
