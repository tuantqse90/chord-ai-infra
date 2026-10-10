// The trust layer's own records (SQLite, the bots' database file): each agent's ERC-8004 identity, the committed document and
// transaction of every filled fill, and the validations asked for and answered. The chain is the source of truth; these rows
// say where to look (agent id, transaction, sequence) and keep the exact document text that was hashed.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";

let db: Database | null = null;
export function trustDb(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run(`CREATE TABLE IF NOT EXISTS trust_agents (bot_id TEXT PRIMARY KEY, agent_id TEXT, agent_uri TEXT, register_tx TEXT, registered_at INTEGER,
    head TEXT, count INTEGER NOT NULL DEFAULT 0, last_commit_tx TEXT, last_commit_at INTEGER, error TEXT, tries INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS trust_fills (fill_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, seq INTEGER NOT NULL, doc TEXT NOT NULL, hash TEXT NOT NULL,
    fill_ts INTEGER NOT NULL, commit_tx TEXT, commit_block INTEGER, committed_at INTEGER, head TEXT, UNIQUE (bot_id, seq))`);
  db.run("CREATE INDEX IF NOT EXISTS trust_fills_pending ON trust_fills (bot_id, commit_tx, seq)");
  db.run(`CREATE TABLE IF NOT EXISTS trust_validations (request_hash TEXT PRIMARY KEY, bot_id TEXT NOT NULL, agent_id TEXT NOT NULL, validator TEXT NOT NULL,
    from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, head TEXT NOT NULL, request TEXT NOT NULL, request_tx TEXT, created_at INTEGER NOT NULL,
    response INTEGER, report TEXT, response_hash TEXT, response_tx TEXT, responded_at INTEGER, error TEXT)`);
  db.run("CREATE INDEX IF NOT EXISTS trust_validations_bot ON trust_validations (bot_id, created_at)");
  return db;
}
export function _closeTrustDb(): void { db?.close(); db = null; }

export interface AgentRow { bot_id: string; agent_id: string | null; agent_uri: string | null; register_tx: string | null; registered_at: number | null; head: string | null; count: number; last_commit_tx: string | null; last_commit_at: number | null; error: string | null; tries: number; updated: number }
export interface FillRow { fill_id: string; bot_id: string; seq: number; doc: string; hash: string; fill_ts: number; commit_tx: string | null; commit_block: number | null; committed_at: number | null; head: string | null }
export interface ValidationRow { request_hash: string; bot_id: string; agent_id: string; validator: string; from_seq: number; to_seq: number; head: string; request: string; request_tx: string | null; created_at: number; response: number | null; report: string | null; response_hash: string | null; response_tx: string | null; responded_at: number | null; error: string | null }

export const agentRow = (botId: string): AgentRow | null => trustDb().query("SELECT * FROM trust_agents WHERE bot_id = ?").get(botId) as AgentRow | null;
export const fillsOfBot = (botId: string, limit = 500): FillRow[] => trustDb().query("SELECT * FROM trust_fills WHERE bot_id = ? ORDER BY seq DESC LIMIT ?").all(botId, limit) as FillRow[];
export const fillRow = (fillId: string): FillRow | null => trustDb().query("SELECT * FROM trust_fills WHERE fill_id = ?").get(fillId) as FillRow | null;
export const validationsOf = (botId: string): ValidationRow[] => trustDb().query("SELECT * FROM trust_validations WHERE bot_id = ? ORDER BY created_at DESC LIMIT 20").all(botId) as ValidationRow[];
export const validationRow = (hash: string): ValidationRow | null => trustDb().query("SELECT * FROM trust_validations WHERE request_hash = ?").get(hash.toLowerCase()) as ValidationRow | null;

/** What a board row or an agent card shows about the agent's trust state (no network call). */
export function trustOf(botId: string): { agentId: string | null; registerTx: string | null; committed: number; pending: number; lastCommitTx: string | null; lastCommitAt: number | null; validation: { response: number; at: number } | null } | null {
  const a = agentRow(botId);
  const pend = (trustDb().query("SELECT COUNT(*) AS n FROM trust_fills WHERE bot_id = ? AND commit_tx IS NULL").get(botId) as { n: number }).n;
  if (!a && !pend) return null;
  const v = trustDb().query("SELECT response, responded_at FROM trust_validations WHERE bot_id = ? AND response IS NOT NULL ORDER BY responded_at DESC LIMIT 1").get(botId) as { response: number; responded_at: number } | null;
  return { agentId: a?.agent_id ?? null, registerTx: a?.register_tx ?? null, committed: a?.count ?? 0, pending: pend, lastCommitTx: a?.last_commit_tx ?? null, lastCommitAt: a?.last_commit_at ?? null,
    validation: v ? { response: v.response, at: v.responded_at } : null };
}
