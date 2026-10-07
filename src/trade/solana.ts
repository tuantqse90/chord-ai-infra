// Solana swaps through Jupiter. The server quotes and builds; the browser wallet signs; the server relays the signed
// transaction through the app's own Solana RPC, and only a transaction whose message it built itself (no open relay).
import { VersionedTransaction } from "@solana/web3.js";
import { createHash, randomUUID } from "node:crypto";
import { rpc } from "../rpc/solana";
import { isPubkey } from "../solana/tokens";
import { offensiveName } from "../tokenNames";
import { fromRaw, toRaw, TradeError } from "./amounts";
import type { TradeToken } from "./chains";

const jupBase = () => (process.env.JUPITER_API_URL ?? "").trim().replace(/\/$/, "") || "https://lite-api.jup.ag/swap/v1";
const tokBase = () => jupBase().replace(/\/swap\/v1$/, "/tokens/v2");
const jupHeaders = (): Record<string, string> => {
  const k = (process.env.JUPITER_API_KEY ?? "").trim();
  return { "Content-Type": "application/json", ...(k ? { "x-api-key": k } : {}) };
};

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (...a) => fetch(...a);
export function setJupiterFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a));
}
async function jup<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetchImpl(url, { ...init, headers: jupHeaders(), signal: AbortSignal.timeout(12_000) });
  const text = await r.text();
  if (r.status === 429) throw new TradeError("Jupiter is rate-limiting quotes right now, try again in a few seconds", 503);
  if (!r.ok) {
    let msg = text.slice(0, 160);
    try { const j = JSON.parse(text); msg = j.error ?? j.message ?? msg; } catch { /* keep text */ }
    throw new TradeError(`Jupiter: ${msg}`, r.status >= 500 ? 502 : 400);
  }
  return JSON.parse(text) as T;
}

export const SOL_MAJORS = [
  "So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
];
type JupToken = { id: string; symbol: string; name: string; decimals: number; icon?: string | null; isVerified?: boolean | null };
const toToken = (t: JupToken): TradeToken => ({ address: t.id, symbol: t.id === SOL_MAJORS[0] ? "SOL" : t.symbol, name: t.id === SOL_MAJORS[0] ? "Solana" : t.name, decimals: t.decimals, logoURI: t.icon ?? null, verified: t.isVerified === true });

const tokCache = new Map<string, { at: number; v: TradeToken[] }>();
async function searchTokens(query: string): Promise<TradeToken[]> {
  const hit = tokCache.get(query);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.v;
  const list = await jup<JupToken[]>(`${tokBase()}/search?query=${encodeURIComponent(query)}`);
  const v = list.map(toToken);
  tokCache.set(query, { at: Date.now(), v });
  return v;
}

/** A text search drops slur names and copies of a verified token: an unverified token whose symbol or name is a verified
 *  one's in the same answer (a second "Bonk" under the real one). A pasted mint is shown whatever it is called. */
export function pickable(list: TradeToken[], q: string): TradeToken[] {
  if (isPubkey(q)) return list;
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const real = new Set(list.filter((t) => t.verified).flatMap((t) => [key(t.symbol), key(t.name)]));
  return list.filter((t) => !offensiveName(t.symbol, t.name) && (t.verified || (!real.has(key(t.symbol)) && !real.has(key(t.name)))));
}

/** The picker list: majors in a fixed order, or a search (symbol, name or mint). */
export async function solTokens(q?: string): Promise<TradeToken[]> {
  if (q && q.trim()) return pickable(await searchTokens(q.trim()), q.trim()).slice(0, 25);
  const got = await searchTokens(SOL_MAJORS.join(","));
  return SOL_MAJORS.map((m) => got.find((t) => t.address === m)).filter((t): t is TradeToken => !!t);
}

/** One token by mint: Jupiter's list when it knows it, else decimals read on-chain. */
export async function solToken(mint: string): Promise<TradeToken> {
  if (!isPubkey(mint)) throw new TradeError("not a Solana mint address");
  const known = (await searchTokens(mint).catch(() => [])).find((t) => t.address === mint);
  if (known) return known;
  const acc = await rpc<{ value: any }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const info = acc?.value?.data?.parsed;
  if (info?.type !== "mint") throw new TradeError("this address is not a token mint");
  return { address: mint, symbol: `${mint.slice(0, 4)}…`, name: "Unknown token", decimals: info.info.decimals, logoURI: null };
}

