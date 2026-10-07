// Read-only proof of auto-trade's pre-sign checks (src/autoTrade.ts) on REAL Jupiter swaps: quote + build for a public wallet
// with wrapAndUnwrapSol false, the instruction allowlist + destination check, Jupiter's mint / freeze audit, and a simulation
// on a public RPC with sigVerify false. No key, no signature, nothing is sent.
//   bun scripts/auto-trade-check.ts [wallet] [usd] [outMint …]
// The wallet must hold that much USDC and a little SOL for the simulation to pass (the guard runs either way).
import { VersionedTransaction } from "@solana/web3.js";
import { ALLOWED_PROGRAMS, checkSwapTx } from "../src/autoTrade";
import { tokenInfo } from "../src/bots/market";
import { USDC_MINT } from "../src/config";
import { solBuild, solQuote } from "../src/trade/solana";

const SOL = "So11111111111111111111111111111111111111112";
const [wallet = "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", usd = "1", ...outs] = process.argv.slice(2);
const SIM_RPC = (process.env.SIM_RPC_URL ?? "").trim() || "https://api.mainnet-beta.solana.com";

async function simulate(b64: string) {
  const r = await fetch(SIM_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }] }) });
  const j = (await r.json()) as any;
  return j.error ? { err: j.error.message, units: null, logs: [] } : { err: j.result?.value?.err ?? null, units: j.result?.value?.unitsConsumed ?? null, logs: j.result?.value?.logs ?? [] };
}

console.log(`wallet ${wallet} · $${usd} USDC → ${outs.length ? outs.join(", ") : "SOL"} · allowlist ${ALLOWED_PROGRAMS.join(", ")}`);
let bad = 0;
for (const out of outs.length ? outs : [SOL]) {
  const info = await tokenInfo(out).catch((e) => { console.log(`  audit: ${e.message}`); return null; });
  console.log(`\n${info?.symbol ?? out}: audit mintAuthorityDisabled=${info?.mintAuthorityDisabled} freezeAuthorityDisabled=${info?.freezeAuthorityDisabled}`);
  const q = await solQuote(USDC_MINT, out, usd, 100);
  console.log(`  quote: ${q.amountIn} ${q.tokenIn.symbol} → ${q.amountOut} ${q.tokenOut.symbol} via ${q.route.join(" › ")}`);
  const built = await solBuild(q.quoteId, wallet, { wrapAndUnwrapSol: false });
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  console.log(`  top-level programs: ${tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]).join(", ")}`);
  try {
    const c = checkSwapTx(built.transaction, { wallet, inMint: USDC_MINT, outMint: out });
    console.log(`  guard: PASS · ${c.swap} · output to ${c.destination} · fee payer ${c.feePayer} · priority ${c.priorityLamports} lamports`);
  } catch (e) { bad++; console.log(`  guard: REFUSED · ${(e as Error).message}`); }
  const sim = await simulate(built.transaction);
  console.log(`  simulation on ${new URL(SIM_RPC).host}: ${sim.err == null ? "OK" : `FAILED ${JSON.stringify(sim.err)}`}${sim.units ? ` · ${sim.units} CU` : ""}`);
  if (sim.err != null) console.log(sim.logs.slice(-6).map((l: string) => `    ${l}`).join("\n"));
}
process.exit(bad ? 1 : 0);
