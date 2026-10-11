// The open side of the trust layer: TrackRecord takes commits from the owner of ANY ERC-8004 identity, so the record is not
// limited to this app's agents. This module makes outside agents first-class:
//   · an index of every Committed event on TrackRecord (all agents), kept in SQLite and caught up every minute;
//   · a document host: an agent publishes each fill's canonical JSON here (content-addressed by its keccak-256, so a stored
//     document can never be swapped), and its fills read back joined with the chain at /v1/trust/onchain/:agentId/fills;
//   · the list of outside agents, each named from the registration file its agentURI points at.
// The chain stays the source of truth: a document is shown only next to the event whose fillHash it hashes to.
import type { Hex } from "viem";
import { logger } from "../chord/utils/logger";
import { IDENTITY_REGISTRY } from "../monad/chain";
import { publicClient } from "../monad/client";
import { identityAbi, trackRecordAbi } from "./abi";
import { canonical, hashDoc } from "./canonical";
import { trustConfig } from "./chain";
import { trustDb } from "./registry";

/** TrackRecord's deploy block on Monad (the index starts here) */
export const TRACK_RECORD_FROM_BLOCK = Number(process.env.TRACK_RECORD_FROM_BLOCK || 112_399_354);
const SYNC_MS = 60_000;
const MAX_DOC_BYTES = 16_384;

