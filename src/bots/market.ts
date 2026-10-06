// What the bots read from Jupiter (keyless ≈ 30 calls a minute for the whole box, so everything is cached and batched):
// token facts (liquidity, mint / freeze authority) cached 10 min per mint, USD prices cached 30 s and fetched for many
// mints in one call, and paper quotes through the app's own solQuote (identical asks inside 5 s share one quote).
import { solQuote } from "../trade/solana";
import { KNOWN_MINTS } from "../solana/tokens";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** What a wallet pays with or is paid in: a swap between two of these is not a trade the bots copy. */
export const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** Tests swap the transport for every HTTP call the bots make (Jupiter tokens / prices, Chord's tape, webhooks). */
export function setBotsFetch(f: Fetch | null): void { fetchImpl = f ?? ((...a) => fetch(...a)); }
export const http: Fetch = (input, init) => fetchImpl(input, init);

const jupRoot = () => {
  const v = (process.env.JUPITER_API_URL ?? "").trim().replace(/\/$/, "");
  return v ? v.replace(/\/swap\/v1$/, "") : "https://lite-api.jup.ag";
};
const jupHeaders = (): Record<string, string> => {
  const k = (process.env.JUPITER_API_KEY ?? "").trim();
  return k ? { "x-api-key": k } : {};
};
async function jupGet<T>(path: string): Promise<T> {
  const r = await http(`${jupRoot()}${path}`, { headers: jupHeaders(), signal: AbortSignal.timeout(8_000) });
  if (r.status === 429) throw new Error("Jupiter is rate-limiting (429)");
  if (!r.ok) throw new Error(`Jupiter ${path.split("?")[0]} answered ${r.status}`);
  return (await r.json()) as T;
}

export interface TokenInfo {
  mint: string; symbol: string | null; name: string | null; decimals: number | null; liquidityUsd: number | null; usdPrice: number | null;
  /** true = renounced, false = live, null = Jupiter has no answer */
  mintAuthorityDisabled: boolean | null; freezeAuthorityDisabled: boolean | null; icon: string | null;
}
const INFO_TTL = 10 * 60_000;
const INFO_ERR_TTL = 30_000;
const infoCache = new Map<string, { at: number; v: TokenInfo | null; err?: string }>();
const infoInflight = new Map<string, Promise<TokenInfo | null>>();
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const boolOrNull = (v: unknown) => (typeof v === "boolean" ? v : null);

/** Jupiter's facts about one mint (null = Jupiter does not list it). Throws when Jupiter cannot be read. */
export async function tokenInfo(mint: string): Promise<TokenInfo | null> {
  const hit = infoCache.get(mint);
  if (hit && Date.now() - hit.at < (hit.err ? INFO_ERR_TTL : INFO_TTL)) {
    if (hit.err) throw new Error(hit.err);
    return hit.v;
  }
  const running = infoInflight.get(mint);
  if (running) return running;
  const p = (async () => {
    try {
      const list = await jupGet<any[]>(`/tokens/v2/search?query=${encodeURIComponent(mint)}`);
      const t = Array.isArray(list) ? list.find((x) => x?.id === mint) : null;
      const v: TokenInfo | null = t ? {
        mint, symbol: typeof t.symbol === "string" ? t.symbol : null, name: typeof t.name === "string" ? t.name : null, decimals: numOrNull(t.decimals),
        liquidityUsd: numOrNull(t.liquidity), usdPrice: numOrNull(t.usdPrice),
        mintAuthorityDisabled: boolOrNull(t.audit?.mintAuthorityDisabled), freezeAuthorityDisabled: boolOrNull(t.audit?.freezeAuthorityDisabled),
        icon: typeof t.icon === "string" ? t.icon : null,
      } : null;
      infoCache.set(mint, { at: Date.now(), v });
      if (v?.usdPrice != null) priceCache.set(mint, { at: Date.now(), v: v.usdPrice });
      return v;
    } catch (e) {
      const err = String((e as Error)?.message ?? e).slice(0, 160);
      infoCache.set(mint, { at: Date.now(), v: null, err });
      throw new Error(err);
    } finally {
      infoInflight.delete(mint);
    }
  })();
  infoInflight.set(mint, p);
  return p;
}

/** A symbol without a network call: the majors, or what Jupiter already told us. */
export function knownSymbol(mint: string): string | null {
  return KNOWN_MINTS[mint]?.symbol ?? infoCache.get(mint)?.v?.symbol ?? null;
}

const PRICE_TTL = 30_000;
const PRICE_STALE = 10 * 60_000;
const priceCache = new Map<string, { at: number; v: number | null }>();

/** USD prices for many mints in as few calls as possible (50 ids a call), each cached 30 s; on a failed refresh the last
 *  price up to 10 min old is served. Mints Jupiter does not price are left out of the answer. */
export async function prices(mints: string[]): Promise<Map<string, number>> {
  const now = Date.now();
  const want = [...new Set(mints)];
  const stale = want.filter((m) => { const h = priceCache.get(m); return !h || now - h.at >= PRICE_TTL; });
  for (let i = 0; i < stale.length; i += 50) {
    const ids = stale.slice(i, i + 50);
    try {
      const j = await jupGet<Record<string, { usdPrice?: unknown } | null>>(`/price/v3?ids=${ids.join(",")}`);
      for (const m of ids) {
        const v = numOrNull(j?.[m]?.usdPrice);
        priceCache.set(m, { at: Date.now(), v: v != null && v > 0 ? v : null });
      }
    } catch { /* keep what we had */ }
  }
  const out = new Map<string, number>();
  for (const m of want) {
    const h = priceCache.get(m);
    if (h?.v != null && Date.now() - h.at < PRICE_STALE) out.set(m, h.v);
  }
  return out;
}
/** The cached price, no call (null when unknown or older than 10 min). */
export function cachedPrice(mint: string): number | null {
  const h = priceCache.get(mint);
  return h?.v != null && Date.now() - h.at < PRICE_STALE ? h.v : null;
}

/** A plain decimal string for a positive number (no exponent): what the quote route accepts. */
export function plain(n: number): string {
  if (!Number.isFinite(n) || n <= 0) throw new Error("amount must be a positive number");
  return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

export interface PaperQuote { amountOut: number; priceImpactPct: number | null; route: string[]; outSymbol: string | null; inSymbol: string | null }
const quoteCache = new Map<string, { at: number; p: Promise<PaperQuote> }>();
/** A real Jupiter quote (ExactIn) for `amount` whole units of inMint. */
export function paperQuote(inMint: string, outMint: string, amount: number, slippageBps: number): Promise<PaperQuote> {
  const key = `${inMint}|${outMint}|${plain(amount)}|${slippageBps}`;
  const now = Date.now();
  for (const [k, v] of quoteCache) if (now - v.at > 5_000) quoteCache.delete(k);
  const hit = quoteCache.get(key);
  if (hit) return hit.p;
  const p = solQuote(inMint, outMint, plain(amount), slippageBps).then((q) => ({
    amountOut: Number(q.amountOut), priceImpactPct: q.priceImpactPct, route: q.route, outSymbol: q.tokenOut.symbol ?? null, inSymbol: q.tokenIn.symbol ?? null,
  }));
  p.catch(() => quoteCache.delete(key));
  quoteCache.set(key, { at: now, p });
  return p;
}

export function _resetMarket(): void { infoCache.clear(); infoInflight.clear(); priceCache.clear(); quoteCache.clear(); }
