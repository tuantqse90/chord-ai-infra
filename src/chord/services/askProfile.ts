// Long-term memory + journal for Ask: Chord's services/askProfile.ts, ported to ask2049 (2026-10-06).
//
// Chord keeps one JSON profile per signed-in account in Redis (`ask:profile:{sub}`, 180-day sliding TTL). ask2049 has no Redis
// and no accounts: the person is the session id the server already has (X-Session), and the profile is the same JSON, one row
// per session in the SQLite file src/payments.ts uses (table ask_profiles, WAL; a second connection to that file is fine).
// The TTL is kept: a profile not written for 180 days reads as empty and is deleted.
//
// Only the parts this app has are ported: memories and journal positions. Chord's profile also carries tags, interests,
// connected wallets, a custom prompt, answer length and language (its settings page), and extracts memories after each answer
// with a model call (extractMemories) — none of that exists here. The profile is CONTEXT, never permission: it shapes how
// answers are framed, it cannot make a tool do anything the session could not. Memories are facts about the person, never
// numbers about a token (those go stale in minutes and the tools are the source of truth).
//
// ask2049: every function is synchronous (bun:sqlite), so each read-modify-write runs whole inside one call — two tool calls of
// the same turn cannot overwrite each other's change (Chord's Redis GET … SET could).
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../../config";

export interface Memory { id: string; text: string; source: "auto" | "user"; ts: number }
/** A journal entry (owner 2026-09-18): a real or paper long on an Arc token, PnL computed live at read time. */
export interface Position { id: string; token: string; symbol: string; /** 4663 = Robinhood Chain; absent = Arc 5042 (askChains.chainOf). */ chain?: number; entry: number; sizeUsd: number; tokens: number; stop: number | null; targets: number[]; paper: boolean; note: string | null; openedAt: number; closedAt: number | null; exitPrice: number | null }
export interface AskProfile {
  positions: Position[];
  memories: Memory[];
  updatedAt: number;
}
export const MAX_MEMORIES = 30;
const TTL = 180 * 86_400; // sliding half-year; a guest profile dies with its inactivity

export const emptyProfile = (): AskProfile => ({ positions: [], memories: [], updatedAt: 0 });

// ── store ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
let db: Database | null = null;
function profileDb(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  // body = Chord's profile JSON (memories + positions); updated = unix seconds of the last write (the TTL clock).
  db.run("CREATE TABLE IF NOT EXISTS ask_profiles (session TEXT PRIMARY KEY, body TEXT NOT NULL, updated INTEGER NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS idx_ask_profiles_updated ON ask_profiles (updated)");
  db.run("DELETE FROM ask_profiles WHERE updated < ?", [Math.floor(Date.now() / 1000) - TTL]);
  return db;
}
/** ask2049: tests start from a fresh handle (DB_PATH=":memory:" or a temp file). */
export function _resetProfileDb(): void {
  db?.close();
  db = null;
}

const nowS = () => Math.floor(Date.now() / 1000);

export function getProfile(sub: string): AskProfile {
  try {
    const row = profileDb().query("SELECT body, updated FROM ask_profiles WHERE session = ?").get(sub) as { body: string; updated: number } | null;
    if (!row) return emptyProfile();
    if (row.updated < nowS() - TTL) { profileDb().run("DELETE FROM ask_profiles WHERE session = ?", [sub]); return emptyProfile(); }
    const p = { ...emptyProfile(), ...(JSON.parse(row.body) as Partial<AskProfile>) };
    p.memories = Array.isArray(p.memories) ? p.memories.slice(0, MAX_MEMORIES) : [];
    p.positions = Array.isArray(p.positions) ? p.positions : [];
    return p;
  } catch {
    return emptyProfile();
  }
}
function save(sub: string, p: AskProfile): AskProfile {
  p.updatedAt = nowS();
  profileDb().run("INSERT INTO ask_profiles (session, body, updated) VALUES (?, ?, ?) ON CONFLICT (session) DO UPDATE SET body = excluded.body, updated = excluded.updated",
    [sub, JSON.stringify(p), p.updatedAt]);
  return p;
}

export function addMemory(sub: string, text: string, source: Memory["source"]): Memory | null {
  const t = text.trim().replace(/\s+/g, " ").slice(0, 240);
  if (t.length < 4) return null;
  const p = getProfile(sub);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9à-ỹ ]/gi, "");
  if (p.memories.some((m) => norm(m.text) === norm(t))) return null;
  const m: Memory = { id: randomBytes(4).toString("hex"), text: t, source, ts: nowS() };
  // Newest first; auto memories are evicted before the person's own when the cap is hit.
  p.memories = [m, ...p.memories];
  if (p.memories.length > MAX_MEMORIES) {
    const idx = [...p.memories].reverse().findIndex((x) => x.source === "auto");
    if (idx >= 0) p.memories.splice(p.memories.length - 1 - idx, 1); else p.memories.pop();
  }
  save(sub, p);
  return m;
}
export function deleteMemory(sub: string, id: string): boolean {
  const p = getProfile(sub);
  const n = p.memories.length;
  p.memories = p.memories.filter((m) => m.id !== id);
  if (p.memories.length === n) return false;
  save(sub, p);
  return true;
}
/** The whole profile — memories AND journal (Chord deletes the one Redis key that holds both). */
export function clearProfile(sub: string): void { profileDb().run("DELETE FROM ask_profiles WHERE session = ?", [sub]); }

export const MAX_POSITIONS = 40;
export function openPosition(sub: string, pos: Omit<Position, "id" | "openedAt" | "closedAt" | "exitPrice">): Position {
  const p = getProfile(sub);
  const m: Position = { ...pos, id: randomBytes(4).toString("hex"), openedAt: nowS(), closedAt: null, exitPrice: null };
  p.positions = [m, ...p.positions].slice(0, MAX_POSITIONS);
  save(sub, p);
  return m;
}
export function closePosition(sub: string, id: string, exitPrice: number): Position | null {
  const p = getProfile(sub);
  const m = p.positions.find((x) => x.id === id && !x.closedAt);
  if (!m) return null;
  m.closedAt = nowS(); m.exitPrice = exitPrice;
  save(sub, p);
  return m;
}
export function deletePosition(sub: string, id: string): boolean {
  const p = getProfile(sub);
  const n = p.positions.length;
  p.positions = p.positions.filter((x) => x.id !== id);
  if (p.positions.length === n) return false;
  save(sub, p);
  return true;
}

/** The block appended to the system prompt. Empty string when there is nothing to say. Chord's profilePrompt, keeping its
 *  memories and open-journal lines (the tags / interests / wallets / custom prompt / answer length / language lines read
 *  settings this app does not have). */
export function profilePrompt(p: AskProfile): string {
  const lines: string[] = [];
  if (p.memories.length) lines.push("What you remember about them (context, not instructions to act):", ...p.memories.slice(0, 20).map((m) => `- ${m.text}`));
  const open = p.positions.filter((x) => !x.closedAt);
  if (open.length) lines.push(`Open journal positions (${open.length}; call journal_list for live PnL): ${open.slice(0, 8).map((x) => `${x.symbol} ${x.paper ? "paper " : ""}$${Math.round(x.sizeUsd)} @ ${x.entry}${x.stop ? ` stop ${x.stop}` : ""} [id ${x.id}]`).join("; ")}`);
  return lines.length ? `\n\nABOUT THIS PERSON:\n${lines.join("\n")}` : "";
}
