// x402 "exact" on Solana, the facilitator side (spec: github.com/coinbase/x402 specs/schemes/exact/scheme_exact_svm.md, v2;
// HTTP transport specs/transports-v2/http.md). The client builds and signs a USDC TransferChecked whose fee payer is OUR
// facilitator key; we check every instruction, co-sign as fee payer only, send it, and wait for it to confirm. Every read, the
// simulation, the send and the status go through NOWNodes (src/nownodes.ts), never another RPC.
//   requirements(): PaymentRequirements v2 (CAIP-2 network, amount, extra.feePayer, extra.memo) and its v1 twin (network "solana",
//   maxAmountRequired) · decodePayment(): PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1) → the transaction · verify() / settle().
// The fee payer key is X402_FEE_PAYER_SECRET (base58 or a JSON byte array); without it the facilitator is off and the marketplace
// keeps its legacy flow (the buyer sends the USDC, then X-PAYMENT: solana:<signature>).
import { createPublicKey, verify as edVerify } from "node:crypto";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { NowNodesOffError, nowRpc, nownodesReady } from "./nownodes";

export const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"; // Phantom adds 1, Solflare 2 (allowed by the spec)
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const MAX_CU_PRICE = 5_000_000n;   // micro-lamports per CU: the reference implementations' cap
export const MAX_CU_LIMIT = 400_000;      // ours: with the price cap, at most 0.002 SOL of priority fee per settlement
const SETTLE_CONFIRM_MS = 45_000;
const INFLIGHT_MS = 120_000;              // twice a blockhash's lifetime (the spec's duplicate-settlement cache)

export class X402Error extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "X402Error"; }
}
export type Requirements = {
  scheme: "exact"; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number;
  extra: { feePayer: string; memo?: string; name?: string; decimals?: number };
};

// ── the fee payer ────────────────────────────────────────────────────────────────────────────────────────────────────────
let kp: Keypair | null | undefined;
export function feePayer(): Keypair | null {
  if (kp !== undefined) return kp;
  const raw = (process.env.X402_FEE_PAYER_SECRET ?? "").trim();
  try { kp = raw ? Keypair.fromSecretKey(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw)) : null; }
  catch { kp = null; }
  return kp;
}
export function _resetX402(k?: Keypair | null): void { kp = k === undefined ? undefined : k; inflight.clear(); funded = { ok: !!k, lamports: k ? 1e9 : 0, at: 0 }; }
// the fee payer's SOL, read through NOWNodes every minute: an empty fee payer never advertises (the legacy path stays)
export const MIN_FEE_PAYER_LAMPORTS = 2_000_000;
let funded = { ok: false, lamports: 0, at: 0 };
export async function refreshFunded(): Promise<void> {
  const fp = feePayer();
  if (!fp || !nownodesReady()) { funded = { ok: false, lamports: 0, at: Date.now() }; return; }
  try {
    const r = await nowRpc<{ value: number }>("getBalance", [fp.publicKey.toBase58(), { commitment: "confirmed" }]);
    const lamports = Number(r?.value ?? 0);
    funded = { ok: lamports >= MIN_FEE_PAYER_LAMPORTS, lamports, at: Date.now() };
  } catch { /* keep the last reading */ }
}
let timer: ReturnType<typeof setInterval> | null = null;
/** On boot: read the fee payer's balance now and every minute (only when a fee payer is configured). */
export function initX402(): void {
  if (timer || !feePayer()) return;
  void refreshFunded();
  timer = setInterval(() => void refreshFunded(), 60_000);
  (timer as any).unref?.();
}
export const facilitatorStatus = () => ({ feePayer: feePayer()?.publicKey.toBase58() ?? null, lamports: funded.lamports, funded: funded.ok, checkedAt: funded.at || null });
export const facilitatorReady = () => !!feePayer() && nownodesReady() && funded.ok;

