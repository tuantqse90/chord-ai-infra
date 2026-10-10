// What the agents read about Monad tokens, all from Chord's API (src/monad/chord.ts): the token list (symbol, decimals,
// liquidity, tax, verified mark; 10 min), the price map (30 s; per-token stats for a token the map lacks), and real router
// quotes (GET /v1/quote, ExactIn) that price every paper fill. Decimals a list does not carry are read on-chain once.
// Identical quote asks inside 5 s share one call. Addresses are lower case everywhere in the engine.
import { erc20Abi } from "viem";
import { ChordHttpError, chordMonad } from "../monad/chord";
import { addQuoteToken, isAddress, isQuoteToken, lower, MONAD_CHAIN_ID, NATIVE, USDC, WMON } from "../monad/chain";
import { publicClient } from "../monad/client";

/** The engine's quote currency: every paper buy spends USDC and every sell is paid in USDC. */
export const USDC_MINT = USDC;
/** The chain's own coin (wrapped), the reference a DCA template buys. */
export const NATIVE_MINT = WMON;
/** A swap whose token is one of these (USDC, AUSD, USDT0, WMON, MON) is not a trade the agents copy. */
export const QUOTE_MINTS = { has: (m: string) => isQuoteToken(m) };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** Tests swap the transport for the webhooks the agents post. */
export function setBotsFetch(f: Fetch | null): void { fetchImpl = f ?? ((...a) => fetch(...a)); }
export const http: Fetch = (input, init) => fetchImpl(input, init);

const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

// ── the token list ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface ListToken { address: string; symbol: string; name: string | null; decimals: number; logoURI: string | null; liquidityUsd: number | null; taxPct: number | null; verified: boolean | null }
const LIST_TTL = 10 * 60_000;
let list: { at: number; map: Map<string, ListToken> } | null = null;
let listInflight: Promise<Map<string, ListToken>> | null = null;

/** Chord's Monad token list, keyed by lower-case address (the last good list is kept when a refresh fails). */
export async function tokenList(): Promise<Map<string, ListToken>> {
  if (list && Date.now() - list.at < LIST_TTL) return list.map;
  if (listInflight) return listInflight;
  listInflight = (async () => {
    try {
      const j = await chordMonad<{ tokens?: any[] }>(`/tokens?chain=${MONAD_CHAIN_ID}`);
      const map = new Map<string, ListToken>();
      for (const t of Array.isArray(j?.tokens) ? j.tokens : []) {
        if (!isAddress(t?.address) || typeof t.symbol !== "string" || !Number.isInteger(t.decimals)) continue;
        const row: ListToken = { address: lower(t.address), symbol: t.symbol, name: typeof t.name === "string" ? t.name : null, decimals: t.decimals,
          logoURI: typeof t.logoURI === "string" ? t.logoURI : null, liquidityUsd: numOrNull(t.liquidityUsd), taxPct: numOrNull(t.taxPct), verified: typeof t.verified === "boolean" ? t.verified : null };
        map.set(row.address, row);
        if (isQuoteToken(row.address, row.symbol)) addQuoteToken(row.address);
      }
      if (!map.size) throw new Error("Chord's Monad token list came back empty");
      list = { at: Date.now(), map };
      return map;
    } catch (e) {
      if (list) return list.map;
      throw e;
    } finally {
      listInflight = null;
    }
  })();
  return listInflight;
}

// ── token facts ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface TokenInfo {
  mint: string; symbol: string | null; name: string | null; decimals: number | null; liquidityUsd: number | null; usdPrice: number | null;
  /** buy / sell tax in %, from Chord's tax probe (null = not probed) */
  taxPct: number | null;
  /** Chord's verified mark (the curated Monad token list) */
  verified: boolean | null;
  icon: string | null;
}
const INFO_TTL = 10 * 60_000;
const INFO_ERR_TTL = 30_000;
const infoCache = new Map<string, { at: number; v: TokenInfo | null; err?: string }>();
const infoInflight = new Map<string, Promise<TokenInfo | null>>();
const decimalsCache = new Map<string, number>();
const symbolCache = new Map<string, string>();

