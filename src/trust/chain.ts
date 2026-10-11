// Every transaction the trust layer sends, and the reads it makes. One queue per signing account, so the operator's
// registrations, commits and validation requests never race for a nonce; each send waits for its receipt and fails loudly
// on a revert. Addresses come from the environment (TRACK_RECORD_ADDRESS, VALIDATION_REGISTRY_ADDRESS); the ERC-8004
// Identity and Reputation registries are the canonical ones on Monad.
import { decodeEventLog, formatEther, type Abi, type Hex, type PrivateKeyAccount, type TransactionReceipt } from "viem";
import { IDENTITY_REGISTRY, REPUTATION_REGISTRY } from "../monad/chain";
import { operatorAccount, publicClient, validatorAccount, walletClient } from "../monad/client";
import { identityAbi, reputationAbi, trackRecordAbi, validationAbi } from "./abi";

const env = (k: string, d = "") => (process.env[k] ?? "").trim() || d;
const addr = (k: string) => { const v = env(k); return /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : null; };
export const trustConfig = {
  trackRecord: () => addr("TRACK_RECORD_ADDRESS"),
  validationRegistry: () => addr("VALIDATION_REGISTRY_ADDRESS"),
  publicBase: () => env("PUBLIC_BASE_URL", "https://chordsi.xyz").replace(/\/$/, ""),
  /** the trust layer writes only with an operator key and a TrackRecord address (TRUST_ENABLED=0 switches it off) */
  enabled: () => env("TRUST_ENABLED", "1") !== "0" && !!operatorAccount() && !!addr("TRACK_RECORD_ADDRESS"),
  /** below this the operator sends nothing (registrations and commits wait for a top-up) */
  minOperatorWei: () => BigInt(Math.floor(Number(env("TRUST_MIN_OPERATOR_MON", "0.05")) * 1e18)),
};

const queues = new Map<string, Promise<unknown>>();
function serial<T>(who: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(who) ?? Promise.resolve()).then(fn, fn);
  queues.set(who, next.catch(() => undefined));
  return next;
}

export interface Sent { tx: Hex; block: number; timestamp: number; receipt: TransactionReceipt }
async function send(account: PrivateKeyAccount, req: { address: `0x${string}`; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<Sent> {
  return serial(account.address, async () => {
    const pc = publicClient();
    const { request } = await pc.simulateContract({ ...req, account } as any);
    const tx = await walletClient(account).writeContract(request as any);
    const receipt = await pc.waitForTransactionReceipt({ hash: tx, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error(`transaction ${tx} reverted`);
    const block = await pc.getBlock({ blockNumber: receipt.blockNumber });
    return { tx, block: Number(receipt.blockNumber), timestamp: Number(block.timestamp) * 1000, receipt };
  });
}

function logsOf<T = any>(receipt: TransactionReceipt, address: string, abi: Abi, eventName: string): T[] {
  const out: T[] = [];
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== address.toLowerCase()) continue;
    try { const d = decodeEventLog({ abi, data: l.data, topics: l.topics }); if (d.eventName === eventName) out.push(d.args as T); } catch { /* another event */ }
  }
  return out;
}

const needOperator = (): PrivateKeyAccount => { const a = operatorAccount(); if (!a) throw new Error("OPERATOR_PRIVATE_KEY is not set"); return a; };
const needTrack = (): `0x${string}` => { const a = trustConfig.trackRecord(); if (!a) throw new Error("TRACK_RECORD_ADDRESS is not set"); return a; };
const needValidation = (): `0x${string}` => { const a = trustConfig.validationRegistry(); if (!a) throw new Error("VALIDATION_REGISTRY_ADDRESS is not set"); return a; };

// ── identity ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Register an agent in the canonical ERC-8004 Identity Registry; the operator owns the identity. */
export async function registerAgent(agentURI: string): Promise<Sent & { agentId: string }> {
  const s = await send(needOperator(), { address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "register", args: [agentURI] });
  const ev = logsOf<{ agentId: bigint }>(s.receipt, IDENTITY_REGISTRY, identityAbi, "Registered")[0];
  if (!ev) throw new Error(`register ${s.tx}: no Registered event`);
  return { ...s, agentId: ev.agentId.toString() };
}
export async function identityOwner(agentId: string): Promise<string | null> {
  try { return (await publicClient().readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [BigInt(agentId)] })) as string; } catch { return null; }
}

