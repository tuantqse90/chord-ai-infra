// /v1/market: the marketplace. An owner lists one of their trading agents with a title and a one-line pitch; everyone sees
// the listings ranked by a score built only from what anyone can check: fills committed to the agent's TrackRecord on Monad,
// the validator's replays in the ERC-8004 Validation Registry, ratings in the ERC-8004 Reputation Registry, and the paper PnL.
// Owners never leave the server.
//   GET    /                   ranked listings; sort = score | pnl | validated | new; X-Session marks the caller's own (mine)
//   POST   /listings           { botId, title?, pitch } list one of your trading agents, or edit its listing
//   DELETE /listings/:botId    unlist
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import { config } from "./config";
import { getBot, type Bot } from "./bots";
import { botRow } from "./bots/store";
import { resolveKey } from "./devkeys";
import { rowOf } from "./agentsApi";
import { reputationOf } from "./trust/chain";
import { trades } from "./trust/committer";
import { validationsOf } from "./trust/registry";

export const MAX_LISTINGS = 5;
const BOT_ID = /^[0-9a-f]{12}$/;
const SESSION_RE = /^[A-Za-z0-9:_-]{8,120}$/;
const now = () => Date.now();

let db: Database | null = null;
function store(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS market_listings (bot_id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, pitch TEXT NOT NULL,
    listed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS market_listings_owner ON market_listings (owner)");
  return db;
}
type ListingRow = { bot_id: string; owner: string; title: string; pitch: string; listed_at: number; updated_at: number };

function ownerOf(c: any): string | null {
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-api-key") ?? "";
  if (bearer.startsWith("ak_")) { const k = resolveKey(bearer); return k ? `key:${k.id}` : null; }
  const s = c.req.header("x-session");
  return s && SESSION_RE.test(s) ? s : null;
}

export class ListingError extends Error { constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); } }
/** Plain text: control characters out, runs of spaces folded. */
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "");

export function listAgent(owner: string, input: { botId?: unknown; title?: unknown; pitch?: unknown }): ListingRow {
  const id = typeof input?.botId === "string" ? input.botId : "";
  const row = BOT_ID.test(id) ? botRow(id) : null;
  if (!row || row.owner !== owner) throw new ListingError("No agent of yours has that id.", 404);
  if (!trades(row)) throw new ListingError("Only trading agents can be listed (copy traders and strategies that buy or sell): an alert has no fills to rank.");
  const title = clean(input.title) || row.name;
  if (title.length < 3 || title.length > 60) throw new ListingError("title: 3 to 60 characters.");
  const pitch = clean(input.pitch);
  if (pitch.length < 10 || pitch.length > 280) throw new ListingError("pitch: say what the agent does in 10 to 280 characters.");
  const was = store().query("SELECT * FROM market_listings WHERE bot_id = ?").get(id) as ListingRow | null;
  // a deleted agent's listing does not count (the bots table lives in the same database file)
  if (!was && (store().query("SELECT COUNT(*) AS n FROM market_listings m JOIN bots b ON b.id = m.bot_id WHERE m.owner = ?").get(owner) as { n: number }).n >= MAX_LISTINGS) {
    throw new ListingError(`Up to ${MAX_LISTINGS} listings per account: unlist one first.`, 409);
  }
  const t = now();
  store().run(`INSERT INTO market_listings (bot_id, owner, title, pitch, listed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (bot_id) DO UPDATE SET title = excluded.title, pitch = excluded.pitch, updated_at = excluded.updated_at`, [id, owner, title, pitch, t, t]);
  cache = null;
  return store().query("SELECT * FROM market_listings WHERE bot_id = ?").get(id) as ListingRow;
}
export function unlistAgent(owner: string, botId: string): boolean {
  const r = store().run("DELETE FROM market_listings WHERE bot_id = ? AND owner = ?", [botId, owner]);
  if (r.changes) cache = null;
  return r.changes > 0;
}

