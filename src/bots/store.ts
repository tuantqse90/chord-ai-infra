// SQLite for bots: their params and state, fills (filled and skipped, one per bot per source trade), events and open
// positions. Its own connection on config.dbPath() (WAL), like src/devkeys.ts. Stats are recomputed from fills + positions
// after every change and kept on the bot row, so lists and the leaderboard read one column.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";
import type { Bot, BotEvent, BotMode, BotStats, BotStatus, BotType, Fill, Position } from "./types";

export const EVENTS_KEPT = 500;
export const SKIPPED_KEPT = 2000;

let db: Database | null = null;
export function store(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run(`CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, mode TEXT NOT NULL,
    status TEXT NOT NULL, params TEXT NOT NULL, stats TEXT NOT NULL, error TEXT, skipped_pruned INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS bots_owner ON bots (owner)");
  db.run("CREATE INDEX IF NOT EXISTS bots_status ON bots (status)");
  db.run(`CREATE TABLE IF NOT EXISTS bot_fills (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, ts INTEGER NOT NULL, side TEXT NOT NULL, mint TEXT NOT NULL,
    symbol TEXT, usd REAL NOT NULL, token_amount REAL NOT NULL, price_usd REAL, status TEXT NOT NULL, reason TEXT, pnl_usd REAL,
    source TEXT NOT NULL, quote TEXT, mode TEXT NOT NULL, src_key TEXT NOT NULL, UNIQUE (bot_id, src_key))`);
  db.run("CREATE INDEX IF NOT EXISTS bot_fills_bot ON bot_fills (bot_id, ts)");
  db.run("CREATE TABLE IF NOT EXISTS bot_events (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, ts INTEGER NOT NULL, level TEXT NOT NULL, msg TEXT NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS bot_events_bot ON bot_events (bot_id, id)");
  db.run(`CREATE TABLE IF NOT EXISTS bot_positions (bot_id TEXT NOT NULL, mint TEXT NOT NULL, symbol TEXT, qty REAL NOT NULL, cost_usd REAL NOT NULL,
    price_usd REAL, opened_at INTEGER NOT NULL, marked_at INTEGER, PRIMARY KEY (bot_id, mint))`);
  return db;
}
/** Tests: close the connection so the next call opens DB_PATH again. */
export function _closeStore(): void { db?.close(); db = null; }

export const EMPTY_STATS: BotStats = { trades: 0, buys: 0, sells: 0, skipped: 0, investedUsd: 0, realizedUsd: 0, unrealizedUsd: 0, openPositions: 0, winRate: null, lastEventAt: null };
const cents = (n: number) => Math.round(n * 100) / 100;

type BotRow = { id: string; owner: string; name: string; type: string; mode: string; status: string; params: string; stats: string; error: string | null; created: number; updated: number };
const toBot = (r: BotRow): Bot => ({
  id: r.id, name: r.name, type: r.type as BotType, mode: r.mode as BotMode, status: r.status as BotStatus, params: JSON.parse(r.params),
  createdAt: r.created, updatedAt: r.updated, stats: JSON.parse(r.stats), error: r.error,
});

export function insertBot(b: { id: string; owner: string; name: string; type: BotType; mode: BotMode; status: BotStatus; params: unknown; ts: number }): void {
  store().run("INSERT INTO bots (id, owner, name, type, mode, status, params, stats, error, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    [b.id, b.owner, b.name, b.type, b.mode, b.status, JSON.stringify(b.params), JSON.stringify(EMPTY_STATS), b.ts, b.ts]);
}
export function botRow(id: string): (Bot & { owner: string }) | null {
  const r = store().query("SELECT * FROM bots WHERE id = ?").get(id) as BotRow | null;
  return r ? { ...toBot(r), owner: r.owner } : null;
}
export function botsOf(owner: string): Bot[] {
  return (store().query("SELECT * FROM bots WHERE owner = ? ORDER BY created DESC").all(owner) as BotRow[]).map(toBot);
}
export function allBots(where: "all" | "running" = "all"): (Bot & { owner: string })[] {
  const q = where === "running" ? "SELECT * FROM bots WHERE status = 'running'" : "SELECT * FROM bots";
  return (store().query(q).all() as BotRow[]).map((r) => ({ ...toBot(r), owner: r.owner }));
}
export const countOf = (owner: string): number => (store().query("SELECT COUNT(*) AS n FROM bots WHERE owner = ?").get(owner) as { n: number }).n;
export const countRunning = (): number => (store().query("SELECT COUNT(*) AS n FROM bots WHERE status = 'running'").get() as { n: number }).n;

export function setBotStatus(id: string, status: BotStatus, error: string | null, ts: number): void {
  store().run("UPDATE bots SET status = ?, error = ?, updated = ? WHERE id = ?", [status, error, ts, id]);
}
export function removeBot(id: string): void {
  const s = store();
  s.transaction(() => {
    s.run("DELETE FROM bots WHERE id = ?", [id]);
    s.run("DELETE FROM bot_fills WHERE bot_id = ?", [id]);
    s.run("DELETE FROM bot_events WHERE bot_id = ?", [id]);
    s.run("DELETE FROM bot_positions WHERE bot_id = ?", [id]);
  })();
}

// ── fills ────────────────────────────────────────────────────────────────────────────────────────────────────────────
type FillRow = { id: string; bot_id: string; ts: number; side: string; mint: string; symbol: string | null; usd: number; token_amount: number; price_usd: number | null; status: string; reason: string | null; pnl_usd: number | null; source: string; quote: string | null; mode: string };
const toFill = (r: FillRow): Fill => {
  const source = JSON.parse(r.source) as Fill["source"];
  return {
    id: r.id, botId: r.bot_id, ts: r.ts, side: r.side as Fill["side"], mint: r.mint, symbol: r.symbol, usd: r.usd, tokenAmount: r.token_amount,
    priceUsd: r.price_usd, status: r.status as Fill["status"], reason: r.reason, pnlUsd: r.pnl_usd, source,
    quote: r.quote ? JSON.parse(r.quote) : null, mode: r.mode as BotMode,
  };
};
/** The source trade a fill answers, the key that keeps one fill per bot per trade. */
export const sourceKey = (t: { wallet: string; tx: string; mint: string; side: string }) => `${t.wallet}|${t.tx}|${t.mint}|${t.side}`;

/** False when this bot already has a fill for that source trade. */
export function insertFill(f: Fill): boolean {
  const s = store();
  const ok = s.run(`INSERT OR IGNORE INTO bot_fills (id, bot_id, ts, side, mint, symbol, usd, token_amount, price_usd, status, reason, pnl_usd, source, quote, mode, src_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [f.id, f.botId, f.ts, f.side, f.mint, f.symbol, f.usd, f.tokenAmount, f.priceUsd, f.status, f.reason, f.pnlUsd, JSON.stringify(f.source),
    f.quote ? JSON.stringify(f.quote) : null, f.mode, sourceKey(f.source)]).changes > 0;
  if (ok && f.status === "skipped") {
    const cut = s.query("SELECT ts FROM bot_fills WHERE bot_id = ? AND status = 'skipped' ORDER BY ts DESC LIMIT 1 OFFSET ?").get(f.botId, SKIPPED_KEPT) as { ts: number } | null;
    if (cut) {
      const n = s.run("DELETE FROM bot_fills WHERE bot_id = ? AND status = 'skipped' AND ts <= ?", [f.botId, cut.ts]).changes;
      if (n) s.run("UPDATE bots SET skipped_pruned = skipped_pruned + ? WHERE id = ?", [n, f.botId]);
    }
  }
  return ok;
}
/** Every FILLED fill of a bot since `ts`, oldest first (the public board's PnL, equity line and reaction times: the last 200 rows of
 *  fillsOf are mostly skips on a busy agent, so they cannot carry its PnL). */
export function filledSince(botId: string, ts: number): Fill[] {
  return (store().query("SELECT * FROM bot_fills WHERE bot_id = ? AND status = 'filled' AND ts >= ? ORDER BY ts ASC, rowid ASC").all(botId, ts) as FillRow[]).map(toFill);
}
/** Filled and skipped fills of a bot since `ts` (skips older than the newest SKIPPED_KEPT are pruned, so old skip counts are a floor). */
export function fillCountsSince(botId: string, ts: number): { filled: number; skipped: number } {
  const r = store().query("SELECT SUM(status = 'filled') AS f, SUM(status = 'skipped') AS s FROM bot_fills WHERE bot_id = ? AND ts >= ?").get(botId, ts) as { f: number | null; s: number | null };
  return { filled: r?.f ?? 0, skipped: r?.s ?? 0 };
}
export function hasFill(botId: string, key: string): boolean {
  return !!store().query("SELECT 1 FROM bot_fills WHERE bot_id = ? AND src_key = ?").get(botId, key);
}
export function fillsOf(botId: string, limit = 200): Fill[] {
  return (store().query("SELECT * FROM bot_fills WHERE bot_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?").all(botId, limit) as FillRow[]).map(toFill);
}
export function realizedSince(botId: string, ts: number): number {
  return (store().query("SELECT COALESCE(SUM(pnl_usd), 0) AS v FROM bot_fills WHERE bot_id = ? AND status = 'filled' AND side = 'sell' AND ts >= ?").get(botId, ts) as { v: number }).v;
}

// ── events ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export function insertEvent(botId: string, e: BotEvent): void {
  const s = store();
  s.run("INSERT INTO bot_events (bot_id, ts, level, msg) VALUES (?, ?, ?, ?)", [botId, e.ts, e.level, e.msg.slice(0, 500)]);
  const cut = s.query("SELECT id FROM bot_events WHERE bot_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?").get(botId, EVENTS_KEPT) as { id: number } | null;
  if (cut) s.run("DELETE FROM bot_events WHERE bot_id = ? AND id <= ?", [botId, cut.id]);
}
export function eventsOf(botId: string, limit = 100): BotEvent[] {
  return store().query("SELECT ts, level, msg FROM bot_events WHERE bot_id = ? ORDER BY id DESC LIMIT ?").all(botId, limit) as BotEvent[];
}

