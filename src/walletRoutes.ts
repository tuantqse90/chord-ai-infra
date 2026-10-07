// /v1/wallet/*: the Solana wallet (ask2049-notes/PROMPT-solana-wallet.md, modelled on Chord's Ask wallet).
//   GET  /solana/:address            SOL + every SPL token (both token programs) priced by Jupiter, 15 s cache per address
//   GET  /solana/:address/activity   the wallet's swaps from Chord's Solana tape + the sends / deposits made here
//   POST /solana/withdraw/build      an unsigned transfer (SOL: system transfer; SPL: transferChecked, the recipient's
//                                    token account created when missing), simulated before it is handed out
//   POST /solana/send                relays a signed transfer, only one whose message this server built in the last 2 min
//   GET  /solana/status/:sig
//   GET  /relay/chains · /relay/quote · POST /relay/permit · GET /relay/status/:id
//                                    USDC on six EVM chains → USDC on Solana through Relay: the browser signs, this server
//                                    only forwards the quote, the permit signature and the status (no keys, no CORS).
// Reads go through the READ RPC (SOLANA_RPC_URL via rpc/solana), never NOWNodes: that lane is the agents' swaps only.
// Nothing here signs or holds a key; a transfer moves only when the person's own wallet signed it.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { Hono } from "hono";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { chordHeaders, config, USDC_MINT } from "./config";
import { rpc } from "./rpc/solana";
import { isPubkey, isSignature, symbolsFor } from "./solana/tokens";
import { fromRaw, toRaw, TradeError } from "./trade/amounts";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SOLANA_RELAY_CHAIN = 792703809;
/** Max keeps this much SOL for fees (the browser applies it; the server refuses what would leave the account below rent). */
export const FEE_RESERVE_LAMPORTS = 10_000_000;
const BASE_FEE = 5_000;
const TTL_BUILT = 120_000;

// ── transport (tests swap it): Jupiter, Relay and Chord's tape ─────────────────────────────────────────────────────────
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (...a) => fetch(...a);
export function setWalletFetch(f: Fetch | null): void { fetchImpl = f ?? ((...a) => fetch(...a)); }

const jupRoot = () => {
  const v = (process.env.JUPITER_API_URL ?? "").trim().replace(/\/$/, "");
  return v ? v.replace(/\/swap\/v1$/, "") : "https://lite-api.jup.ag";
};
const jupHeaders = (): Record<string, string> => {
  const k = (process.env.JUPITER_API_KEY ?? "").trim();
  return { Accept: "application/json", ...(k ? { "x-api-key": k } : {}) };
};
async function jupGet<T>(path: string): Promise<T> {
  const r = await fetchImpl(`${jupRoot()}${path}`, { headers: jupHeaders(), signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`Jupiter ${path.split("?")[0]} answered ${r.status}`);
  return (await r.json()) as T;
}

// ── token facts and prices (shared by every wallet: one search per 100 mints, one price call per 50) ──────────────────
type Info = { symbol: string | null; name: string | null; icon: string | null };
const INFO_HIT = 6 * 3600_000, INFO_MISS = 30 * 60_000, PRICE_TTL = 30_000, PRICE_STALE = 10 * 60_000, CACHE_MAX = 20_000;
const infoCache = new Map<string, { at: number; v: Info | null }>();
const priceCache = new Map<string, { at: number; usd: number | null; chg: number | null }>();
const capSet = <V>(m: Map<string, V>, k: string, v: V) => { if (!m.has(k) && m.size >= CACHE_MAX) m.delete(m.keys().next().value!); m.set(k, v); };
/** Token names come from anyone who mints: strip control, zero-width and bidi-override characters (a spam symbol spelled
 *  backwards with U+202E), cap the length. */
export const cleanText = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "").trim();
  return s ? s.slice(0, max) : null;
};
const numOr = (v: unknown): number | null => { const n = typeof v === "string" && v !== "" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) ? n : null; };

