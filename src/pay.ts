// Redeeming a payment: read it through NOWNodes, check it, record it once, credit the session.
import { config, USDC_MINT } from "./config";
import { creditsFor, redeem, verifyCardanoPayment, verifySolanaPayment, type Verdict } from "./payments";
import { bf } from "./rpc/cardano";
import { getParsedTx } from "./solana/tools";
import { isSignature } from "./solana/tokens";
import { isAdaTxHash } from "./cardano/tools";

export type PayResult = { ok: true; chain: "solana" | "cardano"; paid: number; asset: string; credits: number } | { ok: false; status: number; reason: string };

/** "solana:<sig>" / "cardano:<hash>" (the X-Payment header form) or separate chain + ref. */
export function parsePaymentRef(raw: string | null | undefined): { chain: "solana" | "cardano"; ref: string } | null {
  const m = /^(solana|sol|cardano|ada):([0-9A-Za-z]+)$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const chain = m[1].startsWith("s") ? "solana" : "cardano";
  const ref = chain === "cardano" ? m[2].toLowerCase() : m[2];
  if (chain === "solana" ? !isSignature(ref) : !isAdaTxHash(ref)) return null;
  return { chain, ref };
}

export async function redeemPayment(chain: "solana" | "cardano", ref: string, sessionId: string | null): Promise<PayResult> {
  let v: Verdict;
  let price: number;
  if (chain === "solana") {
    const treasury = config.treasurySol();
    if (!treasury) return { ok: false, status: 503, reason: "Solana payments are not set up on this server (TREASURY_SOL)" };
    price = config.priceUsdc();
    const mint = config.payMint();
    v = verifySolanaPayment(await getParsedTx(ref), { recipient: treasury, mint, minUnits: price, symbol: mint === USDC_MINT ? "USDC" : undefined });
  } else {
    const treasury = config.treasuryAda();
    if (!treasury) return { ok: false, status: 503, reason: "Cardano payments are not set up on this server (TREASURY_ADA)" };
    price = config.priceAda();
    const [tx, utxos] = await Promise.all([bf<any>(`/txs/${ref}`), bf<any>(`/txs/${ref}/utxos`)]);
    v = verifyCardanoPayment(tx, utxos, { recipient: treasury, minAda: price });
  }
  if (!v.ok) return { ok: false, status: 402, reason: v.reason };
  const credits = creditsFor(v.paid, price);
  if (!redeem(`${chain}:${ref}`, chain, sessionId, v.paid, v.asset, credits)) return { ok: false, status: 409, reason: "this payment was already used" };
  return { ok: true, chain, paid: v.paid, asset: v.asset, credits };
}
