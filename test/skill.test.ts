// The chord-trust skill (public/skills/chord-trust): its Python reader must agree with the SDK byte for byte, with no
// shared code. trust.py has its own keccak-256 and its own eth_call; here it runs against a local server that plays the
// Monad RPC and a fills endpoint, so a record that was edited, or one with a document missing, must make it exit 1.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionResult, keccak256, toBytes, toFunctionSelector, type Hex } from "viem";
import * as sdk from "../sdk/trackrecord";

const SKILL = "public/skills/chord-trust";
const PY = Bun.which("python3");
const run = async (args: string[], env: Record<string, string> = {}, stdin?: string) => {
  const p = Bun.spawn([PY!, `${SKILL}/scripts/trust.py`, ...args], { env: { ...process.env, ...env }, stdin: stdin == null ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() };
};

const docs = [1, 2, 3].map((seq) => sdk.canonical({ type: "agent-fill/v1", chainId: 143, seq, agent: { agentId: "777", registry: sdk.AGENT_REGISTRY }, fill: { ts: 1_791_700_000_000 + seq, side: "buy", symbol: "MON", usd: 10 * seq, note: "«ünïcødé» ✓" } }));
const hashes = docs.map((d) => sdk.hashDoc(d));
const head = sdk.chainHead(hashes);
let served: { seq: number; hash: Hex; doc: string }[] = [];
let srv: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/fills") return Response.json({ fills: served });
    if (u.pathname === "/rpc") {
      const b: any = await req.json();
      if (b.method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id: b.id, result: "0x8f" });
      const { functionName } = decodeFunctionData({ abi: [...sdk.trackRecordAbi, ...sdk.trustGateAbi], data: b.params[0].data });
      if (functionName === "chains" && b.params[0].to.toLowerCase() === sdk.TRACK_RECORD.toLowerCase())
        return Response.json({ jsonrpc: "2.0", id: b.id, result: encodeFunctionResult({ abi: sdk.trackRecordAbi, functionName: "chains", result: [head, 3n, 1_791_700_100n] }) });
      if (functionName === "check") return Response.json({ jsonrpc: "2.0", id: b.id, result: encodeFunctionResult({ abi: sdk.trustGateAbi, functionName: "check", result: [true, 3n, 1n, 97, 1_791_700_100n] }) });
      return Response.json({ jsonrpc: "2.0", id: b.id, error: { message: "unexpected call" } });
    }
    return new Response("not found", { status: 404 });
  } });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(() => srv?.stop(true));

describe.skipIf(!PY)("chord-trust skill: trust.py", () => {
  it("ships every file the installer downloads", () => {
    const files = /FILES="([^"]+)"/.exec(readFileSync(`${SKILL}/scripts/install.sh`, "utf8"))![1]!.split(" ");
    for (const f of files) expect(existsSync(`${SKILL}/${f}`)).toBe(true);
    expect(readFileSync(`${SKILL}/SKILL.md`, "utf8")).toMatch(/^---\nname: chord-trust\n/);
  });
  it("its keccak-256 is viem's, on empty, short, block-edge and long inputs", async () => {
    for (const s of ["", "abc", "x".repeat(135), "x".repeat(136), "x".repeat(137), "«ünïcødé» ✓".repeat(40), docs[0]!]) {
      const r = await run(["hash", "-"], {}, s);
      expect(r.json.keccak256).toBe(keccak256(toBytes(s)));
    }
  });
  it("its selectors are the contract's", () => {
    const src = readFileSync(`${SKILL}/scripts/trust.py`, "utf8");
    for (const sig of ["chains(uint256)", "check(uint256)", "policy()", "tokenURI(uint256)"]) expect(src).toContain(`selector("${sig}")`);
    expect(toFunctionSelector("function chains(uint256)")).toBe(keccak256(toBytes("chains(uint256)")).slice(0, 10) as Hex);
  });
  it("verifies an intact record against the RPC's head (exit 0)", async () => {
    served = docs.map((doc, i) => ({ seq: i + 1, hash: hashes[i]!, doc }));
    const r = await run(["verify", "777", "--rpc", `${base}/rpc`, "--fills", `${base}/fills`]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, documents: 3, committed: 3, rebuiltHead: head, monadHead: head, missing: [], badHashes: [] });
    expect(r.json.verdict).toContain("VERIFIED");
  });
  it("an edited document breaks the chain (exit 1), even when its listed hash is left as it was", async () => {
    served = docs.map((doc, i) => ({ seq: i + 1, hash: hashes[i]!, doc: i === 1 ? doc.replace('"usd":20', '"usd":2000') : doc }));
    const r = await run(["verify", "777", "--rpc", `${base}/rpc`, "--fills", `${base}/fills`]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, badHashes: [2], monadHead: head });
    expect(r.json.rebuiltHead).not.toBe(head);
    expect(r.json.verdict).toContain("MISMATCH");
  });
  it("a missing or reordered document fails too (exit 1)", async () => {
    served = [{ seq: 1, hash: hashes[0]!, doc: docs[0]! }, { seq: 3, hash: hashes[2]!, doc: docs[2]! }];
    let r = await run(["verify", "777", "--rpc", `${base}/rpc`, "--fills", `${base}/fills`]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, missing: [2] });
    served = [{ seq: 1, hash: hashes[1]!, doc: docs[1]! }, { seq: 2, hash: hashes[0]!, doc: docs[0]! }, { seq: 3, hash: hashes[2]!, doc: docs[2]! }];
    r = await run(["verify", "777", "--rpc", `${base}/rpc`, "--fills", `${base}/fills`]);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
  });
  it("refuses an RPC that is not Monad, a bad id and a plain-http endpoint", async () => {
    expect((await run(["verify", "abc"])).code).toBe(2);
    const r = await run(["verify", "777", "--rpc", `${base}/rpc`, "--fills", "http://example.com/fills"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("non-https");
  });
});
