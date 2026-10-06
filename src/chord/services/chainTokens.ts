// ask2049: stand-in for Chord's services/chainTokens with only getChainTokens, read from Chord's public API (services/chordApi.ts).
import { chordTokenList, type ChordListToken } from "./chordApi";

/** The LI.FI-based, logo-gated token list Chord serves for Avalanche / Base / BNB Chain (GET /v1/tokens?chain=). */
export const getChainTokens = (chain: number): Promise<ChordListToken[]> => chordTokenList(chain);
