// Solana JSON-RPC over NOWNodes (https://sol.nownodes.io, key in the `api-key` header). One retry on 429 / 5xx / timeout,
// a JSON-RPC batch for many calls at once (falls back to single calls when the endpoint refuses batches), every call counted.
import { config, isNowNodes } from "../config";
import { record } from "./ledger";

export class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** Tests swap the transport. */
export function setSolanaFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

const TIMEOUT_MS = 12_000;
let batchOk: boolean | null = null; // learned once per process

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const url = config.solanaRpcUrl();
  const key = config.nownodesKey();
  if (key && isNowNodes(url)) h["api-key"] = key;
  return h;
}

async function post(body: unknown): Promise<unknown> {
  const res = await fetchImpl(config.solanaRpcUrl(), { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (res.status === 429 || res.status >= 500) throw new RpcError(`HTTP ${res.status}`, res.status);
  if (!res.ok) throw new RpcError(`HTTP ${res.status}: ${text.slice(0, 120)}`, res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new RpcError(`not JSON: ${text.slice(0, 120)}`);
  }
}

const retryable = (e: unknown) => e instanceof RpcError ? e.code === 429 || (e.code ?? 0) >= 500 : (e as Error)?.name === "TimeoutError";

export async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    try {
      const j = (await post({ jsonrpc: "2.0", id: 1, method, params })) as { result?: T; error?: { code: number; message: string } };
      record("solana", method, performance.now() - t0, !j.error);
      if (j.error) throw new RpcError(`${method}: ${j.error.message}`, j.error.code);
      return j.result as T;
    } catch (e) {
      if (!(e instanceof RpcError && e.message.startsWith(method))) record("solana", method, performance.now() - t0, false);
      if (attempt === 0 && retryable(e)) {
        await Bun.sleep(400);
        continue;
      }
      throw e;
    }
  }
}

/** Many calls in one round trip when the endpoint takes batches; results come back in request order, an item error = null. */
export async function rpcBatch<T = any>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> {
  if (!calls.length) return [];
  if (batchOk !== false && calls.length > 1) {
    const t0 = performance.now();
    try {
      const out = (await post(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params })))) as any;
      if (Array.isArray(out)) {
        batchOk = true;
        const ms = (performance.now() - t0) / calls.length;
        const byId = new Map(out.map((r: any) => [r.id, r]));
        return calls.map((c, i) => {
          const r: any = byId.get(i);
          record("solana", c.method, ms, !!r && !r.error);
          return r && !r.error ? (r.result as T) : null;
        });
      }
      batchOk = false;
    } catch (e) {
      if (!(e instanceof RpcError) || (e.code !== 400 && e.code !== 413 && e.code !== 403)) throw e;
      batchOk = false;
    }
  }
  return Promise.all(calls.map((c) => rpc<T>(c.method, c.params).catch(() => null)));
}
