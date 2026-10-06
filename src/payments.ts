// Pay per ask. A payment is a transaction the payer already sent; this file only READS it (through NOWNodes) and checks:
// it landed, it paid the treasury, in the right asset, at least the price. A reference (signature / tx hash) redeems once.
// Nothing here signs, holds keys, or moves funds.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import type { ParsedTx } from "./solana/parse";

export type Verdict = { ok: true; paid: number; asset: string } | { ok: false; reason: string };

/** Solana: the treasury's balance of `mint` must rise by ≥ minUnits in a successful, finalized transaction. */
export function verifySolanaPayment(tx: ParsedTx | null, want: { recipient: string; mint: string; minUnits: number; symbol?: string }): Verdict {
  if (!tx) return { ok: false, reason: "transaction not found or not finalized yet" };
  if (!tx.ok) return { ok: false, reason: `transaction failed on chain (${tx.error})` };
  const got = tx.tokenChanges.filter((t) => t.owner === want.recipient && t.mint === want.mint).reduce((s, t) => s + t.amount, 0);
  if (got <= 0) return { ok: false, reason: "this transaction did not pay the treasury in the payment token" };
  if (got + 1e-9 < want.minUnits) return { ok: false, reason: `paid ${got}, the price is ${want.minUnits}` };
  return { ok: true, paid: got, asset: want.symbol ?? want.mint };
}

type BfAmount = { unit: string; quantity: string };
/** Cardano: outputs to the treasury must carry ≥ minAda in lovelace, in a transaction that is in a block and valid. */
export function verifyCardanoPayment(tx: { block?: string | null; valid_contract?: boolean } | null, utxos: { outputs: { address: string; amount: BfAmount[] }[] } | null,
  want: { recipient: string; minAda: number }): Verdict {
  if (!tx || !utxos) return { ok: false, reason: "transaction not found on Cardano mainnet" };
  if (!tx.block) return { ok: false, reason: "transaction is not in a block yet" };
  if (tx.valid_contract === false) return { ok: false, reason: "transaction failed script validation" };
  const lovelace = utxos.outputs.filter((o) => o.address === want.recipient)
    .flatMap((o) => o.amount).filter((a) => a.unit === "lovelace").reduce((s, a) => s + BigInt(a.quantity), 0n);
  const ada = Number(lovelace) / 1e6;
  if (ada <= 0) return { ok: false, reason: "no output of this transaction goes to the treasury" };
  if (ada + 1e-9 < want.minAda) return { ok: false, reason: `paid ${ada} ADA, the price is ${want.minAda} ADA` };
  return { ok: true, paid: ada, asset: "ADA" };
}

// ── store: sessions, free asks, credits, redeemed references ──────────────────────────────────────────────────────────
let db: Database | null = null;
function store(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, free_used INTEGER NOT NULL DEFAULT 0, credits INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS payments (ref TEXT PRIMARY KEY, chain TEXT NOT NULL, session TEXT, paid REAL NOT NULL, asset TEXT NOT NULL, credits INTEGER NOT NULL, at INTEGER NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS feedback (session TEXT NOT NULL, question TEXT NOT NULL, rating TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session, question))");
  return db;
}

/** A thumbs up / down on an answer: one row per session and question, the last click wins. */
export function saveFeedback(sessionId: string, question: string, rating: "up" | "down"): void {
  store().run("INSERT OR REPLACE INTO feedback (session, question, rating, at) VALUES (?, ?, ?, ?)", [sessionId, question.slice(0, 500), rating, Date.now()]);
}
/** Tests use a fresh in-memory store. */
export function resetStore(): void {
  db?.close();
  db = null;
}

export function session(id: string) {
  const s = store();
  s.run("INSERT OR IGNORE INTO sessions (id, created) VALUES (?, ?)", [id, Date.now()]);
  const row = s.query("SELECT free_used, credits FROM sessions WHERE id = ?").get(id) as { free_used: number; credits: number };
  const free = Math.max(0, config.freeAsks() - row.free_used);
  return { id, freeLeft: free, credits: row.credits };
}

/** Spend one ask: a free one first, then a credit. false = nothing left (the caller answers 402). */
export function spendAsk(id: string): { ok: boolean; source?: "free" | "credit" } {
  const s = store();
  session(id);
  const free = s.run("UPDATE sessions SET free_used = free_used + 1 WHERE id = ? AND free_used < ?", [id, config.freeAsks()]);
  if (free.changes) return { ok: true, source: "free" };
  const paid = s.run("UPDATE sessions SET credits = credits - 1 WHERE id = ? AND credits > 0", [id]);
  return paid.changes ? { ok: true, source: "credit" } : { ok: false };
}

/** Give an ask back when the answer failed before it was delivered. */
export function refundAsk(id: string, source: "free" | "credit"): void {
  store().run(source === "free" ? "UPDATE sessions SET free_used = MAX(0, free_used - 1) WHERE id = ?" : "UPDATE sessions SET credits = credits + 1 WHERE id = ?", [id]);
}

/** Record a verified payment once. Returns false when the reference was already redeemed (replay). */
export function redeem(ref: string, chain: "solana" | "cardano", sessionId: string | null, paid: number, asset: string, credits: number): boolean {
  const s = store();
  const tx = s.transaction(() => {
    const ins = s.run("INSERT OR IGNORE INTO payments (ref, chain, session, paid, asset, credits, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [ref, chain, sessionId, paid, asset, credits, Date.now()]);
    if (!ins.changes) return false;
    if (sessionId) {
      session(sessionId);
      s.run("UPDATE sessions SET credits = credits + ? WHERE id = ?", [credits, sessionId]);
    }
    return true;
  });
  return tx();
}

export function paymentStats() {
  const r = store().query("SELECT chain, COUNT(*) AS n, SUM(paid) AS paid, asset FROM payments GROUP BY chain, asset").all();
  return r as { chain: string; n: number; paid: number; asset: string }[];
}

/** How many asks a verified amount buys. */
export const creditsFor = (paid: number, price: number) => Math.max(1, Math.floor(paid / price + 1e-9));
