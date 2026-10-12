// chord-record: keep an agent's own record on TrackRecord (Monad) with its own key. The write half of the chord-trust
// skill; built into one file (viem inside) so an agent host needs Node 18+ and nothing else:
//   bun build sdk/record.ts --target node --outfile public/skills/chord-trust/scripts/record.mjs
//
//   record.mjs whoami                                            the wallet, its MON, what it would pay for
//   record.mjs register --name N --description D [--doc-type T]   a new ERC-8004 identity pointing at a hosted record
//   record.mjs commit --agent ID --fill FILE|-                    one fill: document, publish, commit its hash
//   record.mjs validate --agent ID [--from N] [--to N]            ask Chord's validator to replay the fills
//
// Every command prints a plan and sends NOTHING until it is run again with --user-confirmed. A plan needs no key:
// --wallet 0x… names the wallet that will sign, so the document, its hash and the simulation can be shown first. The key
// comes from the AGENT_KEY environment variable only, is needed only to send, and is never printed, logged or sent anywhere.
// Exit codes: 0 done or planned, 2 a bad argument or a missing key, 1 anything else (a revert, the network).
import { readFileSync } from "node:fs";
import { createWalletClient, formatEther, getAddress, http, isAddress, parseAbi, type Hex } from "viem";
import { getBalance, readContract, simulateContract } from "viem/actions";
import { privateKeyToAccount } from "viem/accounts";
import {
  AGENT_REGISTRY, CHORD_VALIDATOR, EXPLORER, IDENTITY_REGISTRY, MONAD_RPC, TRACK_RECORD, askChordValidator, canonical, commit, gateCheck, hashDoc, hostedFillsUrl,
  identityAbi, monad, publish, readChain, register, registration, registrationFile, rpcClient, setAgentURI, trackRecordAbi,
} from "./trackrecord";

class Fail extends Error {}
// the contract's own errors, so a plan names why a commit would revert instead of printing a selector
const commitAbi = [...trackRecordAbi, ...parseAbi(["error NotAuthorized()", "error EmptyBatch()", "error StaleHead(bytes32 expected, bytes32 actual)"])];
const WHY: Record<string, string> = { NotAuthorized: "this wallet does not own the identity and is not approved for it", StaleHead: "another commit landed first: run the plan again", EmptyBatch: "nothing to commit" };
const args = process.argv.slice(2);
const cmd = args[0] ?? "";
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1] : undefined; };
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
const rpcUrl = process.env.MONAD_RPC_URL || MONAD_RPC;
const CONFIRMED = flag("user-confirmed");
const HOW = "Nothing was sent. Show this plan to the user; after an explicit yes in a later message, run the same command with --user-confirmed (AGENT_KEY must be set in that shell; the user can run it themselves).";

const NO_KEY = "AGENT_KEY is not set. To send, the user exports the agent's private key in the shell that runs this command (export AGENT_KEY=0x...); never ask for it in the conversation. A plan needs no key: pass --wallet 0x... (the address that will sign).";
function wallet() {
  const key = process.env.AGENT_KEY;
  if (!key) throw new Fail(NO_KEY);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Fail("AGENT_KEY is not a 32-byte hex private key (0x + 64 hex characters)");
  const w = createWalletClient({ account: privateKeyToAccount(key as Hex), chain: monad, transport: http(rpcUrl) });
  const named = opt("wallet");
  if (named && named.toLowerCase() !== w.account.address.toLowerCase()) throw new Fail(`--wallet ${named} is not the address of AGENT_KEY (${w.account.address}): the plan was made for another wallet`);
  return w;
}
/** Who signs. A plan takes the address alone (--wallet) when no key is set; sending needs the key. */
function signer(): { address: Hex; keyed: boolean } {
  if (process.env.AGENT_KEY || CONFIRMED) return { address: wallet().account.address, keyed: true };
  const a = opt("wallet");
  if (!a) throw new Fail(NO_KEY);
  if (!isAddress(a)) throw new Fail("--wallet is an address (0x + 40 hex characters)");
  return { address: getAddress(a), keyed: false };
}
const agentArg = (): string => { const v = opt("agent") ?? ""; if (!/^\d{1,12}$/.test(v)) throw new Fail("--agent is the ERC-8004 agent id, a number like 10369"); return v; };
async function balance(address: Hex) { return formatEther(await getBalance(rpcClient({ rpcUrl }), { address })); }
async function ownerOf(agentId: string): Promise<string> {
  return readContract(rpcClient({ rpcUrl }), { address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [BigInt(agentId)] }).catch(() => { throw new Fail(`agent ${agentId} is not registered on Monad's ERC-8004 Identity Registry`); });
}
const lowGas = (mon: string) => (Number(mon) < 0.005 ? `the wallet holds ${mon} MON: a transaction on Monad needs a little MON for gas` : null);

