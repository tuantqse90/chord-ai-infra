// Check an agent's track record without trusting the server that runs it: only its published documents and Monad itself.
//   bun scripts/verify.ts <botId> [--api https://chordmonad.clawpot.xyz] [--rpc https://rpc.monad.xyz]
// It reads the agent's ERC-8004 identity and TrackRecord address from the server, then on Monad:
//   1. identity   the Identity Registry says the agent exists and its agentURI is the registration file the server names;
//   2. hash       every published fill document hashes (keccak-256 of the exact bytes) to the hash the server says it committed;
//   3. order      each document carries its own sequence number and agent id, so a document cannot be moved to another place;
//   4. tx         each commit transaction emitted Committed(agentId, seq, fillHash) for that fill, and the block time is printed
//                 next to the fill time (how long after the fill the record was fixed);
//   5. chain      the hashes rebuild, from 0x0, the head the TrackRecord contract holds for the agent now.
// Exit code 0 = every check passed, 1 = something did not match (the reason is printed).
import { createPublicClient, decodeEventLog, http, keccak256, parseAbi, toBytes, type Hex } from "viem";

const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const identityAbi = parseAbi(["function ownerOf(uint256) view returns (address)", "function tokenURI(uint256) view returns (string)"]);
const trackAbi = parseAbi([
  "function chains(uint256) view returns (bytes32 head, uint64 count, uint64 lastAt)",
  "event Committed(uint256 indexed agentId, uint64 indexed seq, bytes32 fillHash, bytes32 head)",
]);
const ZERO = `0x${"0".repeat(64)}` as Hex;

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const botId = args.find((a) => /^[0-9a-f]{12}$/.test(a));
if (!botId) { console.error("usage: bun scripts/verify.ts <botId> [--api URL] [--rpc URL]"); process.exit(2); }
const api = opt("api", "https://chordmonad.clawpot.xyz").replace(/\/$/, "");
const client = createPublicClient({ transport: http(opt("rpc", "https://rpc.monad.xyz")) });

let failed = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL  ${m}`); };
const get = async (path: string) => { const r = await fetch(`${api}${path}`); if (!r.ok) throw new Error(`${path} answered ${r.status}`); return r.json() as Promise<any>; };

const agent = await get(`/v1/trust/agents/${botId}`);
const agentId: string | undefined = agent.identity?.agentId;
const track = agent.trackRecord as Hex | null;
if (!agentId || !track) { console.log(`agent ${botId} has no ERC-8004 identity or no TrackRecord yet`); process.exit(1); }
console.log(`agent ${botId} = ERC-8004 agent #${agentId} · TrackRecord ${track}`);

console.log("identity");
const [owner, uri] = await Promise.all([
  client.readContract({ address: IDENTITY, abi: identityAbi, functionName: "ownerOf", args: [BigInt(agentId)] }),
  client.readContract({ address: IDENTITY, abi: identityAbi, functionName: "tokenURI", args: [BigInt(agentId)] }),
]);
ok(`owner ${owner}`);
uri === agent.identity.agentURI ? ok(`agentURI ${uri}`) : bad(`agentURI on-chain ${uri} ≠ served ${agent.identity.agentURI}`);

// every committed document, in sequence order (the route pages by 1,000)
const fills: any[] = [];
for (let from = 1; ; from += 1000) {
  const page = (await get(`/v1/trust/agents/${botId}/fills?from=${from}&to=${from + 999}`)).fills as any[];
  fills.push(...page.filter((f) => f.commitTx));
  if (page.length < 1000) break;
}
console.log(`documents: ${fills.length} committed`);
const hashes: Hex[] = [];
let docsOk = 0;
for (const [i, f] of fills.entries()) {
  const h = keccak256(toBytes(f.doc));
  let d: any = null;
  try { d = JSON.parse(f.doc); } catch { /* reported below */ }
  if (f.seq !== i + 1) bad(`fill #${i + 1}: the server skipped to #${f.seq}`);
  else if (h !== f.hash) bad(`fill #${f.seq}: document hashes to ${h}, server says ${f.hash}`);
  else if (!d || d.seq !== f.seq || String(d.agent?.agentId) !== String(agentId)) bad(`fill #${f.seq}: the document names seq ${d?.seq} / agent ${d?.agent?.agentId}`);
  else docsOk++;
  hashes.push(h);
}
if (docsOk === fills.length) ok(`${docsOk} documents hash to their committed hashes and name their own place`);

console.log("transactions");
const byTx = new Map<Hex, any[]>();
for (const f of fills) byTx.set(f.commitTx, [...(byTx.get(f.commitTx) ?? []), f]);
let lags: number[] = [], txOk = 0;
for (const [tx, group] of byTx) {
  const rc = await client.getTransactionReceipt({ hash: tx });
  const block = await client.getBlock({ blockNumber: rc.blockNumber });
  const events = new Map<number, Hex>();
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== track.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi: trackAbi, data: l.data, topics: l.topics }) as any;
      if (e.eventName === "Committed" && String(e.args.agentId) === String(agentId)) events.set(Number(e.args.seq), e.args.fillHash);
    } catch { /* another event */ }
  }
  for (const f of group) {
    if (events.get(f.seq)?.toLowerCase() !== keccak256(toBytes(f.doc)).toLowerCase()) { bad(`fill #${f.seq}: tx ${tx} has no Committed event for this document`); continue; }
    txOk++;
    lags.push(Number(block.timestamp) * 1000 - f.fillTs);
  }
}
if (txOk === fills.length) ok(`${byTx.size} transactions carry all ${txOk} Committed events`);
if (lags.length) {
  lags = lags.sort((a, b) => a - b);
  ok(`fill → block: median ${(lags[Math.floor(lags.length / 2)] / 1000).toFixed(1)} s, worst ${(lags[lags.length - 1] / 1000).toFixed(1)} s`);
}

console.log("chain");
const [head, count] = await client.readContract({ address: track, abi: trackAbi, functionName: "chains", args: [BigInt(agentId)] });
let rebuilt = ZERO;
for (const h of hashes) rebuilt = keccak256(`0x${rebuilt.slice(2)}${h.slice(2)}`);
if (Number(count) !== hashes.length) bad(`the contract holds ${count} fills, the server published ${hashes.length} committed documents`);
else if (rebuilt !== head) bad(`rebuilt head ${rebuilt} ≠ on-chain head ${head}`);
else ok(`${count} fills rebuild the on-chain head ${head}`);

console.log(failed ? `\n${failed} check(s) failed` : "\nverified: the record on Monad matches every published fill");
process.exit(failed ? 1 : 0);
