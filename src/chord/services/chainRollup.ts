// ask2049: stand-in for Chord's services/chainRollup (Avalanche / Base / BNB Chain) with only what services/ask/walletTools.ts
// reads: the chain's 24 h board and one token page, from Chord's public API (services/chordApi.ts) instead of its Postgres
// rollups. Same shapes as GET /v1/chains/:chain/tokens and /v1/chains/:chain/token/:address.
import { ChordApiNotFound, chordGet } from "./chordApi";

export type ChainTokenSort = "volume" | "trades" | "change";
export interface ChainTokens { chain: number; tokens: { address: string; symbol: string | null; priceUsd: number | null }[] }
export interface ChainTokenPage {
  chain: number;
  stats24h: { priceUsd: number | null };
  series: { hour: number; priceLast: number | null }[];
}

export async function chainTokens(chain: number, opts: { limit?: number; sort?: ChainTokenSort } = {}): Promise<ChainTokens> {
  const qs = new URLSearchParams({ limit: String(opts.limit ?? 100), sort: opts.sort ?? "volume" });
  const j = await chordGet<ChainTokens>(`/v1/chains/${chain}/tokens?${qs}`, 60_000);
  if (!Array.isArray(j?.tokens)) throw new Error(`Chord API: no token board for chain ${chain}`);
  return j;
}

/** One token's page; null when Chord's index holds no trade of it on this chain (the route's 404 UNKNOWN_TOKEN). */
export async function chainToken(chain: number, address: string, opts: { hours?: number } = {}): Promise<ChainTokenPage | null> {
  try {
    return await chordGet<ChainTokenPage>(`/v1/chains/${chain}/token/${address.toLowerCase()}?hours=${opts.hours ?? 168}`, 60_000);
  } catch (e) {
    if (e instanceof ChordApiNotFound) return null;
    throw e;
  }
}
