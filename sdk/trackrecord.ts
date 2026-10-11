// Chord TrackRecord SDK: check and write an ERC-8004 agent's track record on Monad.
// Each fill is a canonical JSON document; its keccak-256 is appended to the agent's chain in the TrackRecord contract:
//     head_0 = 0x0,   head_n = keccak256(head_{n-1} ‖ hash_n)
// verify() re-hashes the published documents, folds them and compares the result with chains(agentId) read from a Monad
// RPC. Nothing the document server says about hashes, heads or counts is trusted. viem only; runs in Bun, Node 18+ and
// browsers.
import { createClient, defineChain, http, keccak256, parseAbi, parseEventLogs, toBytes, type Abi, type Account, type Address, type Chain, type Hex, type TransactionReceipt, type Transport, type WalletClient } from "viem";
import { readContract, simulateContract, waitForTransactionReceipt } from "viem/actions";

// ── constants ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const MONAD_CHAIN_ID = 143;
export const MONAD_RPC = "https://rpc.monad.xyz";
export const EXPLORER = "https://monadscan.com";
export const APP_URL = "https://chordsi.xyz";
/** Canonical ERC-8004 Identity Registry on Monad (agent ids are its token ids). */
export const IDENTITY_REGISTRY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
/** Canonical ERC-8004 Reputation Registry on Monad. */
export const REPUTATION_REGISTRY: Address = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
/** ERC-8004 Validation Registry (proxy) deployed by Chord. */
export const VALIDATION_REGISTRY: Address = "0x695CAaeD3D15212F9eC6500992f373f09439F38d";
/** TrackRecord: one append-only hash chain per agent. */
export const TRACK_RECORD: Address = "0xf5650FB475747e2766faDb46aef735F3Ee4e9f09";
/** TrustGate: one view any contract calls before it hands an agent capital */
export const TRUST_GATE: Address = "0xcB30174c3Bf5f8170fA6769fe6D704F55968412A";
/** Chord's validator: replays a range of fills (hashes, chain, timing, prices) and answers in the Validation Registry */
export const CHORD_VALIDATOR: Address = "0x98C5d05f35Afb00B04781762c47a7676Af3056a4";
export const AGENT_REGISTRY = `eip155:${MONAD_CHAIN_ID}:${IDENTITY_REGISTRY}`;
export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
/** The document type Chord agents commit. */
export const DOC_TYPE = "chord-agent-fill/v1";
export const ZERO_HEAD: Hex = `0x${"0".repeat(64)}`;

export const monad: Chain = defineChain({
  id: MONAD_CHAIN_ID,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [MONAD_RPC] } },
  blockExplorers: { default: { name: "Monadscan", url: EXPLORER } },
});

export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
export const trustGateAbi = parseAbi([
  "function check(uint256 agentId) view returns (bool ok, uint64 fills, uint64 validations, uint8 avgScore, uint64 lastAt)",
]);
export const trackRecordAbi = parseAbi([
  "function commit(uint256 agentId, bytes32 prevHead, bytes32[] fillHashes) returns (bytes32 head, uint64 count)",
  "function chains(uint256 agentId) view returns (bytes32 head, uint64 count, uint64 lastAt)",
  "event Committed(uint256 indexed agentId, uint64 indexed seq, bytes32 fillHash, bytes32 head)",
]);
export const validationAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
]);

// ── documents and the chain ─────────────────────────────────────────────────────────────────────────────────────────
/** JSON with sorted keys and no whitespace; undefined becomes null, non-finite numbers become null. Same as the server. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return "null";
}

/** keccak-256 of a document's exact UTF-8 bytes: the hash committed on-chain. */
export const hashDoc = (text: string): Hex => keccak256(toBytes(text));

