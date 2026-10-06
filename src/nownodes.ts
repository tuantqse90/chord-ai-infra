// NOWNodes = the agents' swap lane (owner 07/10: "NOWNodes only when bots swap"; ask2049-notes/PROMPT-agents-marketplace.md C):
// simulating, sending and confirming an agent's swap, and verifying the x402 payment that buys a copy of an agent. Everything
// else (bot triggers, Ask tools) reads SOLANA_RPC_URL. No key = the lane is off and says so: never a silent fallback to the
// read RPC, so the page can only claim "NOWNodes" for calls that really went there.
import { config } from "./config";

export class NowNodesOffError extends Error {
  readonly status = 503;
  readonly code = "nownodes_off";
  constructor() { super("NOWNodes key not set: agent swaps and x402 payments go through NOWNodes only"); this.name = "NowNodesOffError"; }
}

const url = () => (process.env.NOWNODES_SOLANA_URL ?? "").trim() || "https://sol.nownodes.io";
export const nownodesReady = (): boolean => !!config.nownodesKey();

type Stat = { calls: number; ok: number; errors: number; lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null; msTotal: number };
const stats = new Map<string, Stat>();
const stat = (m: string): Stat => {
  let s = stats.get(m);
  if (!s) stats.set(m, (s = { calls: 0, ok: 0, errors: 0, lastOkAt: null, lastError: null, lastErrorAt: null, msTotal: 0 }));
  return s;
};

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (i, init) => fetch(i, init);
export function setNowNodesFetch(f: Fetch | null): void { fetchImpl = f ?? ((i, init) => fetch(i, init)); }

/** One Solana JSON-RPC call on NOWNodes. Throws NowNodesOffError without a key; RPC errors carry the node's message. */
export async function nowRpc<T>(method: string, params: unknown[], timeoutMs = 15_000): Promise<T> {
  const key = config.nownodesKey();
  if (!key) throw new NowNodesOffError();
  const s = stat(method);
  s.calls++;
  const t0 = Date.now();
  try {
    const r = await fetchImpl(url(), {
      method: "POST", headers: { "Content-Type": "application/json", "api-key": key },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`NOWNodes answered HTTP ${r.status}`);
    const j = (await r.json()) as { result?: T; error?: { code?: number; message?: string } };
    if (j.error) throw new Error(`NOWNodes ${method}: ${j.error.message ?? "error"}${j.error.code != null ? ` (${j.error.code})` : ""}`);
    s.ok++; s.lastOkAt = Date.now(); s.msTotal += Date.now() - t0;
    return j.result as T;
  } catch (e) {
    s.errors++; s.lastErrorAt = Date.now();
    s.lastError = String((e as Error)?.message ?? e).replace(key, "[key]").slice(0, 200);
    throw e;
  }
}

/** For /v1/status and the Agents page footer: is the lane on, and what went through it. Never the key or the URL's secrets. */
export function nownodesStatus() {
  const methods = Object.fromEntries([...stats].map(([m, s]) => [m, { calls: s.calls, ok: s.ok, errors: s.errors, avgMs: s.ok ? Math.round(s.msTotal / s.ok) : null, lastOkAt: s.lastOkAt, lastError: s.lastError, lastErrorAt: s.lastErrorAt }]));
  const all = [...stats.values()];
  return {
    provider: "NOWNodes", lane: "agent swaps + x402 payments", keySet: nownodesReady(),
    calls: all.reduce((a, s) => a + s.calls, 0), ok: all.reduce((a, s) => a + s.ok, 0), errors: all.reduce((a, s) => a + s.errors, 0),
    lastOkAt: all.reduce<number | null>((a, s) => (s.lastOkAt != null && (a == null || s.lastOkAt > a) ? s.lastOkAt : a), null), methods,
  };
}
export function _resetNowNodes(): void { stats.clear(); setNowNodesFetch(null); }