// ── positions ────────────────────────────────────────────────────────────────────────────────────────────────────────
type PosRow = { bot_id: string; mint: string; symbol: string | null; qty: number; cost_usd: number; price_usd: number | null; opened_at: number };
const toPosition = (r: PosRow): Position => {
  const value = r.price_usd != null ? r.qty * r.price_usd : null;
  return { mint: r.mint, symbol: r.symbol, qty: r.qty, costUsd: r.cost_usd, priceUsd: r.price_usd, valueUsd: value, pnlUsd: value != null ? value - r.cost_usd : null, openedAt: r.opened_at };
};
export function positionsOf(botId: string): Position[] {
  return (store().query("SELECT * FROM bot_positions WHERE bot_id = ? ORDER BY opened_at").all(botId) as PosRow[]).map(toPosition);
}
export function positionOf(botId: string, mint: string): Position | null {
  const r = store().query("SELECT * FROM bot_positions WHERE bot_id = ? AND mint = ?").get(botId, mint) as PosRow | null;
  return r ? toPosition(r) : null;
}
/** Add a buy to the position (opening it when new). The fill's own price becomes the mark until the next tick. */
export function addToPosition(botId: string, p: { mint: string; symbol: string | null; qty: number; costUsd: number; priceUsd: number | null; ts: number }): void {
  store().run(`INSERT INTO bot_positions (bot_id, mint, symbol, qty, cost_usd, price_usd, opened_at, marked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bot_id, mint) DO UPDATE SET qty = qty + excluded.qty, cost_usd = cost_usd + excluded.cost_usd,
      symbol = COALESCE(bot_positions.symbol, excluded.symbol), price_usd = excluded.price_usd, marked_at = excluded.marked_at`,
  [botId, p.mint, p.symbol, p.qty, p.costUsd, p.priceUsd, p.ts, p.ts]);
}
export function closePosition(botId: string, mint: string): void {
  store().run("DELETE FROM bot_positions WHERE bot_id = ? AND mint = ?", [botId, mint]);
}
/** Every open token position across bots, for the marking tick. */
export function openPositions(): { botId: string; mint: string }[] {
  return (store().query("SELECT p.bot_id, p.mint FROM bot_positions p JOIN bots b ON b.id = p.bot_id").all() as { bot_id: string; mint: string }[]).map((r) => ({ botId: r.bot_id, mint: r.mint }));
}
/** Write (or replace) a position as a whole (a partial strategy sell). */
export function setPosition(botId: string, p: { mint: string; symbol: string | null; qty: number; costUsd: number; priceUsd: number | null; openedAt: number; ts: number }): void {
  store().run(`INSERT INTO bot_positions (bot_id, mint, symbol, qty, cost_usd, price_usd, opened_at, marked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bot_id, mint) DO UPDATE SET symbol = excluded.symbol, qty = excluded.qty, cost_usd = excluded.cost_usd, price_usd = excluded.price_usd,
      opened_at = excluded.opened_at, marked_at = excluded.marked_at`,
  [botId, p.mint, p.symbol, p.qty, p.costUsd, p.priceUsd, p.openedAt, p.ts]);
}
export function setBotName(id: string, name: string): void {
  store().run("UPDATE bots SET name = ? WHERE id = ?", [name, id]);
}

