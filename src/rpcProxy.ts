// /v1/rpc/solana: a same-origin JSON-RPC endpoint for the Privy island (web/privy.tsx). Privy v3's embedded-wallet UIs (the
// "Approve transaction" sheet of signTransaction) need config.solana.rpcs; without it the signing promise never settles and
// the page spins (07/10: a withdraw from the Wallet). Reads and simulations only, through the READ RPC (src/rpc/solana.ts),
// so the RPC key never reaches the browser; sending is the server's own routes' job (never this proxy).
import { Hono } from "hono";
import { rpc } from "./rpc/solana";

export const rpcProxy = new Hono();

const ALLOWED = new Set(["getAccountInfo", "getMultipleAccounts", "getBalance", "getLatestBlockhash", "isBlockhashValid", "getFeeForMessage",
  "getMinimumBalanceForRentExemption", "simulateTransaction", "getSignatureStatuses", "getTokenAccountBalance", "getTokenAccountsByOwner",
  "getTokenSupply", "getEpochInfo", "getSlot", "getBlockHeight", "getRecentPrioritizationFees", "getGenesisHash", "getVersion", "getHealth"]);
const hits = new Map<string, number[]>();
const PER_MIN = 120;
function allow(ip: string): boolean {
  const t = Date.now(), list = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
  if (list.length >= PER_MIN) { hits.set(ip, list); return false; }
  list.push(t); hits.set(ip, list);
  return true;
}
type Req = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
async function one(r: Req) {
  const id = r?.id ?? null;
  if (typeof r?.method !== "string" || !ALLOWED.has(r.method)) return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not available here: ${String(r?.method).slice(0, 40)}` } };
  try { return { jsonrpc: "2.0", id, result: await rpc(r.method, Array.isArray(r.params) ? r.params : []) }; }
  catch (e) {
    const err = e as Error & { code?: number };
    return { jsonrpc: "2.0", id, error: { code: typeof err.code === "number" ? err.code : -32603, message: String(err.message ?? e).replace(/^\w+: /, "").replace(/(https?|wss?):\/\/\S+/g, "[endpoint]").slice(0, 300) } };
  }
}
rpcProxy.post("/solana", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "?";
  const body = (await c.req.json().catch(() => null)) as Req | Req[] | null;
  if (!body) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  const n = Array.isArray(body) ? body.length : 1;
  if (n > 20) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "at most 20 calls per batch" } }, 400);
  for (let i = 0; i < n; i++) if (!allow(ip)) return c.json({ jsonrpc: "2.0", id: null, error: { code: 429, message: `${PER_MIN} calls a minute` } }, 429);
  return c.json(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body));
});
