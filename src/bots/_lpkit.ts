// Test helper for the LP agent (offline): a fake Chord LP tape, venue APIs, Jupiter prices / token facts / quotes, all
// mutable from the test, behind the LpDeps interface.
import { ChordApiNotFound } from "../chord/services/chordApi";
import type { LpDeps } from "./lpData";
import type { TokenInfo } from "./market";

export interface FakePool {
  pool: string; dex: string; mintA: string; mintB: string; symbolA: string | null; symbolB: string | null; token: string;
  priceUsd?: number | null; tvlUsd?: number | null; firstLpEvent?: number;
  lastHour?: { depositsUsd: number; withdrawalsUsd: number };
  hourly?: { hour: number; depositsUsd: number; withdrawalsUsd: number }[];
  list?: { feesClaimedUsd?: number; depositsUsd?: number; withdrawalsUsd?: number; netFlowUsd?: number; lps?: number; openPositions?: number; swapVolumeUsd?: number };
}
export interface LpWorld {
  nowMs: number; pools: FakePool[]; since: number;
  /** key = `${mint}@${pool}` for a pool's candles, `${mint}` for the main pool */
  candles: Record<string, { t: number; c: number }[]>;
  venue: Record<string, unknown>;      // url → answer (an Error is thrown)
  prices: Record<string, number>;
  info: Record<string, TokenInfo | null>;
  quoteLossPct: number;                // what a Jupiter quote loses vs the mid price
  calls: string[];
}

export const safeInfo = (mint: string, o: Partial<TokenInfo> = {}): TokenInfo => ({ mint, symbol: null, name: null, decimals: 6, liquidityUsd: 1e6, usdPrice: null, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, icon: null, ...o });

export function lpWorld(w: Partial<LpWorld> & { nowMs: number }): { world: LpWorld; deps: LpDeps } {
  const world: LpWorld = { pools: [], since: Math.floor(w.nowMs / 1000) - 30 * 86_400, candles: {}, venue: {}, prices: {}, info: {}, quoteLossPct: 0.2, calls: [], ...w };
  const find = (pool: string) => world.pools.find((p) => p.pool === pool);
  const deps: LpDeps = {
    now: () => world.nowMs,
    chord: async <T>(path: string): Promise<T> => {
      world.calls.push(`chord ${path}`);
      let m: RegExpExecArray | null;
      if ((m = /^\/v1\/chains\/solana\/lp\/pools\?(.*)$/.exec(path))) {
        const q = new URLSearchParams(m[1]);
        const limit = Number(q.get("limit") ?? 50);
        return { since: Math.max(world.since, Math.floor(world.nowMs / 1000) - Number(q.get("hours") ?? 24) * 3600), pools: world.pools.length, rows: world.pools.slice(0, limit).map((p) => ({
          pool: p.pool, dex: p.dex, mintA: p.mintA, symbolA: p.symbolA, mintB: p.mintB, symbolB: p.symbolB, tvlUsd: p.tvlUsd ?? null, priceUsd: p.priceUsd ?? null, token: p.token,
          swapVolumeUsd: 0, depositsUsd: 0, withdrawalsUsd: 0, netFlowUsd: 0, feesClaimedUsd: 0, adds: 0, removes: 0, claims: 0, opens: 0, closes: 0, lps: 0, openPositions: 0, ...p.list,
        })) } as T;
      }
      if ((m = /^\/v1\/chains\/solana\/lp\/pool\/([^/?]+)\?hours=(\d+)$/.exec(path))) {
        const p = find(m[1]);
        if (!p) throw new ChordApiNotFound(`Chord API /v1/chains/solana/lp/pool/${m[1]}: not found`);
        const hours = Number(m[2]);
        const lh = p.lastHour ?? { depositsUsd: 0, withdrawalsUsd: 0 };
        return {
          chain: "solana", pool: p.pool, dex: p.dex, windowHours: hours, since: Math.max(world.since, Math.floor(world.nowMs / 1000) - hours * 3600),
          mintA: p.mintA, symbolA: p.symbolA, decimalsA: 6, mintB: p.mintB, symbolB: p.symbolB, decimalsB: 6, tvlUsd: p.tvlUsd ?? null, priceUsd: p.priceUsd ?? null, token: p.token,
          firstLpEvent: p.firstLpEvent ?? world.since, depositsUsd: hours === 1 ? lh.depositsUsd : 0, withdrawalsUsd: hours === 1 ? lh.withdrawalsUsd : 0,
          hourly: hours === 1 ? [] : (p.hourly ?? []).map((h) => ({ ...h, feesClaimedUsd: 0, adds: 0, removes: 0, claims: 0, opens: 0, closes: 0, lps: 0 })),
        } as T;
      }
      if ((m = /^\/v1\/chains\/solana\/token\/([^/]+)\/candles\?(.*)$/.exec(path))) {
        const q = new URLSearchParams(m[2]);
        const key = q.get("pool") ? `${m[1]}@${q.get("pool")}` : m[1];
        const rows = world.candles[key] ?? [];
        return { candles: rows.slice(-Number(q.get("limit") ?? 200)).map((r) => ({ t: r.t, o: r.c, h: r.c, l: r.c, c: r.c, volumeUsd: 0, trades: 1 })) } as T;
      }
      throw new Error(`unexpected chord path ${path}`);
    },
    venue: async (url) => {
      world.calls.push(`venue ${url}`);
      const v = world.venue[url];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`${new URL(url).host} answered 404`);
      return v;
    },
    prices: async (mints) => { world.calls.push(`prices ${mints.length}`); return new Map(mints.filter((m) => world.prices[m] != null).map((m) => [m, world.prices[m]])); },
    tokenInfo: async (mint) => { world.calls.push(`info ${mint}`); return mint in world.info ? world.info[mint] : safeInfo(mint); },
    quote: async (inMint, outMint, amount) => {
      world.calls.push(`quote ${inMint}>${outMint} ${amount}`);
      const pi = world.prices[inMint], po = world.prices[outMint];
      if (pi == null || po == null) throw new Error("no route");
      return { amountOut: (amount * pi / po) * (1 - world.quoteLossPct / 100), priceImpactPct: world.quoteLossPct, route: ["Meteora DLMM"], outSymbol: null, inSymbol: null };
    },
  };
  return { world, deps };
}

/** Hourly candles at hour starts from `fromS`, one close per price. */
export const hourly = (fromS: number, closes: number[]) => closes.map((c, i) => ({ t: fromS + i * 3600, c }));

/** A Meteora datapi pool answer. */
export const meteoraPool = (o: { tvl: number; fees24h: number; protocol24h: number; volume24h: number; createdAtMs: number; binStep?: number; baseFeePct?: number; tokenX?: string; freezeOk?: boolean }) => ({
  address: "x", tvl: o.tvl, created_at: o.createdAtMs, pool_config: { bin_step: o.binStep ?? 100, base_fee_pct: o.baseFeePct ?? 0.3 },
  volume: { "24h": o.volume24h }, fees: { "24h": o.fees24h }, protocol_fees: { "24h": o.protocol24h },
  token_x: { address: o.tokenX ?? "", freeze_authority_disabled: o.freezeOk ?? true }, token_y: { address: "y", freeze_authority_disabled: true },
});
