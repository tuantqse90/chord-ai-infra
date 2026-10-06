// Solana tools. Every read goes to NOWNodes (src/rpc/solana.ts): getBalance, getTokenAccountsByOwner, getSignaturesForAddress,
// getTransaction, getAccountInfo, getTokenLargestAccounts, getMultipleAccounts, getTokenSupply.
import { config, USDC_MINT } from "../config";
import { verifySolanaPayment } from "../payments";
import { rpc, rpcBatch } from "../rpc/solana";
import { short, solscan, ToolInputError, type Source, type Tool } from "../types";
import { parseTx, programName, summarize, type ParsedTx } from "./parse";
import { isPubkey, isSignature, KNOWN_MINTS, symbolsFor } from "./tokens";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TX_OPTS = { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" };

function needPubkey(v: unknown, what = "address"): string {
  const s = String(v ?? "").trim();
  if (!isPubkey(s)) throw new ToolInputError(`${what} must be a Solana base58 address`);
  return s;
}
function needSig(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!isSignature(s)) throw new ToolInputError("signature must be a Solana transaction signature (base58)");
  return s;
}

export async function getParsedTx(sig: string): Promise<ParsedTx | null> {
  return parseTx(await rpc("getTransaction", [sig, TX_OPTS]));
}

async function labelTx(tx: ParsedTx) {
  const syms = await symbolsFor(tx.tokenChanges.map((t) => t.mint));
  return {
    ...tx,
    programs: tx.programs.map((p) => ({ id: p, name: programName(p) })),
    tokenChanges: tx.tokenChanges.map((t) => ({ ...t, symbol: syms.get(t.mint)?.symbol ?? null })),
    time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
  };
}

const solWallet: Tool = {
  name: "sol_wallet",
  via: "NOWNodes Solana",
  label: "Reading the wallet",
  description: "A Solana wallet's SOL balance and SPL token holdings (Token and Token-2022), with symbols read from on-chain metadata.",
  parameters: { type: "object", properties: { address: { type: "string", description: "Wallet address (base58)" } }, required: ["address"] },
  async run(a) {
    const address = needPubkey(a.address);
    const [bal, t1, t2] = await Promise.all([
      rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]),
      rpc<{ value: any[] }>("getTokenAccountsByOwner", [address, { programId: TOKEN }, { encoding: "jsonParsed", commitment: "confirmed" }]),
      rpc<{ value: any[] }>("getTokenAccountsByOwner", [address, { programId: TOKEN22 }, { encoding: "jsonParsed", commitment: "confirmed" }]).catch(() => ({ value: [] })),
    ]);
    const holdings = [...(t1?.value ?? []), ...(t2?.value ?? [])]
      .map((x) => x.account.data.parsed.info)
      .map((i) => ({ mint: i.mint as string, amount: Number(i.tokenAmount.uiAmountString ?? i.tokenAmount.uiAmount ?? 0), decimals: i.tokenAmount.decimals as number }))
      .filter((h) => h.amount > 0)
      .sort((x, y) => y.amount - x.amount);
    const top = holdings.slice(0, 40);
    const syms = await symbolsFor(top.map((h) => h.mint));
    const rows = top.map((h) => ({ ...h, symbol: syms.get(h.mint)?.symbol ?? null, name: syms.get(h.mint)?.name ?? null }));
    const sol = (bal?.value ?? 0) / 1e9;
    return {
      data: { address, sol, tokenAccounts: holdings.length, holdings: rows, note: holdings.length > 40 ? `${holdings.length - 40} smaller holdings not shown` : undefined },
      sources: [{ kind: "account", id: address, label: `Wallet ${short(address)}`, url: solscan.account(address) }],
      summary: `${sol.toFixed(4)} SOL, ${holdings.length} token${holdings.length === 1 ? "" : "s"}`,
    };
  },
};

