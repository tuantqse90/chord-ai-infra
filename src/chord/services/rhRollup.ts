// ask2049 stand-in for Chord's services/rhRollup: the Robinhood Chain stock board comes from Chord's public API
// (GET /v1/rh/stocks) instead of Chord's Postgres rollups. Cached 60 s, like the original.
import { chordHeaders, config } from "../../config";

type RhStockRow = { address: string; symbol: string | null; priceUsd: number | null; change24hPct: number | null; volume24h?: number | null };
let hit: { at: number; v: { stocks: RhStockRow[] } } | null = null;
export const _resetRhRollup = () => { hit = null; };

export async function getRhStocks(): Promise<{ stocks: RhStockRow[] }> {
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const base = config.chordApi() || "https://api.getchord.xyz";
  const r = await fetch(`${base}/v1/rh/stocks`, { headers: chordHeaders(), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`rh stocks ${r.status}`);
  const j: any = await r.json();
  hit = { at: Date.now(), v: { stocks: Array.isArray(j.stocks) ? j.stocks : [] } };
  return hit.v;
}
