// The backtest board: every classic strategy × every Perpl market × 1h and 4h, replayed over the last 1, 3 and 6 months on
// Binance, OKX, Hyperliquid and Perpl data ($1,000 at 1x on Perpl, the strategy's default parameters). Per window the board
// keeps each source's return and the median of the sources that cover at least 90 % of it (a market listed last month has
// no 6-month replay on Perpl, and says so). Built in the background, kept in SQLite so a restart serves the last board, and
// rebuilt every 12 hours. Markets are read one after another with a pause: the data APIs are public and rate limited.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";
import { backtest, type BacktestResult } from "./backtest";
import { SOURCES, type Source } from "./data";
import { CLASSIC } from "./strategies";
import * as perpl from "../perpl/client";

export const BOARD_WINDOWS = [30, 90, 180] as const;
export type BoardWindow = (typeof BOARD_WINDOWS)[number];
const TFS = ["1h", "4h"] as const;
export interface BoardCell { median: number | null; bySource: Partial<Record<Source, { returnPct: number; coveredDays: number; maxDrawdownPct: number; trades: number }>>; agree: boolean | null; maxDrawdownPct: number | null; trades: number | null }
export interface BoardRow { symbol: string; strategy: string; tf: "1h" | "4h"; windows: Partial<Record<BoardWindow, BoardCell>>; holdPct: Partial<Record<BoardWindow, number | null>>; position: number | null }
export interface Board { at: number; ms: number; rows: BoardRow[]; markets: string[]; errors: number }

let db: Database | null = null;
function store(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS classic_board (id INTEGER PRIMARY KEY CHECK (id = 1), board TEXT NOT NULL, at INTEGER NOT NULL)");
  return db;
}
let board: Board | null = null, building: Promise<Board | null> | null = null, timer: ReturnType<typeof setInterval> | null = null;
export const _boardTest = { reset() { board = null; building = null; if (timer) clearInterval(timer); timer = null; db?.close(); db = null; } };

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 100) / 100; };
/** One window's cell from each source's replay: the median of the sources that cover ≥ 90 % of the window. */
export function cellOf(results: Partial<Record<Source, BacktestResult>>, days: number): BoardCell {
  const bySource: BoardCell["bySource"] = {};
  const full: BacktestResult[] = [];
  for (const [k, r] of Object.entries(results) as [Source, BacktestResult][]) {
    if (!r) continue;
    bySource[k] = { returnPct: r.returnPct, coveredDays: r.coveredDays, maxDrawdownPct: r.maxDrawdownPct, trades: r.tradeCount };
    if (r.coveredDays >= days * 0.9) full.push(r);
  }
  const rets = full.map((r) => r.returnPct);
  const up = rets.some((x) => x >= 1), down = rets.some((x) => x <= -1);
  return { median: median(rets), bySource, agree: rets.length >= 2 ? !(up && down) : null, maxDrawdownPct: median(full.map((r) => r.maxDrawdownPct)), trades: full.length ? Math.round(median(full.map((r) => r.tradeCount)) ?? 0) : null };
}

async function build(sources: readonly Source[] = SOURCES): Promise<Board> {
  const t0 = Date.now();
  let markets: string[] = [];
  try { markets = (await perpl.markets()).map((m) => m.symbol); } catch { markets = ["BTC", "ETH", "SOL", "MON", "HYPE"]; }
  const rows: BoardRow[] = [];
  let errors = 0;
  for (const symbol of markets) {
    for (const tf of TFS) {
      for (const s of CLASSIC) {
        const row: BoardRow = { symbol, strategy: s.id, tf, windows: {}, holdPct: {}, position: null };
        // the longest window first: the shorter ones read the same cached candles
        for (const days of [...BOARD_WINDOWS].reverse()) {
          const results: Partial<Record<Source, BacktestResult>> = {};
          for (const source of sources) {
            try { results[source] = await backtest({ strategy: s.id, symbol, tf, days, source, venue: "perpl", sizeUsd: 1000, leverage: 1 }); }
            catch { errors++; }
          }
          row.windows[days] = cellOf(results, days);
          const any = results.binance ?? Object.values(results)[0];
          row.holdPct[days] = any ? any.buyHoldPct : null;
          if (days === 30 && any) row.position = any.position;
        }
        rows.push(row);
      }
    }
    await new Promise((r) => setTimeout(r, 1_500)); // between markets: Perpl ~100 requests / min, Hyperliquid weighs candle reads
  }
  return { at: Date.now(), ms: Date.now() - t0, rows, markets, errors };
}

export function refreshBoard(): Promise<Board | null> {
  building ??= build().then((b) => {
    board = b;
    try { store().run("INSERT INTO classic_board (id, board, at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET board = excluded.board, at = excluded.at", [JSON.stringify(b), b.at]); } catch { /* the board still serves from memory */ }
    return b;
  }).catch(() => null).finally(() => { building = null; });
  return building;
}
/** The last board (memory, else SQLite); null before the first build finishes. */
export function currentBoard(): Board | null {
  if (board) return board;
  try { const r = store().query("SELECT board FROM classic_board WHERE id = 1").get() as { board: string } | null; if (r) board = JSON.parse(r.board); } catch { /* none yet */ }
  return board;
}
export const boardBuilding = () => building != null;
/** On boot: serve the stored board, rebuild when it is older than 12 h, then every 12 h. */
export function startBoard(): void {
  if (timer || process.env.NODE_ENV === "test") return;
  const b = currentBoard();
  if (!b || Date.now() - b.at > 12 * 3_600_000) setTimeout(() => void refreshBoard(), 60_000); // after the boot's own reads
  timer = setInterval(() => void refreshBoard(), 12 * 3_600_000);
  (timer as any).unref?.();
}