const solActivity: Tool = {
  name: "sol_activity",
  via: "NOWNodes Solana",
  label: "Reading recent transactions",
  description: "The latest transactions of a Solana address: time, success, programs used and what moved for this address (SOL and tokens).",
  parameters: { type: "object", properties: { address: { type: "string" }, limit: { type: "number", description: "1-15, default 8" } }, required: ["address"] },
  async run(a) {
    const address = needPubkey(a.address);
    const limit = Math.max(1, Math.min(15, Number(a.limit) || 8));
    const sigs = await rpc<{ signature: string; err: unknown; blockTime: number | null }[]>("getSignaturesForAddress", [address, { limit, commitment: "finalized" }]);
    const txs = await rpcBatch(sigs.map((s) => ({ method: "getTransaction", params: [s.signature, TX_OPTS] })));
    const parsed = txs.map(parseTx).filter((t): t is ParsedTx => !!t);
    const syms = await symbolsFor(parsed.flatMap((t) => t.tokenChanges.filter((c) => c.owner === address).map((c) => c.mint)));
    const rows = parsed.map((t) => ({
      signature: t.signature,
      time: t.blockTime ? new Date(t.blockTime * 1000).toISOString() : null,
      ok: t.ok,
      programs: t.programs.map((p) => programName(p) ?? short(p)).slice(0, 5),
      solChange: (t.solChanges.find((c) => c.account === address)?.sol ?? 0),
      tokenChanges: t.tokenChanges.filter((c) => c.owner === address).map((c) => ({ mint: c.mint, symbol: syms.get(c.mint)?.symbol ?? null, amount: c.amount })),
    }));
    return {
      data: { address, transactions: rows },
      sources: [{ kind: "account", id: address, label: `Wallet ${short(address)}`, url: solscan.account(address) },
        ...rows.slice(0, 6).map((r): Source => ({ kind: "tx", id: r.signature, label: `Tx ${short(r.signature)}`, url: solscan.tx(r.signature) }))],
      summary: `${rows.length} recent transaction${rows.length === 1 ? "" : "s"}`,
    };
  },
};

const solTx: Tool = {
  name: "sol_tx",
  via: "NOWNodes Solana",
  label: "Reading the transaction",
  description: "One Solana transaction by signature: status, fee, signers, programs, and every SOL and token balance change per owner.",
  parameters: { type: "object", properties: { signature: { type: "string" } }, required: ["signature"] },
  async run(a) {
    const sig = needSig(a.signature);
    const tx = await getParsedTx(sig);
    if (!tx) return { data: { signature: sig, found: false, note: "Not found as a finalized transaction (wrong signature, too new, or not landed)." }, sources: [], summary: "not found" };
    const out = await labelTx(tx);
    return {
      data: out,
      sources: [{ kind: "tx", id: sig, label: `Tx ${short(sig)}`, url: solscan.tx(sig) }],
      summary: summarize(tx, (m) => out.tokenChanges.find((t) => t.mint === m)?.symbol ?? null),
    };
  },
};

const solToken: Tool = {
  name: "sol_token",
  via: "NOWNodes Solana",
  label: "Reading the token",
  description: "A Solana token mint: supply, decimals, mint and freeze authority, name and symbol from metadata, and its 10 largest holders with their share of supply.",
  parameters: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] },
  async run(a) {
    const mint = needPubkey(a.mint, "mint");
    const [acc, largest, syms] = await Promise.all([
      rpc<{ value: any }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]),
      rpc<{ value: { address: string; uiAmount: number | null; amount: string }[] }>("getTokenLargestAccounts", [mint]).catch(() => null),
      symbolsFor([mint]),
    ]);
    const info = acc?.value?.data?.parsed?.info;
    if (!info || acc.value.data.parsed.type !== "mint") return { data: { mint, isMint: false }, sources: [], summary: "not a token mint" };
    const decimals = info.decimals as number;
    const supply = Number(BigInt(info.supply)) / 10 ** decimals;
    const ext = (info.extensions ?? []).find((e: any) => e.extension === "tokenMetadata")?.state;
    // Largest token accounts → their owners (one getMultipleAccounts), so concentration reads per wallet, not per account.
    const accts = (largest?.value ?? []).slice(0, 10);
    const owners = accts.length ? await rpc<{ value: any[] }>("getMultipleAccounts", [accts.map((x) => x.address), { encoding: "jsonParsed" }]).catch(() => null) : null;
    const holders = accts.map((x, i) => {
      const amt = x.uiAmount ?? Number(x.amount) / 10 ** decimals;
      return { tokenAccount: x.address, owner: owners?.value?.[i]?.data?.parsed?.info?.owner ?? null, amount: amt, pctSupply: supply > 0 ? +(100 * amt / supply).toFixed(3) : null };
    });
    const top10 = holders.reduce((s, h) => s + (h.pctSupply ?? 0), 0);
    const holdersKnown = !!largest;
    const known = KNOWN_MINTS[mint];
    return {
      data: {
        mint, program: acc.value.owner === TOKEN22 ? "Token-2022" : "SPL Token",
        symbol: known?.symbol ?? ext?.symbol ?? syms.get(mint)?.symbol ?? null, name: known?.name ?? ext?.name ?? syms.get(mint)?.name ?? null,
        decimals, supply, mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null,
        top10HoldersPct: holdersKnown ? +top10.toFixed(2) : null, holders,
        note: holdersKnown ? "Largest holders are token accounts; owners can be pools, programs or exchanges, not only people."
          : "The node did not return the largest holders for this mint (some RPCs refuse it for tokens with very many accounts).",
      },
      sources: [{ kind: "token", id: mint, label: `Token ${short(mint)}`, url: solscan.token(mint) }],
      summary: `supply ${supply.toLocaleString("en-US")}${holdersKnown ? `, top 10 hold ${top10.toFixed(1)}%` : ", holders unavailable"}`,
    };
  },
};

