// ask2049: stand-in for Chord's services/rhMarkets with only what services/ask/walletTools.ts reads, from Chord's public API
// (services/chordApi.ts).
import { chordMarketMap, type ChordMarketMap } from "./chordApi";

/** address → { priceUsd, … } for Robinhood Chain (GET /v1/tokens/market?chain=4663). */
export const getRhMarketMap = (): Promise<ChordMarketMap> => chordMarketMap(4663);

/** ask2049: Chord overlays live prints on the map here; the public /v1/tokens/market?chain=4663 answer already carries that
 *  overlay, so the map passes through unchanged. */
export const withLiveRh = (map: ChordMarketMap): ChordMarketMap => map;

/** ask2049: Chord's services/rhRollup.getRhTrustedPrices (this app's rhRollup.ts stand-in is shared with other tools, so it
 *  lives here). Chord prices a held token from its trusted pool's last 24 h print; those are the same 24 h rows the market
 *  map above is built from, and no public endpoint answers it for a list of tokens. So a held token the map lacks stays
 *  unpriced: an empty answer, never a guess. */
export async function getRhTrustedPrices(_addrs: readonly string[]): Promise<Map<string, { priceUsd: number }>> {
  return new Map();
}
