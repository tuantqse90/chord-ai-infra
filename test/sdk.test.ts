// The TrackRecord SDK (sdk/trackrecord.ts): byte parity with the server's canonical documents and chain fold, and verify()
// against a mocked fills endpoint and a mocked Monad RPC (offline: every fetch goes to the mock).
import { describe, expect, it } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, type Hex } from "viem";
import * as server from "../src/trust/canonical";
import type { Fill } from "../src/bots/types";
import * as sdk from "../sdk/trackrecord";

const RPC = "http://rpc.test";
const FILLS = "http://agent.test/fills";
const REG = "http://agent.test/registration.json";

const fill = (i: number, over: Partial<Fill> = {}): Fill => ({
  id: `fill${i}`, botId: "593f1df17678", ts: 1_791_701_146_398 + i * 60_000, side: i % 2 ? "sell" : "buy", mint: "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b",
  symbol: "cbBTC", usd: 10 + i, tokenAmount: 0.0001204 * i, priceUsd: 83056.47840531562, status: "filled", reason: null, pnlUsd: i % 2 ? -0.12 * i : null,
  source: { via: "copy", wallet: "0xccb9000000000000000000000000000000044f6", tx: `0x${"ab".repeat(32)}`, ts: 1_791_701_100_000, side: "buy", usd: 576, detail: "0xccb9…44f6 bought $576 «ünïcødé»" } as any,
  quote: { provider: "Chord router", route: ["capricorn", "hanji"], priceImpactPct: 0.0343 }, mode: "paper", ...over,
});
const agent = { botId: "593f1df17678", agentId: "10333" };
const docs = (n: number) => Array.from({ length: n }, (_, i) => server.fillDoc(fill(i + 1), agent, i + 1));

describe("sdk parity with src/trust/canonical.ts", () => {
  const values: unknown[] = [
    { b: 1, a: [3, { z: null, y: undefined, x: NaN }], c: "é \"q\"", d: -0, e: 1e21, f: 0.1 + 0.2, g: true },
    [undefined, Infinity, "x", [], {}],
    { "Z": 1, "a": 2, "ä": 3, "10": 4, "9": 5 },
    "plain", 42, null, false,
  ];
  it("canonical() is byte-identical", () => {
    for (const v of values) expect(sdk.canonical(v)).toBe(server.canonical(v));
  });
  it("hashDoc() and chainHead() match the server on real fill documents", () => {
    const ds = docs(6);
    for (const d of ds) {
      expect(sdk.hashDoc(d)).toBe(server.hashDoc(d));
      expect(sdk.canonical(JSON.parse(d))).toBe(d); // a served document is already canonical
    }
    const hs = ds.map(sdk.hashDoc);
    expect(sdk.chainHead(hs)).toBe(server.chainHead(hs));
    expect(sdk.chainHead(hs.slice(3), sdk.chainHead(hs.slice(0, 3)))).toBe(server.chainHead(hs)); // folding in two commits = one
    expect(sdk.chainHead([])).toBe(sdk.ZERO_HEAD);
    expect(sdk.DOC_TYPE).toBe(server.DOC_TYPE);
  });
});

/** A fetch that answers the fills endpoint, the registration file and eth_call on TrackRecord.chains / Identity.tokenURI. */
function mock(p: { fills: any[]; head: Hex; count: number; lastAt?: number; agentURI?: string }) {
  const calls: string[] = [];
  const fetchFn: sdk.FetchLike = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (new URL(url).href === new URL(RPC).href) {
      const req = JSON.parse(String(init?.body));
      const one = (r: any) => {
        if (r.method !== "eth_call") return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
        const to = String(r.params[0].to).toLowerCase();
        if (to === sdk.TRACK_RECORD.toLowerCase()) {
          decodeFunctionData({ abi: sdk.trackRecordAbi, data: r.params[0].data });
          return { jsonrpc: "2.0", id: r.id, result: encodeFunctionResult({ abi: sdk.trackRecordAbi, functionName: "chains", result: [p.head, BigInt(p.count), BigInt(p.lastAt ?? 1_791_701_200)] }) };
        }
        if (to === sdk.IDENTITY_REGISTRY.toLowerCase()) return { jsonrpc: "2.0", id: r.id, result: encodeAbiParameters([{ type: "string" }], [p.agentURI ?? REG]) };
        return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } };
      };
      return Response.json(Array.isArray(req) ? req.map(one) : one(req));
    }
    if (url === REG) return Response.json(sdk.registrationFile({ name: "t", description: "t", endpoints: { trackRecord: FILLS }, agentId: 10333 }));
    const u = new URL(url);
    if (`${u.origin}${u.pathname}` === FILLS) {
      const from = Number(u.searchParams.get("from")) || 1, to = Number(u.searchParams.get("to")) || Number.MAX_SAFE_INTEGER;
      return Response.json({ fills: p.fills.filter((f) => f.seq >= from && f.seq <= to).slice(0, 1000) });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchFn, calls };
}
const served = (ds: string[]) => ds.map((doc, i) => ({ seq: i + 1, hash: sdk.hashDoc(doc), doc, commitTx: `0x${"11".repeat(32)}` }));

