// /v1/rpc/solana (src/rpcProxy.ts): the Privy sheet's reads and simulations go through the read RPC; nothing else does.
import { afterAll, describe, expect, it } from "bun:test";
import { setSolanaFetch } from "../src/rpc/solana";
const { rpcProxy } = await import("../src/rpcProxy");
const calls: any[] = [];
setSolanaFetch(async (_u, init) => {
  const b = JSON.parse(String(init?.body)); calls.push(b);
  if (b.method === "getBalance") return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param: https://secret.example/key123 bad" } });
  return Response.json({ jsonrpc: "2.0", id: 1, result: { value: { blockhash: "abc", lastValidBlockHeight: 7 } } });
});
afterAll(() => setSolanaFetch(null));
const call = (body: unknown) => rpcProxy.request("/solana", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the Privy island's Solana RPC", () => {
  it("reads and simulations pass through with the caller's id; sending is not available", async () => {
    const r = await (await call({ jsonrpc: "2.0", id: 42, method: "getLatestBlockhash", params: [] })).json();
    expect(r).toEqual({ jsonrpc: "2.0", id: 42, result: { value: { blockhash: "abc", lastValidBlockHeight: 7 } } });
    const s = await (await call({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["x"] })).json();
    expect(s.error.code).toBe(-32601);
    expect(calls.map((c) => c.method)).toEqual(["getLatestBlockhash"]);
  });
  it("an upstream error comes back as a JSON-RPC error without the endpoint; batches answer in order", async () => {
    const e = await (await call({ jsonrpc: "2.0", id: 3, method: "getBalance", params: ["w"] })).json();
    expect(e.error.message).not.toContain("secret.example");
    const b = await (await call([{ jsonrpc: "2.0", id: 1, method: "getSlot" }, { jsonrpc: "2.0", id: 2, method: "requestAirdrop" }])).json();
    expect(b.map((x: any) => x.id)).toEqual([1, 2]);
    expect(b[1].error.code).toBe(-32601);
  });
});