async function whoami() {
  const { address, keyed } = signer();
  out({ wallet: address, keyInEnvironment: keyed, mon: await balance(address), chain: "Monad mainnet (143)", rpc: rpcUrl,
    pays: { register: "2 transactions (register, then point the identity at its file)", commit: "1 transaction per call", validate: "1 transaction" }, explorer: `${EXPLORER}/address/${address}` });
}

async function doRegister() {
  const name = (opt("name") ?? "").trim(), description = (opt("description") ?? "").trim(), docType = opt("doc-type") ?? "agent-fill/v1";
  if (name.length < 2 || name.length > 60) throw new Fail("--name: 2 to 60 characters");
  if (description.length < 10 || description.length > 280) throw new Fail("--description: 10 to 280 characters, what the agent does");
  const { address, keyed } = signer(), mon = await balance(address);
  if (!CONFIRMED) {
    return out({ plan: "register", wallet: address, keyInEnvironment: keyed, mon, warnings: [lowGas(mon)].filter(Boolean), name, description, docType,
      steps: ["register an ERC-8004 identity on Monad's canonical Identity Registry; this wallet owns it (transaction 1)",
        "publish the registration file on chordsi.xyz, naming the hosted track-record endpoint for the new id",
        "point the identity at that file (transaction 2)"],
      contracts: { identityRegistry: IDENTITY_REGISTRY }, permanent: "An identity cannot be deleted; its name and description can be changed later by pointing it at a new file.", next: HOW });
  }
  const w = wallet();
  const reg = await register(w, "https://chordsi.xyz/sdk/README.md", { rpcUrl }); // a placeholder: the real file carries the id, known only now
  const file = registrationFile({ name, description, endpoints: { trackRecord: hostedFillsUrl(reg.agentId) }, docType, agentId: reg.agentId });
  const [doc] = await publish([file]);
  const set = await setAgentURI(w, reg.agentId, doc!.url, { rpcUrl });
  out({ done: "register", agentId: reg.agentId, owner: address, agentURI: doc!.url, trackRecordEndpoint: hostedFillsUrl(reg.agentId), docType,
    transactions: [`${EXPLORER}/tx/${reg.tx}`, `${EXPLORER}/tx/${set.tx}`], next: `record.mjs commit --agent ${reg.agentId} --fill fill.json` });
}

async function doCommit() {
  const agentId = agentArg(), src = opt("fill");
  if (!src) throw new Fail("--fill is a JSON file with the fill (or - for stdin), e.g. {\"ts\":" + Date.now() + ",\"side\":\"buy\",\"symbol\":\"MON\",\"usd\":10,\"priceUsd\":0.0265}");
  let fill: unknown;
  try { fill = JSON.parse(readFileSync(src === "-" ? 0 : src, "utf8")); } catch (e) { throw new Fail(`--fill: ${String((e as Error).message).slice(0, 120)}`); }
  if (!fill || typeof fill !== "object" || Array.isArray(fill)) throw new Fail("--fill must be one JSON object");
  // the fill's own time, set by whoever made the fill: the document must be the same bytes in the plan and when it is sent,
  // and a validator checks that the commit landed within 10 minutes after it (a fill dated after its commit fails)
  const ts = (fill as { ts?: unknown }).ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 1_600_000_000_000) throw new Fail("the fill needs \"ts\": the time it happened, in unix milliseconds (for example " + Date.now() + ")");
  if (ts > Date.now() + 60_000) throw new Fail(`fill.ts is ${Math.round((ts - Date.now()) / 60_000)} minutes in the future: a fill cannot be dated after its commit`);
  const late = Date.now() - ts > 10 * 60_000 ? `the fill is ${Math.round((Date.now() - ts) / 60_000)} minutes old: a validator's on-time check (commit within 10 minutes) will fail for it` : null;
  const { address, keyed } = signer();
  const [chain, owner, mon] = await Promise.all([readChain(agentId, { rpcUrl }), ownerOf(agentId), balance(address)]);
  const seq = chain.count + 1;
  // the type the agent's own registration file declares for its documents, unless one is given
  const docType = opt("doc-type") ?? (await registration(agentId, { rpcUrl }).then((r) => r.services.find((x) => String(x?.name ?? "").toLowerCase() === "track-record")?.version).catch(() => undefined)) ?? "agent-fill/v1";
  // the sequence number and the agent sit inside the document, so it cannot be moved to another place or another agent
  const doc = canonical({ type: docType, chainId: 143, seq, agent: { agentId, registry: AGENT_REGISTRY }, fill });
  // the fill before this one, so the same fill is not committed twice: a commit cannot be taken back
  const last = chain.count ? await fetch(`${hostedFillsUrl(agentId)}?from=${chain.count}&to=${chain.count}`).then((r) => r.json()).then((j: any) => j?.fills?.find((f: any) => f.seq === chain.count)?.doc as string | undefined).catch(() => undefined) : undefined;
  const sansTs = (f: unknown) => { const { ts: _t, ...rest } = (f ?? {}) as Record<string, unknown>; return canonical(rest); };
  let lastFill: unknown; try { lastFill = last ? JSON.parse(last).fill : undefined; } catch { /* not JSON */ }
  const same = lastFill !== undefined && sansTs(lastFill) === sansTs(fill) ? `fill #${chain.count} has the same fields apart from its time: make sure this is another fill, not the same one again` : null;
  if (doc.length > 16_000) throw new Fail(`the document is ${doc.length} bytes; the host stores up to 16,000`);
  const hash = hashDoc(doc);
  if (!CONFIRMED) {
    // the same call the transaction would make, run as a read: a revert (not the owner, a stale head) shows here, with no key use
    const sim = await simulateContract(rpcClient({ rpcUrl }), { address: TRACK_RECORD, abi: commitAbi, functionName: "commit", args: [BigInt(agentId), chain.head, [hash]], account: address })
      .then(() => "ok").catch((e) => { const name = e?.cause?.data?.errorName ?? e?.data?.errorName; return `would revert: ${name ? `${name} (${WHY[name] ?? "see the contract"})` : String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`; });
    return out({ plan: "commit", agentId, seq, wallet: address, keyInEnvironment: keyed, mon, warnings: [lowGas(mon), late, same].filter(Boolean), identityOwner: owner, walletIsOwner: owner.toLowerCase() === address.toLowerCase(),
      document: doc, hash, previousHead: chain.head, lastDocument: last ?? null, simulation: sim,
      steps: ["publish this exact document on chordsi.xyz (stored by its hash, served back byte for byte)", "append its hash to the agent's chain on TrackRecord (1 transaction)"],
      permanent: "A committed hash cannot be removed, edited or reordered.", next: HOW });
  }
  const w = wallet();
  await publish([doc]);
  const c = await commit(w, agentId, [doc], { rpcUrl });
  out({ done: "commit", agentId, seq: c.count, hash, head: c.head, transaction: `${EXPLORER}/tx/${c.tx}`, document: `https://chordsi.xyz/v1/trust/docs/${hash}`,
    next: `trust.py verify ${agentId}   # anyone can now re-hash the record` });
}