// ── requirements ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export function requirements(o: { units: bigint; payTo: string; asset: string; decimals: number; memo?: string; timeoutS?: number; name?: string }): Requirements {
  const fp = feePayer();
  if (!fp) throw new X402Error("facilitator_off", "no fee payer configured");
  return { scheme: "exact", network: SOLANA_CAIP2, amount: o.units.toString(), asset: o.asset, payTo: o.payTo, maxTimeoutSeconds: o.timeoutS ?? 120,
    extra: { feePayer: fp.publicKey.toBase58(), ...(o.memo ? { memo: o.memo } : {}), name: o.name ?? "USDC", decimals: o.decimals } };
}
/** The v1 shape of the same requirements (x402Version 1 bodies: network "solana", maxAmountRequired). */
export const v1Of = (r: Requirements, resource: string, description: string) => ({
  scheme: r.scheme, network: "solana", maxAmountRequired: r.amount, asset: r.asset, payTo: r.payTo, resource, description, mimeType: "application/json",
  maxTimeoutSeconds: r.maxTimeoutSeconds, extra: r.extra,
});
/** PAYMENT-REQUIRED (v2): base64 JSON of { x402Version: 2, error, resource, accepts }. */
export const paymentRequiredHeader = (r: Requirements, resource: string, description: string, error = "payment_required") =>
  Buffer.from(JSON.stringify({ x402Version: 2, error, resource: { url: resource, description, mimeType: "application/json" }, accepts: [r] })).toString("base64");
export const settlementHeader = (s: Settlement) => Buffer.from(JSON.stringify(s)).toString("base64");

/** PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1): base64 JSON with payload.transaction. null = not an x402 payload (or not exact/Solana). */
export function decodePayment(h: string | null | undefined): { version: 1 | 2; transaction: string; accepted: Partial<Requirements> | null } | null {
  const s = String(h ?? "").trim();
  if (!s || /^solana:/i.test(s)) return null;
  let j: any;
  try { j = JSON.parse(Buffer.from(s, "base64").toString("utf8")); } catch { return null; }
  const tx = j?.payload?.transaction;
  if (typeof tx !== "string" || !tx) return null;
  if (j.x402Version === 2) {
    const a = j.accepted ?? {};
    if (a.scheme && a.scheme !== "exact") return null;
    if (a.network && a.network !== SOLANA_CAIP2) return null;
    return { version: 2, transaction: tx, accepted: a };
  }
  if (j.x402Version === 1 && (j.scheme ?? "exact") === "exact" && (j.network ?? "solana") === "solana") return { version: 1, transaction: tx, accepted: null };
  return null;
}

// ── static checks (the spec's MUSTs) ─────────────────────────────────────────────────────────────────────────────────────
const ataOf = (owner: string, mint: string, program: string) =>
  PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58();