// ── track record ────────────────────────────────────────────────────────────────────────────────────────────────────
export async function onchainChain(agentId: string): Promise<{ head: Hex; count: number; lastAt: number }> {
  const [head, count, lastAt] = (await publicClient().readContract({ address: needTrack(), abi: trackRecordAbi, functionName: "chains", args: [BigInt(agentId)] })) as [Hex, bigint, bigint];
  return { head, count: Number(count), lastAt: Number(lastAt) * 1000 };
}
/** Append fill hashes to the agent's chain; answers each fill's 1-based sequence and the head after it. */
export async function commitFills(agentId: string, prevHead: Hex, hashes: Hex[]): Promise<Sent & { committed: { seq: number; fillHash: Hex; head: Hex }[] }> {
  const track = needTrack();
  const s = await send(needOperator(), { address: track, abi: trackRecordAbi, functionName: "commit", args: [BigInt(agentId), prevHead, hashes] });
  const committed = logsOf<{ seq: bigint; fillHash: Hex; head: Hex }>(s.receipt, track, trackRecordAbi, "Committed").map((e) => ({ seq: Number(e.seq), fillHash: e.fillHash, head: e.head }));
  return { ...s, committed };
}
/** Every Committed event of one agent from `fromBlock` on (chunked; Monad's RPC caps a getLogs range). */
export async function committedEvents(agentId: string, fromBlock: number): Promise<{ seq: number; fillHash: Hex; head: Hex; block: number; tx: Hex }[]> {
  const pc = publicClient(), track = needTrack();
  const latest = Number(await pc.getBlockNumber());
  const out: { seq: number; fillHash: Hex; head: Hex; block: number; tx: Hex }[] = [];
  const STEP = 100;
  for (let a = Math.max(0, fromBlock); a <= latest; a += STEP) {
    const logs = await pc.getContractEvents({ address: track, abi: trackRecordAbi, eventName: "Committed", args: { agentId: BigInt(agentId) }, fromBlock: BigInt(a), toBlock: BigInt(Math.min(latest, a + STEP - 1)) });
    for (const l of logs as any[]) out.push({ seq: Number(l.args.seq), fillHash: l.args.fillHash, head: l.args.head, block: Number(l.blockNumber), tx: l.transactionHash });
  }
  return out.sort((x, y) => x.seq - y.seq);
}
export async function blockTime(block: number): Promise<number> {
  return Number((await publicClient().getBlock({ blockNumber: BigInt(block) })).timestamp) * 1000;
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────────────────────────
export async function requestValidation(validator: string, agentId: string, requestURI: string, requestHash: Hex): Promise<Sent> {
  return send(needOperator(), { address: needValidation(), abi: validationAbi, functionName: "validationRequest", args: [validator as `0x${string}`, BigInt(agentId), requestURI, requestHash] });
}
export async function respondValidation(requestHash: Hex, response: number, responseURI: string, responseHash: Hex, tag: string): Promise<Sent> {
  const v = validatorAccount();
  if (!v) throw new Error("VALIDATOR_PRIVATE_KEY is not set");
  return send(v, { address: needValidation(), abi: validationAbi, functionName: "validationResponse", args: [requestHash, Math.max(0, Math.min(100, Math.round(response))), responseURI, responseHash, tag] });
}
export async function validationSummary(agentId: string): Promise<{ count: number; average: number } | null> {
  const reg = trustConfig.validationRegistry();
  if (!reg) return null;
  const [count, avg] = (await publicClient().readContract({ address: reg, abi: validationAbi, functionName: "getSummary", args: [BigInt(agentId), [], ""] })) as [bigint, number];
  return { count: Number(count), average: Number(avg) };
}

// ── reputation ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface FeedbackRow { client: string; index: number; value: number; tag1: string; tag2: string; revoked: boolean }
/** Every feedback an agent received in the canonical Reputation Registry, and their average per tag1. */
export async function reputationOf(agentId: string): Promise<{ count: number; feedback: FeedbackRow[] }> {
  const pc = publicClient(), id = BigInt(agentId);
  const clients = (await pc.readContract({ address: REPUTATION_REGISTRY, abi: reputationAbi, functionName: "getClients", args: [id] })) as `0x${string}`[];
  if (!clients.length) return { count: 0, feedback: [] };
  const [cs, idx, values, decs, t1, t2, revoked] = (await pc.readContract({ address: REPUTATION_REGISTRY, abi: reputationAbi, functionName: "readAllFeedback", args: [id, clients, "", "", false] })) as [string[], bigint[], bigint[], number[], string[], string[], boolean[]];
  const feedback = cs.map((c, i) => ({ client: c.toLowerCase(), index: Number(idx[i]), value: Number(values[i]) / 10 ** Number(decs[i]), tag1: t1[i] ?? "", tag2: t2[i] ?? "", revoked: !!revoked[i] }));
  return { count: feedback.length, feedback };
}

// ── accounts ────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function balances(): Promise<{ operator: { address: string; mon: string; wei: bigint } | null; validator: { address: string; mon: string } | null }> {
  const pc = publicClient(), op = operatorAccount(), va = validatorAccount();
  const [ob, vb] = await Promise.all([op ? pc.getBalance({ address: op.address }) : null, va ? pc.getBalance({ address: va.address }) : null]);
  return {
    operator: op && ob != null ? { address: op.address, mon: formatEther(ob), wei: ob } : null,
    validator: va && vb != null ? { address: va.address, mon: formatEther(vb) } : null,
  };
}
