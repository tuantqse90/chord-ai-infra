import { afterEach, describe, expect, it } from "bun:test";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { fromRaw, toRaw } from "../src/trade/amounts";
import { _test, setJupiterFetch, solQuote, solSend } from "../src/trade/solana";
import { evmQuote, setChordFetch } from "../src/trade/evm";
import { setSolanaFetch } from "../src/rpc/solana";

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { setJupiterFetch(null); setChordFetch(null); setSolanaFetch(null); });

describe("amounts", () => {
  it("decimal strings to raw and back, no floats", () => {
    expect(toRaw("0.1", 6)).toBe("100000");
    expect(toRaw("25", 9)).toBe("25000000000");
    expect(toRaw("1.23456789", 6)).toBe("1234567");
    expect(fromRaw("3677976983845065", 18)).toBe("0.003677976983845065");
    expect(fromRaw("100000", 6)).toBe("0.1");
    expect(fromRaw("5000000", 6)).toBe("5");
    expect(() => toRaw("0", 6)).toThrow();
    expect(() => toRaw("-1", 6)).toThrow();
    expect(() => toRaw("1e5", 6)).toThrow();
  });
});

function unsignedTx(): { tx: VersionedTransaction; payer: Keypair } {
  const payer = Keypair.generate();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: "11111111111111111111111111111111",
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey("4azvt8Lo1pDmxhJ5FEJsAGX3fa1FwB51pgeA36ziaj41"), lamports: 1 })] }).compileToV0Message();
  return { tx: new VersionedTransaction(msg), payer };
}

describe("Solana relay only sends what the server built", () => {
  it("refuses a transaction it did not build", async () => {
    const { tx, payer } = unsignedTx();
    tx.sign([payer]);
    await expect(solSend(Buffer.from(tx.serialize()).toString("base64"))).rejects.toThrow("only relays swaps it prepared");
  });
  it("refuses an unsigned one it built, sends a signed one through the app's RPC", async () => {
    const { tx, payer } = unsignedTx();
    _test.built.set(_test.messageHash(tx), Date.now());
    await expect(solSend(Buffer.from(tx.serialize()).toString("base64"))).rejects.toThrow("not signed");
    tx.sign([payer]);
    let method = "";
    setSolanaFetch(async (_u, init) => { method = JSON.parse(String(init?.body)).method; return json({ jsonrpc: "2.0", id: 1, result: "SIG123" }); });
    expect(await solSend(Buffer.from(tx.serialize()).toString("base64"))).toEqual({ signature: "SIG123" });
    expect(method).toBe("sendTransaction");
  });
  it("not a transaction at all", async () => {
    await expect(solSend("bm90IGEgdHg=")).rejects.toThrow();
  });
});

describe("Solana quote", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL = "So11111111111111111111111111111111111111112";
  const jupiter = (quote: object) => setJupiterFetch(async (u) => {
    if (u.includes("/tokens/v2/search")) {
      const q = decodeURIComponent(u.split("query=")[1]);
      return json([{ id: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, icon: null }, { id: SOL, symbol: "SOL", name: "Wrapped SOL", decimals: 9, icon: null }].filter((t) => q.includes(t.id)));
    }
    return json(quote);
  });
  it("normalizes amounts, impact in percent, route labels, and remembers the quote by id", async () => {
    jupiter({ inputMint: USDC, outputMint: SOL, inAmount: "10000000", outAmount: "82622411", otherAmountThreshold: "82209299", priceImpactPct: "0.0004",
      routePlan: [{ swapInfo: { label: "Orca" } }, { swapInfo: { label: "Orca" } }, { swapInfo: { label: "Raydium" } }] });
    const q = await solQuote(USDC, SOL, "10", 50);
    expect(q).toMatchObject({ amountIn: "10", amountOut: "0.082622411", minAmountOut: "0.082209299", priceImpactPct: 0.04, route: ["Orca", "Raydium"], provider: "Jupiter" });
    expect(_test.quotes.has(q.quoteId)).toBe(true);
  });
  it("rejects a quote for a different amount than asked", async () => {
    jupiter({ inputMint: USDC, outputMint: SOL, inAmount: "999", outAmount: "1", otherAmountThreshold: "1", routePlan: [] });
    await expect(solQuote(USDC, SOL, "10", 50)).rejects.toThrow("different quote");
  });
});

describe("EVM quote via Chord's router", () => {
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const chord = (meta: object) => setChordFetch(async (u) => u.includes("/v1/tokens")
    ? json([{ address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6 }, { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether", decimals: 18 }])
    : json(meta));
  it("native ETH is in the list; tx, approval and simulation pass through", async () => {
    chord({ amountIn: "10000000", provider: "chord", amountOut: "3677976983845065", minAmountOut: "3659587098925840", priceImpactPct: "0.0000",
      route: { venues: ["aerodrome_slipstream_3"] }, feeBps: 0, quoteId: "q1", tx: { to: "0x1b1f", data: "0x", value: "0" }, approval: { token: USDC }, simulation: { ok: true } });
    const q = await evmQuote("base", "USDC", "ETH", "10", 50, "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A");
    expect(q).toMatchObject({ provider: "Chord router", amountOut: "0.003677976983845065", route: ["aerodrome_slipstream_3"], simulation: { ok: true } });
    expect(q.tokenOut.symbol).toBe("ETH");
    expect(q.wallet.hex).toBe("0x2105");
  });
  it("no provider = no route; a different amount = refused", async () => {
    chord({ amountIn: "10000000", provider: null });
    await expect(evmQuote("bnb", "USDC", "WETH", "10", 50)).rejects.toThrow("no route");
    chord({ amountIn: "1", provider: "chord", amountOut: "1", minAmountOut: "1" });
    await expect(evmQuote("avalanche", "USDC", "WETH", "10", 50)).rejects.toThrow("different amount");
  });
});
