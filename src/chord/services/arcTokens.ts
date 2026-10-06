// ask2049: stand-in for Chord's services/arcTokens with only getArcTokens, read from Chord's public API (services/chordApi.ts).
import { chordTokenList, type ChordListToken } from "./chordApi";

/** The Arc token list (GET /v1/tokens?chain=5042), tags included (stablecoin, fx …). */
export const getArcTokens = (): Promise<ChordListToken[]> => chordTokenList(5042);
