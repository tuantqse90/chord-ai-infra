import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { addr } from "../bots/_testkit";
import { _resetMarket } from "../bots/market";
import { _resetTape } from "../bots/tape";
import { setMonadFetch } from "../monad/chord";
import { parseStrategy, type Filter } from "./schema";
import { _resetSnapshots, buildSnapshot, evaluateFilters, type TokenSnapshot } from "./snapshot";
import { fakeFetch } from "./_testkit";

const M = addr(501), S1 = addr(511), S2 = addr(512), S3 = addr(513), X1 = addr(521);
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const NOW = 1_800_000_000_000, HEAD = NOW / 1000;
const filters = (...fs: unknown[]) => parseStrategy({ trigger: { type: "schedule", every: "1h", mint: M }, action: { type: "alert" }, filters: fs }).filters;

/** Chord's stats for the token (what tokenView reads). */
const stats = {
  priceUsd: 0.002, liquidityUsd: 45_000, firstTradeTs: HEAD - 90 * 60,
  windows: { m5: { change: 3.2 }, h1: { change: -4.5, buyVol: 30_000, sellVol: 10_000 }, h24: { change: 120, buyVol: 600_000, sellVol: 400_000 } },
};
/** Chord's Monad feed rows for the token: S1 and S2 bought within the hour, S3 83 min ago, X1 is not smart. */
const feed = [
  { wallet: X1, token: M, symbol: "TOK", side: "sell", usd: 700, tokenAmt: 1, ts: HEAD - 60, tx: "0xa" },
  { wallet: X1, token: M, symbol: "TOK", side: "buy", usd: 100, tokenAmt: 1, ts: HEAD - 70, tx: "0xb" },
  { wallet: S1, token: M, symbol: "TOK", side: "buy", usd: 600, tokenAmt: 1, ts: HEAD - 300, tx: "0xc" },
  { wallet: S2, token: M, symbol: "TOK", side: "buy", usd: 200, tokenAmt: 1, ts: HEAD - 600, tx: "0xd" },
  { wallet: S2, token: M, symbol: "TOK", side: "sell", usd: 100, tokenAmt: 1, ts: HEAD - 650, tx: "0xe" },
  { wallet: S3, token: M, symbol: "TOK", side: "buy", usd: 500, tokenAmt: 1, ts: HEAD - 5000, tx: "0xf" },
];
const smart = async (days: number) => (days === 7 ? [{ wallet: S1 }, { wallet: S3 }] : [{ wallet: S2 }]) as any;
let back = 9.8; // what a $10 buy of M sold straight back returns
let statsDown = false;
const monadCalls: string[] = [];
function chord(u: string): Response {
  monadCalls.push(u);
  const url = new URL(u), p = url.pathname;
  if (p === "/v1/smart-money/whales") return Response.json({ trades: url.searchParams.get("page") === "1" ? feed : [], hasMore: false });
  if (p === "/v1/tokens") return Response.json({ tokens: [{ address: M, symbol: "TOK", decimals: 18, liquidityUsd: 44_000, verified: true }, { address: USDC, symbol: "USDC", decimals: 6, verified: true }] });
  if (p === `/v1/tokens/stats/${M}`) return statsDown ? new Response("{}", { status: 503 }) : Response.json(stats);
  if (p === "/v1/quote") {
    const buy = url.searchParams.get("inputMint") === USDC;
    return Response.json({ outputAmount: buy ? "5000000000000000000000" : String(Math.round(back * 1e6)), feeAmount: "0", feeMint: url.searchParams.get("outputMint"), routePlan: [], priceImpactPct: "0.1" });
  }
  return new Response("{}", { status: 404 });
}

beforeEach(() => { _resetSnapshots(); _resetMarket(); _resetTape(); back = 9.8; statsDown = false; monadCalls.length = 0; setMonadFetch(async (u) => chord(String(u))); process.env.CHORD_API = "https://chord.test"; });
afterAll(() => { setMonadFetch(null); _resetTape(); delete process.env.CHORD_API; });

