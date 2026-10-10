// Chord's public API (api.getchord.xyz/v1, CHORD_API): every market fact about Monad the agents read comes through here —
// the token list, prices, per-token stats, swaps, the large-trade feed, the smart-money board, candles and real router quotes.
// One GET helper with the owner's key, a deadline and an error that names the path (never the full URL with its query).
import { chordHeaders, config } from "../config";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** Tests swap the transport for every call to Chord's API made by the Monad lane. */
export function setMonadFetch(f: Fetch | null): void { fetchImpl = f ?? ((...a) => fetch(...a)); }

export class ChordHttpError extends Error {
  constructor(public status: number, public code: string | null, msg: string) { super(msg); }
}

export async function chordMonad<T>(path: string, timeoutMs = 10_000): Promise<T> {
  const base = config.chordApi();
  if (!base) throw new Error("Chord's API is switched off on this server (CHORD_API=off)");
  const r = await fetchImpl(`${base}/v1${path}`, { headers: chordHeaders({ Accept: "application/json" }), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) {
    let code: string | null = null, msg = "";
    try { const j: any = await r.json(); code = typeof j?.error === "string" ? j.error : typeof j?.code === "string" ? j.code : null; msg = typeof j?.message === "string" ? j.message : ""; } catch { /* no body */ }
    throw new ChordHttpError(r.status, code, `Chord API ${path.split("?")[0]} answered ${r.status}${code ? ` ${code}` : ""}${msg ? `: ${msg.slice(0, 120)}` : ""}`);
  }
  return (await r.json()) as T;
}
