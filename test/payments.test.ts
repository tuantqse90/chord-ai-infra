import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import transfer from "./fixtures/usdc-transfer.json";
import failed from "./fixtures/failed.json";
import { parseTx } from "../src/solana/parse";
import { creditsFor, redeem, refundAsk, resetStore, session, spendAsk, verifyCardanoPayment, verifySolanaPayment } from "../src/payments";
import { parsePaymentRef } from "../src/pay";
import { USDC_MINT } from "../src/config";

const RECEIVER = parseTx(transfer.result)!.tokenChanges.find((c) => c.amount > 0)!.owner;
const SIG = transfer.result.transaction.signatures[0];

describe("Solana payment verification (real transfer of 9.435174 USDC)", () => {
  const tx = parseTx(transfer.result);
  it("accepts the right recipient, mint and a price at or below the amount", () => {
    expect(verifySolanaPayment(tx, { recipient: RECEIVER, mint: USDC_MINT, minUnits: 9.435174 })).toEqual({ ok: true, paid: 9.435174, asset: USDC_MINT });
    expect(verifySolanaPayment(tx, { recipient: RECEIVER, mint: USDC_MINT, minUnits: 0.1, symbol: "USDC" }).ok).toBe(true);
  });
  it("rejects a short payment", () => {
    const v = verifySolanaPayment(tx, { recipient: RECEIVER, mint: USDC_MINT, minUnits: 10 });
    expect(v.ok).toBe(false);
    expect((v as any).reason).toContain("price is 10");
  });
  it("rejects the wrong recipient (the payer itself) and the wrong mint", () => {
    expect(verifySolanaPayment(tx, { recipient: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", mint: USDC_MINT, minUnits: 1 }).ok).toBe(false);
    expect(verifySolanaPayment(tx, { recipient: RECEIVER, mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", minUnits: 1 }).ok).toBe(false);
  });
  it("rejects a failed transaction and a missing one", () => {
    expect(verifySolanaPayment(parseTx(failed.result), { recipient: RECEIVER, mint: USDC_MINT, minUnits: 0.01 }).ok).toBe(false);
    expect(verifySolanaPayment(null, { recipient: RECEIVER, mint: USDC_MINT, minUnits: 0.01 })).toEqual({ ok: false, reason: "transaction not found or not finalized yet" });
  });
});

describe("Cardano payment verification", () => {
  const T = "addr1q9treasury000000000000000000000000000000000000000000000000000000000000000000000000000000000x";
  const utxos = { outputs: [
    { address: T, amount: [{ unit: "lovelace", quantity: "300000" }, { unit: "abc", quantity: "5" }] },
    { address: T, amount: [{ unit: "lovelace", quantity: "250000" }] },
    { address: "addr1qother", amount: [{ unit: "lovelace", quantity: "9000000" }] },
  ] };
  it("sums every output to the treasury", () => {
    expect(verifyCardanoPayment({ block: "b", valid_contract: true }, utxos, { recipient: T, minAda: 0.5 })).toEqual({ ok: true, paid: 0.55, asset: "ADA" });
  });
  it("rejects short, unconfirmed, invalid and missing", () => {
    expect(verifyCardanoPayment({ block: "b", valid_contract: true }, utxos, { recipient: T, minAda: 1 }).ok).toBe(false);
    expect(verifyCardanoPayment({ block: null, valid_contract: true }, utxos, { recipient: T, minAda: 0.1 }).ok).toBe(false);
    expect(verifyCardanoPayment({ block: "b", valid_contract: false }, utxos, { recipient: T, minAda: 0.1 }).ok).toBe(false);
    expect(verifyCardanoPayment(null, null, { recipient: T, minAda: 0.1 }).ok).toBe(false);
  });
});

describe("store: free asks, credits, one redemption per reference", () => {
  beforeEach(() => { process.env.DB_PATH = ":memory:"; process.env.FREE_ASKS = "2"; resetStore(); });
  afterEach(() => { resetStore(); delete process.env.FREE_ASKS; });

  it("spends free asks, then credits, then refuses", () => {
    expect(spendAsk("sess-aaaa1")).toEqual({ ok: true, source: "free" });
    expect(spendAsk("sess-aaaa1")).toEqual({ ok: true, source: "free" });
    expect(spendAsk("sess-aaaa1")).toEqual({ ok: false });
    expect(redeem(`solana:${SIG}`, "solana", "sess-aaaa1", 0.3, "USDC", creditsFor(0.3, 0.1))).toBe(true);
    expect(session("sess-aaaa1").credits).toBe(3);
    expect(spendAsk("sess-aaaa1")).toEqual({ ok: true, source: "credit" });
    refundAsk("sess-aaaa1", "credit");
    expect(session("sess-aaaa1").credits).toBe(3);
  });
  it("a payment reference redeems once (replay → false)", () => {
    expect(redeem(`solana:${SIG}`, "solana", "sess-bbbb1", 1, "USDC", 10)).toBe(true);
    expect(redeem(`solana:${SIG}`, "solana", "sess-cccc1", 1, "USDC", 10)).toBe(false);
    expect(session("sess-cccc1").credits).toBe(0);
  });
  it("credits: floor(paid / price), at least one", () => {
    expect(creditsFor(0.3, 0.1)).toBe(3);
    expect(creditsFor(0.1, 0.1)).toBe(1);
    expect(creditsFor(9.435174, 0.1)).toBe(94);
  });
});

describe("payment reference parsing", () => {
  it("accepts solana:<sig> and cardano:<hash>, rejects junk", () => {
    expect(parsePaymentRef(`solana:${SIG}`)).toEqual({ chain: "solana", ref: SIG });
    expect(parsePaymentRef(`ada:${"AB".repeat(32)}`)).toEqual({ chain: "cardano", ref: "ab".repeat(32) });
    expect(parsePaymentRef("solana:short")).toBeNull();
    expect(parsePaymentRef("eth:0x1")).toBeNull();
  });
});