describe("token snapshot (Monad, Chord's API)", () => {
  it("reads only the sources the filters need, and every field it can", async () => {
    const f = fakeFetch({ [`/v1/tokens/stats/${M}`]: stats });
    const s1 = await buildSnapshot(M, { filters: filters({ field: "liquidityUsd", op: ">=", value: 1 }), deps: { fetch: f, now: () => NOW, smart } });
    expect(f.calls).toEqual([`https://chord.test/v1/tokens/stats/${M}`]);
    expect(s1).toMatchObject({ liquidityUsd: 45_000, priceUsd: 0.002, from: { liquidityUsd: "chordToken" } });
    expect(monadCalls).toEqual([]); // no feed, list or quote read for a liquidity filter

    _resetSnapshots();
    const all = await buildSnapshot(M, { deps: { fetch: f, now: () => NOW, smart } });
    expect(all).toMatchObject({
      liquidityUsd: 45_000, volume24hUsd: 1_000_000, ageMin: 90, priceChange5mPct: 3.2, priceChange1hPct: -4.5, priceChange24hPct: 120,
      buyShare1hPct: 75, smartBuyers1h: 2, // S1 and S2 bought within the feed's last hour; S3 bought 83 min before its head; X1 is not smart
      marketCapUsd: null, holders: null, organicScore: null, // not on Chord's Monad data
      safety: { mintAuthorityDisabled: null, freezeAuthorityDisabled: null, verified: true, flagged: false },
    });
    expect(all.from).toMatchObject({ buyShare1hPct: "chordToken", smartBuyers1h: "chordTraders", safety: "chordList" });
  });

  it("a round trip that does not come back flags the token; a stats outage falls back to the list and the feed, the error named", async () => {
    back = 7; statsDown = true; // 30 % lost on a straight sell, and Chord's stats are down
    const f = fakeFetch({ [`/v1/tokens/stats/${M}`]: 503 });
    const s = await buildSnapshot(M, { filters: filters({ field: "liquidityUsd", op: ">=", value: 1 }, { field: "buyShare1hPct", op: ">=", value: 50 }, { field: "ageMin", op: "<", value: 120 }, { safety: "not_flagged" }), deps: { fetch: f, now: () => NOW, smart } });
    expect(s).toMatchObject({ liquidityUsd: 44_000, ageMin: null, safety: { flagged: true, verified: true } });
    expect(s.buyShare1hPct).toBeCloseTo((900 / 1700) * 100, 6); // the feed's hour: 600 + 200 + 100 bought, 700 + 100 sold
    expect(s.from).toMatchObject({ liquidityUsd: "chordList", buyShare1hPct: "chordTraders" });
    expect(s.errors.join(" ")).toMatch(/Chord's token stats: Chord \/v1\/tokens\/stats\/… answered 503/);
  });

  it("caches each source 60 s per token", async () => {
    const f = fakeFetch({ [`/v1/tokens/stats/${M}`]: stats });
    let now = NOW;
    const deps = { fetch: f, now: () => now, smart };
    const fs = filters({ field: "priceChange1hPct", op: ">", value: 1 });
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
    expect(ev(filters({ field: "smartBuyers1h", op: ">=", value: 2 }), {})).toEqual({ pass: false, filter: { field: "smartBuyers1h", op: ">=", value: 2 }, field: "smartBuyers1h", value: null, reason: "unknown smartBuyers1h" });
    expect(ev(filters({ safety: "verified" }), {})).toMatchObject({ pass: false, field: "verified", value: null, reason: "unknown verified" });
    expect(ev(filters({ safety: "not_flagged" }), {})).toMatchObject({ pass: false, reason: "unknown not_flagged" });
  });

  it("says which filter said no and the value it saw, in order", () => {
    const fs = filters({ field: "liquidityUsd", op: ">=", value: 30_000 }, { field: "buyShare1hPct", op: ">=", value: 55 }, { field: "ageMin", op: "between", value: [0, 30] }, { safety: "not_flagged" });
    expect(ev(fs, { liquidityUsd: 12_345.6, buyShare1hPct: 90 })).toMatchObject({ pass: false, field: "liquidityUsd", value: 12_345.6, reason: "liquidity $12,346 (needs at least $30,000)" });
    expect(ev(fs, { liquidityUsd: 31_000, buyShare1hPct: 40 })).toMatchObject({ field: "buyShare1hPct", value: 40 });
    expect(ev(fs, { liquidityUsd: 31_000, buyShare1hPct: 60, ageMin: 45 })).toMatchObject({ field: "ageMin", value: 45, reason: "age 45 min (needs between 0 min and 30 min)" });
    expect(ev(fs, { liquidityUsd: 31_000, buyShare1hPct: 60, ageMin: 5, safety: { mintAuthorityDisabled: null, freezeAuthorityDisabled: null, verified: true, flagged: true } }))
      .toMatchObject({ field: "not_flagged", value: false, reason: "no transfer tax and sellable: a transfer tax, or a $10 buy sold straight back returns less than 90 %" });
    expect(ev(fs, { liquidityUsd: 31_000, buyShare1hPct: 60, ageMin: 5, safety: { mintAuthorityDisabled: null, freezeAuthorityDisabled: null, verified: null, flagged: false } })).toEqual({ pass: true });
    expect(ev(filters({ field: "priceChange1hPct", op: "<", value: -20 }), { priceChange1hPct: -25 })).toEqual({ pass: true });
  });
});