export type Checked = { tx: VersionedTransaction; payer: string; source: string; destination: string; units: bigint; clientSig: string };
/** Throws X402Error(invalidReason) unless the transaction is exactly the payment the requirements ask for. */
export function checkExact(txB64: string, r: Requirements): Checked {
  const fp = feePayer();
  if (!fp) throw new X402Error("facilitator_off", "no fee payer configured");
  const FP = fp.publicKey.toBase58();
  if (r.scheme !== "exact" || r.network !== SOLANA_CAIP2) throw new X402Error("unsupported_scheme", "only exact on Solana mainnet");
  if (r.extra?.feePayer !== FP) throw new X402Error("invalid_fee_payer", "the requirements name another fee payer");
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(txB64, "base64")); } catch { throw new X402Error("invalid_transaction", "the payload is not a Solana versioned transaction"); }
  const m = tx.message;
  if (m.addressTableLookups.length) throw new X402Error("invalid_transaction", "address lookup tables are not accepted: every account must be in the message");
  const keys = m.staticAccountKeys.map((k) => k.toBase58());
  if (keys[0] !== FP) throw new X402Error("invalid_fee_payer", "the transaction's fee payer is not this facilitator");
  const ixs = m.compiledInstructions;
  if (ixs.length < 3 || ixs.length > 6) throw new X402Error("invalid_instructions", `3 to 6 instructions expected, got ${ixs.length}`);
  // the fee payer never appears in any instruction's accounts (so it can only pay the fee)
  for (const ix of ixs) if (ix.accountKeyIndexes.some((i) => i === 0)) throw new X402Error("fee_payer_in_instruction", "the fee payer appears in an instruction");
  const prog = (i: number) => keys[ixs[i].programIdIndex];
  const data = (i: number) => Buffer.from(ixs[i].data);
  // 1-2: compute budget, limit then price, both bounded
  if (prog(0) !== COMPUTE_BUDGET || data(0)[0] !== 2 || data(0).length < 5) throw new X402Error("invalid_compute_limit", "instruction 1 must set the compute unit limit");
  if (data(0).readUInt32LE(1) > MAX_CU_LIMIT) throw new X402Error("invalid_compute_limit", `compute unit limit above ${MAX_CU_LIMIT}`);
  if (prog(1) !== COMPUTE_BUDGET || data(1)[0] !== 3 || data(1).length < 9) throw new X402Error("invalid_compute_price", "instruction 2 must set the compute unit price");
  if (data(1).readBigUInt64LE(1) > MAX_CU_PRICE) throw new X402Error("invalid_compute_price", `compute unit price above ${MAX_CU_PRICE} micro-lamports`);
  // 3: TransferChecked of the asset, exactly the amount, into payTo's associated token account
  const tp = prog(2);
  if (tp !== TOKEN_PROGRAM && tp !== TOKEN_2022) throw new X402Error("invalid_transfer", "instruction 3 must be an SPL Token or Token-2022 TransferChecked");
  const d = data(2);
  if (d.length !== 10 || d[0] !== 12) throw new X402Error("invalid_transfer", "instruction 3 is not TransferChecked");
  const [source, mint, destination, authority] = ixs[2].accountKeyIndexes.map((i) => keys[i]);
  if (!source || !mint || !destination || !authority) throw new X402Error("invalid_transfer", "TransferChecked accounts missing");
  if (mint !== r.asset) throw new X402Error("invalid_asset", "the transfer is not of the required asset");
  if (r.extra?.decimals != null && d[9] !== r.extra.decimals) throw new X402Error("invalid_transfer", "TransferChecked decimals do not match the asset");
  const units = d.readBigUInt64LE(1);
  if (units.toString() !== r.amount) throw new X402Error("invalid_amount", `the transfer is ${units} units, the requirement is ${r.amount}`);
  if (destination !== ataOf(r.payTo, mint, tp)) throw new X402Error("invalid_destination", "the destination is not payTo's associated token account");
  if (authority === FP || source === ataOf(FP, mint, tp)) throw new X402Error("fee_payer_transfer", "the fee payer cannot be the payer");
  // 4-6: only Lighthouse or Memo; exactly one memo, equal to extra.memo when the requirements set one
  const memos: string[] = [];
  for (let i = 3; i < ixs.length; i++) {
    if (prog(i) === MEMO_PROGRAM) memos.push(data(i).toString("utf8"));
    else if (prog(i) !== LIGHTHOUSE) throw new X402Error("invalid_instructions", `instruction ${i + 1} is not Memo or Lighthouse`);
  }
  if (memos.length !== 1) throw new X402Error("invalid_memo", `exactly one Memo instruction expected, got ${memos.length}`);
  if (r.extra?.memo != null && memos[0] !== r.extra.memo) throw new X402Error("invalid_memo", "the memo does not match the requirements");
  // signatures: the fee payer's slot empty (ours to fill), the authority signed this message
  const ai = keys.indexOf(authority);
  if (ai < 1 || ai >= m.header.numRequiredSignatures) throw new X402Error("invalid_signature", "the transfer authority is not a signer");
  if (m.header.numRequiredSignatures !== 2) throw new X402Error("invalid_signature", "exactly two signers expected: the fee payer and the payer");
  const sig = tx.signatures[ai];
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(new PublicKey(authority).toBytes()).toString("base64url") }, format: "jwk" });
  if (!sig || sig.every((b) => b === 0) || !edVerify(null, Buffer.from(m.serialize()), pub, Buffer.from(sig))) throw new X402Error("invalid_signature", "the payer's signature is missing or wrong");
  return { tx, payer: authority, source, destination, units, clientSig: bs58.encode(sig) };
}