// ── the score ────────────────────────────────────────────────────────────────────────────────────────────────────────
// evidence   = committed fills / 20, at most 1 (an agent needs 20 fills on Monad before its score counts in full)
// validation = the validator's average score / 100 (0.5 until it has replayed anything)
// results    = 0.5 + 7-day PnL ÷ invested × 5, kept in 0..1 (+10 % → 1, −10 % → 0; 0.5 with nothing invested)
// rating     = the average on-chain rating / 100 (0.5 with no ratings)
// score      = 100 × evidence × (0.4 validation + 0.4 results + 0.2 rating); no ERC-8004 identity = 0
export const FULL_EVIDENCE = 20;
export type ScoreParts = { total: number; evidence: number; validation: number; results: number; rating: number };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const r2 = (x: number) => Math.round(x * 100) / 100;
export function scoreOf(i: { registered: boolean; committed: number; validationAvg: number | null; pnl7d: number; investedUsd: number; ratingAvg: number | null }): ScoreParts {
  const evidence = i.registered ? clamp01(i.committed / FULL_EVIDENCE) : 0;
  const validation = i.validationAvg == null ? 0.5 : clamp01(i.validationAvg / 100);
  const results = i.investedUsd > 0 ? clamp01(0.5 + (i.pnl7d / i.investedUsd) * 5) : 0.5;
  const rating = i.ratingAvg == null ? 0.5 : clamp01(i.ratingAvg / 100);
  return { total: Math.round(100 * evidence * (0.4 * validation + 0.4 * results + 0.2 * rating)), evidence: r2(evidence), validation: r2(validation), results: r2(results), rating: r2(rating) };
}
export const SCORING = `Score 0-100 = evidence × (40% validation + 40% results + 20% rating). Evidence: fills committed to the agent's TrackRecord on Monad, full weight at ${FULL_EVIDENCE}. Validation: the validator's average replay score. Results: 7-day paper PnL against what it invested (+10% or better = full marks, -10% or worse = none). Rating: the average rating in the ERC-8004 Reputation Registry. No validation or rating yet counts as half marks; no ERC-8004 identity scores 0.`;

// on-chain ratings, read at most every 5 minutes per agent; an RPC failure shows as no rating, never as a guess
const ratings = new Map<string, { at: number; v: { avg: number | null; count: number } }>();
async function ratingOf(agentId: string): Promise<{ avg: number | null; count: number }> {
  const hit = ratings.get(agentId);
  if (hit && now() - hit.at < 300_000) return hit.v;
  try {
    const live = (await reputationOf(agentId)).feedback.filter((f) => !f.revoked);
    const v = { avg: live.length ? r2(live.reduce((a, f) => a + f.value, 0) / live.length) : null, count: live.length };
    ratings.set(agentId, { at: now(), v });
    return v;
  } catch { return hit?.v ?? { avg: null, count: 0 }; }
}

export type Listing = {
  rank: number; botId: string; title: string; pitch: string; listedAt: number; mine?: boolean;
  agent: { id: string; name: string; type: Bot["type"]; status: Bot["status"]; template: string | null; createdAt: number };
  perf: { pnl7dUsd: number; pnlAllUsd: number; investedUsd: number; winRate: number | null; trades: number; openPositions: number; spark: number[]; copies: number };
  record: { agentId: string | null; committed: number; pending: number; lastCommitAt: number | null; validation: { avg: number | null; count: number; latest: number | null }; rating: { avg: number | null; count: number } };
  score: ScoreParts;
};
type Built = Listing & { owner: string };

