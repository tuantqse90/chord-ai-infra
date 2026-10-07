// The x402 facilitator (src/x402.ts), offline: a real client keypair signs a real "exact" payment; NOWNodes is faked.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from "@solana/web3.js";
import bs58 from "bs58";
import { USDC } from "../src/bots/_testkit";
const X = await import("../src/x402");
const NN = await import("../src/nownodes");

const FP = Keypair.fromSeed(new Uint8Array(32).fill(3)), CLIENT = Keypair.fromSeed(new Uint8Array(32).fill(5)), OTHER = Keypair.fromSeed(new Uint8Array(32).fill(6));
const PAY_TO = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
const ATA = new PublicKey(X.TOKEN_PROGRAM ? "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" : "");
const ataOf = (o: PublicKey | string, mint = USDC, program = X.TOKEN_PROGRAM) =>
  PublicKey.findProgramAddressSync([new PublicKey(o).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()], ATA)[0];
const BH = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey.toBase58();
const MEMO = "x402:00112233aabbccdd";
const prevKey = process.env.NOWNODES_API_KEY;

type Opt = { units?: bigint; dest?: PublicKey; feePayer?: PublicKey; price?: number; limit?: number; memo?: string | null; extra?: TransactionInstruction[]; fpInMemo?: boolean;
  sign?: boolean; lighthouse?: boolean; lut?: boolean; authority?: Keypair };
function payment(o: Opt = {}): string {
  const auth = o.authority ?? CLIENT;
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(o.units ?? 1_000_000n, 1); data[9] = 6;
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: o.limit ?? 50_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.price ?? 100_000 }),
    new TransactionInstruction({ programId: new PublicKey(X.TOKEN_PROGRAM), data, keys: [
      { pubkey: ataOf(auth.publicKey), isSigner: false, isWritable: true }, { pubkey: new PublicKey(USDC), isSigner: false, isWritable: false },
      { pubkey: o.dest ?? ataOf(PAY_TO), isSigner: false, isWritable: true }, { pubkey: auth.publicKey, isSigner: true, isWritable: false }] }),
  ];
  if (o.lighthouse) ixs.push(new TransactionInstruction({ programId: new PublicKey(X.LIGHTHOUSE), keys: [{ pubkey: ataOf(auth.publicKey), isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) }));
  if (o.memo !== null) ixs.push(new TransactionInstruction({ programId: new PublicKey(X.MEMO_PROGRAM), keys: o.fpInMemo ? [{ pubkey: FP.publicKey, isSigner: true, isWritable: false }] : [], data: Buffer.from(o.memo ?? MEMO) }));
  ixs.push(...(o.extra ?? []));
  const luts = o.lut ? [new AddressLookupTableAccount({ key: OTHER.publicKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [new PublicKey(USDC)] } })] : [];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: o.feePayer ?? FP.publicKey, recentBlockhash: BH, instructions: ixs }).compileToV0Message(luts));
  if (o.sign !== false) tx.sign([auth]);
  return Buffer.from(tx.serialize()).toString("base64");
}
const REQ = () => X.requirements({ units: 1_000_000n, payTo: PAY_TO, asset: USDC, decimals: 6, memo: MEMO });

const calls: { method: string; params: any[] }[] = [];
let simErr: unknown = null, statusErr: unknown = null, accts: (object | null)[] = [{ owner: X.TOKEN_PROGRAM }, { owner: X.TOKEN_PROGRAM }];
beforeEach(() => {
  process.env.NOWNODES_API_KEY = "test-key";
  X._resetX402(FP); X._setX402Sleep(async () => {}); calls.length = 0; simErr = null; statusErr = null;
  accts = [{ owner: X.TOKEN_PROGRAM }, { owner: X.TOKEN_PROGRAM }];
  NN.setNowNodesFetch(async (_u, init) => {
    const b = JSON.parse(String(init?.body)); calls.push({ method: b.method, params: b.params });
    const result = b.method === "getMultipleAccounts" ? { value: accts }
      : b.method === "simulateTransaction" ? { value: { err: simErr, logs: simErr ? ["Program log: Error: insufficient funds"] : [] } }
      : b.method === "sendTransaction" ? bs58.encode(VersionedTransaction.deserialize(Buffer.from(b.params[0], "base64")).signatures[0])
      : b.method === "getSignatureStatuses" ? { value: [{ err: statusErr, confirmationStatus: "confirmed" }] } : null;
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  });
});
afterAll(() => { X._resetX402(); X._setX402Sleep(null); NN._resetNowNodes(); if (prevKey === undefined) delete process.env.NOWNODES_API_KEY; else process.env.NOWNODES_API_KEY = prevKey; });

describe("requirements and payloads", () => {
  it("v2 requirements name our fee payer and the buyer's memo; v1 twin and the PAYMENT-REQUIRED header", () => {
    const r = REQ();
    expect(r).toMatchObject({ scheme: "exact", network: X.SOLANA_CAIP2, amount: "1000000", asset: USDC, payTo: PAY_TO, extra: { feePayer: FP.publicKey.toBase58(), memo: MEMO, decimals: 6 } });
    expect(X.v1Of(r, "https://x/y", "d")).toMatchObject({ network: "solana", maxAmountRequired: "1000000", resource: "https://x/y" });
    const h = JSON.parse(Buffer.from(X.paymentRequiredHeader(r, "https://x/y", "d"), "base64").toString());
    expect(h).toMatchObject({ x402Version: 2, resource: { url: "https://x/y" }, accepts: [{ network: X.SOLANA_CAIP2 }] });
  });
  it("decodes PAYMENT-SIGNATURE (v2) and X-PAYMENT (v1); the legacy solana:<sig> and other networks are not x402 payloads", () => {
    const tx = payment(), b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    expect(X.decodePayment(b64({ x402Version: 2, accepted: REQ(), payload: { transaction: tx } }))).toMatchObject({ version: 2, transaction: tx });
    expect(X.decodePayment(b64({ x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: tx } }))).toMatchObject({ version: 1, transaction: tx });
    expect(X.decodePayment("solana:" + "5".repeat(88))).toBeNull();
    expect(X.decodePayment(b64({ x402Version: 2, accepted: { ...REQ(), network: "eip155:8453" }, payload: { transaction: tx } }))).toBeNull();
    expect(X.decodePayment("not base64 json")).toBeNull();
  });
});