/** Decimals of a token: the list, else an on-chain read (kept forever). The native coin is 18. */
export async function decimalsOf(addr: string): Promise<number> {
  const a = lower(addr);
  if (a === NATIVE) return 18;
  const hit = decimalsCache.get(a);
  if (hit != null) return hit;
  const t = (await tokenList().catch(() => null))?.get(a);
  if (t) { decimalsCache.set(a, t.decimals); return t.decimals; }
  const d = Number(await publicClient().readContract({ address: a as `0x${string}`, abi: erc20Abi, functionName: "decimals" }));
  if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error(`${a} answered no usable decimals`);
  decimalsCache.set(a, d);
  return d;
}

/** Facts about one token (null = neither Chord nor the chain knows it as a token). Throws when Chord cannot be read. */
export async function tokenInfo(mint: string): Promise<TokenInfo | null> {
  const a = lower(mint);
  const hit = infoCache.get(a);
  if (hit && Date.now() - hit.at < (hit.err ? INFO_ERR_TTL : INFO_TTL)) {
    if (hit.err) throw new Error(hit.err);
    return hit.v;
  }
  const running = infoInflight.get(a);
  if (running) return running;
  const p = (async () => {
    try {
      const t = (await tokenList()).get(a) ?? null;
      let stats: any = null;
      try { stats = await chordMonad<any>(`/tokens/stats/${a}`); } catch (e) { if (!(e instanceof ChordHttpError && e.status === 404)) throw e; }
      let symbol = t?.symbol ?? symbolCache.get(a) ?? null, decimals: number | null = t?.decimals ?? null;
      if (!t) {
        try {
          const [s, d] = await Promise.all([
            publicClient().readContract({ address: a as `0x${string}`, abi: erc20Abi, functionName: "symbol" }),
            publicClient().readContract({ address: a as `0x${string}`, abi: erc20Abi, functionName: "decimals" }),
          ]);
          symbol = symbol ?? String(s).slice(0, 24);
          decimals = Number(d);
          decimalsCache.set(a, decimals);
        } catch { /* not an ERC-20 the chain can describe */ }
      }
      const v: TokenInfo | null = t || stats || decimals != null ? {
        mint: a, symbol, name: t?.name ?? null, decimals,
        liquidityUsd: numOrNull(stats?.liquidityUsd) ?? t?.liquidityUsd ?? null, usdPrice: numOrNull(stats?.priceUsd),
        taxPct: t?.taxPct ?? null, verified: t?.verified ?? null, icon: t?.logoURI ?? null,
      } : null;
      infoCache.set(a, { at: Date.now(), v });
      if (v?.usdPrice != null) priceCache.set(a, { at: Date.now(), v: v.usdPrice });
      if (v?.symbol) symbolCache.set(a, v.symbol);
      return v;
    } catch (e) {
      const err = String((e as Error)?.message ?? e).slice(0, 160);
      infoCache.set(a, { at: Date.now(), v: null, err });
      throw new Error(err);
    } finally {
      infoInflight.delete(a);
    }
  })();
  infoInflight.set(a, p);
  return p;
}

/** Remember a symbol a trade row carried (the large-trade feed names tokens the curated list does not). */
export function noteSymbol(mint: string, symbol: string | null | undefined): void {
  if (symbol && !symbolCache.has(lower(mint))) symbolCache.set(lower(mint), symbol.slice(0, 24));
}
/** A symbol without a network call: the list, a trade row, or what an earlier lookup found. */
export function knownSymbol(mint: string): string | null {
  const a = lower(mint);
  return list?.map.get(a)?.symbol ?? symbolCache.get(a) ?? infoCache.get(a)?.v?.symbol ?? null;
}

// ── prices ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const PRICE_TTL = 30_000;
const PRICE_STALE = 10 * 60_000;
const STATS_PER_CALL = 8;
const priceCache = new Map<string, { at: number; v: number | null }>();
let marketAt = 0;

/** USD prices for many tokens: Chord's Monad price map (one call, 30 s), then per-token stats for at most 8 tokens the map
 *  lacks. On a failed refresh the last price up to 10 min old is served; tokens nobody prices are left out. */
