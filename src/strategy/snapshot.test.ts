import { beforeEach, describe, expect, it } from "bun:test";
import { addr } from "../bots/_testkit";
import { parseStrategy, type Filter } from "./schema";
import { _resetSnapshots, buildSnapshot, evaluateFilters, type TokenSnapshot } from "./snapshot";
import { fakeFetch } from "./_testkit";

const M = addr(501), S1 = addr(511), S2 = addr(512), S3 = addr(513), X1 = addr(521);
const NOW = 1_800_000_000_000;
const filters = (...fs: unknown[]) => parseStrategy({ trigger: { type: "new_token" }, action: { type: "alert" }, filters: fs }).filters;

const jup = {
  id: M, symbol: "TOK", usdPrice: 0.002, liquidity: 45_000, mcap: 2_000_000, fdv: 2_500_000, holderCount: 640, organicScore: 71.5,
  firstPool: { createdAt: new Date(NOW - 90 * 60_000).toISOString() },
  stats5m: { priceChange: 3.2 }, stats1h: { priceChange: -4.5, buyVolume: 30_000, sellVolume: 10_000 }, stats24h: { priceChange: 120, buyVolume: 600_000, sellVolume: 400_000 },
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false, topHoldersPercentage: 31.4 }, tags: ["verified"],
};
const traders = { since: NOW / 1000 - 4000, traders: [
  { wallet: S1, boughtUsd: 600, soldUsd: 0, lastTrade: NOW / 1000 - 300 },
  { wallet: S2, boughtUsd: 200, soldUsd: 100, lastTrade: NOW / 1000 - 600 },
  { wallet: S3, boughtUsd: 500, soldUsd: 0, lastTrade: NOW / 1000 - 5000 }, // bought, but more than an hour ago
  { wallet: X1, boughtUsd: 100, soldUsd: 700, lastTrade: NOW / 1000 - 60 }, // not smart
] };
const smart = async (days: number) => (days === 7 ? [{ wallet: S1 }, { wallet: S3 }] : [{ wallet: S2 }]) as any;

beforeEach(() => _resetSnapshots());

describe("token snapshot", () => {
  it("reads only the sources the filters need, and every field it can", async () => {
    const f = fakeFetch({ "/tokens/v2/search": [jup], [`/token/${M}/traders`]: traders, [`/token/${M}?`]: 500 });
    const s1 = await buildSnapshot(M, { filters: filters({ field: "liquidityUsd", op: ">=", value: 1 }), deps: { fetch: f, now: () => NOW, smart } });
    expect(f.calls.length).toBe(1);
    expect(f.calls[0]).toContain("/tokens/v2/search?query=");
    expect(s1).toMatchObject({ liquidityUsd: 45_000, symbol: "TOK", priceUsd: 0.002, from: { liquidityUsd: "jupiter" } });
    expect(s1.holders).toBeNull(); // not asked for

    _resetSnapshots();
    const all = await buildSnapshot(M, { deps: { fetch: f, now: () => NOW, smart } });
    expect(all).toMatchObject({
      liquidityUsd: 45_000, marketCapUsd: 2_000_000, fdvUsd: 2_500_000, volume24hUsd: 1_000_000, ageMin: 90, holders: 640, top10Pct: 31.4,
      priceChange5mPct: 3.2, priceChange1hPct: -4.5, priceChange24hPct: 120, organicScore: 71.5,
      buyShare1hPct: (1400 / 2200) * 100, smartBuyers1h: 2, // S1 and S2 bought within the hour; S3 bought 83 min ago; X1 is not smart
      safety: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false, verified: true, flagged: false },
    });
    expect(all.from).toMatchObject({ buyShare1hPct: "chordTraders", smartBuyers1h: "chordTraders", holders: "jupiter", safety: "jupiter" });
  });

  it("falls back to Chord's tape when Jupiter cannot answer; what nobody gives stays unknown", async () => {
    const view = { token: M, symbol: "TOK", priceUsd: 0.0021, change1hPct: 7, change24hPct: 50, marketCapUsd: 1_900_000, liquidityUsd: 38_000, volume24hUsd: 800_000, firstSeen: NOW / 1000 - 3600, pools: [] };
    const f = fakeFetch({ "/tokens/v2/search": 429, [`/token/${M}?`]: view, [`/token/${M}/traders`]: 503 });
    const s = await buildSnapshot(M, { filters: filters(
      { field: "liquidityUsd", op: ">=", value: 1 }, { field: "priceChange1hPct", op: ">", value: 0 }, { field: "ageMin", op: "<", value: 120 },
      { field: "holders", op: ">=", value: 100 }, { field: "buyShare1hPct", op: ">=", value: 50 }, { safety: "no_mint_authority" }), deps: { fetch: f, now: () => NOW, smart } });
    expect(s).toMatchObject({ liquidityUsd: 38_000, priceChange1hPct: 7, ageMin: 60, holders: null, buyShare1hPct: null, symbol: "TOK", priceUsd: 0.0021 });
    expect(s.from).toEqual({ liquidityUsd: "chordToken", priceChange1hPct: "chordToken", ageMin: "chordToken" });
    expect(s.safety.mintAuthorityDisabled).toBeNull();
    expect(s.errors.join(" ")).toMatch(/Jupiter is rate-limiting \(429\)/);
  });

  it("caches each source 60 s per mint", async () => {
    const f = fakeFetch({ "/tokens/v2/search": [jup] });
    let now = NOW;
    const deps = { fetch: f, now: () => now, smart };
    const fs = filters({ field: "holders", op: ">", value: 1 });
    await buildSnapshot(M, { filters: fs, deps });
    await buildSnapshot(M, { filters: fs, deps });
    now += 59_000;
    await buildSnapshot(M, { filters: fs, deps });
    expect(f.calls.length).toBe(1);
    now += 2_000;
    await buildSnapshot(M, { filters: fs, deps });
    expect(f.calls.length).toBe(2);
  });
});

