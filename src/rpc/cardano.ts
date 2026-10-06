// Cardano over NOWNodes' Blockfrost-compatible REST API (https://ada-blockfrost.nownodes.io/api/v0, key in `api-key`;
// `project_id` is sent too, as Blockfrost itself expects it). 404 = "not on chain" and comes back as null.
import { config, isNowNodes } from "../config";
import { record } from "./ledger";
import { RpcError } from "./solana";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (...a) => fetch(...a);
export function setCardanoFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

/** The ledger label of a path: ids (addresses, hashes) folded so the status page groups by endpoint. */
export const labelOf = (path: string) => path.split("?")[0].replace(/\/(addr|stake)[0-9a-z_]+/g, "/:addr").replace(/\/[0-9a-f]{56,64}/g, "/:hash");

export async function bf<T = any>(path: string): Promise<T | null> {
  const base = config.cardanoApiUrl().replace(/\/$/, "");
  const key = config.nownodesKey();
  const h: Record<string, string> = { Accept: "application/json" };
  if (key && isNowNodes(base)) {
    h["api-key"] = key;
    h["project_id"] = key;
  }
  const label = labelOf(path);
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetchImpl(base + path, { headers: h, signal: AbortSignal.timeout(12_000) });
    } catch (e) {
      record("cardano", label, performance.now() - t0, false);
      if (attempt === 0 && (e as Error)?.name === "TimeoutError") continue;
      throw e;
    }
    const ms = performance.now() - t0;
    if (res.status === 404) {
      record("cardano", label, ms, true);
      return null;
    }
    if (res.status === 429 || res.status >= 500) {
      record("cardano", label, ms, false);
      if (attempt === 0) {
        await Bun.sleep(400);
        continue;
      }
      throw new RpcError(`HTTP ${res.status}`, res.status);
    }
    const text = await res.text();
    if (!res.ok) {
      record("cardano", label, ms, false);
      throw new RpcError(`HTTP ${res.status}: ${text.slice(0, 120)}`, res.status);
    }
    record("cardano", label, ms, true);
    return JSON.parse(text) as T;
  }
}
