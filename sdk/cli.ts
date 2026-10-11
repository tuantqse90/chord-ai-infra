#!/usr/bin/env node
// chord-verify: check an ERC-8004 agent's TrackRecord on Monad from your own machine.
//   chord-verify verify <agentId> [--fills <url>] [--rpc <url>]   re-hash the published fills, compare with Monad (exit 0 = equal)
//   chord-verify chain <agentId> [--rpc <url>]                    head, count and last commit time on TrackRecord
//   chord-verify hash <file|-> [--raw]                            keccak-256 of a canonical document (--raw: the exact bytes)
//   chord-verify gate <agentId> [--rpc <url>]                     TrustGate.check: does a contract trust this agent today (exit 0 = yes)
import { readFileSync } from "node:fs";
import { canonical, EXPLORER, gateCheck, hashDoc, readChain, TRACK_RECORD, TRUST_GATE, verify } from "./trackrecord";

const argv = process.argv.slice(2);
const opts: Record<string, string> = {}, flags = new Set<string>(), positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--raw") flags.add("raw");
  else if (a.startsWith("--")) opts[a.slice(2)] = argv[++i] ?? "";
  else positional.push(a);
}
const opt = (name: string): string | undefined => opts[name] || undefined;
const [cmd, arg] = positional;
const USAGE = `usage:
  chord-verify verify <agentId> [--fills <url>] [--rpc <url>]
  chord-verify chain <agentId> [--rpc <url>]
  chord-verify hash <file|-> [--raw]
  chord-verify gate <agentId> [--rpc <url>]`;
const when = (ms: number) => (ms ? new Date(ms).toISOString().replace(".000Z", "Z") : "never");

async function main(): Promise<number> {
  const rpcUrl = opt("rpc");
  if (cmd === "verify" && arg) {
    const r = await verify(arg, { rpcUrl, fillsUrl: opt("fills") });
    console.log(`agent #${r.agentId} on TrackRecord ${TRACK_RECORD} (Monad, chain 143)`);
    console.log(`  fills        ${r.fillsUrl}`);
    console.log(`  re-hashed    ${r.documents} of ${r.onchain.count} committed document${r.onchain.count === 1 ? "" : "s"}${r.missing.length ? `, ${r.missing.length} missing` : ""}${r.badHashes.length ? `, ${r.badHashes.length} not matching their listed hash` : ""}`);
    console.log(`  rebuilt head ${r.rebuiltHead}`);
    console.log(`  Monad head   ${r.onchain.head} (count ${r.onchain.count}, last commit ${when(r.onchain.lastAt)})`);
    console.log(`${r.ok ? "VERIFIED" : "MISMATCH"}: ${r.reason}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === "chain" && arg) {
    const c = await readChain(arg, { rpcUrl });
    console.log(`agent #${arg} on TrackRecord ${TRACK_RECORD}`);
    console.log(`  head    ${c.head}`);
    console.log(`  count   ${c.count}`);
    console.log(`  lastAt  ${when(c.lastAt)}${c.lastAt ? ` (unix ${c.lastAt / 1000})` : ""}`);
    console.log(`  ${EXPLORER}/address/${TRACK_RECORD}`);
    return 0;
  }
  if (cmd === "gate" && arg) {
    const g = await gateCheck(arg, { rpcUrl });
    console.log(`agent #${arg} on TrustGate ${TRUST_GATE}`);
    console.log(`  fills        ${g.fills}`);
    console.log(`  validations  ${g.validations} (average ${g.avgScore}/100)`);
    console.log(`  last commit  ${when(g.lastAt)}`);
    console.log(g.ok ? "TRUSTED: a contract calling TrustGate.check today gets yes" : "NOT YET: the gate's policy is not met");
    return g.ok ? 0 : 1;
  }
  if (cmd === "hash" && arg) {
    const text = readFileSync(arg === "-" ? 0 : arg, "utf8");
    if (flags.has("raw")) { console.log(hashDoc(text)); return 0; }
    let doc: string;
    try { doc = canonical(JSON.parse(text)); } catch (e) { console.error(`${arg} is not JSON (${(e as Error).message}); use --raw to hash its exact bytes`); return 2; }
    console.log(hashDoc(doc));
    if (doc !== text) console.error("note: the file is not in canonical form; this is the hash of its canonical form");
    return 0;
  }
  console.error(USAGE);
  return 2;
}

main().then((code) => process.exit(code), (e) => { console.error(`error: ${(e as any)?.shortMessage ?? (e as Error)?.message ?? e}`); process.exit(1); });
