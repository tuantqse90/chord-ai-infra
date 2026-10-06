import { describe, expect, it } from "bun:test";
import transfer from "./fixtures/usdc-transfer.json";
import swap from "./fixtures/swap.json";
import failed from "./fixtures/failed.json";
import { parseTx, summarize } from "../src/solana/parse";
import { decodeMetadata, isPubkey, isSignature, metadataPda } from "../src/solana/tokens";
import { USDC_MINT } from "../src/config";

const PAYER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

describe("parseTx on real mainnet transactions", () => {
  it("a USDC transfer: one owner down, one owner up, same raw amount", () => {
    const t = parseTx(transfer.result)!;
    expect(t.ok).toBe(true);
    expect(t.signature.startsWith("5zpWe5sy")).toBe(true);
    const usdc = t.tokenChanges.filter((c) => c.mint === USDC_MINT);
    expect(usdc).toHaveLength(2);
    const out = usdc.find((c) => c.owner === PAYER)!;
    const into = usdc.find((c) => c.owner !== PAYER)!;
    expect(out.raw).toBe("-9435174");
    expect(into.raw).toBe("9435174");
    expect(into.amount).toBeCloseTo(9.435174, 6);
    expect(t.feeLamports).toBe(15000);
    expect(t.actions).toContain("spl-token:transferChecked");
    expect(summarize(t, (m) => (m === USDC_MINT ? "USDC" : null))).toContain("+9.435174 USDC");
  });

  it("a swap: several owners and mints move; zero deltas are dropped", () => {
    const t = parseTx(swap.result)!;
    expect(t.ok).toBe(true);
    expect(t.tokenChanges.every((c) => c.raw !== "0")).toBe(true);
    expect(t.tokenChanges.some((c) => c.mint === USDC_MINT && c.amount < 0)).toBe(true);
    expect(t.programs).not.toContain("ComputeBudget111111111111111111111111111111");
  });

  it("a failed transaction reports the error and moves no tokens", () => {
    const t = parseTx(failed.result)!;
    expect(t.ok).toBe(false);
    expect(t.error).toBeTruthy();
    expect(t.tokenChanges).toHaveLength(0);
    expect(summarize(t)).toStartWith("failed");
  });

  it("null in, null out", () => {
    expect(parseTx(null)).toBeNull();
  });
});

describe("token helpers", () => {
  it("validates addresses and signatures", () => {
    expect(isPubkey(USDC_MINT)).toBe(true);
    expect(isPubkey("0x754704bc059f8c67012fed69bc8a327a5aafb603")).toBe(false);
    expect(isSignature(transfer.result.transaction.signatures[0])).toBe(true);
  });
  it("derives the Metaplex metadata PDA of USDC", () => {
    expect(metadataPda(USDC_MINT)).toBe("5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq");
  });
  it("decodes a Metaplex metadata account", () => {
    const str = (s: string, pad: number) => { const b = Buffer.alloc(4 + pad); b.writeUInt32LE(pad, 0); b.write(s, 4); return b; };
    const data = Buffer.concat([Buffer.from([4]), Buffer.alloc(64), str("Bonk", 32), str("BONK", 10), str("https://x", 200)]);
    expect(decodeMetadata(data)).toEqual({ name: "Bonk", symbol: "BONK", uri: "https://x" });
  });
});