// ── verify / settle (NOWNodes) ───────────────────────────────────────────────────────────────────────────────────────────
type Acct = { value: ({ owner?: string } | null)[] };
export type Verified = { isValid: true; payer: string } | { isValid: false; invalidReason: string; message: string; payer?: string };
export async function verify(txB64: string, r: Requirements): Promise<Verified> {
  let c: Checked;
  try { c = checkExact(txB64, r); } catch (e) { return e instanceof X402Error ? { isValid: false, invalidReason: e.code, message: e.message } : { isValid: false, invalidReason: "invalid_payload", message: String((e as Error).message) }; }
  try {
    const a = await nowRpc<Acct>("getMultipleAccounts", [[c.source, c.destination], { encoding: "base64", commitment: "confirmed" }]);
    if (!a?.value?.[0]) return { isValid: false, invalidReason: "source_missing", message: "the payer has no token account for this asset", payer: c.payer };
    if (!a?.value?.[1]) return { isValid: false, invalidReason: "destination_missing", message: "payTo has no token account for this asset yet", payer: c.payer };
    const sim = await nowRpc<{ value: { err: unknown; logs?: string[] } }>("simulateTransaction", [txB64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }]);
    if (sim?.value?.err != null) {
      const logs = (sim.value.logs ?? []).join(" ");
      const why = /insufficient funds/i.test(logs) ? "the payer does not hold enough of the asset" : /BlockhashNotFound/i.test(JSON.stringify(sim.value.err)) ? "the transaction's blockhash expired: sign a fresh one" : JSON.stringify(sim.value.err);
      return { isValid: false, invalidReason: "simulation_failed", message: why, payer: c.payer };
    }
  } catch (e) {
    if (e instanceof NowNodesOffError) return { isValid: false, invalidReason: "facilitator_off", message: e.message, payer: c.payer };
    return { isValid: false, invalidReason: "unexpected_verify_error", message: String((e as Error).message).slice(0, 160), payer: c.payer };
  }
  return { isValid: true, payer: c.payer };
}

export type Settlement = { success: boolean; errorReason?: string; message?: string; payer: string; transaction: string; network: string; amount?: string };
const inflight = new Map<string, number>();
let sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
export function _setX402Sleep(f: ((ms: number) => Promise<void>) | null): void { sleep = f ?? ((ms) => new Promise((res) => setTimeout(res, ms))); }
/** verify → co-sign as fee payer → send through NOWNodes → wait until confirmed. One payload settles once (in flight 120 s). */
export async function settle(txB64: string, r: Requirements): Promise<Settlement> {
  const fail = (errorReason: string, message: string, payer = "", transaction = ""): Settlement => ({ success: false, errorReason, message, payer, transaction, network: SOLANA_CAIP2 });
  const v = await verify(txB64, r);
  if (!v.isValid) return fail(v.invalidReason, v.message, v.payer);
  const c = checkExact(txB64, r);
  const now = Date.now();
  for (const [k, t] of inflight) if (now - t > INFLIGHT_MS) inflight.delete(k);
  if (inflight.has(c.clientSig)) return fail("duplicate_settlement", "this payment is already being settled", c.payer, c.clientSig);
  inflight.set(c.clientSig, now);
  c.tx.sign([feePayer()!]); // fills only the fee payer's slot; the payer's signature stays as signed
  const signed = Buffer.from(c.tx.serialize()).toString("base64");
  let sig: string;
  try { sig = await nowRpc<string>("sendTransaction", [signed, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]); }
  catch (e) { inflight.delete(c.clientSig); return fail("send_failed", String((e as Error).message).slice(0, 200), c.payer); }
  const t0 = Date.now();
  while (Date.now() - t0 < SETTLE_CONFIRM_MS) {
    await sleep(1_500);
    let st: { err: unknown; confirmationStatus?: string } | null = null;
    try { st = (await nowRpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]))?.value?.[0] ?? null; } catch { continue; }
    if (!st) continue;
    if (st.err != null) return fail("transaction_failed", JSON.stringify(st.err), c.payer, sig);
    if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return { success: true, payer: c.payer, transaction: sig, network: SOLANA_CAIP2, amount: r.amount };
  }
  return fail("settlement_timeout", `sent but not confirmed within ${SETTLE_CONFIRM_MS / 1000} s; check ${sig} on Solscan`, c.payer, sig);
}
