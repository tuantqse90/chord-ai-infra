// A followed wallet's swap read from balances, not instructions (works for every venue and router): net SOL (native plus
// WSOL, the fee given back when the wallet paid it), net USDC + USDT, and every other mint whose balance the wallet's own
// token accounts changed.
//   received token X and paid SOL / USDC / USDT  → buy X
//   sent token X and was paid SOL / USDC / USDT  → sell X
//   sent exactly one token and received exactly one other → sell the one, buy the other (token-to-token route)
//   only SOL / USDC / USDT moved (quote-to-quote), or a token moved with no payment (a transfer, an airdrop) → nothing
import type { ParsedTx } from "../solana/parse";
import { QUOTE_MINTS, SOL_MINT, USDC_MINT, USDT_MINT } from "./market";
import type { SourceTrade } from "./types";

/** Below these a quote leg is noise (rent for a token account is 0.002 SOL, fees and tips are less). */
export const SOL_MIN = 0.005;
export const USD_MIN = 0.5;

export type DetectedTrade = Omit<SourceTrade, "via">;

export function detectSwaps(tx: ParsedTx, wallet: string, solUsd: number | null, nowMs = Date.now()): DetectedTrade[] {
  if (!tx.ok) return [];
  let lamports = 0;
  for (const c of tx.solChanges) if (c.account === wallet) lamports += Number(c.lamports);
  if (tx.feePayer === wallet) lamports += tx.feeLamports;
  let usdStable = 0;
  const tokens: { mint: string; amount: number }[] = [];
  for (const t of tx.tokenChanges) {
    if (t.owner !== wallet) continue;
    if (t.mint === SOL_MINT) lamports += Number(t.raw);
    else if (t.mint === USDC_MINT || t.mint === USDT_MINT) usdStable += t.amount;
    else if (!QUOTE_MINTS.has(t.mint) && t.amount !== 0) tokens.push({ mint: t.mint, amount: t.amount });
  }
  const sol = lamports / 1e9;
  const received = tokens.filter((t) => t.amount > 0);
  const sent = tokens.filter((t) => t.amount < 0);
  const paid = sol <= -SOL_MIN || usdStable <= -USD_MIN;
  const gotPaid = sol >= SOL_MIN || usdStable >= USD_MIN;
  // USD of the quote leg in one direction (-1 = paid out, +1 = paid in); null when SOL is part of it and its price is unknown.
  const legUsd = (dir: 1 | -1): number | null => {
    const s = dir * sol >= SOL_MIN ? dir * sol : 0;
    const u = dir * usdStable >= USD_MIN ? dir * usdStable : 0;
    if (s > 0 && solUsd == null) return null;
    return s * (solUsd ?? 0) + u;
  };
  const ts = tx.blockTime ? tx.blockTime * 1000 : nowMs;
  const make = (side: "buy" | "sell", t: { mint: string; amount: number }, usd: number | null): DetectedTrade => {
    const qty = Math.abs(t.amount);
    return { wallet, tx: tx.signature, side, mint: t.mint, symbol: null, usd, priceUsd: usd != null && qty > 0 ? usd / qty : null, ts };
  };
  if (received.length && !sent.length && paid) {
    const usd = legUsd(-1);
    return received.map((t) => make("buy", t, received.length === 1 ? usd : null));
  }
  if (sent.length && !received.length && gotPaid) {
    const usd = legUsd(1);
    return sent.map((t) => make("sell", t, sent.length === 1 ? usd : null));
  }
  if (sent.length === 1 && received.length === 1) return [make("sell", sent[0], null), make("buy", received[0], null)];
  return [];
}