describe("the facilitator's checks", () => {
  it("a well-formed payment passes; Phantom's Lighthouse instruction is allowed", () => {
    expect(X.checkExact(payment(), REQ())).toMatchObject({ payer: CLIENT.publicKey.toBase58(), units: 1_000_000n, destination: ataOf(PAY_TO).toBase58() });
    expect(X.checkExact(payment({ lighthouse: true }), REQ()).payer).toBe(CLIENT.publicKey.toBase58());
  });
  const bad: [string, Opt | (() => [string, ReturnType<typeof REQ>]), string][] = [
    ["another amount", { units: 999_999n }, "invalid_amount"],
    ["another destination", { dest: ataOf(OTHER.publicKey) }, "invalid_destination"],
    ["another fee payer", { feePayer: OTHER.publicKey }, "invalid_fee_payer"],
    ["the fee payer inside an instruction", { fpInMemo: true }, "fee_payer_in_instruction"],
    ["a compute price above the cap", { price: 5_000_001 }, "invalid_compute_price"],
    ["a compute limit above the cap", { limit: 400_001 }, "invalid_compute_limit"],
    ["an extra System transfer", { extra: [SystemProgram.transfer({ fromPubkey: CLIENT.publicKey, toPubkey: OTHER.publicKey, lamports: 1 })] }, "invalid_instructions"],
    ["no memo", { memo: null }, "invalid_memo"],
    ["another memo", { memo: "x402:ffffffffffffffff" }, "invalid_memo"],
    ["the payer did not sign", { sign: false }, "invalid_signature"],
    ["a lookup table", { lut: true }, "invalid_transaction"],
  ];
  for (const [what, o, code] of bad) {
    it(`refused: ${what}`, () => {
      let err: unknown = null;
      try { X.checkExact(payment(o as Opt), REQ()); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(X.X402Error);
      expect((err as InstanceType<typeof X.X402Error>).code).toBe(code);
    });
  }
  it("refused: the fee payer as the transfer authority", () => {
    let err: any = null;
    try { X.checkExact(payment({ authority: FP }), REQ()); } catch (e) { err = e; }
    expect(["fee_payer_in_instruction", "fee_payer_transfer"]).toContain(err?.code);
  });
  it("no fee payer configured: off", () => {
    X._resetX402(null);
    expect(X.facilitatorReady()).toBe(false);
    expect(() => X.checkExact(payment(), { ...REQ(), extra: { feePayer: FP.publicKey.toBase58() } } as any)).toThrow();
  });
});

describe("verify and settle through NOWNodes", () => {
  it("verify reads both token accounts and simulates; a missing destination or a failing simulation is invalid", async () => {
    expect(await X.verify(payment(), REQ())).toEqual({ isValid: true, payer: CLIENT.publicKey.toBase58() });
    expect(calls.map((c) => c.method)).toEqual(["getMultipleAccounts", "simulateTransaction"]);
    accts = [{ owner: X.TOKEN_PROGRAM }, null];
    expect(await X.verify(payment(), REQ())).toMatchObject({ isValid: false, invalidReason: "destination_missing" });
    accts = [{ owner: X.TOKEN_PROGRAM }, { owner: X.TOKEN_PROGRAM }]; simErr = { InstructionError: [2, { Custom: 1 }] };
    expect(await X.verify(payment(), REQ())).toMatchObject({ isValid: false, invalidReason: "simulation_failed", message: "the payer does not hold enough of the asset" });
  });
  it("settle co-signs as fee payer only, sends through NOWNodes, waits for confirmed; the same payload never settles twice", async () => {
    const tx = payment();
    const s = await X.settle(tx, REQ());
    expect(s).toMatchObject({ success: true, payer: CLIENT.publicKey.toBase58(), network: X.SOLANA_CAIP2, amount: "1000000" });
    const sent = VersionedTransaction.deserialize(Buffer.from(calls.find((c) => c.method === "sendTransaction")!.params[0], "base64"));
    expect(sent.signatures.every((x) => x.some((b) => b !== 0))).toBe(true); // both slots filled
    expect(s.transaction).toBe(bs58.encode(sent.signatures[0]));
    expect(calls.map((c) => c.method)).toEqual(["getMultipleAccounts", "simulateTransaction", "sendTransaction", "getSignatureStatuses"]);
    expect(await X.settle(tx, REQ())).toMatchObject({ success: false, errorReason: "duplicate_settlement" });
  });
  it("a payment that fails on chain is reported, not settled", async () => {
    statusErr = { InstructionError: [2, { Custom: 1 }] };
    expect(await X.settle(payment({ units: 1_000_000n, memo: MEMO }), REQ())).toMatchObject({ success: false, errorReason: "transaction_failed" });
  });
});