async function infos(mints: string[]): Promise<Map<string, Info>> {
  const now = Date.now();
  const want = mints.filter((m) => { const h = infoCache.get(m); return !h || now - h.at >= (h.v ? INFO_HIT : INFO_MISS); });
  for (let i = 0; i < want.length; i += 100) {
    const part = want.slice(i, i + 100);
    try {
      const list = await jupGet<any[]>(`/tokens/v2/search?query=${part.join(",")}`);
      const by = new Map((Array.isArray(list) ? list : []).filter((t) => t && typeof t.id === "string").map((t) => [t.id as string, t]));
      for (const m of part) {
        const t = by.get(m);
        capSet(infoCache, m, { at: Date.now(), v: t ? { symbol: cleanText(t.symbol, 24), name: cleanText(t.name, 48), icon: typeof t.icon === "string" && /^https:\/\//.test(t.icon) ? t.icon : null } : null });
      }
    } catch { /* unknown this time; the on-chain names below fill what they can */ }
  }
  const out = new Map<string, Info>();
  const missing: string[] = [];
  for (const m of mints) { const v = infoCache.get(m)?.v; if (v) out.set(m, v); else missing.push(m); }
  if (missing.length) {
    const chain = await symbolsFor(missing).catch(() => new Map());
    for (const m of missing) { const s = chain.get(m); const symbol = cleanText(s?.symbol, 24), name = cleanText(s?.name, 48); if (symbol || name) out.set(m, { symbol, name, icon: null }); }
  }
  return out;
}

async function priceMap(mints: string[]): Promise<Map<string, { usd: number; chg: number | null }>> {
  const now = Date.now();
  const stale = mints.filter((m) => { const h = priceCache.get(m); return !h || now - h.at >= PRICE_TTL; });
  for (let i = 0; i < stale.length; i += 50) {
    const ids = stale.slice(i, i + 50);
    try {
      const j = await jupGet<Record<string, { usdPrice?: unknown; priceChange24h?: unknown } | null>>(`/price/v3?ids=${ids.join(",")}`);
      for (const m of ids) {
        const usd = numOr(j?.[m]?.usdPrice);
        capSet(priceCache, m, { at: Date.now(), usd: usd != null && usd > 0 ? usd : null, chg: numOr(j?.[m]?.priceChange24h) });
      }
    } catch { /* the last price up to 10 min old stays */ }
  }
  const out = new Map<string, { usd: number; chg: number | null }>();
  for (const m of mints) { const h = priceCache.get(m); if (h?.usd != null && Date.now() - h.at < PRICE_STALE) out.set(m, { usd: h.usd, chg: h.chg }); }
  return out;
}

// ── balances ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Holding = {
  mint: string; symbol: string; name: string | null; decimals: number; raw: string; amount: string;
  priceUsd: number | null; valueUsd: number | null; change24h: number | null; logo: string; program: "token" | "token-2022"; accounts: number;
};
export type WalletBalances = {
  address: string;
  sol: { lamports: string; amount: string; priceUsd: number | null; valueUsd: number | null; change24h: number | null; logo: string };
  tokens: Holding[]; totalUsd: number; change24hUsd: number | null; change24hPct: number | null; unpriced: number; truncated: number; at: number;
};
/** Mints priced per wallet; a wallet holding more lists the rest unpriced (a sweep of 2,000 dust airdrops must not cost 40 calls). */
export const MAX_PRICED = 300;
const logoOf = (mint: string) => `/v1/logo/solana/${mint}`;
const shortMint = (m: string) => `${m.slice(0, 4)}…`;

type ParsedAcc = { pubkey: string; account: { owner?: string; data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number }; state?: string } } } } };

/** Value first, unpriced after the priced ones, then by symbol. */
export function byValue(a: { valueUsd: number | null; symbol: string }, b: { valueUsd: number | null; symbol: string }): number {
  if (a.valueUsd == null && b.valueUsd == null) return a.symbol.localeCompare(b.symbol);
  if (a.valueUsd == null) return 1;
  if (b.valueUsd == null) return -1;
  return b.valueUsd - a.valueUsd || a.symbol.localeCompare(b.symbol);
}

export async function readBalances(address: string): Promise<WalletBalances> {
  const [lamports, legacy, t22] = await Promise.all([
    rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]),
    rpc<{ value: ParsedAcc[] }>("getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed", commitment: "confirmed" }]),
    rpc<{ value: ParsedAcc[] }>("getTokenAccountsByOwner", [address, { programId: TOKEN_2022 }, { encoding: "jsonParsed", commitment: "confirmed" }]),
  ]);
  const agg = new Map<string, { raw: bigint; decimals: number; program: "token" | "token-2022"; accounts: number }>();
  for (const [list, program] of [[legacy?.value ?? [], "token"], [t22?.value ?? [], "token-2022"]] as const) {
    for (const a of list) {
      const info = a?.account?.data?.parsed?.info;
      const mint = info?.mint, amt = info?.tokenAmount;
      if (typeof mint !== "string" || !amt || typeof amt.amount !== "string" || typeof amt.decimals !== "number") continue;
      let raw = 0n; try { raw = BigInt(amt.amount); } catch { continue; }
      if (raw <= 0n) continue;
      const cur = agg.get(mint);
      if (cur) { cur.raw += raw; cur.accounts++; } else agg.set(mint, { raw, decimals: amt.decimals, program, accounts: 1 });
    }
  }
  const mints = [...agg.keys()];
  const priced = mints.slice(0, MAX_PRICED);
  const [meta, px] = await Promise.all([infos(priced), priceMap([SOL_MINT, ...priced])]);
  const tokens: Holding[] = mints.map((mint) => {
    const a = agg.get(mint)!;
    const amount = fromRaw(a.raw, a.decimals);
    const p = px.get(mint) ?? null;
    const m = meta.get(mint);
    const symbol = mint === SOL_MINT ? "wSOL" : m?.symbol?.trim() || shortMint(mint);
    const name = mint === SOL_MINT ? "Wrapped SOL" : m?.name?.trim() || null;
    return { mint, symbol, name, decimals: a.decimals, raw: a.raw.toString(), amount, priceUsd: p?.usd ?? null, valueUsd: p ? Number(amount) * p.usd : null,
      change24h: p?.chg ?? null, logo: m?.icon ?? logoOf(mint), program: a.program, accounts: a.accounts };
  }).sort(byValue);
  const solP = px.get(SOL_MINT) ?? null;
  const solAmount = fromRaw(BigInt(lamports?.value ?? 0), 9);
  const sol = { lamports: String(lamports?.value ?? 0), amount: solAmount, priceUsd: solP?.usd ?? null, valueUsd: solP ? Number(solAmount) * solP.usd : null, change24h: solP?.chg ?? null, logo: logoOf(SOL_MINT) };
  const rows = [sol, ...tokens];
  const totalUsd = rows.reduce((s, r) => s + (r.valueUsd ?? 0), 0);
  // the move over 24 h: value now minus value at yesterday's price, for every row Jupiter gives a change for
  let moved = 0, known = false;
  for (const r of rows) if (r.valueUsd != null && r.change24h != null && r.change24h > -100) { known = true; moved += r.valueUsd - r.valueUsd / (1 + r.change24h / 100); }
  const before = totalUsd - moved;
  return {
    address, sol, tokens, totalUsd, change24hUsd: known ? moved : null, change24hPct: known && before > 0 ? (moved / before) * 100 : null,
    unpriced: tokens.filter((t) => t.priceUsd == null).length, truncated: Math.max(0, mints.length - MAX_PRICED), at: Date.now(),
  };
}

