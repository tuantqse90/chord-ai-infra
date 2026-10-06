// ask2049: stand-in for Chord's services/arcRollup with only what services/ask/walletTools.ts reads, from Chord's public API
// (services/chordApi.ts).
import { ChordApiNotFound, chordGet, chordMarketMap, type ChordMarketMap } from "./chordApi";

/** address → { priceUsd, … } for Arc (GET /v1/tokens/market?chain=5042). */
export const getArcMarketMap = (): Promise<ChordMarketMap> => chordMarketMap(5042);

/** token → its most recent hourly close, for held tokens that did not trade in the map's 24 h window. */
export async function getArcLastPrices(tokens: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // ask2049: Chord reads every token in one Postgres query over all of arc_token_hourly; here it is one public token-page read
  // per token (GET /v1/arc/token/:addr?hours=720, the route's maximum: closes older than 30 days are not seen), at most 8.
  const list = [...new Set(tokens.map((t) => t.toLowerCase()))].slice(0, 8);
  await Promise.all(list.map(async (a) => {
    const page = await chordGet<{ series?: { priceLast?: number | null }[] }>(`/v1/arc/token/${a}?hours=720`, 60_000).catch((e) => {
      if (e instanceof ChordApiNotFound) return null;
      throw e;
    });
    const last = [...(page?.series ?? [])].reverse().find((s) => typeof s.priceLast === "number" && s.priceLast > 0)?.priceLast;
    if (last) out.set(a, last);
  }));
  return out;
}
