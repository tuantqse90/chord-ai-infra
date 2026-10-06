// Direct, read-only access to the existing Chord databases:
//   INDEX_DATABASE_URL  — the main index (dex_trades, chain_trades, *_token_hourly, *_chain_daily): Monad, Robinhood Chain, Arc,
//                         Avalanche, Base, BNB Chain.
//   SOLANA_DATABASE_URL — the Solana box index (sol_swaps, sol_pools, sol_tokens, sol_token_hourly, sol_wallet_token_daily).
// Use a READ-ONLY role for both. On top of that every query runs inside a READ ONLY transaction with a statement timeout,
// so even a mis-granted role cannot write and a slow query cannot hold a connection.
import { SQL } from "bun";

const TIMEOUT_MS = 15_000;
const clients = new Map<string, SQL>();

export type DbName = "index" | "solana";
const urlOf = (db: DbName) => (process.env[db === "index" ? "INDEX_DATABASE_URL" : "SOLANA_DATABASE_URL"] ?? "").trim();
export const dbEnabled = (db: DbName) => !!urlOf(db);

function client(db: DbName): SQL {
  const url = urlOf(db);
  if (!url) throw new Error(`${db} database not configured`);
  let c = clients.get(url);
  if (!c) {
    c = new SQL({ url, max: 4, idleTimeout: 30, connectionTimeout: 10 });
    clients.set(url, c);
  }
  return c;
}

type Runner = (text: string, params?: unknown[]) => Promise<any[]>;
let override: ((db: DbName) => Runner) | null = null;
/** Tests point the layer at a scratch database or a fake. */
export function setDbRunner(f: ((db: DbName) => Runner) | null): void {
  override = f;
}

export async function q<T = any>(db: DbName, text: string, params: unknown[] = []): Promise<T[]> {
  if (override) return (await override(db)(text, params)) as T[];
  return client(db).begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ ONLY");
    await tx.unsafe(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
    return (await tx.unsafe(text, params as any[])) as T[];
  }) as Promise<T[]>;
}

export async function closeDbs(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => c.close()));
  clients.clear();
}
