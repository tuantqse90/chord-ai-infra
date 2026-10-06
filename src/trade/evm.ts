// EVM swaps through Chord's router (/v1/meta/quote). With `taker` the same call returns the unsigned transaction, the approval
// to send first and a simulation run as that wallet; the browser wallet signs and sends both.
import { config } from "../config";
import { fromRaw, toRaw, TradeError } from "./amounts";
import { EVM, NATIVE, type EvmChain, type TradeToken } from "./chains";

const api = () => config.chordApi() || "https://api.getchord.xyz";
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (...a) => fetch(...a);
export function setChordFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

const listCache = new Map<EvmChain, { at: number; v: TradeToken[] }>();
export async function evmTokens(chain: EvmChain): Promise<TradeToken[]> {
  const hit = listCache.get(chain);
  if (hit && Date.now() - hit.at < 600_000) return hit.v;
  const def = EVM[chain];
  const r = await fetchImpl(`${api()}/v1/tokens?chain=${def.id}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new TradeError(`token list for ${def.name} is unavailable`, 502);
  const j: any = await r.json();
  const raw: any[] = Array.isArray(j) ? j : j.tokens ?? [];
  const seen = new Set<string>();
  const list: TradeToken[] = [];
  if (def.native) list.push({ address: NATIVE, symbol: def.native.symbol, name: def.native.name, decimals: def.native.decimals, logoURI: null });
  for (const t of raw) {
    const a = String(t.address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a) || seen.has(a) || a === NATIVE || t.decimals == null) continue;
    seen.add(a);
    list.push({ address: a, symbol: String(t.symbol ?? "?"), name: String(t.name ?? ""), decimals: Number(t.decimals), logoURI: t.logoURI ?? null });
  }
  // The native gas token borrows its wrapped token's logo (WETH for ETH, WBNB for BNB, ...).
  if (def.native && list[0]?.address === NATIVE) list[0].logoURI = list.find((t) => t.symbol.toUpperCase() === `W${def.native!.symbol}`)?.logoURI ?? null;
  const rank = (t: TradeToken) => { if (t.address === NATIVE) return -1; const i = def.pin.findIndex((p) => p.toLowerCase() === t.symbol.toLowerCase()); return i < 0 ? 1e6 : i; };
  list.sort((a, b) => rank(a) - rank(b));
  listCache.set(chain, { at: Date.now(), v: list });
  return list;
}

export async function evmToken(chain: EvmChain, addressOrSymbol: string): Promise<TradeToken> {
  const q = addressOrSymbol.trim().toLowerCase();
  const list = await evmTokens(chain);
  const hit = list.find((t) => t.address === q) ?? list.find((t) => t.symbol.toLowerCase() === q);
  if (!hit) throw new TradeError(`${addressOrSymbol} is not in Chord's token list for ${EVM[chain].name}`);
  return hit;
}

export async function evmQuote(chain: EvmChain, tokenIn: string, tokenOut: string, amount: string, slippageBps: number, taker?: string | null) {
  const def = EVM[chain];
  const [inTok, outTok] = await Promise.all([evmToken(chain, tokenIn), evmToken(chain, tokenOut)]);
  if (inTok.address === outTok.address) throw new TradeError("pick two different tokens");
  const raw = toRaw(amount, inTok.decimals);
  if (taker && !/^0x[0-9a-fA-F]{40}$/.test(taker)) throw new TradeError("wallet must be an EVM address");
  const qs = new URLSearchParams({ chain: String(def.id), tokenIn: inTok.address, tokenOut: outTok.address, amount: raw, slippageBps: String(slippageBps), ...(taker ? { taker } : {}) });
  const r = await fetchImpl(`${api()}/v1/meta/quote?${qs}`, { signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new TradeError(j.message ?? `quote failed (${r.status})`, r.status >= 500 ? 502 : 400);
  if (!j.provider) throw new TradeError("no route for this pair right now");
  if (String(j.amountIn) !== raw) throw new TradeError("the router answered a different amount than the one asked", 502);
  return {
    chain, chainId: def.id, provider: j.provider === "chord" ? "Chord router" : j.provider, fallbackReason: j.fallbackReason ?? null,
    quoteId: j.quoteId, expiresAt: j.expiresAt, tokenIn: inTok, tokenOut: outTok, amountIn: fromRaw(raw, inTok.decimals), amountInRaw: raw,
    amountOut: fromRaw(j.amountOut, outTok.decimals), minAmountOut: fromRaw(j.minAmountOut, outTok.decimals),
    priceImpactPct: j.priceImpactPct != null ? Number(j.priceImpactPct) : null, route: (j.route?.venues ?? []) as string[],
    feeBps: Number(j.feeBps ?? 0), slippageBps, warnings: (j.warnings ?? []) as string[],
    tx: j.tx ?? null, approval: j.approval ?? null, simulation: j.simulation ?? null,
    wallet: { hex: def.hex, name: def.name, rpc: def.rpc, native: def.native, explorer: def.explorer },
  };
}