// Quotes and built transactions are remembered for two minutes: the client refers to them, it never sends them back.
const TTL = 120_000;
const quotes = new Map<string, { at: number; quote: any; inTok: TradeToken; outTok: TradeToken }>();
const built = new Map<string, number>(); // sha256(message) → built at
const sweep = () => { const now = Date.now(); for (const [k, v] of quotes) if (now - v.at > TTL) quotes.delete(k); for (const [k, at] of built) if (now - at > TTL) built.delete(k); };

export async function solQuote(inMint: string, outMint: string, amount: string, slippageBps: number) {
  if (inMint === outMint) throw new TradeError("pick two different tokens");
  const [inTok, outTok] = await Promise.all([solToken(inMint), solToken(outMint)]);
  const raw = toRaw(amount, inTok.decimals);
  const q = await jup<any>(`${jupBase()}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${raw}&slippageBps=${slippageBps}&swapMode=ExactIn`);
  if (q.inputMint !== inMint || q.outputMint !== outMint || q.inAmount !== raw) throw new TradeError("Jupiter answered a different quote than the one asked", 502);
  sweep();
  const quoteId = randomUUID();
  quotes.set(quoteId, { at: Date.now(), quote: q, inTok, outTok });
  return {
    chain: "solana" as const, provider: "Jupiter", quoteId, expiresAt: Math.floor((Date.now() + TTL) / 1000),
    tokenIn: inTok, tokenOut: outTok, amountIn: fromRaw(raw, inTok.decimals), amountInRaw: raw,
    amountOut: fromRaw(q.outAmount, outTok.decimals), minAmountOut: fromRaw(q.otherAmountThreshold, outTok.decimals),
    priceImpactPct: q.priceImpactPct != null ? +(Number(q.priceImpactPct) * 100).toFixed(4) : null,
    route: [...new Set((q.routePlan ?? []).map((r: any) => r.swapInfo?.label).filter(Boolean))] as string[],
    feeBps: 0, slippageBps, valueUsd: q.swapUsdValue != null ? Number(q.swapUsdValue) : null,
  };
}

const messageHash = (tx: VersionedTransaction) => createHash("sha256").update(tx.message.serialize()).digest("hex");

/** wrapAndUnwrapSol false (auto-trade): SOL stays wrapped in the wallet's wSOL account, so the transaction holds no System
 *  transfer and no Token close / sync instruction, only Jupiter, ComputeBudget and an idempotent ATA create. */
export async function solBuild(quoteId: string, user: string, opts: { wrapAndUnwrapSol?: boolean } = {}) {
  sweep();
  const q = quotes.get(quoteId);
  if (!q) throw new TradeError("this quote expired, ask for a new one", 410);
  if (!isPubkey(user)) throw new TradeError("wallet must be a Solana address");
  const r = await jup<{ swapTransaction: string; lastValidBlockHeight: number }>(`${jupBase()}/swap`, {
    method: "POST",
    body: JSON.stringify({ quoteResponse: q.quote, userPublicKey: user, wrapAndUnwrapSol: opts.wrapAndUnwrapSol ?? true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "medium" } } }),
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, "base64"));
  if (tx.message.staticAccountKeys[0]?.toBase58() !== user) throw new TradeError("the built transaction is not paid by this wallet", 502);
  built.set(messageHash(tx), Date.now());
  return { transaction: r.swapTransaction, lastValidBlockHeight: r.lastValidBlockHeight };
}

/** Relay a signed transaction, only when the server built its message in the last two minutes. */
export async function solSend(signedB64: string) {
  sweep();
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(signedB64, "base64")); } catch { throw new TradeError("not a Solana transaction"); }
  if (!built.has(messageHash(tx))) throw new TradeError("this server only relays swaps it prepared in the last two minutes", 403);
  if (!tx.signatures[0] || tx.signatures[0].every((b) => b === 0)) throw new TradeError("the transaction is not signed");
  const sig = await rpc<string>("sendTransaction", [signedB64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
  return { signature: sig };
}

export async function solStatus(sig: string) {
  const r = await rpc<{ value: ({ confirmationStatus: string; err: unknown } | null)[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: false }]);
  const s = r?.value?.[0];
  return { signature: sig, status: s?.confirmationStatus ?? "pending", error: s?.err ? JSON.stringify(s.err) : null };
}

/** For checks only: run the built (unsigned) transaction as the wallet would, without sending it. */
export async function solSimulate(b64: string) {
  const r = await rpc<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
  return { ok: r.value.err == null, error: r.value.err ? JSON.stringify(r.value.err) : null, units: r.value.unitsConsumed ?? null };
}

export const _test = { messageHash, built, quotes };
