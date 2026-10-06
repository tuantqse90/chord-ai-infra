// ask2049: the Chord modules the ported Ask tools import (tokenRegistry, rhTokens, arcTokens, chainTokens, rhMarkets, arcRollup,
// chainRollup) read Chord's Redis / Postgres. Here their stand-ins read the same lists and maps from Chord's public API
// (CHORD_API, default https://api.getchord.xyz — the same base src/trade/evm.ts and rhRollup.ts use) through this one GET:
// fresh for `ttlMs`, the last good answer served for up to 6 h when a refresh fails, concurrent identical requests share one
// fetch, a bounded number of paths kept. A 404 throws ChordApiNotFound and is never served stale.
import { chordHeaders, config } from "../../config";
import { boundedCache, coalescer } from "../utils/boundedCache";

const base = () => config.chordApi() || "https://api.getchord.xyz";
const STALE_MS = 6 * 3600_000;
let hits = boundedCache<{ at: number; v: unknown }>(512);
/** Tests: forget every cached answer (the cache is module-level, so mocked answers would leak between test files). */
export function _resetChordApi(): void { hits = boundedCache<{ at: number; v: unknown }>(512); }
const inflight = coalescer<unknown>();

export class ChordApiNotFound extends Error {}

/** One token row of Chord's GET /v1/tokens?chain=… (the fields the ported tools read). */
export interface ChordListToken { address: string; symbol: string; name?: string; decimals: number; tags?: string[]; logoURI?: string | null }
export type ChordMarketMap = Record<string, { priceUsd?: number; change24h?: number; volume24h?: number }>;

export async function chordGet<T>(path: string, ttlMs: number, timeoutMs = 8_000): Promise<T> {
  const hit = hits.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  try {
    return (await inflight(path, async () => {
      const r = await fetch(`${base()}${path}`, { headers: chordHeaders(), signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 404) throw new ChordApiNotFound(`Chord API ${path.split("?")[0]}: not found`);
      if (!r.ok) throw new Error(`Chord API ${path.split("?")[0]} answered ${r.status}`);
      const v: unknown = await r.json();
      hits.set(path, { at: Date.now(), v });
      return v;
    })) as T;
  } catch (e) {
    if (hit && !(e instanceof ChordApiNotFound) && Date.now() - hit.at < STALE_MS) return hit.v as T;
    throw e;
  }
}

const LIST_TTL_MS = 10 * 60_000;
const MAP_TTL_MS = 60_000;

/** Chord's token list for a chain (GET /v1/tokens?chain=). Throws when the answer carries no list: an empty list would
 *  read as "holds nothing" instead of "could not check". */
export async function chordTokenList(chain: number): Promise<ChordListToken[]> {
  const j = await chordGet<{ tokens?: unknown }>(`/v1/tokens?chain=${chain}`, LIST_TTL_MS);
  if (!Array.isArray(j?.tokens)) throw new Error(`Chord API: no token list for chain ${chain}`);
  return j.tokens as ChordListToken[];
}

/** Chord's price map for Monad / Robinhood Chain / Arc (GET /v1/tokens/market?chain=). */
export async function chordMarketMap(chain: 143 | 4663 | 5042): Promise<ChordMarketMap> {
  const j = await chordGet<{ market?: unknown }>(`/v1/tokens/market?chain=${chain}`, MAP_TTL_MS);
  if (!j?.market || typeof j.market !== "object") throw new Error(`Chord API: no market map for chain ${chain}`);
  return j.market as ChordMarketMap;
}
