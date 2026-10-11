// Every ERC-8004 agent on Monad, not only this app's: the canonical Identity Registry numbers agents from 0 up, so the index
// reads ownerOf and tokenURI for every id through Multicall3 (150 ids a call, ~70 calls for the whole registry), then fetches
// each agent card in the background (16 at a time, 4 s timeout, 64 KB cap; https, data: and ipfs:// through a gateway).
// Joined with what this server can check: commits on TrackRecord (the chain index), answered validations, TrustGate.
import { logger } from "../chord/utils/logger";
import { IDENTITY_REGISTRY } from "../monad/chain";
import { publicClient } from "../monad/client";
import { identityAbi } from "./abi";
import { trustDb } from "./registry";
import { safeFetch } from "./safeFetch";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const BATCH = 150;
const CARD_CONCURRENCY = 16;
const CARDS_PER_TICK = 400;
const CARD_TTL_MS = 24 * 3_600_000;

function db() {
  const d = trustDb();
  d.run(`CREATE TABLE IF NOT EXISTS registry_agents (agent_id INTEGER PRIMARY KEY, owner TEXT, uri TEXT, scheme TEXT, name TEXT, description TEXT,
    image TEXT, services TEXT, trust TEXT, card TEXT, card_at INTEGER, updated INTEGER NOT NULL)`);
  d.run("CREATE INDEX IF NOT EXISTS registry_agents_owner ON registry_agents (owner)");
  return d;
}
const schemeOf = (uri: string | null) => (!uri ? "none" : /^https?:\/\//i.test(uri) ? "https" : uri.startsWith("data:") ? "data" : uri.startsWith("ipfs://") ? "ipfs" : uri.startsWith("ar://") ? "ar" : "other");

/** the first id with no owner (ids are sequential from 0): grow from the last known top, then bisect */
async function nextFreeId(from: number): Promise<number> {
  const pc = publicClient();
  const exists = async (id: number) => { try { await pc.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [BigInt(id)] }); return true; } catch { return false; } };
  let lo = Math.max(0, from), hi = lo + 64;
  if (!(await exists(lo))) return lo;
  while (await exists(hi)) { lo = hi; hi = hi * 2 + 64; }
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await exists(mid)) lo = mid; else hi = mid; }
  return hi;
}

let syncing: Promise<number> | null = null;
let last: { at: number; top: number; error: string | null } = { at: 0, top: 0, error: null };
/** Read owner and agentURI for ids [from, top): new ids, or every id when `all` (owners and URIs change). Answers rows written. */
export function syncRegistry(all = false): Promise<number> {
  syncing ??= (async () => {
    let wrote = 0;
    try {
      const known = (db().query("SELECT COALESCE(MAX(agent_id), -1) AS m FROM registry_agents").get() as { m: number }).m;
      const top = await nextFreeId(Math.max(0, known));
      const pc = publicClient(), up = db().prepare(`INSERT INTO registry_agents (agent_id, owner, uri, scheme, updated) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (agent_id) DO UPDATE SET owner = excluded.owner, uri = excluded.uri, scheme = excluded.scheme, updated = excluded.updated,
          card_at = CASE WHEN registry_agents.uri IS excluded.uri THEN registry_agents.card_at ELSE NULL END`);
      for (let a = all ? 0 : known + 1; a < top; a += BATCH) {
        const ids = Array.from({ length: Math.min(BATCH, top - a) }, (_, k) => a + k);
        const res = await pc.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: ids.flatMap((id) => [
          { address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [BigInt(id)] },
          { address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [BigInt(id)] },
        ]) as any });
        const now = Date.now();
        db().transaction(() => {
          ids.forEach((id, k) => {
            const owner = res[2 * k]?.status === "success" ? String(res[2 * k]!.result).toLowerCase() : null;
            const uri = res[2 * k + 1]?.status === "success" ? String(res[2 * k + 1]!.result).slice(0, 20_000) || null : null;
            if (owner) { up.run(id, owner, uri, schemeOf(uri), now); wrote++; }
          });
        })();
      }
      last = { at: Date.now(), top, error: null };
    } catch (e) {
      last = { ...last, at: Date.now(), error: String((e as Error)?.message ?? e).slice(0, 200) };
      logger.warn({ err: last.error }, "registry: sync failed");
    }
    return wrote;
  })().finally(() => { syncing = null; });
  return syncing;
}