let cache: { at: number; v: Built[] } | null = null;
async function build(): Promise<Built[]> {
  if (cache && now() - cache.at < 15_000) return cache.v;
  const rows = store().query("SELECT * FROM market_listings").all() as ListingRow[];
  const out: Built[] = [];
  await Promise.all(rows.map(async (l) => {
    const b = getBot(null, l.bot_id)?.bot;
    if (!b) return; // the agent was deleted: its listing goes with it
    const r = rowOf(b, "7d"), t = r.trust;
    const vals = validationsOf(b.id).map((v) => v.response).filter((x): x is number => x != null);
    const rating = t?.agentId ? await ratingOf(t.agentId) : { avg: null, count: 0 };
    const validationAvg = vals.length ? r2(vals.reduce((a, x) => a + x, 0) / vals.length) : null;
    out.push({
      rank: 0, botId: b.id, title: l.title, pitch: l.pitch, listedAt: l.listed_at, owner: l.owner,
      agent: { id: b.id, name: b.name, type: b.type, status: b.status, template: r.template, createdAt: b.createdAt },
      perf: { pnl7dUsd: r2(r.pnl), pnlAllUsd: r2(r.pnlAll), investedUsd: r2(b.stats.investedUsd ?? 0), winRate: b.stats.winRate, trades: b.stats.trades, openPositions: b.stats.openPositions, spark: r.spark, copies: r.copies },
      record: { agentId: t?.agentId ?? null, committed: t?.committed ?? 0, pending: t?.pending ?? 0, lastCommitAt: t?.lastCommitAt ?? null, validation: { avg: validationAvg, count: vals.length, latest: t?.validation?.response ?? null }, rating },
      score: scoreOf({ registered: !!t?.agentId, committed: t?.committed ?? 0, validationAvg, pnl7d: r.pnl, investedUsd: b.stats.investedUsd ?? 0, ratingAvg: rating.avg }),
    });
  }));
  cache = { at: now(), v: out };
  return out;
}

const SORTS = {
  score: (a: Built, b: Built) => b.score.total - a.score.total || b.record.committed - a.record.committed || b.perf.pnl7dUsd - a.perf.pnl7dUsd,
  pnl: (a: Built, b: Built) => b.perf.pnl7dUsd - a.perf.pnl7dUsd || b.score.total - a.score.total,
  validated: (a: Built, b: Built) => (b.record.validation.avg ?? -1) - (a.record.validation.avg ?? -1) || b.record.validation.count - a.record.validation.count || b.score.total - a.score.total,
  new: (a: Built, b: Built) => b.listedAt - a.listedAt,
} as const;
export type Sort = keyof typeof SORTS;

export async function listings(sort: Sort = "score", viewer: string | null = null): Promise<Listing[]> {
  return [...(await build())].sort(SORTS[sort]).map(({ owner, ...l }, i) => ({ ...l, rank: i + 1, ...(viewer && owner === viewer ? { mine: true } : {}) }));
}

export const market = new Hono();
market.get("/", async (c) => {
  const q = c.req.query("sort");
  const sort: Sort = q && q in SORTS ? (q as Sort) : "score";
  return c.json({ sort, scoring: SCORING, maxListings: MAX_LISTINGS, listings: await listings(sort, ownerOf(c)), updatedAt: now() });
});
market.post("/listings", async (c) => {
  const owner = ownerOf(c);
  if (!owner) return c.json({ error: "no_session", message: "send X-Session (web) or an API key" }, 401);
  const body = await c.req.json().catch(() => ({}));
  try { const l = listAgent(owner, body); return c.json({ botId: l.bot_id, title: l.title, pitch: l.pitch, listedAt: l.listed_at, updatedAt: l.updated_at }, 201); }
  catch (e) {
    if (e instanceof ListingError) return c.json({ error: "listing_refused", message: e.message }, e.status);
    throw e;
  }
});
market.delete("/listings/:botId", (c) => {
  const owner = ownerOf(c);
  if (!owner) return c.json({ error: "no_session", message: "send X-Session (web) or an API key" }, 401);
  return unlistAgent(owner, c.req.param("botId")) ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
});

export const _marketTest = { reset() { cache = null; ratings.clear(); db?.close(); db = null; } };
