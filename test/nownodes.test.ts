import { afterEach, describe, expect, it } from "bun:test";
import { NowNodesOffError, nowRpc, nownodesStatus, setNowNodesFetch, _resetNowNodes } from "../src/nownodes";

const prev = process.env.NOWNODES_API_KEY;
afterEach(() => { _resetNowNodes(); if (prev === undefined) delete process.env.NOWNODES_API_KEY; else process.env.NOWNODES_API_KEY = prev; });

describe("NOWNodes swap lane", () => {
  it("no key = off, said plainly, nothing fetched (never a fallback to the read RPC)", async () => {
    delete process.env.NOWNODES_API_KEY;
    let fetched = 0;
    setNowNodesFetch(async () => { fetched++; return new Response("{}"); });
    await expect(nowRpc("getSlot", [])).rejects.toBeInstanceOf(NowNodesOffError);
    expect(fetched).toBe(0);
    expect(nownodesStatus()).toMatchObject({ provider: "NOWNodes", keySet: false, calls: 0 });
  });
  it("sends the key as the api-key header, counts calls, keeps the key out of errors", async () => {
    process.env.NOWNODES_API_KEY = "k-secret-123";
    const seen: { url: string; key: string | null; body: any }[] = [];
    setNowNodesFetch(async (u, init) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url: u, key: new Headers(init?.headers).get("api-key"), body });
      if (body.method === "getSlot") return Response.json({ jsonrpc: "2.0", id: 1, result: 42 });
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "bad tx for k-secret-123" } });
    });
    expect(await nowRpc<number>("getSlot", [])).toBe(42);
    await expect(nowRpc("sendTransaction", ["x"])).rejects.toThrow(/bad tx/);
    expect(seen[0]).toMatchObject({ url: "https://sol.nownodes.io", key: "k-secret-123", body: { method: "getSlot" } });
    const st = nownodesStatus();
    expect(st).toMatchObject({ keySet: true, calls: 2, ok: 1, errors: 1 });
    expect(JSON.stringify(st)).not.toContain("k-secret-123");
  });
});