function db() {
  const d = trustDb();
  d.run(`CREATE TABLE IF NOT EXISTS trust_chain (agent_id TEXT NOT NULL, seq INTEGER NOT NULL, fill_hash TEXT NOT NULL, head TEXT NOT NULL,
    block INTEGER NOT NULL, tx TEXT NOT NULL, PRIMARY KEY (agent_id, seq))`);
  d.run("CREATE INDEX IF NOT EXISTS trust_chain_hash ON trust_chain (fill_hash)");
  d.run("CREATE TABLE IF NOT EXISTS trust_docs (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, at INTEGER NOT NULL)");
  d.run("CREATE TABLE IF NOT EXISTS trust_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  return d;
}
export const meta = (k: string): string | null => (db().query("SELECT v FROM trust_meta WHERE k = ?").get(k) as { v: string } | null)?.v ?? null;
export const setMeta = (k: string, v: string) => db().run("INSERT INTO trust_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [k, v]);

// ── the index of every commit ───────────────────────────────────────────────────────────────────────────────────────
let span = 2_000; // blocks per getLogs; halves on a refusal (Monad's public RPC answers 100), never under 100
/** every Committed event in [from, to]; a refused range is split in two (both halves read), and later windows use the smaller span */
async function logsBetween(from: number, to: number): Promise<any[]> {
  const track = trustConfig.trackRecord();
  if (!track) return [];
  try {
    return await publicClient().getContractEvents({ address: track, abi: trackRecordAbi, eventName: "Committed", fromBlock: BigInt(from), toBlock: BigInt(to) }) as any[];
  } catch (e) {
    if (to - from + 1 <= 100) throw e;
    span = Math.max(100, Math.floor((to - from + 1) / 2));
    const mid = from + span - 1;
    return [...(await logsBetween(from, mid)), ...(await logsBetween(mid + 1, to))];
  }
}
let syncing: Promise<number> | null = null;
let lastSync: { at: number; block: number; error: string | null } = { at: 0, block: 0, error: null };
/** Catch the index up to the head: windows of `span` blocks, four at a time. Answers the number of new events. */
export function syncChain(maxWindows = 400): Promise<number> {
  syncing ??= (async () => {
    let added = 0;
    try {
      const head = Number(await publicClient().getBlockNumber());
      let from = Number(meta("chain_cursor") ?? TRACK_RECORD_FROM_BLOCK - 1) + 1;
      const ins = db().prepare("INSERT OR IGNORE INTO trust_chain (agent_id, seq, fill_hash, head, block, tx) VALUES (?, ?, ?, ?, ?, ?)");
      for (let w = 0; w < maxWindows && from <= head; ) {
        const jobs: [number, number][] = [];
        for (let k = 0; k < 4 && from <= head && w < maxWindows; k++, w++) { const to = Math.min(head, from + span - 1); jobs.push([from, to]); from = to + 1; }
        const got = await Promise.all(jobs.map(([a, b]) => logsBetween(a, b)));
        db().transaction(() => {
          for (const logs of got) for (const l of logs) {
            const r = ins.run(l.args.agentId.toString(), Number(l.args.seq), String(l.args.fillHash).toLowerCase(), String(l.args.head).toLowerCase(), Number(l.blockNumber), l.transactionHash);
            added += r.changes;
          }
          setMeta("chain_cursor", String(jobs[jobs.length - 1]![1]));
        })();
      }
      lastSync = { at: Date.now(), block: Number(meta("chain_cursor")), error: null };
    } catch (e) {
      lastSync = { ...lastSync, at: Date.now(), error: String((e as Error)?.message ?? e).slice(0, 200) };
      logger.warn({ err: lastSync.error }, "trust: chain index sync failed");
    }
    return added;
  })().finally(() => { syncing = null; });
  return syncing;
}
let timer: ReturnType<typeof setInterval> | null = null;
export function startChainIndex(): void {
  if (timer || process.env.NODE_ENV === "test" || !trustConfig.trackRecord()) return;
  const tick = () => void syncChain().then((n) => { if (n) logger.info({ added: n, block: lastSync.block }, "trust: chain index caught up"); });
  setTimeout(tick, 8_000);
  timer = setInterval(tick, SYNC_MS);
  (timer as any).unref?.();
}
export const chainIndexStatus = () => ({ ...lastSync, span, agents: (db().query("SELECT COUNT(DISTINCT agent_id) AS n FROM trust_chain").get() as { n: number }).n });

export interface ChainEvent { agent_id: string; seq: number; fill_hash: string; head: string; block: number; tx: string }
export const chainOf = (agentId: string): ChainEvent[] => db().query("SELECT * FROM trust_chain WHERE agent_id = ? ORDER BY seq").all(agentId) as ChainEvent[];
/** this app's own agents: their ERC-8004 ids */
const ownIds = (): Set<string> => new Set((trustDb().query("SELECT agent_id FROM trust_agents WHERE agent_id IS NOT NULL").all() as { agent_id: string }[]).map((r) => r.agent_id));

// ── the document host ───────────────────────────────────────────────────────────────────────────────────────────────
export class DocInputError extends Error {}
/** Store one fill document (or a registration file): it must be canonical JSON (sorted keys, no spaces) under 16 KB. Answers
 *  its keccak-256, the hash a TrackRecord commit carries. Storing the same document twice is a no-op. */
export function putDoc(raw: unknown): { hash: Hex; bytes: number; committed: boolean } {
  const text = typeof raw === "string" ? raw : canonical(raw);
  if (Buffer.byteLength(text, "utf8") > MAX_DOC_BYTES) throw new DocInputError(`a document is at most ${MAX_DOC_BYTES} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new DocInputError("a document is one JSON value"); }
  if (canonical(parsed) !== text) throw new DocInputError("the document is not in canonical form: keys sorted, no whitespace (send the JSON object and the server canonicalises it, or canonicalise it first)");
  const hash = hashDoc(text).toLowerCase() as Hex;
  db().run("INSERT OR IGNORE INTO trust_docs (hash, doc, at) VALUES (?, ?, ?)", [hash, text, Date.now()]);
  const committed = !!db().query("SELECT 1 FROM trust_chain WHERE fill_hash = ? LIMIT 1").get(hash);
  return { hash, bytes: Buffer.byteLength(text, "utf8"), committed };
}
export const getDoc = (hash: string): string | null => (db().query("SELECT doc FROM trust_docs WHERE hash = ?").get(hash.toLowerCase()) as { doc: string } | null)?.doc ?? null;
/** a committed fill's document: this app's own record first, then the host */
function docFor(fillHash: string): string | null {
  const own = trustDb().query("SELECT doc FROM trust_fills WHERE lower(hash) = ? LIMIT 1").get(fillHash) as { doc: string } | null;
  return own?.doc ?? getDoc(fillHash);
}

/** Any agent's fills as the chain holds them, each with its document when one is published (here or by this app). */
export function onchainFills(agentId: string, from = 1, to = Number.MAX_SAFE_INTEGER) {
  return chainOf(agentId).filter((e) => e.seq >= from && e.seq <= to).map((e) => {
    const doc = docFor(e.fill_hash);
    let ts: number | null = null;
    try { const t = Number(JSON.parse(doc ?? "null")?.fill?.ts); ts = Number.isFinite(t) ? t : null; } catch { /* not this app's fill format */ }
    return { seq: e.seq, hash: e.fill_hash, doc, fillTs: ts, commitTx: e.tx, commitBlock: e.block, head: e.head };
  });
}

// ── outside agents ──────────────────────────────────────────────────────────────────────────────────────────────────
const regCache = new Map<string, { at: number; uri: string | null; owner: string | null; name: string | null; description: string | null; image: string | null; fillsUrl: string | null }>();
/** an agent's agentURI and owner from the Identity Registry, its name from the registration file (cached 10 minutes) */
export async function identityOf(agentId: string) {
  const c = regCache.get(agentId);
  if (c && Date.now() - c.at < 600_000) return c;
  const pc = publicClient(), id = BigInt(agentId);
  const [uri, owner] = await Promise.all([
    pc.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [id] }).catch(() => null) as Promise<string | null>,
    pc.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [id] }).catch(() => null) as Promise<string | null>,
  ]);
  let reg: any = null;
  if (uri && /^https?:\/\//.test(uri)) {
    try { const r = await fetch(uri, { signal: AbortSignal.timeout(4_000), redirect: "follow" }); if (r.ok) reg = JSON.parse((await r.text()).slice(0, 65_536)); } catch { /* unreachable or not JSON */ }
  } else if (uri?.startsWith("data:application/json")) {
    try { const b = uri.split(",")[1] ?? ""; reg = JSON.parse(uri.includes(";base64") ? Buffer.from(b, "base64").toString("utf8") : decodeURIComponent(b)); } catch { /* not JSON */ }
  }
  const svc = Array.isArray(reg?.services) ? reg.services.find((s: any) => s?.name === "track-record") : null;
  const out = { at: Date.now(), uri, owner, name: typeof reg?.name === "string" ? reg.name.slice(0, 80) : null, description: typeof reg?.description === "string" ? reg.description.slice(0, 280) : null,
    image: typeof reg?.image === "string" ? reg.image : null, fillsUrl: typeof svc?.endpoint === "string" ? svc.endpoint : null };
  regCache.set(agentId, out);
  return out;
}
/** Agents with commits on TrackRecord that this app does not run: who they are, how long their chain is, how much of it
 *  has a published document. */
export async function outsideAgents() {
  const own = ownIds();
  const rows = (db().query("SELECT agent_id, COUNT(*) AS n, MAX(seq) AS top, MAX(block) AS last_block, MAX(tx) AS any_tx FROM trust_chain GROUP BY agent_id ORDER BY last_block DESC").all() as { agent_id: string; n: number; top: number; last_block: number }[])
    .filter((r) => !own.has(r.agent_id)).slice(0, 100);
  return Promise.all(rows.map(async (r) => {
    const docs = (db().query("SELECT COUNT(*) AS n FROM trust_chain c JOIN trust_docs d ON d.hash = c.fill_hash WHERE c.agent_id = ?").get(r.agent_id) as { n: number }).n;
    const last = db().query("SELECT tx, block FROM trust_chain WHERE agent_id = ? ORDER BY seq DESC LIMIT 1").get(r.agent_id) as { tx: string; block: number };
    const id = await identityOf(r.agent_id).catch(() => null);
    return { agentId: r.agent_id, fills: r.n, published: docs, lastCommitTx: last.tx, lastCommitBlock: last.block, owner: id?.owner ?? null, agentURI: id?.uri ?? null, name: id?.name ?? null, description: id?.description ?? null, fillsUrl: id?.fillsUrl ?? `${trustConfig.publicBase()}/v1/trust/onchain/${r.agent_id}/fills` };
  }));
}
export function _resetOpen(): void { regCache.clear(); syncing = null; span = 2_000; if (timer) clearInterval(timer); timer = null; }
