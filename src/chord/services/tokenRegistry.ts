// ask2049: stand-in for Chord's services/tokenRegistry (Monad 143) with only what services/ask/walletTools.ts reads. Chord
// builds both from its Redis caches; here they come from Chord's public API (services/chordApi.ts).
import { chordMarketMap, chordTokenList, type ChordListToken, type ChordMarketMap } from "./chordApi";

/** The Monad token list (GET /v1/tokens?chain=143). */
export const getTokenList = (): Promise<ChordListToken[]> => chordTokenList(143);
/** address → { priceUsd, change24h, volume24h } for Monad (GET /v1/tokens/market?chain=143). */
export const getMarketMap = (): Promise<ChordMarketMap> => chordMarketMap(143);