/** an agent card's JSON from its URI (https, data:, ipfs:// via a public gateway), or why not */
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export async function readCard(uri: string, fetcher: Fetcher = safeFetch): Promise<{ card: any } | { error: string }> {
  try {
    if (uri.startsWith("data:")) {
      const comma = uri.indexOf(",");
      const body = uri.slice(comma + 1), meta = uri.slice(5, comma);
      return { card: JSON.parse(meta.includes(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body)) };
    }
    const url = uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, "")}` : uri;
    if (!/^https?:\/\//i.test(url)) return { error: "unsupported scheme" };
    const r = await fetcher(url, { signal: AbortSignal.timeout(4_000), headers: { accept: "application/json" } });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const text = (await r.text()).slice(0, 65_536);
    return { card: JSON.parse(text) };
  } catch (e) { return { error: String((e as Error)?.name === "TimeoutError" ? "timeout" : (e as Error)?.message ?? e).slice(0, 80) }; }
}
const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) || null : null);
/** Fetch the cards not read yet (or older than a day), CARDS_PER_TICK a pass. */
export async function fetchCards(limit = CARDS_PER_TICK, fetcher: Fetcher = safeFetch): Promise<number> {
  const rows = db().query("SELECT agent_id, uri FROM registry_agents WHERE uri IS NOT NULL AND scheme IN ('https','data','ipfs') AND (card_at IS NULL OR card_at < ?) ORDER BY card_at IS NOT NULL, agent_id DESC LIMIT ?")
    .all(Date.now() - CARD_TTL_MS, limit) as { agent_id: number; uri: string }[];
  const set = db().prepare("UPDATE registry_agents SET name = ?, description = ?, image = ?, services = ?, trust = ?, card = ?, card_at = ? WHERE agent_id = ?");
  let i = 0;
  await Promise.all(Array.from({ length: CARD_CONCURRENCY }, async () => {
    while (i < rows.length) {
      const r = rows[i++]!;
      const got = await readCard(r.uri, fetcher);
      const c = "card" in got && got.card && typeof got.card === "object" ? got.card : null;
      const services = c && Array.isArray(c.services ?? c.endpoints) ? (c.services ?? c.endpoints).filter((s: any) => s && typeof s.name === "string").slice(0, 12).map((s: any) => ({ name: String(s.name).slice(0, 40), endpoint: str(s.endpoint, 300) })) : [];
      set.run(c ? str(c.name, 80) : null, c ? str(c.description, 300) : null, c ? str(c.image, 300) : null, JSON.stringify(services),
        JSON.stringify(c && Array.isArray(c.supportedTrust) ? c.supportedTrust.filter((t: unknown) => typeof t === "string").slice(0, 6) : []), c ? "ok" : ("error" in got ? got.error : "not JSON"), Date.now(), r.agent_id);
    }
  }));
  return rows.length;
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface RegistryRow {
  agentId: number; owner: string | null; uri: string | null; scheme: string; name: string | null; description: string | null; image: string | null;
  card: "ok" | "unread" | string; services: string[]; trackRecordService: boolean; commits: number; validations: number; avgScore: number | null; ours: boolean;
}
type Filter = "all" | "record" | "card" | "validated";
/** Search every ERC-8004 agent on Monad: by id, name, description or owner; filter to those with a record, a card or a validation. */
export function searchRegistry(o: { q?: string; filter?: Filter; page?: number; size?: number } = {}): { total: number; rows: RegistryRow[] } {
  const size = Math.max(1, Math.min(100, o.size ?? 50)), page = Math.max(0, o.page ?? 0), q = (o.q ?? "").trim().toLowerCase();
  const where: string[] = [], args: (string | number)[] = [];
  if (q) {
    if (/^\d+$/.test(q)) { where.push("r.agent_id = ?"); args.push(Number(q)); }
    else if (/^0x[0-9a-f]{1,40}$/.test(q)) { where.push("r.owner LIKE ?"); args.push(`${q}%`); }
    else { where.push("(lower(r.name) LIKE ? OR lower(r.description) LIKE ?)"); args.push(`%${q}%`, `%${q}%`); }
  }
  if (o.filter === "record") where.push("c.n > 0");
  if (o.filter === "card") where.push("r.card = 'ok'");
  if (o.filter === "validated") where.push("v.n > 0");
  const from = `FROM registry_agents r
    LEFT JOIN (SELECT CAST(agent_id AS INTEGER) AS id, COUNT(*) AS n FROM trust_chain GROUP BY agent_id) c ON c.id = r.agent_id
    LEFT JOIN (SELECT CAST(agent_id AS INTEGER) AS id, COUNT(*) AS n, AVG(response) AS avg FROM trust_validations WHERE response IS NOT NULL GROUP BY agent_id) v ON v.id = r.agent_id
    LEFT JOIN (SELECT CAST(agent_id AS INTEGER) AS id FROM trust_agents WHERE agent_id IS NOT NULL) o ON o.id = r.agent_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  ensureJoinTables();
  const total = (db().query(`SELECT COUNT(*) AS n ${from}`).get(...args) as { n: number }).n;
  const rows = db().query(`SELECT r.*, COALESCE(c.n, 0) AS commits, COALESCE(v.n, 0) AS vals, v.avg AS avg, o.id IS NOT NULL AS ours ${from}
    ORDER BY COALESCE(c.n, 0) > 0 DESC, COALESCE(v.n, 0) DESC, r.card = 'ok' DESC, r.agent_id DESC LIMIT ? OFFSET ?`).all(...args, size, page * size) as any[];
  return { total, rows: rows.map((r) => {
    const services = (() => { try { return (JSON.parse(r.services ?? "[]") as { name: string }[]).map((s) => s.name); } catch { return []; } })();
    return { agentId: r.agent_id, owner: r.owner, uri: r.uri, scheme: r.scheme, name: r.name, description: r.description, image: r.image, card: r.card ?? "unread",
      services, trackRecordService: services.includes("track-record"), commits: r.commits, validations: r.vals, avgScore: r.avg == null ? null : Math.round(r.avg * 10) / 10, ours: !!r.ours };
  }) };
}
/** the tables the search joins exist even before the first commit or validation */
function ensureJoinTables() {
  const d = trustDb();
  d.run(`CREATE TABLE IF NOT EXISTS trust_chain (agent_id TEXT NOT NULL, seq INTEGER NOT NULL, fill_hash TEXT NOT NULL, head TEXT NOT NULL, block INTEGER NOT NULL, tx TEXT NOT NULL, PRIMARY KEY (agent_id, seq))`);
}
/** The registry in numbers: agents, cards read, agents that keep a record here, validated ones, the biggest card hosts and owners. */
export function registryStats() {
  ensureJoinTables();
  const n = (sql: string) => (db().query(sql).get() as { n: number }).n;
  const hosts = (db().query("SELECT uri FROM registry_agents WHERE scheme = 'https'").all() as { uri: string }[]).reduce((m, r) => { try { const h = new URL(r.uri).host; m.set(h, (m.get(h) ?? 0) + 1); } catch { /* not a URL */ } return m; }, new Map<string, number>());
  return {
    agents: n("SELECT COUNT(*) AS n FROM registry_agents"),
    withUri: n("SELECT COUNT(*) AS n FROM registry_agents WHERE uri IS NOT NULL"),
    cardsRead: n("SELECT COUNT(*) AS n FROM registry_agents WHERE card_at IS NOT NULL"),
    cardsOk: n("SELECT COUNT(*) AS n FROM registry_agents WHERE card = 'ok'"),
    trackRecordService: n("SELECT COUNT(*) AS n FROM registry_agents WHERE services LIKE '%\"track-record\"%'"),
    withRecord: n("SELECT COUNT(DISTINCT agent_id) AS n FROM trust_chain"),
    validated: n("SELECT COUNT(DISTINCT agent_id) AS n FROM trust_validations WHERE response IS NOT NULL"),
    owners: n("SELECT COUNT(DISTINCT owner) AS n FROM registry_agents"),
    topHosts: [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([host, agents]) => ({ host, agents })),
    topOwners: (db().query("SELECT owner, COUNT(*) AS agents FROM registry_agents GROUP BY owner ORDER BY agents DESC LIMIT 6").all() as { owner: string; agents: number }[]),
    sync: last,
  };
}

let timers: ReturnType<typeof setInterval>[] = [];
/** On boot: new ids every 2 minutes, every id's owner and URI every 6 hours, cards in the background every 30 s. */
export function startRegistryIndex(): void {
  if (timers.length || process.env.NODE_ENV === "test") return;
  const tick = () => void syncRegistry().then((n) => { if (n) logger.info({ wrote: n, top: last.top }, "registry: agents indexed"); });
  setTimeout(tick, 12_000);
  let cardsBusy = false;
  const cards = () => { if (cardsBusy) return; cardsBusy = true; void fetchCards().catch(() => 0).finally(() => { cardsBusy = false; }); };
  timers = [setInterval(tick, 120_000), setInterval(() => void syncRegistry(true), 6 * 3_600_000), setInterval(cards, 30_000)];
  setTimeout(cards, 40_000);
  for (const t of timers) (t as any).unref?.();
}
export function _resetRegistry(): void { syncing = null; last = { at: 0, top: 0, error: null }; for (const t of timers) clearInterval(t); timers = []; }
