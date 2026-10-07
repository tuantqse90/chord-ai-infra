// The Solana wallet routes (src/walletRoutes.ts), offline: a fake Solana RPC (rpc/solana transport) and a fake HTTP for
// Jupiter, Relay and Chord's tape. Real transactions are built and decoded; nothing reaches a network.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { setSolanaFetch } from "../src/rpc/solana";
import {
  _resetWallet, _test, activityOf, ata, ATA_PROGRAM, balances, buildWithdraw, cleanText, relayPermit, relayQuote, relayStatus, sendWithdraw,
  setWalletFetch, SOL_MINT, TOKEN_2022, TOKEN_PROGRAM, wallet,
} from "../src/walletRoutes";

let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "wallet-")); process.env.DB_PATH = join(dir, "w.db"); });
afterAll(() => { _resetWallet(); rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { _resetWallet(); setSolanaFetch(null); });

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const addr = () => Keypair.generate().publicKey.toBase58();
const tokenAcc = (pubkey: string, mint: string, amount: string, decimals: number, owner = TOKEN_PROGRAM, state = "initialized") =>
  ({ pubkey, account: { owner, data: { parsed: { info: { mint, tokenAmount: { amount, decimals }, state } } } } });

type Handler = (params: any[]) => unknown;
/** A Solana RPC that answers from `h` by method and counts every call. */
function fakeRpc(h: Record<string, Handler>) {
  const calls: { method: string; params: any[] }[] = [];
  setSolanaFetch(async (_u, init) => {
    const b = JSON.parse(String(init?.body));
    const one = (x: any) => {
      calls.push({ method: x.method, params: x.params });
      const f = h[x.method];
      if (!f) return { jsonrpc: "2.0", id: x.id, error: { code: -32601, message: `no ${x.method}` } };
      return { jsonrpc: "2.0", id: x.id, result: f(x.params) };
    };
    return json(Array.isArray(b) ? b.map(one) : one(b));
  });
  return calls;
}
/** Jupiter / Relay / Chord answered by URL. */
function fakeHttp(f: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; init?: RequestInit }[] = [];
  setWalletFetch(async (u, init) => { seen.push({ url: u, init }); return f(u, init); });
  return seen;
}

describe("names from anyone who mints", () => {
  it("drops control, zero-width and bidi-override characters, caps the length", () => {
    expect(cleanText("‮46OIRAM", 24)).toBe("46OIRAM");
    expect(cleanText("BO​NK\n", 24)).toBe("BONK");
    expect(cleanText("x".repeat(40), 24)).toHaveLength(24);
    expect(cleanText("   ", 24)).toBeNull();
    expect(cleanText(7, 24)).toBeNull();
  });
});

