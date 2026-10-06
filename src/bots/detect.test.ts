import { describe, expect, it } from "bun:test";
import { parseTx } from "../solana/parse";
import { addr, rawTx, SOL, USDC } from "./_testkit";
import { detectSwaps } from "./detect";

const W = addr(1), POOL = addr(2), X = addr(3), Y = addr(4);
const parse = (o: Parameters<typeof rawTx>[0]) => parseTx(rawTx(o))!;

describe("swap detection from a parsed transaction", () => {
  it("paid 1 SOL, received X = buy X, valued at the SOL price", () => {
    const tx = parse({ sig: "S1", payer: W, sol: [{ account: W, pre: 10e9, post: 10e9 - 1e9 - 5000 }, { account: POOL, pre: 5e9, post: 6e9 }],
      tokens: [{ owner: W, mint: X, post: "1000000000", decimals: 6 }, { owner: POOL, mint: X, pre: "9000000000", post: "8000000000", decimals: 6 }] });
    expect(detectSwaps(tx, W, 150)).toEqual([{ wallet: W, tx: "S1", side: "buy", mint: X, symbol: null, usd: 150, priceUsd: 0.15, ts: 1_800_000_000_000 }]);
    expect(detectSwaps(tx, W, null)[0].usd).toBeNull(); // SOL leg with no SOL price: size unknown, still a buy
  });
  it("paid WSOL from a token account = buy too", () => {
    const tx = parse({ sig: "S2", payer: W, tokens: [{ owner: W, mint: SOL, pre: "3000000000", post: "1000000000", decimals: 9 }, { owner: W, mint: X, pre: "0", post: "500000000", decimals: 6 }] });
    const [t] = detectSwaps(tx, W, 150);
    expect(t).toMatchObject({ side: "buy", mint: X, usd: 300, priceUsd: 0.6 });
  });
  it("sent X, received USDC = sell X", () => {
    const tx = parse({ sig: "S3", payer: W, tokens: [{ owner: W, mint: X, pre: "500000000", post: "0", decimals: 6 }, { owner: W, mint: USDC, pre: "1000000", post: "76000000", decimals: 6 }] });
    expect(detectSwaps(tx, W, 150)).toEqual([{ wallet: W, tx: "S3", side: "sell", mint: X, symbol: null, usd: 75, priceUsd: 0.15, ts: 1_800_000_000_000 }]);
  });
  it("a plain token transfer in or out is not a trade (rent refunds included)", () => {
    const inbound = parse({ sig: "T1", payer: addr(9), sol: [{ account: addr(9), pre: 1e9, post: 1e9 - 5000 }], tokens: [{ owner: W, mint: X, post: "1000", decimals: 6 }, { owner: addr(9), mint: X, pre: "1000", post: "0", decimals: 6 }] });
    expect(detectSwaps(inbound, W, 150)).toEqual([]);
    const out = parse({ sig: "T2", payer: W, sol: [{ account: W, pre: 1e9, post: 1e9 - 5000 + 2_039_280 }], tokens: [{ owner: W, mint: X, pre: "1000", post: "0", decimals: 6 }] });
    expect(detectSwaps(out, W, 150)).toEqual([]);
  });
  it("quote-to-quote is ignored (real USDC → SOL swap fixture)", async () => {
    const j = await Bun.file(new URL("../../test/fixtures/swap.json", import.meta.url).pathname).json();
    const tx = parseTx(j.result)!;
    expect(detectSwaps(tx, "DUyKGiyZDWgMoRaz1MCZSvqGDTfCZcvD7G6iM8joi2KT", 150)).toEqual([]);
  });
  it("a failed transaction is nothing; token to token = sell one, buy the other", () => {
    expect(detectSwaps(parse({ sig: "F", payer: W, err: { InstructionError: [0, "Custom"] }, tokens: [{ owner: W, mint: X, post: "1", decimals: 0 }, { owner: W, mint: USDC, pre: "9000000", post: "0", decimals: 6 }] }), W, 150)).toEqual([]);
    const tt = parse({ sig: "TT", payer: W, tokens: [{ owner: W, mint: X, pre: "100", post: "0", decimals: 0 }, { owner: W, mint: Y, pre: "0", post: "7", decimals: 0 }] });
    expect(detectSwaps(tt, W, 150).map((t) => [t.side, t.mint, t.usd])).toEqual([["sell", X, null], ["buy", Y, null]]);
  });
});