export function markMint(mint: string, priceUsd: number, ts: number): void {
  store().run("UPDATE bot_positions SET price_usd = ?, marked_at = ? WHERE mint = ?", [priceUsd, ts, mint]);
}

// ── stats ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function computeStats(botId: string): BotStats {
  const s = store();
  const f = s.query(`SELECT COALESCE(SUM(status = 'filled'), 0) AS trades, COALESCE(SUM(status = 'filled' AND side = 'buy'), 0) AS buys,
      COALESCE(SUM(status = 'filled' AND side = 'sell'), 0) AS sells, COALESCE(SUM(status = 'skipped'), 0) AS skipped,
      COALESCE(SUM(CASE WHEN status = 'filled' AND side = 'buy' THEN usd END), 0) AS invested,
      COALESCE(SUM(CASE WHEN status = 'filled' AND side = 'sell' THEN pnl_usd END), 0) AS realized,
      COALESCE(SUM(status = 'filled' AND side = 'sell' AND pnl_usd > 0), 0) AS wins, MAX(ts) AS last
    FROM bot_fills WHERE bot_id = ?`).get(botId) as { trades: number; buys: number; sells: number; skipped: number; invested: number; realized: number; wins: number; last: number | null };
  const pruned = (s.query("SELECT skipped_pruned AS n FROM bots WHERE id = ?").get(botId) as { n: number } | null)?.n ?? 0;
  const lastEvent = (s.query("SELECT MAX(ts) AS t FROM bot_events WHERE bot_id = ?").get(botId) as { t: number | null }).t;
  const pos = positionsOf(botId);
  const unrealized = pos.reduce((a, p) => a + (p.pnlUsd ?? 0), 0);
  const last = Math.max(f.last ?? 0, lastEvent ?? 0);
  return {
    trades: f.trades, buys: f.buys, sells: f.sells, skipped: f.skipped + pruned, investedUsd: cents(f.invested), realizedUsd: cents(f.realized),
    unrealizedUsd: cents(unrealized), openPositions: pos.length, winRate: f.sells ? f.wins / f.sells : null, lastEventAt: last || null,
  };
}
/** Recompute and keep the bot's stats; the fresh bot, or null when it is gone. */
export function refreshStats(botId: string): Bot | null {
  if (!botRow(botId)) return null;
  store().run("UPDATE bots SET stats = ? WHERE id = ?", [JSON.stringify(computeStats(botId)), botId]);
  const b = botRow(botId);
  if (!b) return null;
  const { owner: _o, ...bot } = b;
  return bot;
}