async function doValidate() {
  const agentId = agentArg(), { address, keyed } = signer();
  const [chain, owner, mon, gate] = await Promise.all([readChain(agentId, { rpcUrl }), ownerOf(agentId), balance(address), gateCheck(agentId, { rpcUrl })]);
  if (!chain.count) throw new Fail(`agent ${agentId} has no committed fill yet: commit at least one first`);
  const fromSeq = Number(opt("from") ?? 1), toSeq = Number(opt("to") ?? chain.count);
  if (!(fromSeq >= 1 && toSeq >= fromSeq && toSeq <= chain.count)) throw new Fail(`--from / --to must lie in 1..${chain.count}`);
  if (toSeq - fromSeq + 1 > 200) throw new Fail("the validator replays at most 200 fills a request: narrow --from / --to");
  if (!CONFIRMED) {
    return out({ plan: "validate", agentId, range: { fromSeq, toSeq }, wallet: address, keyInEnvironment: keyed, mon, warnings: [lowGas(mon)].filter(Boolean), identityOwner: owner, walletIsOwner: owner.toLowerCase() === address.toLowerCase(),
      validator: CHORD_VALIDATOR, gateToday: gate,
      steps: ["publish a request document naming the range", "send validationRequest on the ERC-8004 Validation Registry (1 transaction)", "tell Chord's validator; it replays the fills and answers on-chain with a 0 to 100 score"],
      limits: "Chord's validator answers up to 20 outside requests a day, one per agent per hour.", next: HOW });
  }
  const r = await askChordValidator(wallet(), agentId, { fromSeq, toSeq }, { rpcUrl });
  out({ done: "validate", agentId, range: { fromSeq, toSeq }, transaction: `${EXPLORER}/tx/${r.tx}`, request: r.requestURI, report: r.reportURI,
    next: `The score lands within a minute or two. Then: trust.py gate ${agentId}` });
}

const USAGE = `chord-record: keep an agent's record on TrackRecord (Monad) with its own key
  record.mjs whoami
  record.mjs register --name NAME --description TEXT [--doc-type TYPE]
  record.mjs commit --agent ID --fill FILE|- [--doc-type TYPE]
  record.mjs validate --agent ID [--from N] [--to N]
Each prints a plan and sends nothing until run again with --user-confirmed.
A plan needs no key: add --wallet 0x... (the address that will sign). Sending reads the key from AGENT_KEY
(export it in the shell that runs the command); MONAD_RPC_URL overrides ${MONAD_RPC}.`;

const run = { whoami, register: doRegister, commit: doCommit, validate: doValidate }[cmd];
if (!run) { console.log(USAGE); process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0); }
run().catch((e) => {
  const msg = String(e?.shortMessage ?? e?.message ?? e).replace(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, (h) => (process.env.AGENT_KEY && h.toLowerCase() === process.env.AGENT_KEY.toLowerCase() ? "[key]" : h));
  console.error(JSON.stringify({ error: msg.slice(0, 400) }));
  process.exit(e instanceof Fail ? 2 : 1);
});