const BAL_TTL = 15_000;
const balCache = new Map<string, { at: number; v: WalletBalances }>();
const balInflight = new Map<string, Promise<WalletBalances>>();
export function balances(address: string, fresh = false): Promise<WalletBalances> {
  const hit = balCache.get(address);
  if (hit && Date.now() - hit.at < (fresh ? 3_000 : BAL_TTL)) return Promise.resolve(hit.v);
  const run = balInflight.get(address);
  if (run) return run;
  const p = readBalances(address).then((v) => { capSet(balCache, address, { at: Date.now(), v }); return v; }).finally(() => balInflight.delete(address));
  balInflight.set(address, p);
  return p;
}

// ── activity: sends and deposits made here, kept in the app DB ─────────────────────────────────────────────────────────
let db: Database | null = null;
function store(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS wallet_activity (ref TEXT PRIMARY KEY, address TEXT NOT NULL, kind TEXT NOT NULL, mint TEXT, symbol TEXT, amount TEXT, usd REAL, counterparty TEXT, chain TEXT, status TEXT NOT NULL, at INTEGER NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS wallet_activity_addr ON wallet_activity (address, at)");
  return db;
}
export type ActivityRow = { ref: string; address: string; kind: "send" | "deposit"; mint: string | null; symbol: string | null; amount: string | null; usd: number | null; counterparty: string | null; chain: string | null; status: string; at: number };
function recordActivity(r: ActivityRow): void {
  try { store().run("INSERT OR IGNORE INTO wallet_activity (ref, address, kind, mint, symbol, amount, usd, counterparty, chain, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [r.ref, r.address, r.kind, r.mint, r.symbol, r.amount, r.usd, r.counterparty, r.chain, r.status, r.at]); } catch { /* the move itself already happened */ }
}
function setActivityStatus(ref: string, status: string): void {
  try { store().run("UPDATE wallet_activity SET status = ? WHERE ref = ? AND status != ?", [status, ref, status]); } catch { /* best effort */ }
}
export function activityOf(address: string, limit = 40): ActivityRow[] {
  return store().query("SELECT * FROM wallet_activity WHERE address = ? ORDER BY at DESC LIMIT ?").all(address, limit) as ActivityRow[];
}

type TapeSwap = { ts: number; side: "buy" | "sell"; token: string; symbol: string | null; tokenAmount: number; usd: number | null; dex: string | null; tx: string };
const tapeCache = new Map<string, { at: number; v: TapeSwap[] }>();
async function walletSwaps(address: string): Promise<TapeSwap[]> {
  const hit = tapeCache.get(address);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const base = config.chordApi();
  if (!base) throw new Error("Chord's tape is switched off on this server");
  const r = await fetchImpl(`${base}/v1/chains/solana/wallet/${encodeURIComponent(address)}/trades?limit=30`, { headers: chordHeaders(), signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`Chord's tape answered ${r.status}`);
  const j: any = await r.json();
  if (!Array.isArray(j?.trades)) throw new Error("Chord's tape answered without a trade list");
  const v: TapeSwap[] = j.trades.filter((t: any) => t && typeof t.tx === "string" && typeof t.token === "string" && (t.side === "buy" || t.side === "sell") && Number.isFinite(Number(t.ts)))
    .map((t: any) => ({ ts: Number(t.ts), side: t.side, token: t.token, symbol: cleanText(t.symbol, 24), tokenAmount: Number(t.tokenAmount) || 0, usd: numOr(t.usd), dex: typeof t.dex === "string" ? t.dex : null, tx: t.tx }));
  capSet(tapeCache, address, { at: Date.now(), v });
  return v;
}

// ── withdraw: build → (the wallet signs) → send ────────────────────────────────────────────────────────────────────────
export type WithdrawSummary = {
  kind: "sol" | "spl"; from: string; to: string; mint: string; symbol: string; decimals: number; amount: string; amountRaw: string;
  valueUsd: number | null; destinationAccount: string; createsAccount: boolean; rentLamports: string; feeLamports: string;
  /** SOL leaving the wallet besides the amount (fee + rent of a new token account). */
  solCost: string; program: "system" | "token" | "token-2022"; warnings: string[];
};
const built = new Map<string, { at: number; summary: WithdrawSummary }>(); // sha256(message) → built at
const sweepBuilt = () => { const now = Date.now(); for (const [k, v] of built) if (now - v.at > TTL_BUILT) built.delete(k); };
const messageHash = (tx: VersionedTransaction) => createHash("sha256").update(tx.message.serialize()).digest("hex");

const rentCache = new Map<number, number>();
async function rentFor(size: number): Promise<number> {
  const hit = rentCache.get(size);
  if (hit) return hit;
  const v = Number(await rpc<number>("getMinimumBalanceForRentExemption", [size]));
  if (!Number.isFinite(v) || v <= 0) throw new TradeError("could not read Solana's rent minimum", 502);
  rentCache.set(size, v);
  return v;
}
/** A priority fee that lands: the median of recent non-zero fees, in micro-lamports per compute unit, kept within bounds. */
async function priorityPrice(): Promise<number> {
  const r = await rpc<{ prioritizationFee: number }[]>("getRecentPrioritizationFees", [[]]).catch(() => null);
  const fees = (r ?? []).map((x) => Number(x?.prioritizationFee)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  const mid = fees.length ? fees[Math.floor(fees.length / 2)] : 20_000;
  return Math.max(20_000, Math.min(500_000, Math.round(mid)));
}

export const ata = (owner: string, mint: string, program: string): string =>
  PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58();
const createAtaIdempotent = (payer: string, account: string, owner: string, mint: string, program: string) => new TransactionInstruction({
  programId: new PublicKey(ATA_PROGRAM), data: Buffer.from([1]),
  keys: [
    { pubkey: new PublicKey(payer), isSigner: true, isWritable: true }, { pubkey: new PublicKey(account), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(owner), isSigner: false, isWritable: false }, { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: new PublicKey(program), isSigner: false, isWritable: false },
  ],
});
const transferChecked = (source: string, mint: string, dest: string, owner: string, raw: bigint, decimals: number, program: string) => {
  const data = Buffer.alloc(10);
  data[0] = 12; data.writeBigUInt64LE(raw, 1); data[9] = decimals;
  return new TransactionInstruction({ programId: new PublicKey(program), data, keys: [
    { pubkey: new PublicKey(source), isSigner: false, isWritable: true }, { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(dest), isSigner: false, isWritable: true }, { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
  ] });
};
const solStr = (lamports: number | bigint) => fromRaw(BigInt(lamports), 9);

/** A simulation error in words the person can act on. */
export function simReason(err: unknown, logs: string[] | null): string {
  const e = JSON.stringify(err ?? "");
  const text = (logs ?? []).join("\n");
  if (/InsufficientFundsForRent/.test(e)) return "That leaves an account below Solana's rent minimum. Keep a little more SOL, or send a bigger amount to a new address.";
  if (/AccountNotFound/.test(e)) return "The wallet has no SOL to pay the network fee.";
  if (/insufficient funds|Custom":1\b/i.test(text + e)) return "Not enough balance for this amount and the network fee.";
  if (/frozen|Custom":17\b/i.test(text + e)) return "This token account is frozen by the token's issuer.";
  const last = (logs ?? []).filter((l) => /failed|error/i.test(l)).pop();
  return `The transfer fails when simulated${last ? `: ${last.replace(/^Program \w+ /, "").slice(0, 140)}` : ` (${e.slice(0, 120)})`}. Nothing was sent.`;
}

export async function buildWithdraw(b: { from?: unknown; to?: unknown; mint?: unknown; amount?: unknown }) {
  const from = String(b.from ?? "").trim(), to = String(b.to ?? "").trim(), mintIn = String(b.mint ?? "").trim(), amount = String(b.amount ?? "").trim();
  if (!isPubkey(from)) throw new TradeError("from must be a Solana address");
  if (!isPubkey(to)) throw new TradeError("That is not a Solana address.");
  if (to === from) throw new TradeError("That is this wallet.");
  const isSol = mintIn === "SOL" || mintIn === "";
  if (!isSol && !isPubkey(mintIn)) throw new TradeError("mint must be \"SOL\" or a token mint address");
  if (!isSol && mintIn === to) throw new TradeError("That is the token's mint address, not a wallet.");

  const warnings: string[] = [];
  const [balance, toAcc, price] = await Promise.all([
    rpc<{ value: number }>("getBalance", [from, { commitment: "confirmed" }]).then((r) => Number(r?.value ?? 0)),
    rpc<{ value: { owner: string; executable: boolean; lamports: number } | null }>("getAccountInfo", [to, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]).then((r) => r?.value ?? null),
    priorityPrice(),
  ]);
  if (toAcc?.executable) throw new TradeError("That address is a program, not a wallet.");
  if (toAcc && (toAcc.owner === TOKEN_PROGRAM || toAcc.owner === TOKEN_2022)) throw new TradeError("That is a token account. Paste the owner's wallet address instead.");
  if (!PublicKey.isOnCurve(new PublicKey(to).toBytes())) warnings.push("This address is not a regular wallet (a program or multisig account). Make sure it can receive and move this token.");

  const ixs: TransactionInstruction[] = [];
  let summary: WithdrawSummary;
  if (isSol) {
    const lamports = BigInt(toRaw(amount, 9));
    const limit = 1_000;
    const fee = BASE_FEE + Math.ceil((limit * price) / 1e6);
    const rent0 = await rentFor(0);
    if (!toAcc && lamports < BigInt(rent0)) throw new TradeError(`A new address needs at least ${solStr(rent0)} SOL.`);
    const left = BigInt(balance) - lamports - BigInt(fee);
    if (left < 0n) throw new TradeError(`More than the ${solStr(Math.max(0, balance - fee))} SOL you can send.`);
    if (left > 0n && left < BigInt(rent0)) throw new TradeError(`That leaves ${solStr(left)} SOL, under Solana's ${solStr(rent0)} SOL minimum for an open account. Send less, or use Max.`);
    ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: limit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
      SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(to), lamports }));
    const p = (await priceMap([SOL_MINT])).get(SOL_MINT);
    summary = { kind: "sol", from, to, mint: SOL_MINT, symbol: "SOL", decimals: 9, amount: fromRaw(lamports, 9), amountRaw: lamports.toString(),
      valueUsd: p ? Number(fromRaw(lamports, 9)) * p.usd : null, destinationAccount: to, createsAccount: false, rentLamports: "0",
      feeLamports: String(fee), solCost: solStr(fee), program: "system", warnings };
  } else {
    const mint = mintIn;
    const mintAcc = (await rpc<{ value: { owner: string; data: { parsed?: { type?: string; info?: any } } } | null }>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]))?.value;
    const program = mintAcc?.owner;
    if (!mintAcc || (program !== TOKEN_PROGRAM && program !== TOKEN_2022) || mintAcc.data?.parsed?.type !== "mint") throw new TradeError("That mint is not an SPL token.");
    const mi = mintAcc.data.parsed.info ?? {};
    const decimals = Number(mi.decimals);
    const exts: any[] = Array.isArray(mi.extensions) ? mi.extensions : [];
    const ext = (name: string) => exts.find((e) => e?.extension === name);
    if (ext("nonTransferable")) throw new TradeError("This token cannot be transferred (its issuer made it non-transferable).");
    if (ext("transferHook")?.state?.programId) throw new TradeError("This token runs its issuer's program on every transfer. Send it from a wallet app that supports transfer hooks.");
    const fee2022 = ext("transferFeeConfig")?.state;
    if (fee2022) {
      const bps = Number(fee2022.newerTransferFee?.transferFeeBasisPoints ?? fee2022.olderTransferFee?.transferFeeBasisPoints ?? 0);
      if (bps > 0) warnings.push(`The token's issuer keeps ${(bps / 100).toFixed(2)}% of every transfer; the recipient gets that much less.`);
    }
    const raw = BigInt(toRaw(amount, decimals));
    const src = await rpc<{ value: ParsedAcc[] }>("getTokenAccountsByOwner", [from, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const accs = (src?.value ?? []).map((a) => ({ pubkey: a.pubkey, raw: BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0"), frozen: a.account?.data?.parsed?.info?.state === "frozen" }))
      .filter((a) => a.raw > 0n).sort((x, y) => (y.raw > x.raw ? 1 : y.raw < x.raw ? -1 : 0));
    const total = accs.reduce((s, a) => s + a.raw, 0n);
    const source = accs[0];
    if (!source || total < raw) throw new TradeError(`More than the ${fromRaw(total, decimals)} you hold.`);
    if (source.raw < raw) throw new TradeError(`This token sits in ${accs.length} accounts; send up to ${fromRaw(source.raw, decimals)} at once.`);
    if (source.frozen) throw new TradeError("Your account of this token is frozen by its issuer.");
    const dest = ata(to, mint, program);
    const destAcc = (await rpc<{ value: { data: { parsed?: { info?: { state?: string } } } } | null }>("getAccountInfo", [dest, { encoding: "jsonParsed", commitment: "confirmed" }]))?.value ?? null;
    if (destAcc?.data?.parsed?.info?.state === "frozen") throw new TradeError("The recipient's account of this token is frozen by its issuer.");
    const creates = !destAcc;
    // a new account: 165 bytes (Token); Token-2022 adds the account type, ImmutableOwner and the mint's account-side extensions
    const size = program === TOKEN_PROGRAM ? 165 : 170 + (fee2022 ? 12 : 0);
    const rent = creates ? await rentFor(size) : 0;
    const limit = creates ? 40_000 : 12_000;
    const fee = BASE_FEE + Math.ceil((limit * price) / 1e6);
    if (BigInt(balance) < BigInt(fee + rent)) {
      throw new TradeError(creates
        ? `Needs ${solStr(fee + rent)} SOL: the network fee plus ${solStr(rent)} SOL to open the recipient's account of this token. The wallet has ${solStr(balance)} SOL.`
        : `Needs ${solStr(fee)} SOL for the network fee. The wallet has ${solStr(balance)} SOL.`);
    }
    ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: limit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
    if (creates) ixs.push(createAtaIdempotent(from, dest, to, mint, program));
    ixs.push(transferChecked(source.pubkey, mint, dest, from, raw, decimals, program));
    const [meta, px] = await Promise.all([infos([mint]), priceMap([mint])]);
    const p = px.get(mint);
    summary = { kind: "spl", from, to, mint, symbol: meta.get(mint)?.symbol?.trim() || shortMint(mint), decimals, amount: fromRaw(raw, decimals), amountRaw: raw.toString(),
      valueUsd: p ? Number(fromRaw(raw, decimals)) * p.usd : null, destinationAccount: dest, createsAccount: creates, rentLamports: String(rent),
      feeLamports: String(fee), solCost: solStr(fee + rent), program: program === TOKEN_PROGRAM ? "token" : "token-2022", warnings };
  }

  const { blockhash, lastValidBlockHeight } = (await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(from), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const b64 = Buffer.from(tx.serialize()).toString("base64");
  const sim = await rpc<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]);
  if (sim?.value?.err != null) throw new TradeError(simReason(sim.value.err, sim.value.logs), 422);
  sweepBuilt();
  built.set(messageHash(tx), { at: Date.now(), summary });
  return { transaction: b64, lastValidBlockHeight, expiresAt: Math.floor((Date.now() + TTL_BUILT) / 1000), summary, simulation: { ok: true, units: sim?.value?.unitsConsumed ?? null } };
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
/** Relay a signed transfer, only when this server built its message in the last two minutes and the payer's signature checks. */
export async function sendWithdraw(signedB64: unknown) {
  sweepBuilt();
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(String(signedB64 ?? ""), "base64")); } catch { throw new TradeError("not a Solana transaction"); }
  const entry = built.get(messageHash(tx));
  if (!entry) throw new TradeError("this server only relays transfers it prepared in the last two minutes", 403);
  const sig = tx.signatures[0];
  if (!sig || sig.every((x) => x === 0)) throw new TradeError("the transaction is not signed");
  const payer = tx.message.staticAccountKeys[0];
  const ok = edVerify(null, Buffer.from(tx.message.serialize()), createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(payer.toBytes())]), format: "der", type: "spki" }), Buffer.from(sig));
  if (!ok) throw new TradeError("the signature does not match the sending wallet");
  const signature = await rpc<string>("sendTransaction", [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
  built.delete(messageHash(tx));
  const s = entry.summary;
  recordActivity({ ref: signature, address: s.from, kind: "send", mint: s.mint, symbol: s.symbol, amount: s.amount, usd: s.valueUsd, counterparty: s.to, chain: "solana", status: "sent", at: Date.now() });
  balCache.delete(s.from); balCache.delete(s.to);
  return { signature };
}

export async function txStatus(sig: string) {
  const r = await rpc<{ value: ({ confirmationStatus: string; err: unknown } | null)[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
  const s = r?.value?.[0];
  const status = s?.err ? "failed" : s?.confirmationStatus ?? "pending";
  if (status !== "pending") setActivityStatus(sig, status);
  return { signature: sig, status, error: s?.err ? JSON.stringify(s.err) : null };
}

// ── Relay: USDC on an EVM chain → USDC on Solana ───────────────────────────────────────────────────────────────────────
export type DepositSource = { key: string; chainId: number; hex: string; name: string; usdc: string; decimals: number; native: { symbol: string; name: string; decimals: number }; rpc: string[]; explorer: string };
/** Order of the Deposit panel. RPCs answer browsers (CORS) and are read from the page: balances never pass through here. */
export const DEPOSIT_SOURCES: DepositSource[] = [
  { key: "base", chainId: 8453, hex: "0x2105", name: "Base", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, native: { symbol: "ETH", name: "Ether", decimals: 18 }, rpc: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"], explorer: "https://basescan.org/tx/" },
  { key: "arbitrum", chainId: 42161, hex: "0xa4b1", name: "Arbitrum", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, native: { symbol: "ETH", name: "Ether", decimals: 18 }, rpc: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"], explorer: "https://arbiscan.io/tx/" },
  { key: "ethereum", chainId: 1, hex: "0x1", name: "Ethereum", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, native: { symbol: "ETH", name: "Ether", decimals: 18 }, rpc: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"], explorer: "https://etherscan.io/tx/" },
  { key: "optimism", chainId: 10, hex: "0xa", name: "Optimism", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, native: { symbol: "ETH", name: "Ether", decimals: 18 }, rpc: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"], explorer: "https://optimistic.etherscan.io/tx/" },
  { key: "polygon", chainId: 137, hex: "0x89", name: "Polygon", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, native: { symbol: "POL", name: "POL", decimals: 18 }, rpc: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"], explorer: "https://polygonscan.com/tx/" },
  { key: "bnb", chainId: 56, hex: "0x38", name: "BNB Chain", usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, native: { symbol: "BNB", name: "BNB", decimals: 18 }, rpc: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com"], explorer: "https://bscscan.com/tx/" },
];
const relayBase = () => (process.env.RELAY_API_URL ?? "").trim().replace(/\/$/, "") || "https://api.relay.link";
const relayHeaders = (): Record<string, string> => {
  const k = (process.env.RELAY_API_KEY ?? "").trim();
  return { "Content-Type": "application/json", Accept: "application/json", ...(k ? { "x-api-key": k } : {}) };
};
// Relay caps a caller IP (quote 50/min keyless; status + permits share 200/min): one budget for the whole box.
const budgets = new Map<string, { minute: number; n: number }>();
function take(kind: string, perMin: number): void {
  const minute = Math.floor(Date.now() / 60_000);
  const b = budgets.get(kind);
  if (!b || b.minute !== minute) { budgets.set(kind, { minute, n: 1 }); return; }
  if (++b.n > perMin) throw new TradeError("Too many deposit requests right now. Try again in a minute.", 429);
}
const ADDR = /^0x[0-9a-fA-F]{40}$/, REQ = /^0x[0-9a-fA-F]{64}$/;
const quoted = new Map<string, { at: number; recipient: string; chain: string; amountIn: string; receive: string; receiveUsd: number | null }>();

export type RelayView = {
  requestId: string; chain: { key: string; chainId: number; name: string }; amountIn: string; amountInRaw: string;
  receive: string; minReceive: string; receiveUsd: number | null;
  fees: { relayerUsd: number | null; appUsd: number | null; gasUsd: number | null; totalUsd: number | null };
  seconds: number | null; impactPct: number | null;
  /** Relay answered with signature steps only: the wallet signs once, sends nothing, pays no gas. */
  signatureOnly: boolean; txCount: number; steps: unknown[];
};

/** Validates Relay's answer against what was asked and reduces it to what the page shows and runs. */
export function relayView(q: any, src: DepositSource, ask: { user: string; recipient: string; raw: string }): RelayView {
  const bad = (why: string) => new TradeError(`Relay answered a different route than the one asked (${why})`, 502);
  const d = q?.details ?? {}, ci = d.currencyIn, co = d.currencyOut;
  if (co?.currency?.chainId !== SOLANA_RELAY_CHAIN || co?.currency?.address !== USDC_MINT) throw bad("destination");
  if (ci?.currency?.chainId !== src.chainId || String(ci?.currency?.address ?? "").toLowerCase() !== src.usdc.toLowerCase()) throw bad("source");
  if (String(ci?.amount ?? "") !== ask.raw) throw bad("amount");
  if (d.recipient != null && d.recipient !== ask.recipient) throw bad("recipient");
  if (d.sender != null && String(d.sender).toLowerCase() !== ask.user.toLowerCase()) throw bad("sender");
  let requestId: string | null = typeof q.requestId === "string" && REQ.test(q.requestId) ? q.requestId : null;
  const steps: any[] = Array.isArray(q.steps) ? q.steps : [];
  let txCount = 0, sigs = 0;
  for (const s of steps) {
    for (const it of Array.isArray(s?.items) ? s.items : []) {
      const ep = it?.check?.endpoint;
      if (!requestId && typeof ep === "string") { const id = new URLSearchParams(ep.split("?")[1] ?? "").get("requestId"); if (id && REQ.test(id)) requestId = id; }
      if (it?.status === "complete") continue;
      if (s.kind === "transaction") {
        const t = it?.data;
        if (!t || !ADDR.test(String(t.to ?? "")) || Number(t.chainId) !== src.chainId) throw bad("transaction");
        if (t.from != null && String(t.from).toLowerCase() !== ask.user.toLowerCase()) throw bad("transaction sender");
        if (s.id === "approve" && (String(t.to).toLowerCase() !== src.usdc.toLowerCase() || !String(t.data ?? "").startsWith("0x095ea7b3"))) throw bad("approval");
        txCount++;
      } else if (s.kind === "signature") {
        const sg = it?.data?.sign, post = it?.data?.post;
        if (sg?.signatureKind !== "eip712" || Number(sg?.domain?.chainId) !== src.chainId || post?.endpoint !== "/execute/permits" || !REQ.test(String(post?.body?.requestId ?? ""))) throw bad("signature");
        sigs++;
      } else throw bad(`step ${String(s?.kind)}`);
    }
  }
  if (!requestId) throw bad("request id");
  if (!txCount && !sigs) throw bad("nothing to sign");
  const fees = q.fees ?? {};
  const relayerUsd = numOr(fees.relayer?.amountUsd), appUsd = numOr(fees.app?.amountUsd), gasUsd = numOr(fees.gas?.amountUsd);
  const parts = [relayerUsd, appUsd].filter((x): x is number => x != null);
  return {
    requestId, chain: { key: src.key, chainId: src.chainId, name: src.name }, amountIn: fromRaw(ask.raw, src.decimals), amountInRaw: ask.raw,
    receive: fromRaw(String(co.amount ?? "0"), 6), minReceive: fromRaw(String(co.minimumAmount ?? co.amount ?? "0"), 6), receiveUsd: numOr(co.amountUsd),
    fees: { relayerUsd, appUsd, gasUsd, totalUsd: parts.length ? parts.reduce((a, b) => a + b, 0) : null },
    seconds: numOr(d.timeEstimate), impactPct: numOr(d.totalImpact?.percent), signatureOnly: sigs > 0 && txCount === 0, txCount, steps,
  };
}

export async function relayQuote(p: { from?: string; user?: string; recipient?: string; amount?: string }): Promise<RelayView> {
  const src = DEPOSIT_SOURCES.find((s) => s.key === String(p.from ?? "").toLowerCase());
  if (!src) throw new TradeError(`from must be one of ${DEPOSIT_SOURCES.map((s) => s.key).join(", ")}`);
  const user = String(p.user ?? ""), recipient = String(p.recipient ?? "");
  if (!ADDR.test(user)) throw new TradeError("user must be an EVM address");
  if (!isPubkey(recipient)) throw new TradeError("recipient must be a Solana address");
  const raw = toRaw(String(p.amount ?? ""), src.decimals);
  if (BigInt(raw) > 10n ** BigInt(src.decimals) * 1_000_000n) throw new TradeError("at most 1,000,000 USDC at once");
  take("quote", 40);
  const body = { user, recipient, originChainId: src.chainId, destinationChainId: SOLANA_RELAY_CHAIN, originCurrency: src.usdc, destinationCurrency: USDC_MINT,
    amount: raw, tradeType: "EXACT_INPUT", refundTo: user, slippageTolerance: "100", usePermit: true,
    // Relay refuses a keyless quote that names a referrer (UNAUTHORIZED_QUOTE, measured 07/10): only with a key
    ...((process.env.RELAY_API_KEY ?? "").trim() ? { referrer: "chord.clawpot.xyz" } : {}) };
  let r: Response;
  try { r = await fetchImpl(`${relayBase()}/quote/v2`, { method: "POST", headers: relayHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) }); }
  catch { throw new TradeError("Relay did not answer. Try again in a moment.", 502); }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String(j?.message ?? `HTTP ${r.status}`);
    throw new TradeError(/AMOUNT_TOO_LOW|too small|too low/i.test(`${j?.errorCode} ${msg}`) ? "That amount is too small to cover the bridge fees. Try a bigger amount." : `Relay: ${msg.slice(0, 160)}`, r.status === 429 ? 503 : r.status >= 500 ? 502 : 400);
  }
  const v = relayView(j, src, { user, recipient, raw });
  for (const [k, x] of quoted) if (Date.now() - x.at > 30 * 60_000) quoted.delete(k);
  quoted.set(v.requestId, { at: Date.now(), recipient, chain: src.key, amountIn: v.amountIn, receive: v.receive, receiveUsd: v.receiveUsd });
  return v;
}

export async function relayPermit(b: { requestId?: unknown; kind?: unknown; api?: unknown; signature?: unknown }) {
  const requestId = String(b.requestId ?? ""), kind = String(b.kind ?? ""), api = String(b.api ?? ""), signature = String(b.signature ?? "");
  if (!REQ.test(requestId) || !/^[a-z0-9_-]{1,32}$/i.test(kind) || !/^[a-z0-9_-]{1,32}$/i.test(api) || !/^0x[0-9a-fA-F]{2,4096}$/.test(signature)) throw new TradeError("send the step's requestId, kind, api and the signature");
  const q = quoted.get(requestId);
  if (!q) throw new TradeError("this deposit was not quoted here in the last 30 minutes; get a new quote", 410);
  take("permit", 50);
  let r: Response;
  try { r = await fetchImpl(`${relayBase()}/execute/permits?signature=${encodeURIComponent(signature)}`, { method: "POST", headers: relayHeaders(), body: JSON.stringify({ kind, requestId, api }), signal: AbortSignal.timeout(15_000) }); }
  catch { throw new TradeError("Relay did not answer. Try again in a moment.", 502); }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new TradeError(`Relay refused the signature: ${String(j?.message ?? `HTTP ${r.status}`).slice(0, 160)}`, r.status >= 500 ? 502 : 400);
  recordActivity({ ref: requestId, address: q.recipient, kind: "deposit", mint: USDC_MINT, symbol: "USDC", amount: q.receive, usd: q.receiveUsd, counterparty: null, chain: q.chain, status: "pending", at: Date.now() });
  return { ok: true };
}

export async function relayStatus(requestId: string) {
  if (!REQ.test(requestId)) throw new TradeError("requestId must be 0x + 64 hex");
  take("status", 150);
  const r = await fetchImpl(`${relayBase()}/intents/status/v3?requestId=${requestId}`, { headers: relayHeaders(), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r) throw new TradeError("Relay did not answer.", 502);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new TradeError(`Relay status: HTTP ${r.status}`, r.status >= 500 ? 502 : 400);
  const status = typeof j?.status === "string" ? j.status : "unknown";
  if (status === "success" || status === "failure" || status === "refund") setActivityStatus(requestId, status);
  const hashes = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 4) : []);
  return { requestId, status, inTx: hashes(j?.inTxHashes), outTx: hashes(j?.txHashes) };
}

// ── routes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Per caller, per minute: every uncached balance read and every build costs several RPC calls on the app's paid endpoint.
const hits = new Map<string, { minute: number; n: number }>();
function limited(c: any, kind: string, perMin: number): boolean {
  const ip = (c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0] ?? "local").trim();
  const key = `${kind}|${ip}`, minute = Math.floor(Date.now() / 60_000);
  const h = hits.get(key);
  if (!h || h.minute !== minute) { if (!h && hits.size >= 5_000) hits.delete(hits.keys().next().value!); hits.set(key, { minute, n: 1 }); return false; }
  return ++h.n > perMin;
}
const slowDown = (c: any) => c.json({ error: "rate_limited", message: "Too many requests. Try again in a minute." }, 429);
export const wallet = new Hono();
const fail = (c: any, e: unknown) => {
  if (e instanceof TradeError) return c.json({ error: "wallet", message: e.message }, e.status);
  return c.json({ error: "upstream", message: String((e as Error)?.message ?? e).replace(/(https?|wss?):\/\/\S+/g, "[endpoint]").slice(0, 200) }, 502);
};

wallet.get("/solana/status/:sig", async (c) => {
  try {
    const sig = c.req.param("sig");
    if (!isSignature(sig)) throw new TradeError("sig must be a Solana signature");
    return c.json(await txStatus(sig));
  } catch (e) { return fail(c, e); }
});
wallet.get("/solana/:address", async (c) => {
  try {
    const a = c.req.param("address");
    if (!isPubkey(a)) throw new TradeError("not a Solana address");
    if (!balCache.has(a) && limited(c, "bal", 60)) return slowDown(c);
    return c.json(await balances(a, c.req.query("fresh") === "1"), 200, { "Cache-Control": "no-store" });
  } catch (e) { return fail(c, e); }
});
wallet.get("/solana/:address/activity", async (c) => {
  try {
    const a = c.req.param("address");
    if (!isPubkey(a)) throw new TradeError("not a Solana address");
    let swaps: TapeSwap[] = [], swapsError: string | null = null;
    try { swaps = await walletSwaps(a); } catch (e) { swapsError = String((e as Error)?.message ?? e).replace(/(https?):\/\/\S+/g, "[endpoint]").slice(0, 160); }
    const own = activityOf(a);
    const items = [
      ...swaps.map((s) => ({ kind: "swap" as const, at: s.ts * 1000, side: s.side, mint: s.token, symbol: s.symbol, amount: s.tokenAmount, usd: s.usd, venue: s.dex, ref: s.tx, status: "confirmed", counterparty: null, chain: "solana" })),
      ...own.map((r) => ({ kind: r.kind, at: r.at, side: null, mint: r.mint, symbol: r.symbol, amount: r.amount != null ? Number(r.amount) : null, usd: r.usd, venue: r.kind === "deposit" ? "Relay" : null, ref: r.ref, status: r.status, counterparty: r.counterparty, chain: r.chain })),
    ].sort((x, y) => y.at - x.at).slice(0, 50);
    return c.json({ address: a, items, swapsError, at: Date.now() });
  } catch (e) { return fail(c, e); }
});
wallet.post("/solana/withdraw/build", async (c) => {
  if (limited(c, "build", 30)) return slowDown(c);
  try { return c.json(await buildWithdraw(await c.req.json().catch(() => ({})))); } catch (e) { return fail(c, e); }
});
wallet.post("/solana/send", async (c) => {
  try { const b = await c.req.json().catch(() => ({})); return c.json(await sendWithdraw(b.transaction)); } catch (e) { return fail(c, e); }
});
wallet.get("/relay/chains", (c) => c.json({ destination: { chainId: SOLANA_RELAY_CHAIN, currency: USDC_MINT, symbol: "USDC" }, sources: DEPOSIT_SOURCES }, 200, { "Cache-Control": "public, max-age=300" }));
wallet.get("/relay/quote", async (c) => {
  try { return c.json(await relayQuote({ from: c.req.query("from"), user: c.req.query("user"), recipient: c.req.query("recipient"), amount: c.req.query("amount") })); } catch (e) { return fail(c, e); }
});
wallet.post("/relay/permit", async (c) => {
  try { return c.json(await relayPermit(await c.req.json().catch(() => ({})))); } catch (e) { return fail(c, e); }
});
wallet.get("/relay/status/:id", async (c) => {
  try { return c.json(await relayStatus(c.req.param("id"))); } catch (e) { return fail(c, e); }
});

export function _resetWallet(): void {
  built.clear(); hits.clear(); balCache.clear(); balInflight.clear(); infoCache.clear(); priceCache.clear(); tapeCache.clear(); quoted.clear(); budgets.clear(); rentCache.clear();
  db?.close(); db = null; setWalletFetch(null);
}
export const _test = { built, messageHash, quoted };