const solAccounts: Tool = {
  name: "sol_accounts",
  via: "NOWNodes Solana",
  label: "Reading accounts",
  description: "Up to 100 Solana accounts at once (getMultipleAccounts): SOL balance, owner program, executable, and the parsed type when known (token account, mint, etc.).",
  parameters: { type: "object", properties: { addresses: { type: "array", items: { type: "string" } } }, required: ["addresses"] },
  async run(a) {
    const list = (Array.isArray(a.addresses) ? a.addresses : []).map(String).filter(isPubkey).slice(0, 100);
    if (!list.length) throw new ToolInputError("addresses must hold at least one Solana address");
    const res = await rpc<{ value: any[] }>("getMultipleAccounts", [list, { encoding: "jsonParsed" }]);
    const rows = list.map((addr, i) => {
      const v = res?.value?.[i];
      if (!v) return { address: addr, exists: false };
      const parsed = v.data?.parsed;
      return { address: addr, exists: true, sol: v.lamports / 1e9, ownerProgram: v.owner, ownerName: programName(v.owner), executable: v.executable, type: parsed?.type ?? null,
        info: parsed?.type === "account" ? { mint: parsed.info.mint, owner: parsed.info.owner, amount: parsed.info.tokenAmount?.uiAmount } : undefined };
    });
    return { data: { accounts: rows }, sources: rows.slice(0, 8).map((r) => ({ kind: "account" as const, id: r.address, label: short(r.address), url: solscan.account(r.address) })), summary: `${rows.filter((r) => r.exists).length}/${rows.length} accounts exist` };
  },
};

const solVerifyPayment: Tool = {
  name: "sol_verify_payment",
  via: "NOWNodes Solana",
  label: "Verifying the payment",
  description: "Check whether a Solana transaction paid a recipient at least an amount of a token (default: this app's treasury, USDC, one ask). Reads the finalized transaction; never moves funds.",
  parameters: { type: "object", properties: {
    signature: { type: "string" }, recipient: { type: "string", description: "Wallet that should have received (default: treasury)" },
    mint: { type: "string", description: "Token mint (default USDC)" }, amount: { type: "number", description: "Minimum amount in whole tokens" },
  }, required: ["signature"] },
  async run(a) {
    const sig = needSig(a.signature);
    const recipient = a.recipient ? needPubkey(a.recipient, "recipient") : config.treasurySol();
    if (!recipient) throw new ToolInputError("no recipient given and no treasury configured");
    const mint = a.mint ? needPubkey(a.mint, "mint") : config.payMint();
    const min = Number(a.amount) > 0 ? Number(a.amount) : config.priceUsdc();
    const tx = await getParsedTx(sig);
    const v = verifySolanaPayment(tx, { recipient, mint, minUnits: min, symbol: mint === USDC_MINT ? "USDC" : undefined });
    return {
      data: { signature: sig, recipient, mint, minimum: min, ...v },
      sources: [{ kind: "tx", id: sig, label: `Tx ${short(sig)}`, url: solscan.tx(sig) }],
      summary: v.ok ? `paid ${v.paid} ${v.asset}` : `not valid: ${v.reason}`,
    };
  },
};

export const solanaTools: Tool[] = [solWallet, solActivity, solTx, solToken, solAccounts, solVerifyPayment];
