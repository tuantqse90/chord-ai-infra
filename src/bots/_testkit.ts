// Test helpers for the agents engine (offline): a temp SQLite file and deterministic Monad (EVM) addresses.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function useTempDb(prefix: string): { dir: string; restore: () => void } {
  const prev = process.env.DB_PATH;
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  process.env.DB_PATH = join(dir, "bots.db");
  return {
    dir,
    restore: () => {
      if (prev === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A valid Monad address (lower case), the same for the same n. */
export const addr = (n: number) => `0x${(0xabc0000 + n).toString(16).padStart(8, "0")}${"7".repeat(32)}`;

export const SOL = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a"; // WMON: the chain's own coin in the engine's tests
export const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