describe("balances", () => {
  it("SOL + both token programs, summed per mint, priced, sorted by value, unpriced last, cached 15 s", async () => {
    const owner = addr(), odd = addr();
    const calls = fakeRpc({
      getBalance: () => ({ value: 2_500_000_000 }),
      getTokenAccountsByOwner: (p) => ({ value: p[1].programId === TOKEN_PROGRAM
        ? [tokenAcc(addr(), USDC, "3000000", 6), tokenAcc(addr(), USDC, "2000000", 6), tokenAcc(addr(), BONK, "100000000", 5), tokenAcc(addr(), BONK, "0", 5)]
        : [tokenAcc(addr(), odd, "42", 0, TOKEN_2022)] }),
      getMultipleAccounts: (p) => ({ value: p[0].map(() => null) }),
    });
    const http = fakeHttp((u) => {
      if (u.includes("/tokens/v2/search")) return json([{ id: USDC, symbol: "USDC", name: "USD Coin", icon: "https://x.test/usdc.png" }, { id: BONK, symbol: "‮Bonk", name: "Bonk", icon: "http://insecure.test/b.png" }]);
      if (u.includes("/price/v3")) return json({ [SOL_MINT]: { usdPrice: 100, priceChange24h: -2 }, [USDC]: { usdPrice: 1, priceChange24h: 0 }, [BONK]: { usdPrice: 0.00002, priceChange24h: 10 } });
      return json({}, 404);
    });
    const b = await balances(owner);
    expect(b.sol).toMatchObject({ lamports: "2500000000", amount: "2.5", priceUsd: 100, valueUsd: 250, change24h: -2 });
    expect(b.tokens.map((t) => t.symbol)).toEqual(["USDC", "Bonk", `${odd.slice(0, 4)}…`]);
    const [usdc, bonk, unknown] = b.tokens;
    expect(usdc).toMatchObject({ mint: USDC, raw: "5000000", amount: "5", valueUsd: 5, accounts: 2, program: "token", logo: "https://x.test/usdc.png" });
    expect(bonk).toMatchObject({ amount: "1000", valueUsd: 0.02, change24h: 10, logo: `/v1/logo/solana/${BONK}` }); // only https icons pass
    expect(unknown).toMatchObject({ priceUsd: null, valueUsd: null, program: "token-2022", logo: `/v1/logo/solana/${odd}` });
    expect(b.totalUsd).toBeCloseTo(255.02, 6);
    expect(b.change24hUsd!).toBeCloseTo(250 - 250 / 0.98 + (0.02 - 0.02 / 1.1), 6);
    expect(b.unpriced).toBe(1);
    const before = calls.length, httpBefore = http.length;
    await balances(owner);
    expect(calls.length).toBe(before);
    expect(http.length).toBe(httpBefore);
  });
  it("route: a bad address is a 400, a good one answers the shape", async () => {
    fakeRpc({ getBalance: () => ({ value: 0 }), getTokenAccountsByOwner: () => ({ value: [] }) });
    fakeHttp((u) => (u.includes("/price/v3") ? json({ [SOL_MINT]: { usdPrice: 100 } }) : json([])));
    expect((await wallet.request("/solana/not-an-address")).status).toBe(400);
    const r = await wallet.request(`/solana/${addr()}`);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j).toMatchObject({ tokens: [], totalUsd: 0, unpriced: 0, truncated: 0 });
    expect(typeof j.at).toBe("number");
  });
});

// a withdraw world: balance, recipient, mint, token accounts, rent, blockhash, simulation
function withdrawWorld(o: { from: string; to: string; lamports: number; toAcc?: unknown; mintAcc?: unknown; srcAccs?: unknown[]; destAcc?: unknown; simErr?: unknown; logs?: string[] }) {
  return fakeRpc({
    getBalance: () => ({ value: o.lamports }),
    getAccountInfo: (p) => ({ value: p[0] === o.to ? o.toAcc ?? null : p[1]?.encoding === "jsonParsed" && o.mintAcc && (o.mintAcc as any).__mint === p[0] ? o.mintAcc : o.destAcc ?? null }),
    getRecentPrioritizationFees: () => [{ prioritizationFee: 0 }, { prioritizationFee: 60_000 }],
    getMinimumBalanceForRentExemption: (p) => (p[0] + 128) * 6960, // 0 bytes → 890,880 lamports; 165 → 2,039,280
    getTokenAccountsByOwner: () => ({ value: o.srcAccs ?? [] }),
    getLatestBlockhash: () => ({ value: { blockhash: addr(), lastValidBlockHeight: 1234 } }),
    simulateTransaction: () => ({ value: { err: o.simErr ?? null, logs: o.logs ?? [], unitsConsumed: 450 } }),
  });
}
const prices = () => fakeHttp((u) => (u.includes("/price/v3") ? json({ [SOL_MINT]: { usdPrice: 100 }, [USDC]: { usdPrice: 1 } }) : u.includes("/tokens/v2/search") ? json([{ id: USDC, symbol: "USDC", name: "USD Coin" }]) : json({}, 404)));
const decode = (b64: string) => VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
const ixOf = (tx: VersionedTransaction) => tx.message.compiledInstructions.map((ix) => ({
  program: tx.message.staticAccountKeys[ix.programIdIndex].toBase58(), data: Buffer.from(ix.data), keys: ix.accountKeyIndexes.map((k) => tx.message.staticAccountKeys[k].toBase58()),
}));

