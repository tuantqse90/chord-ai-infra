// API keys for developers: created from the developer console by a signed-in Chord account, shown once, stored as a
// SHA-256 hash. A key on /v1/ask (Authorization: Bearer ak_live_… or X-API-Key) is its own session and counts usage per
// UTC day; 60 requests a minute per key; at most 5 live keys per account.
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

export const MAX_KEYS = 5;
export const KEY_RPM = 60;
let db: Database | null = null;
function store(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, masked TEXT NOT NULL, created INTEGER NOT NULL, revoked INTEGER)");
  db.run("CREATE INDEX IF NOT EXISTS api_keys_owner ON api_keys (owner)");
  db.run("CREATE TABLE IF NOT EXISTS key_usage (key_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key_id, day))");
  return db;
}
export const _resetKeys = () => { db?.close(); db = null; };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);

export type KeyRow = { id: string; label: string; masked: string; created: number; usage30d: number; today: number };

export function listKeys(owner: string): KeyRow[] {
  const s = store();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  return (s.query("SELECT id, label, masked, created FROM api_keys WHERE owner = ? AND revoked IS NULL ORDER BY created DESC").all(owner) as any[]).map((k) => ({
    ...k,
    usage30d: (s.query("SELECT COALESCE(SUM(n), 0) AS n FROM key_usage WHERE key_id = ? AND day >= ?").get(k.id, since) as any).n,
    today: (s.query("SELECT COALESCE(SUM(n), 0) AS n FROM key_usage WHERE key_id = ? AND day = ?").get(k.id, today()) as any).n,
  }));
}

export function createKey(owner: string, label: string): { id: string; key: string; masked: string; label: string } | null {
  if (listKeys(owner).length >= MAX_KEYS) return null;
  const key = `ak_live_${randomBytes(24).toString("hex")}`;
  const id = randomBytes(6).toString("hex");
  const masked = `${key.slice(0, 12)}…${key.slice(-4)}`;
  const clean = label.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) || "Default";
  store().run("INSERT INTO api_keys (id, owner, label, hash, masked, created) VALUES (?, ?, ?, ?, ?, ?)", [id, owner, clean, sha(key), masked, Date.now()]);
  return { id, key, masked, label: clean };
}

export function revokeKey(owner: string, id: string): boolean {
  return store().run("UPDATE api_keys SET revoked = ? WHERE id = ? AND owner = ? AND revoked IS NULL", [Date.now(), id, owner]).changes > 0;
}

/** The key behind a bearer string, or null. */
export function resolveKey(plain: string): { id: string; owner: string } | null {
  if (!/^ak_live_[0-9a-f]{48}$/.test(plain)) return null;
  return (store().query("SELECT id, owner FROM api_keys WHERE hash = ? AND revoked IS NULL").get(sha(plain)) as any) ?? null;
}

const minute = new Map<string, { m: number; n: number }>();
/** Count one call; false when the key is over its per-minute budget. */
export function useKey(id: string): boolean {
  const m = Math.floor(Date.now() / 60_000);
  const w = minute.get(id);
  if (w && w.m === m && w.n >= KEY_RPM) return false;
  minute.set(id, w && w.m === m ? { m, n: w.n + 1 } : { m, n: 1 });
  store().run("INSERT INTO key_usage (key_id, day, n) VALUES (?, ?, 1) ON CONFLICT (key_id, day) DO UPDATE SET n = n + 1", [id, today()]);
  return true;
}

/** Daily calls over the last `days` days for every key of an account (oldest first, zero days included). */
export function usageSeries(owner: string, days = 30): { day: string; n: number }[] {
  const s = store();
  const rows = s.query("SELECT u.day AS day, SUM(u.n) AS n FROM key_usage u JOIN api_keys k ON k.id = u.key_id WHERE k.owner = ? AND u.day >= ? GROUP BY u.day").all(owner, new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)) as any[];
  const by = new Map(rows.map((r) => [r.day, Number(r.n)]));
  return Array.from({ length: days }, (_, i) => { const d = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10); return { day: d, n: by.get(d) ?? 0 }; });
}
