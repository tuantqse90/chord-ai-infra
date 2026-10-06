// Live check: every Solana tool once against the configured endpoint (NOWNodes when NOWNODES_API_KEY is set), latency per
// method, whether the endpoint takes JSON-RPC batches, and the Cardano tools when a key is set.
//   NOWNODES_API_KEY=… bun scripts/smoke.ts
//   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com bun scripts/smoke.ts   (before a key exists)
import { config, isNowNodes } from "../src/config";
import { cardanoTools } from "../src/cardano/tools";
import { ledger } from "../src/rpc/ledger";
import { rpc, rpcBatch } from "../src/rpc/solana";
import { solanaTools } from "../src/solana/tools";

const WALLET = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const SIG = "5zpWe5sy5Ph1pyK9tuUc1eQ2B933UjgqpBf29XyPzk4wq4mNyi1r9xyd3FDLoTnaUv9kwSieu7RrwBLCSQ1nJ3Tf";
const RECEIVER = "4azvt8Lo1pDmxhJ5FEJsAGX3fa1FwB51pgeA36ziaj41";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const url = config.solanaRpcUrl();
console.log(`Solana endpoint: ${new URL(url).host}${isNowNodes(url) ? (config.nownodesKey() ? " (NOWNodes, key set)" : " (NOWNodes, NO KEY: expect 422)") : " (not NOWNodes)"}`);

const pct = (xs: number[], p: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const lat: number[] = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  await rpc("getSlot", [{ commitment: "confirmed" }]).catch((e) => console.log("getSlot failed:", e.message));
  lat.push(performance.now() - t);
}
console.log(`getSlot ×10: p50 ${pct(lat, 0.5).toFixed(0)} ms, p95 ${pct(lat, 0.95).toFixed(0)} ms`);
const b = await rpcBatch([{ method: "getSlot", params: [] }, { method: "getBlockHeight", params: [] }]).catch((e) => e.message);
console.log("batch of 2:", JSON.stringify(b));

const args: Record<string, Record<string, unknown>> = {
  sol_wallet: { address: WALLET },
  sol_activity: { address: WALLET, limit: 5 },
  sol_tx: { signature: SIG },
  sol_token: { mint: BONK },
  sol_accounts: { addresses: [WALLET, RECEIVER, BONK] },
  sol_verify_payment: { signature: SIG, recipient: RECEIVER, amount: 9 },
};
for (const t of solanaTools) {
  const t0 = performance.now();
  try {
    const r = await t.run(args[t.name] ?? {});
    console.log(`✓ ${t.name.padEnd(20)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms  ${r.summary}`);
  } catch (e) {
    console.log(`✗ ${t.name.padEnd(20)} ${(e as Error).message}`);
  }
}

const adaAddr = process.env.CARDANO_SAMPLE_ADDRESS;
if (config.nownodesKey() && adaAddr) {
  for (const t of cardanoTools.filter((x) => x.name === "ada_address")) {
    const t0 = performance.now();
    try { const r = await t.run({ address: adaAddr }); console.log(`✓ ${t.name.padEnd(20)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms  ${r.summary}`); }
    catch (e) { console.log(`✗ ${t.name.padEnd(20)} ${(e as Error).message}`); }
  }
} else console.log("Cardano: skipped (needs NOWNODES_API_KEY and CARDANO_SAMPLE_ADDRESS)");

console.log("\nCalls by method:");
for (const m of ledger().methods) console.log(`  ${m.provider}:${m.method.padEnd(26)} ${String(m.calls).padStart(3)} calls  avg ${m.avgMs} ms  max ${m.maxMs} ms  errors ${m.errors}`);