describe("verify()", () => {
  const ds = docs(5);
  const head = server.chainHead(ds.map(server.hashDoc));

  it("a matching record: found through agentURI -> registration -> track-record, rebuilt head = Monad's", async () => {
    const m = mock({ fills: served(ds), head, count: 5 });
    const r = await sdk.verify(10333, { rpcUrl: RPC, fetch: m.fetchFn });
    expect(r).toMatchObject({ ok: true, agentId: "10333", documents: 5, badHashes: [], missing: [], rebuiltHead: head, fillsUrl: FILLS });
    expect(r.onchain).toEqual({ head, count: 5, lastAt: 1_791_701_200_000 });
    expect(m.calls).toContain(REG);
  });

  it("documents past the on-chain count (pending) are not part of the check", async () => {
    const m = mock({ fills: served(docs(7)), head, count: 5 });
    const r = await sdk.verify("10333", { rpcUrl: RPC, fetch: m.fetchFn, fillsUrl: FILLS });
    expect(r.ok).toBe(true);
    expect(r.documents).toBe(5);
  });

  it("a tampered document: its hash no longer matches, the head differs", async () => {
    const f = served(ds);
    f[2]!.doc = f[2]!.doc.replace('"usd":13', '"usd":1300');
    const m = mock({ fills: f, head, count: 5 });
    const r = await sdk.verify(10333, { rpcUrl: RPC, fetch: m.fetchFn, fillsUrl: FILLS });
    expect(r.ok).toBe(false);
    expect(r.badHashes).toEqual([3]);
    expect(r.rebuiltHead).not.toBe(head);
    expect(r.reason).toContain("differs from Monad");
  });

  it("a tampered document with a re-computed hash: the listed hashes look fine, Monad still says no", async () => {
    const f = served(ds);
    f[0]!.doc = f[0]!.doc.replace('"side":"sell"', '"side":"buy"');
    f[0]!.hash = sdk.hashDoc(f[0]!.doc);
    const r = await sdk.verify(10333, { rpcUrl: RPC, fetch: mock({ fills: f, head, count: 5 }).fetchFn, fillsUrl: FILLS });
    expect(r.ok).toBe(false);
    expect(r.badHashes).toEqual([]);
  });

  it("a missing document", async () => {
    const f = served(ds).filter((x) => x.seq !== 4);
    const r = await sdk.verify(10333, { rpcUrl: RPC, fetch: mock({ fills: f, head, count: 5 }).fetchFn, fillsUrl: FILLS });
    expect(r).toMatchObject({ ok: false, documents: 4, missing: [4] });
    expect(r.reason).toContain("missing");
  });

  it("an empty chain is not a verified record", async () => {
    const r = await sdk.verify(10333, { rpcUrl: RPC, fetch: mock({ fills: [], head: sdk.ZERO_HEAD, count: 0 }).fetchFn, fillsUrl: FILLS });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no fills");
  });

  it("pages past 1,000 documents with from/to", async () => {
    const many = Array.from({ length: 1003 }, (_, i) => sdk.canonical({ type: sdk.DOC_TYPE, seq: i + 1, n: i }));
    const m = mock({ fills: served(many), head: sdk.chainHead(many.map(sdk.hashDoc)), count: 1003 });
    const r = await sdk.verify(1, { rpcUrl: RPC, fetch: m.fetchFn, fillsUrl: FILLS });
    expect(r).toMatchObject({ ok: true, documents: 1003 });
    expect(m.calls.filter((c) => c.startsWith(FILLS)).length).toBe(2);
  });
});

describe("registrationFile()", () => {
  it("is an ERC-8004 registration-v1 with a track-record service", () => {
    const r = sdk.registrationFile({ name: "Bot", description: "Does things", endpoints: { trackRecord: FILLS, web: "http://agent.test", mcp: "http://agent.test/mcp" }, agentId: "42" });
    expect(r.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    expect(r.services).toContainEqual({ name: "track-record", endpoint: FILLS, version: "chord-agent-fill/v1" });
    expect(r.services.map((s) => s.name)).toEqual(["web", "MCP", "track-record"]);
    expect(r.supportedTrust).toEqual(["validation", "reputation"]);
    expect(r.registrations).toEqual([{ agentId: 42, agentRegistry: "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }]);
  });
});