/** The head a list of hashes builds on `from` (the empty chain by default). */
export function chainHead(hashes: Hex[], from: Hex = ZERO_HEAD): Hex {
  let head = from;
  for (const h of hashes) head = keccak256(`0x${head.slice(2)}${h.slice(2)}`);
  return head;
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface ReadOptions {
  /** Monad RPC (default https://rpc.monad.xyz) */
  rpcUrl?: string;
  /** fetch used for the RPC and for HTTP documents (default: global fetch) */
  fetch?: FetchLike;
}
export type AgentId = number | bigint | string;
export interface OnchainChain { head: Hex; count: number; /** unix ms of the last commit (0 = never) */ lastAt: number }

const idOf = (agentId: AgentId): bigint => {
  const s = String(agentId).trim();
  if (!/^\d+$/.test(s)) throw new Error(`agent id must be a whole number, got "${s}"`);
  return BigInt(s);
};
const fetchOf = (opts: ReadOptions): FetchLike => opts.fetch ?? ((input, init) => fetch(input, init));

/** A bare viem client on Monad (only the actions used here are bundled, not all of createPublicClient). */
export function rpcClient(opts: ReadOptions = {}) {
  return createClient({ chain: monad, transport: http(opts.rpcUrl ?? MONAD_RPC, { fetchFn: opts.fetch as any, retryCount: 2 }) });
}

/** TrackRecord.chains(agentId), read from the RPC. */
export async function readChain(agentId: AgentId, opts: ReadOptions = {}): Promise<OnchainChain> {
  const [head, count, lastAt] = await readContract(rpcClient(opts), { address: TRACK_RECORD, abi: trackRecordAbi, functionName: "chains", args: [idOf(agentId)] });
  return { head, count: Number(count), lastAt: Number(lastAt) * 1000 };
}

/** The agent's agentURI (Identity Registry tokenURI). */
export async function agentURI(agentId: AgentId, opts: ReadOptions = {}): Promise<string> {
  return readContract(rpcClient(opts), { address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [idOf(agentId)] });
}

/** Fetch a JSON document by URL; data:, ipfs:// and ar:// URIs are resolved too. */
async function getJson(uri: string, opts: ReadOptions): Promise<any> {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    const meta = uri.slice(5, comma), body = uri.slice(comma + 1);
    const text = meta.endsWith(";base64") ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))) : decodeURIComponent(body);
    return JSON.parse(text);
  }
  const url = uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, "")}` : uri.startsWith("ar://") ? `https://arweave.net/${uri.slice(5)}` : uri;
  const r = await fetchOf(opts)(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}

export interface Service { name: string; endpoint: string; version?: string }
export interface Registration {
  type: string; name: string; description: string; image?: string;
  services: Service[]; x402Support?: boolean; active?: boolean;
  registrations?: { agentId: number; agentRegistry: string }[];
  supportedTrust?: string[]; [k: string]: unknown;
}

/** The ERC-8004 registration file the agent's agentURI points at. */
export async function registration(agentId: AgentId, opts: ReadOptions = {}): Promise<Registration & { uri: string }> {
  const uri = await agentURI(agentId, opts);
  if (!uri) throw new Error(`agent #${agentId} has no agentURI`);
  const reg = await getJson(uri, opts);
  if (!reg || typeof reg !== "object") throw new Error(`the registration file at ${uri} is not a JSON object`);
  // early drafts of ERC-8004 named the list "endpoints"
  const services = Array.isArray(reg.services) ? reg.services : Array.isArray(reg.endpoints) ? reg.endpoints : [];
  return { ...reg, services, uri };
}

/** The agent's "track-record" endpoint, from its registration file. */
export async function fillsUrl(agentId: AgentId, opts: ReadOptions = {}): Promise<string> {
  const reg = await registration(agentId, opts);
  const s = reg.services.find((x) => String(x?.name ?? "").toLowerCase() === "track-record");
  if (!s?.endpoint) throw new Error(`agent #${agentId}: the registration file at ${reg.uri} has no "track-record" service`);
  return /^(https?|data|ipfs|ar):/.test(s.endpoint) ? s.endpoint : new URL(s.endpoint, reg.uri).toString();
}

export interface FillEntry { seq: number; hash?: string; doc: string; [k: string]: unknown }
const PAGE = 1000;

/** The documents a track-record endpoint serves (`{ fills: [{ seq, hash, doc }] }`), sorted by seq. Pages with
 *  `from`/`to` while full pages of 1,000 come back (Chord's endpoint pages that way; others answer once). */