describe("withdraw build", () => {
  it("SOL: compute budget + one system transfer paid by the sender, simulated, remembered for the relay", async () => {
    const from = addr(), to = addr();
    const calls = withdrawWorld({ from, to, lamports: 1_000_000_000, toAcc: { owner: SystemProgram.programId.toBase58(), executable: false, lamports: 5 } });
    prices();
    const r = await buildWithdraw({ from, to, mint: "SOL", amount: "0.25" });
    expect(r.summary).toMatchObject({ kind: "sol", amount: "0.25", amountRaw: "250000000", symbol: "SOL", createsAccount: false, program: "system", valueUsd: 25, warnings: [] });
    const tx = decode(r.transaction);
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(from);
    const ixs = ixOf(tx);
    expect(ixs.map((i) => i.program)).toEqual([ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), SystemProgram.programId.toBase58()]);
    const xfer = ixs[2];
    expect(xfer.data.readUInt32LE(0)).toBe(2);
    expect(xfer.data.readBigUInt64LE(4)).toBe(250_000_000n);
    expect(xfer.keys).toEqual([from, to]);
    expect(Number(r.summary.feeLamports)).toBe(5_000 + Math.ceil((1_000 * 60_000) / 1e6));
    expect(calls.some((c) => c.method === "simulateTransaction" && c.params[1].sigVerify === false)).toBe(true);
    expect(_test.built.has(_test.messageHash(tx))).toBe(true);
  });
  it("SOL: refuses what the chain would refuse, in words", async () => {
    const from = addr(), to = addr();
    withdrawWorld({ from, to, lamports: 100_000_000 });
    prices();
    await expect(buildWithdraw({ from, to: from, mint: "SOL", amount: "0.01" })).rejects.toThrow("That is this wallet.");
    await expect(buildWithdraw({ from, to: "0xabc", mint: "SOL", amount: "0.01" })).rejects.toThrow("not a Solana address");
    await expect(buildWithdraw({ from, to, mint: "SOL", amount: "0.0001" })).rejects.toThrow("A new address needs at least 0.00089088 SOL");
    await expect(buildWithdraw({ from, to, mint: "SOL", amount: "0.2" })).rejects.toThrow("More than the");
    await expect(buildWithdraw({ from, to, mint: "SOL", amount: "0.0995" })).rejects.toThrow("under Solana's 0.00089088 SOL minimum");
    await expect(buildWithdraw({ from, to, mint: "SOL", amount: "-1" })).rejects.toThrow("positive number");
  });
  it("refuses a token account or a program as the destination", async () => {
    const from = addr(), to = addr();
    withdrawWorld({ from, to, lamports: 1e9, toAcc: { owner: TOKEN_PROGRAM, executable: false, lamports: 2e6 } });
    prices();
    await expect(buildWithdraw({ from, to, mint: "SOL", amount: "0.1" })).rejects.toThrow("token account");
    withdrawWorld({ from, to, lamports: 1e9, toAcc: { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true, lamports: 1 } });
    await expect(buildWithdraw({ from, to, mint: "SOL", amount: "0.1" })).rejects.toThrow("program");
  });
  it("SPL (Token-2022): opens the recipient's account when missing, transferChecked from the biggest account, warns about a transfer fee", async () => {
    const from = addr(), to = addr(), mint = addr(), src = addr();
    const mintAcc = { __mint: mint, owner: TOKEN_2022, data: { parsed: { type: "mint", info: { decimals: 6, extensions: [{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 100 } } }] } } } };
    withdrawWorld({ from, to, lamports: 50_000_000, mintAcc, srcAccs: [tokenAcc(addr(), mint, "1000", 6, TOKEN_2022), tokenAcc(src, mint, "7000000", 6, TOKEN_2022)] });
    prices();
    const r = await buildWithdraw({ from, to, mint, amount: "5" });
    const dest = ata(to, mint, TOKEN_2022);
    expect(r.summary).toMatchObject({ kind: "spl", amount: "5", amountRaw: "5000000", decimals: 6, createsAccount: true, destinationAccount: dest, program: "token-2022", rentLamports: String((182 + 128) * 6960) });
    expect(r.summary.warnings[0]).toContain("1.00%");
    const ixs = ixOf(decode(r.transaction));
    const create = ixs.find((i) => i.program === ATA_PROGRAM)!;
    expect([...create.data]).toEqual([1]); // CreateIdempotent
    expect(create.keys).toEqual([from, dest, to, mint, SystemProgram.programId.toBase58(), TOKEN_2022]);
    const xfer = ixs.find((i) => i.program === TOKEN_2022)!;
    expect(xfer.data[0]).toBe(12); // TransferChecked
    expect(xfer.data.readBigUInt64LE(1)).toBe(5_000_000n);
    expect(xfer.data[9]).toBe(6);
    expect(xfer.keys).toEqual([src, mint, dest, from]);
  });
  it("SPL: an existing recipient account is reused; too little SOL for the fee + rent is said up front; a failed simulation is a 422", async () => {
    const from = addr(), to = addr();
    const mintAcc = { __mint: USDC, owner: TOKEN_PROGRAM, data: { parsed: { type: "mint", info: { decimals: 6 } } } };
    withdrawWorld({ from, to, lamports: 1_000_000_000, mintAcc, srcAccs: [tokenAcc(addr(), USDC, "9000000", 6)], destAcc: { data: { parsed: { info: { state: "initialized" } } } } });
    prices();
    const r = await buildWithdraw({ from, to, mint: USDC, amount: "9" });
    expect(r.summary).toMatchObject({ createsAccount: false, rentLamports: "0", symbol: "USDC", valueUsd: 9 });
    expect(ixOf(decode(r.transaction)).some((i) => i.program === ATA_PROGRAM)).toBe(false);
    await expect(buildWithdraw({ from, to, mint: USDC, amount: "9.5" })).rejects.toThrow("More than the 9 you hold");
    withdrawWorld({ from, to, lamports: 1_000_000, mintAcc, srcAccs: [tokenAcc(addr(), USDC, "9000000", 6)] });
    await expect(buildWithdraw({ from, to, mint: USDC, amount: "1" })).rejects.toThrow("to open the recipient's account");
    withdrawWorld({ from, to, lamports: 1e9, mintAcc, srcAccs: [tokenAcc(addr(), USDC, "9000000", 6)], simErr: { InstructionError: [2, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds"] });
    const e = await buildWithdraw({ from, to, mint: USDC, amount: "1" }).catch((x) => x);
    expect(e.status).toBe(422);
    expect(e.message).toContain("Not enough balance");
  });
  it("SPL: refuses a non-transferable token and one that runs a transfer hook", async () => {
    const from = addr(), to = addr(), mint = addr();
    const m = (ext: unknown) => ({ __mint: mint, owner: TOKEN_2022, data: { parsed: { type: "mint", info: { decimals: 0, extensions: [ext] } } } });
    withdrawWorld({ from, to, lamports: 1e9, mintAcc: m({ extension: "nonTransferable" }) });
    prices();
    await expect(buildWithdraw({ from, to, mint, amount: "1" })).rejects.toThrow("non-transferable");
    withdrawWorld({ from, to, lamports: 1e9, mintAcc: m({ extension: "transferHook", state: { programId: addr() } }) });
    await expect(buildWithdraw({ from, to, mint, amount: "1" })).rejects.toThrow("transfer hooks");
  });
});

describe("limits", () => {
  it("builds are capped per caller per minute (each one costs several RPC calls)", async () => {
    const post = (ip: string) => wallet.request("/solana/withdraw/build", { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": ip }, body: "{}" });
    for (let i = 0; i < 30; i++) expect((await post("1.1.1.1")).status).toBe(400);
    expect((await post("1.1.1.1")).status).toBe(429);
    expect((await post("2.2.2.2")).status).toBe(400);
  });
});

describe("withdraw send", () => {
  async function builtFor(payer: Keypair) {
    const to = addr();
    withdrawWorld({ from: payer.publicKey.toBase58(), to, lamports: 1e9, toAcc: { owner: SystemProgram.programId.toBase58(), executable: false, lamports: 1 } });
    prices();
    return { to, r: await buildWithdraw({ from: payer.publicKey.toBase58(), to, mint: "SOL", amount: "0.1" }) };
  }
  it("relays only what it built, signed by the sender, and records the send", async () => {
    const payer = Keypair.generate();
    const { to, r } = await builtFor(payer);
    const tx = decode(r.transaction);
    await expect(sendWithdraw(r.transaction)).rejects.toThrow("not signed");
    tx.signatures[0] = new Uint8Array(64).fill(7);
    await expect(sendWithdraw(Buffer.from(tx.serialize()).toString("base64"))).rejects.toThrow("signature does not match");
    tx.sign([payer]);
    let sent: any = null;
    const SIG = "5".repeat(88);
    setSolanaFetch(async (_u, init) => { const b = JSON.parse(String(init?.body)); sent = b; return json({ jsonrpc: "2.0", id: 1, result: SIG }); });
    expect(await sendWithdraw(Buffer.from(tx.serialize()).toString("base64"))).toEqual({ signature: SIG });
    expect(sent.method).toBe("sendTransaction");
    const rows = activityOf(payer.publicKey.toBase58());
    expect(rows[0]).toMatchObject({ ref: SIG, kind: "send", symbol: "SOL", amount: "0.1", counterparty: to, status: "sent" });
    // built once, relayed once
    await expect(sendWithdraw(Buffer.from(tx.serialize()).toString("base64"))).rejects.toThrow("only relays transfers it prepared");
  });
  it("refuses a transaction it never built", async () => {
    const payer = Keypair.generate();
    const { r } = await builtFor(payer);
    _resetWallet();
    const tx = decode(r.transaction);
    tx.sign([payer]);
    const e = await sendWithdraw(Buffer.from(tx.serialize()).toString("base64")).catch((x) => x);
    expect(e.status).toBe(403);
    await expect(sendWithdraw("bm90IGEgdHg=")).rejects.toThrow();
  });
});

// ── Relay ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const REQ = `0x${"ab".repeat(32)}`;
function relayAnswer(o: { chainId?: number; token?: string; amount?: string; outCurrency?: string; steps?: unknown[]; recipient: string }) {
  const chainId = o.chainId ?? 8453;
  return {
    requestId: REQ,
    steps: o.steps ?? [{ id: "authorize1", kind: "signature", items: [{ status: "incomplete", data: { sign: { signatureKind: "eip712", domain: { name: "USD Coin", version: "2", chainId, verifyingContract: o.token ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, types: {}, primaryType: "ReceiveWithAuthorization", value: {} }, post: { endpoint: "/execute/permits", method: "POST", body: { kind: "eip3009", requestId: REQ, api: "swap" } } }, check: { endpoint: `/intents/status/v3?requestId=${REQ}` } }] }],
    fees: { gas: { amountUsd: "0" }, relayer: { amountUsd: "0.028" }, app: { amountUsd: "0" } },
    details: {
      sender: USER, recipient: o.recipient, timeEstimate: 1, totalImpact: { percent: "-0.14" },
      currencyIn: { currency: { chainId, address: (o.token ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").toLowerCase() }, amount: o.amount ?? "20000000" },
      currencyOut: { currency: { chainId: 792703809, address: o.outCurrency ?? USDC }, amount: "19971553", minimumAmount: "19771838", amountUsd: "19.969" },
    },
  };
}

describe("Relay deposits", () => {
  it("quote: asks for USDC on Solana with a permit, checks the answer, reduces it to what the page shows", async () => {
    const recipient = addr();
    const seen = fakeHttp(() => json(relayAnswer({ recipient })));
    const q = await relayQuote({ from: "base", user: USER, recipient, amount: "20" });
    expect(q).toMatchObject({ requestId: REQ, chain: { key: "base", chainId: 8453 }, amountIn: "20", amountInRaw: "20000000", receive: "19.971553", minReceive: "19.771838",
      signatureOnly: true, txCount: 0, seconds: 1, impactPct: -0.14, fees: { relayerUsd: 0.028, gasUsd: 0, totalUsd: 0.028 } });
    const body = JSON.parse(String(seen[0].init?.body));
    expect(seen[0].url).toBe("https://api.relay.link/quote/v2");
    expect(body).toMatchObject({ user: USER, recipient, originChainId: 8453, destinationChainId: 792703809, destinationCurrency: USDC, amount: "20000000", usePermit: true, refundTo: USER, tradeType: "EXACT_INPUT" });
    expect(body.referrer).toBeUndefined(); // keyless quotes with a referrer are refused by Relay
  });
  it("quote: BNB Chain USDC has 18 decimals and an approval before the signature (not 'no gas')", async () => {
    const recipient = addr(), token = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
    const ans = relayAnswer({ recipient, chainId: 56, token, amount: "20000000000000000000" });
    ans.steps.unshift({ id: "approve", kind: "transaction", items: [{ status: "incomplete", data: { from: USER, to: token, data: "0x095ea7b3" + "0".repeat(128), value: "0", chainId: 56 } }] } as any);
    fakeHttp(() => json(ans));
    const q = await relayQuote({ from: "bnb", user: USER, recipient, amount: "20" });
    expect(q).toMatchObject({ amountInRaw: "20000000000000000000", signatureOnly: false, txCount: 1 });
  });
  it("quote: a route other than the one asked is refused", async () => {
    const recipient = addr();
    fakeHttp(() => json(relayAnswer({ recipient, outCurrency: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" })));
    expect((await relayQuote({ from: "base", user: USER, recipient, amount: "20" }).catch((e) => e)).status).toBe(502);
    fakeHttp(() => json(relayAnswer({ recipient: addr() })));
    await expect(relayQuote({ from: "base", user: USER, recipient, amount: "20" })).rejects.toThrow("recipient");
    fakeHttp(() => json(relayAnswer({ recipient, amount: "1" })));
    await expect(relayQuote({ from: "base", user: USER, recipient, amount: "20" })).rejects.toThrow("amount");
    const bad = relayAnswer({ recipient });
    bad.steps.unshift({ id: "approve", kind: "transaction", items: [{ status: "incomplete", data: { to: "0x000000000000000000000000000000000000dEaD", data: "0x095ea7b3", chainId: 8453 } }] } as any);
    fakeHttp(() => json(bad));
    await expect(relayQuote({ from: "base", user: USER, recipient, amount: "20" })).rejects.toThrow("approval");
  });
  it("quote: bad input is a 400 before Relay is asked; a too-small amount reads as such", async () => {
    const seen = fakeHttp(() => json({ errorCode: "AMOUNT_TOO_LOW", message: "Amount too low" }, 400));
    await expect(relayQuote({ from: "fantom", user: USER, recipient: addr(), amount: "1" })).rejects.toThrow("from must be one of");
    await expect(relayQuote({ from: "base", user: "0x1", recipient: addr(), amount: "1" })).rejects.toThrow("EVM address");
    await expect(relayQuote({ from: "base", user: USER, recipient: USER, amount: "1" })).rejects.toThrow("Solana address");
    expect(seen.length).toBe(0);
    await expect(relayQuote({ from: "base", user: USER, recipient: addr(), amount: "0.01" })).rejects.toThrow("too small to cover the bridge fees");
  });
  it("permit: only for a deposit quoted here; forwards the signature in the query; records the deposit; status settles it", async () => {
    const recipient = addr();
    fakeHttp(() => json(relayAnswer({ recipient })));
    const sig = `0x${"11".repeat(65)}`;
    expect((await relayPermit({ requestId: `0x${"cd".repeat(32)}`, kind: "eip3009", api: "swap", signature: sig }).catch((e) => e)).status).toBe(410);
    await relayQuote({ from: "base", user: USER, recipient, amount: "20" });
    const seen = fakeHttp((u) => (u.includes("/execute/permits") ? json({ message: "ok" }) : json({ status: "success", inTxHashes: ["0xin"], txHashes: ["sol-out"] })));
    await expect(relayPermit({ requestId: REQ, kind: "eip3009", api: "swap", signature: "nope" })).rejects.toThrow("signature");
    expect(await relayPermit({ requestId: REQ, kind: "eip3009", api: "swap", signature: sig })).toEqual({ ok: true });
    expect(seen[0].url).toBe(`https://api.relay.link/execute/permits?signature=${sig}`);
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ kind: "eip3009", requestId: REQ, api: "swap" });
    expect(activityOf(recipient)[0]).toMatchObject({ ref: REQ, kind: "deposit", symbol: "USDC", amount: "19.971553", chain: "base", status: "pending" });
    expect(await relayStatus(REQ)).toEqual({ requestId: REQ, status: "success", inTx: ["0xin"], outTx: ["sol-out"] });
    expect(activityOf(recipient)[0].status).toBe("success");
    await expect(relayStatus("0x12")).rejects.toThrow("requestId");
  });
});

describe("activity", () => {
  it("the wallet's swaps from Chord's tape + what was sent here, newest first; a tape outage is said, not hidden", async () => {
    const payer = Keypair.generate(), w = payer.publicKey.toBase58();
    const to = addr();
    withdrawWorld({ from: w, to, lamports: 1e9, toAcc: { owner: SystemProgram.programId.toBase58(), executable: false, lamports: 1 } });
    prices();
    const r = await buildWithdraw({ from: w, to, mint: "SOL", amount: "0.1" });
    const tx = decode(r.transaction); tx.sign([payer]);
    setSolanaFetch(async () => json({ jsonrpc: "2.0", id: 1, result: "4".repeat(88) }));
    await sendWithdraw(Buffer.from(tx.serialize()).toString("base64"));
    const now = Math.floor(Date.now() / 1000);
    const seen = fakeHttp((u) => (u.includes(`/v1/chains/solana/wallet/${w}/trades`) ? json({ trades: [
      { ts: now - 60, side: "buy", token: BONK, symbol: "Bonk", tokenAmount: 1000, usd: 12.5, dex: "pumpswap", tx: "6".repeat(88) },
      { ts: now + 60, side: "sell", token: USDC, symbol: "USDC", tokenAmount: 3, usd: 3, dex: "meteora_dlmm", tx: "7".repeat(88) },
      { ts: "bad", side: "buy", token: BONK, tx: "x" },
    ] }) : json({}, 404)));
    const j: any = await (await wallet.request(`/solana/${w}/activity`)).json();
    expect(seen[0].url).toContain("limit=30");
    expect(j.swapsError).toBeNull();
    expect(j.items.map((x: any) => x.kind)).toEqual(["swap", "send", "swap"]);
    expect(j.items[1]).toMatchObject({ kind: "send", symbol: "SOL", amount: 0.1, counterparty: to, status: "sent" });
    _resetWallet();
    fakeHttp(() => json({}, 503));
    const k: any = await (await wallet.request(`/solana/${w}/activity`)).json();
    expect(k.swapsError).toContain("503");
    expect(k.items.map((x: any) => x.kind)).toEqual(["send"]);
  });
});