export async function prices(mints: string[]): Promise<Map<string, number>> {
  const want = [...new Set(mints.map(lower))];
  if (Date.now() - marketAt >= PRICE_TTL && want.some((m) => { const h = priceCache.get(m); return !h || Date.now() - h.at >= PRICE_TTL; })) {
    try {
      const j = await chordMonad<{ market?: Record<string, { priceUsd?: unknown }> }>(`/tokens/market?chain=${MONAD_CHAIN_ID}`);
      const now = Date.now();
      for (const [k, v] of Object.entries(j?.market ?? {})) { const p = numOrNull(v?.priceUsd); if (p != null && p > 0) priceCache.set(lower(k), { at: now, v: p }); }
      marketAt = now;
    } catch { /* keep what we had */ }
  }
  const missing = want.filter((m) => { const h = priceCache.get(m); return !h || Date.now() - h.at >= PRICE_TTL; }).slice(0, STATS_PER_CALL);
  await Promise.all(missing.map(async (m) => {
    try { const s = await chordMonad<any>(`/tokens/stats/${m}`); const p = numOrNull(s?.priceUsd); priceCache.set(m, { at: Date.now(), v: p != null && p > 0 ? p : null }); } catch { /* unpriced this round */ }
  }));
  const out = new Map<string, number>();
  for (const m of want) {
    const h = priceCache.get(m);
    if (h?.v != null && Date.now() - h.at < PRICE_STALE) out.set(m, h.v);
  }
  return out;
}
/** The cached price, no call (null when unknown or older than 10 min). */
export function cachedPrice(mint: string): number | null {
  const h = priceCache.get(lower(mint));
  return h?.v != null && Date.now() - h.at < PRICE_STALE ? h.v : null;
}

// ── quotes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A plain decimal string for a positive number (no exponent). */
export function plain(n: number): string {
  if (!Number.isFinite(n) || n <= 0) throw new Error("amount must be a positive number");
  return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}
/** Whole units (a decimal string) to the token's smallest unit, exactly. */
export function toUnits(amount: string, decimals: number): bigint {
  const [i, f = ""] = amount.split(".");
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
export const fromUnits = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

export interface PaperQuote { amountOut: number; priceImpactPct: number | null; route: string[]; outSymbol: string | null; inSymbol: string | null; feeBps: number | null }
const quoteCache = new Map<string, { at: number; p: Promise<PaperQuote> }>();

/** A real router quote on Monad (Chord's GET /v1/quote, ExactIn) for `amount` whole units of inMint; amountOut is what
 *  arrives after the router's fee when the fee is taken in the output token. */
export function paperQuote(inMint: string, outMint: string, amount: number, slippageBps: number): Promise<PaperQuote> {
  const a = lower(inMint), b = lower(outMint);
  const key = `${a}|${b}|${plain(amount)}|${slippageBps}`;
  const now = Date.now();
  for (const [k, v] of quoteCache) if (now - v.at > 5_000) quoteCache.delete(k);
  const hit = quoteCache.get(key);
  if (hit) return hit.p;
  const p = (async (): Promise<PaperQuote> => {
    const [di, dout] = await Promise.all([decimalsOf(a), decimalsOf(b)]);
    const wei = toUnits(plain(amount), di);
    if (wei <= 0n) throw new Error("amount rounds to zero");
    let q: any;
    try {
      q = await chordMonad<any>(`/quote?inputMint=${a}&outputMint=${b}&amount=${wei}&slippageBps=${slippageBps}&chain=${MONAD_CHAIN_ID}`, 12_000);
    } catch (e) {
      if (e instanceof ChordHttpError && e.code === "TAXED_TOKEN") throw new Error("the router does not trade taxed tokens");
      throw e;
    }
    if (typeof q?.outputAmount !== "string") throw new Error(q?.noRouteReason ? `no route: ${String(q.noRouteReason).slice(0, 80)}` : "the router answered without an amount");
    let out = BigInt(q.outputAmount);
    if (typeof q.feeAmount === "string" && typeof q.feeMint === "string" && lower(q.feeMint) === b) out -= BigInt(q.feeAmount);
    const route = [...new Set((Array.isArray(q.routePlan) ? q.routePlan : []).map((r: any) => String(r?.swapInfo?.dex ?? "")).filter(Boolean))] as string[];
    return { amountOut: fromUnits(out > 0n ? out : 0n, dout), priceImpactPct: numOrNull(q.priceImpactPct), route, outSymbol: knownSymbol(b), inSymbol: knownSymbol(a), feeBps: numOrNull(q.feeBps) };
  })();
  p.catch(() => quoteCache.delete(key));
  quoteCache.set(key, { at: now, p });
  return p;
}

export function _resetMarket(): void { infoCache.clear(); infoInflight.clear(); priceCache.clear(); quoteCache.clear(); decimalsCache.clear(); symbolCache.clear(); list = null; listInflight = null; marketAt = 0; }