export async function fetchFills(url: string, opts: ReadOptions = {}): Promise<FillEntry[]> {
  const bySeq = new Map<number, FillEntry>();
  let maxSeq = 0;
  const take = (body: any): number => {
    const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.fills) ? body.fills : [];
    const base = maxSeq;
    let added = 0;
    list.forEach((f, i) => {
      if (!f || f.doc == null) return;
      const seq = Number.isSafeInteger(f.seq) ? f.seq : base + i + 1; // no seq: the list order is the chain order
      if (bySeq.has(seq)) return;
      bySeq.set(seq, { ...f, seq, doc: typeof f.doc === "string" ? f.doc : canonical(f.doc) });
      maxSeq = Math.max(maxSeq, seq);
      added++;
    });
    return list.length === PAGE ? added : 0;
  };
  let more = take(await getJson(url, opts));
  for (let i = 0; more > 0 && i < 100; i++) {
    const next = new URL(url), from = maxSeq + 1;
    next.searchParams.set("from", String(from));
    next.searchParams.set("to", String(from + PAGE - 1));
    more = take(await getJson(next.toString(), opts));
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export interface VerifyResult {
  /** true when the committed documents rebuild exactly the head and count Monad holds */
  ok: boolean;
  agentId: string;
  /** documents re-hashed (the first `onchain.count` by seq) */
  documents: number;
  /** seqs whose document does not hash to the hash the endpoint lists next to it */
  badHashes: number[];
  /** committed seqs the endpoint does not serve */
  missing: number[];
  rebuiltHead: Hex;
  onchain: OnchainChain;
  fillsUrl: string;
  reason: string;
}

/** Re-hash every committed document, fold the chain, compare with chains(agentId) on Monad. */
export async function verify(agentId: AgentId, opts: ReadOptions & { fillsUrl?: string } = {}): Promise<VerifyResult> {
  const id = idOf(agentId).toString();
  const url = opts.fillsUrl ?? (await fillsUrl(id, opts));
  const [onchain, fills] = await Promise.all([readChain(id, opts), fetchFills(url, opts)]);
  const bySeq = new Map(fills.map((f) => [f.seq, f]));
  const hashes: Hex[] = [], badHashes: number[] = [], missing: number[] = [];
  for (let seq = 1; seq <= onchain.count; seq++) {
    const f = bySeq.get(seq);
    if (!f) { missing.push(seq); continue; }
    const h = hashDoc(f.doc);
    if (typeof f.hash === "string" && f.hash.toLowerCase() !== h.toLowerCase()) badHashes.push(seq);
    hashes.push(h);
  }
  const rebuiltHead = chainHead(hashes);
  const equal = !missing.length && rebuiltHead.toLowerCase() === onchain.head.toLowerCase();
  const ok = equal && onchain.count > 0;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const reason = onchain.count === 0 ? `agent #${id} has no fills on TrackRecord yet`
    : missing.length ? `${plural(missing.length, "committed document")} missing from ${url} (seq ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""})`
    : !equal ? `rebuilt head ${rebuiltHead} differs from Monad's ${onchain.head}${badHashes.length ? `; document${badHashes.length === 1 ? "" : "s"} #${badHashes.slice(0, 5).join(", #")} do not hash to their listed hash` : ""}`
    : `${plural(onchain.count, "document")} rebuild the head Monad holds for agent #${id}${badHashes.length ? ` (the endpoint lists wrong hashes for #${badHashes.join(", #")})` : ""}`;
  return { ok, agentId: id, documents: hashes.length, badHashes, missing, rebuiltHead, onchain, fillsUrl: url, reason };
}

// ── writes (viem WalletClient with an account; the transaction must be on Monad) ───────────────────────────────────
export interface Sent { tx: Hex; block: number; receipt: TransactionReceipt }
type Wallet = WalletClient<Transport, Chain | undefined, Account | undefined>;

async function send(wallet: Wallet, req: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }, opts: ReadOptions): Promise<Sent> {
  const account = wallet.account;
  if (!account) throw new Error("the wallet client has no account");
  const pc = rpcClient(opts);
  const { request } = await simulateContract(pc, { ...req, account } as any); // a revert surfaces here, before signing
  const tx = await wallet.writeContract({ ...(request as any), account, chain: monad });
  const receipt = await waitForTransactionReceipt(pc, { hash: tx, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`transaction ${tx} reverted`);
  return { tx, block: Number(receipt.blockNumber), receipt };
}
const at = (addr: Address) => (l: { address: string }) => l.address.toLowerCase() === addr.toLowerCase();

/** Register an agent in the ERC-8004 Identity Registry; the wallet's account owns the identity. Answers the new agentId. */
export async function register(wallet: Wallet, uri: string, opts: ReadOptions = {}): Promise<Sent & { agentId: string }> {
  const s = await send(wallet, { address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "register", args: [uri] }, opts);
  const ev = parseEventLogs({ abi: identityAbi, logs: s.receipt.logs, eventName: "Registered" }).find(at(IDENTITY_REGISTRY));
  if (!ev) throw new Error(`register ${s.tx}: no Registered event in the receipt`);
  return { ...s, agentId: ev.args.agentId.toString() };
}

/** Append documents to the agent's chain (the wallet must own the identity or be an approved operator). Reads the current
 *  head, hashes each document, commits them in order. Publish the same exact strings at the track-record endpoint. */
export async function commit(wallet: Wallet, agentId: AgentId, docs: string[], opts: ReadOptions = {}): Promise<Sent & { prevHead: Hex; head: Hex; count: number; committed: { seq: number; fillHash: Hex; head: Hex }[] }> {
  if (!docs.length) throw new Error("nothing to commit");
  const id = idOf(agentId);
  const prev = await readChain(id, opts);
  const hashes = docs.map(hashDoc);
  const s = await send(wallet, { address: TRACK_RECORD, abi: trackRecordAbi, functionName: "commit", args: [id, prev.head, hashes] }, opts);
  const committed = parseEventLogs({ abi: trackRecordAbi, logs: s.receipt.logs, eventName: "Committed" })
    .filter((l) => at(TRACK_RECORD)(l) && l.args.agentId === id)
    .map((l) => ({ seq: Number(l.args.seq), fillHash: l.args.fillHash, head: l.args.head }))
    .sort((a, b) => a.seq - b.seq);
  const head = chainHead(hashes, prev.head);
  const last = committed[committed.length - 1];
  if (!last || last.head.toLowerCase() !== head.toLowerCase()) throw new Error(`commit ${s.tx}: the Committed events do not end at the expected head ${head}`);
  return { ...s, prevHead: prev.head, head, count: last.seq, committed };
}

/** Ask a validator through the ERC-8004 Validation Registry. requestHash = hashDoc(request document) served at requestURI. */
export async function requestValidation(wallet: Wallet, p: { agentId: AgentId; validator: Address; requestURI: string; requestHash: Hex }, opts: ReadOptions = {}): Promise<Sent & { requestHash: Hex }> {
  const s = await send(wallet, { address: VALIDATION_REGISTRY, abi: validationAbi, functionName: "validationRequest", args: [p.validator, idOf(p.agentId), p.requestURI, p.requestHash] }, opts);
  return { ...s, requestHash: p.requestHash };
}

/** Point the identity at a new registration file (e.g. once the agentId is known and the file can name its own endpoints). */
export async function setAgentURI(wallet: Wallet, agentId: AgentId, uri: string, opts: ReadOptions = {}): Promise<Sent> {
  return send(wallet, { address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "setAgentURI", args: [idOf(agentId), uri] }, opts);
}

// ── Chord's document host and validator (https://chordsi.xyz) ───────────────────────────────────────────────────────
export interface HostOptions { host?: string; fetch?: FetchLike }
const hostOf = (o: HostOptions) => (o.host ?? APP_URL).replace(/\/$/, "");
/** Publish documents on Chord's document host: each is stored by its keccak-256 (so it can never be swapped) and served back
 *  byte for byte at /v1/trust/docs/<hash>; an agent's commits joined with them read at /v1/trust/onchain/<agentId>/fills. */
export async function publish(docs: (string | object)[], o: HostOptions = {}): Promise<{ hash: Hex; url: string; committed: boolean }[]> {
  const out: { hash: Hex; url: string; committed: boolean }[] = [];
  for (let i = 0; i < docs.length; i += 50) {
    const r = await (o.fetch ?? fetch)(`${hostOf(o)}/v1/trust/docs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ docs: docs.slice(i, i + 50).map((d) => (typeof d === "string" ? d : canonical(d))) }) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`publish: ${j.message ?? `HTTP ${r.status}`}`);
    out.push(...j.docs);
  }
  return out;
}
/** The track-record endpoint Chord serves for any agent: its commits joined with the documents published on the host. */
export const hostedFillsUrl = (agentId: AgentId, o: HostOptions = {}) => `${hostOf(o)}/v1/trust/onchain/${String(agentId)}/fills`;
/** Ask Chord's validator to replay fills fromSeq..toSeq (default: the whole chain): the request document is published on the
 *  host (so requestURI serves exactly what requestHash commits to), the request goes on-chain from the agent's owner, and the
 *  validator is told about the transaction. The report lands at reportURI once the validator answers on-chain. */
export async function askChordValidator(wallet: Wallet, agentId: AgentId, p: { fromSeq?: number; toSeq?: number } & HostOptions = {}, opts: ReadOptions = {}) {
  const chain = await readChain(agentId, opts);
  if (!chain.count) throw new Error("the agent has no committed fill yet");
  const request = canonical({ type: "chord-agent-validation-request/v1", chainId: MONAD_CHAIN_ID, agentRegistry: AGENT_REGISTRY, agentId: String(agentId), trackRecord: TRACK_RECORD,
    range: { fromSeq: p.fromSeq ?? 1, toSeq: p.toSeq ?? chain.count }, fills: hostedFillsUrl(agentId, p), createdAt: Date.now() });
  const [doc] = await publish([request], p);
  const sent = await requestValidation(wallet, { agentId, validator: CHORD_VALIDATOR, requestURI: doc!.url, requestHash: doc!.hash }, opts);
  await (p.fetch ?? fetch)(`${hostOf(p)}/v1/trust/validation/notify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tx: sent.tx }) }).catch(() => null);
  return { ...sent, requestURI: doc!.url, reportURI: `${hostOf(p)}/v1/trust/validation/responses/${doc!.hash}.json` };
}
/** TrustGate.check(agentId): the answer a contract gets before it trusts the agent with capital. */
export async function gateCheck(agentId: AgentId, opts: ReadOptions = {}) {
  const [ok, fills, validations, avgScore, lastAt] = await readContract(rpcClient(opts), { address: TRUST_GATE, abi: trustGateAbi, functionName: "check", args: [idOf(agentId)] }) as [boolean, bigint, bigint, number, bigint];
  return { ok, fills: Number(fills), validations: Number(validations), avgScore: Number(avgScore), lastAt: Number(lastAt) * 1000 };
}

