// Test helpers for the bots engine (offline): a temp SQLite file, deterministic Solana addresses, getTransaction results
// shaped like jsonParsed answers, and a fake WebSocket.
import { Keypair } from "@solana/web3.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WsLike } from "./triggers";

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

/** A valid Solana address, the same for the same n. */
export const addr = (n: number) => {
  const seed = new Uint8Array(32).fill(7);
  seed[0] = n & 255;
  seed[1] = (n >> 8) & 255;
  return Keypair.fromSeed(seed).publicKey.toBase58();
};

export const SOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Tok = { owner: string; mint: string; pre?: string; post?: string; decimals: number };
/** A getTransaction (jsonParsed) result: native SOL pre/post per account, token balances per (owner, mint). */
export function rawTx(o: { sig: string; payer: string; fee?: number; blockTime?: number; err?: unknown; sol?: { account: string; pre: number; post: number }[]; tokens?: Tok[] }) {
  const sol = o.sol ?? [{ account: o.payer, pre: 10e9, post: 10e9 - (o.fee ?? 5000) }];
  const keys = sol.map((s, i) => ({ pubkey: s.account, signer: i === 0, writable: true }));
  const tb = (which: "pre" | "post") => (o.tokens ?? []).filter((t) => t[which] !== undefined).map((t, i) => ({
    accountIndex: keys.length + i, mint: t.mint, owner: t.owner, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    uiTokenAmount: { amount: t[which]!, decimals: t.decimals },
  }));
  return {
    slot: 1, blockTime: o.blockTime ?? 1_800_000_000,
    transaction: { signatures: [o.sig], message: { accountKeys: keys, instructions: [] } },
    meta: { err: o.err ?? null, fee: o.fee ?? 5000, preBalances: sol.map((s) => s.pre), postBalances: sol.map((s) => s.post), preTokenBalances: tb("pre"), postTokenBalances: tb("post"), innerInstructions: [] },
  };
}

export class FakeWS implements WsLike {
  readyState = 0;
  sent: any[] = [];
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: any }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  push(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