describe("filters fail closed", () => {
  const snap = (o: Partial<TokenSnapshot>): TokenSnapshot => ({
    mint: M, symbol: "TOK", at: NOW, priceUsd: 1, liquidityUsd: null, marketCapUsd: null, fdvUsd: null, volume24hUsd: null, ageMin: null, holders: null, top10Pct: null,
    priceChange5mPct: null, priceChange1hPct: null, priceChange24hPct: null, organicScore: null, buyShare1hPct: null, smartBuyers1h: null,
    safety: { mintAuthorityDisabled: null, freezeAuthorityDisabled: null, verified: null, flagged: null }, from: {}, errors: [], ...o,
  });
  const ev = (fs: Filter[], o: Partial<TokenSnapshot>) => evaluateFilters(fs, snap(o));

  it("a field no source gave fails with 'unknown <field>'", () => {
    expect(ev(filters({ field: "holders", op: ">=", value: 150 }), {})).toEqual({ pass: false, filter: { field: "holders", op: ">=", value: 150 }, field: "holders", value: null, reason: "unknown holders" });
    expect(ev(filters({ safety: "no_freeze_authority" }), {})).toMatchObject({ pass: false, field: "no_freeze_authority", value: null, reason: "unknown no_freeze_authority" });
    expect(ev(filters({ safety: "not_flagged" }), {})).toMatchObject({ pass: false, reason: "unknown not_flagged" });
  });

  it("says which filter said no and the value it saw, in order", () => {
    const fs = filters({ field: "liquidityUsd", op: ">=", value: 30_000 }, { field: "top10Pct", op: "<=", value: 40 }, { field: "ageMin", op: "between", value: [0, 30] }, { safety: "no_mint_authority" });
    expect(ev(fs, { liquidityUsd: 12_345.6, top10Pct: 90 })).toMatchObject({ pass: false, field: "liquidityUsd", value: 12_345.6, reason: "liquidity $12,346 (needs at least $30,000)" });
    expect(ev(fs, { liquidityUsd: 31_000, top10Pct: 55 })).toMatchObject({ field: "top10Pct", value: 55, reason: "top-10 holders' share 55 % (needs at most 40 %)" });
    expect(ev(fs, { liquidityUsd: 31_000, top10Pct: 20, ageMin: 45 })).toMatchObject({ field: "ageMin", value: 45, reason: "age 45 min (needs between 0 min and 30 min)" });
    expect(ev(fs, { liquidityUsd: 31_000, top10Pct: 20, ageMin: 5, safety: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true, verified: false, flagged: false } }))
      .toMatchObject({ field: "no_mint_authority", value: false, reason: "no mint authority: the mint authority is live (more can be minted)" });
    expect(ev(fs, { liquidityUsd: 31_000, top10Pct: 20, ageMin: 5, safety: { mintAuthorityDisabled: true, freezeAuthorityDisabled: null, verified: null, flagged: null } })).toEqual({ pass: true });
    expect(ev(filters({ field: "priceChange1hPct", op: "<", value: -20 }), { priceChange1hPct: -25 })).toEqual({ pass: true });
  });
});