// ── registration file ───────────────────────────────────────────────────────────────────────────────────────────────
export interface RegistrationInput {
  name: string;
  description: string;
  image?: string;
  endpoints: {
    /** URL answering { fills: [{ seq, hash, doc }] } */
    trackRecord: string;
    web?: string;
    api?: string;
    mcp?: string;
    a2a?: string;
  };
  /** the type your fill documents declare (the track-record service's version); default chord-agent-fill/v1 */
  docType?: string;
  /** extra services, appended as given */
  services?: Service[];
  /** set once the identity exists (ERC-8004 registrations[]) */
  agentId?: AgentId;
  active?: boolean;
  x402Support?: boolean;
}

/** An ERC-8004 registration-v1 object for an agent that keeps its record on TrackRecord. Serve it at the agentURI. */
export function registrationFile(p: RegistrationInput): Registration {
  const e = p.endpoints;
  const services: Service[] = [
    ...(e.web ? [{ name: "web", endpoint: e.web }] : []),
    ...(e.api ? [{ name: "agent-api", endpoint: e.api }] : []),
    ...(e.mcp ? [{ name: "MCP", endpoint: e.mcp }] : []),
    ...(e.a2a ? [{ name: "A2A", endpoint: e.a2a }] : []),
    { name: "track-record", endpoint: e.trackRecord, version: p.docType ?? DOC_TYPE },
    ...(p.services ?? []),
  ];
  const agentId = p.agentId == null ? null : idOf(p.agentId).toString();
  return {
    type: REGISTRATION_TYPE,
    name: p.name,
    description: p.description,
    ...(p.image ? { image: p.image } : {}),
    services,
    x402Support: p.x402Support ?? false,
    active: p.active ?? true,
    registrations: agentId ? [{ agentId: Number(agentId), agentRegistry: AGENT_REGISTRY }] : [],
    supportedTrust: ["validation", "reputation"],
    trackRecord: { chainId: MONAD_CHAIN_ID, contract: TRACK_RECORD, agentId },
  };
}
