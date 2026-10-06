// A finalized Solana transaction (getTransaction, encoding jsonParsed) reduced to what a person asks about: did it land,
// who signed, what it cost, and what moved — SOL per account and tokens per (owner, mint), from pre/post balances.
// Balances, not instruction decoding: it is exact for every program, including ones this app has never heard of.

export type SolChange = { account: string; lamports: string; sol: number };
export type TokenChange = { owner: string; mint: string; raw: string; amount: number; decimals: number };
export type ParsedTx = {
  signature: string;
  slot: number;
  blockTime: number | null;
  ok: boolean;
  error: string | null;
  feeLamports: number;
  feePayer: string;
  signers: string[];
  programs: string[];
  actions: string[];
  solChanges: SolChange[];
  tokenChanges: TokenChange[];
};

const KNOWN_PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "System",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
};
export const programName = (id: string) => KNOWN_PROGRAMS[id] ?? null;

const big = (s: string | number | undefined) => BigInt(s ?? 0);
const toUnits = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

export function parseTx(result: any): ParsedTx | null {
  if (!result?.transaction || !result?.meta) return null;
  const msg = result.transaction.message;
  const meta = result.meta;
  const keys: { pubkey: string; signer: boolean }[] = (msg.accountKeys ?? []).map((k: any) =>
    typeof k === "string" ? { pubkey: k, signer: false } : { pubkey: k.pubkey, signer: !!k.signer });

  const solChanges: SolChange[] = [];
  (meta.preBalances ?? []).forEach((pre: number, i: number) => {
    const d = big(meta.postBalances?.[i]) - big(pre);
    if (d !== 0n && keys[i]) solChanges.push({ account: keys[i].pubkey, lamports: d.toString(), sol: Number(d) / 1e9 });
  });

  // Token balances are keyed by token account; fold them to (owner, mint) so "who received what" reads directly.
  const tok = new Map<string, { owner: string; mint: string; decimals: number; raw: bigint }>();
  const add = (b: any, sign: 1n | -1n) => {
    const owner = b.owner ?? keys[b.accountIndex]?.pubkey ?? "unknown";
    const k = `${owner}|${b.mint}`;
    const cur = tok.get(k) ?? { owner, mint: b.mint, decimals: b.uiTokenAmount?.decimals ?? 0, raw: 0n };
    cur.raw += sign * big(b.uiTokenAmount?.amount);
    tok.set(k, cur);
  };
  for (const b of meta.postTokenBalances ?? []) add(b, 1n);
  for (const b of meta.preTokenBalances ?? []) add(b, -1n);
  const tokenChanges = [...tok.values()]
    .filter((t) => t.raw !== 0n)
    .map((t) => ({ owner: t.owner, mint: t.mint, raw: t.raw.toString(), amount: toUnits(t.raw, t.decimals), decimals: t.decimals }));

  const programs = new Set<string>();
  const actions: string[] = [];
  const walk = (ix: any) => {
    if (ix?.programId) programs.add(ix.programId);
    const p = ix?.parsed;
    if (p && typeof p === "object" && p.type) actions.push(`${ix.program ?? programName(ix.programId) ?? ix.programId}:${p.type}`);
  };
  for (const ix of msg.instructions ?? []) walk(ix);
  for (const inner of meta.innerInstructions ?? []) for (const ix of inner.instructions ?? []) walk(ix);

  return {
    signature: result.transaction.signatures?.[0] ?? "",
    slot: result.slot,
    blockTime: result.blockTime ?? null,
    ok: meta.err == null,
    error: meta.err == null ? null : JSON.stringify(meta.err),
    feeLamports: meta.fee ?? 0,
    feePayer: keys[0]?.pubkey ?? "",
    signers: keys.filter((k) => k.signer).map((k) => k.pubkey),
    programs: [...programs].filter((p) => p !== "ComputeBudget111111111111111111111111111111"),
    actions: [...new Set(actions)].slice(0, 20),
    solChanges,
    tokenChanges,
  };
}

/** One line a model can quote: "+9.435174 USDC to 4azv…" style facts for the step card. */
export function summarize(tx: ParsedTx, symbolOf: (mint: string) => string | null = () => null): string {
  if (!tx.ok) return `failed (${tx.error})`;
  const moves = tx.tokenChanges.filter((t) => t.amount > 0).slice(0, 3)
    .map((t) => `+${t.amount} ${symbolOf(t.mint) ?? t.mint.slice(0, 4) + "…"} to ${t.owner.slice(0, 4)}…`);
  return moves.length ? moves.join(", ") : `${tx.actions.slice(0, 2).join(", ") || "no token movement"}`;
}
