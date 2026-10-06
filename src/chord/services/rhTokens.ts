// ask2049: stand-in for Chord's services/rhTokens with only getRhTokens, read from Chord's public API (services/chordApi.ts).
import { chordTokenList, type ChordListToken } from "./chordApi";

/** The Robinhood Chain token list (GET /v1/tokens?chain=4663), tags included (stablecoin / stock / meme …). */
export const getRhTokens = (): Promise<ChordListToken[]> => chordTokenList(4663);
