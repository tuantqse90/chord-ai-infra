// How the demo agent "Edited record (demo)" was made: an ERC-8004 agent that commits three fills to TrackRecord and then
// serves a different document for the third one. It exists to show the failure case end to end: the re-hash does not rebuild
// Monad's head, Chord's validator scores it 0, TrustGate does not trust it and AgentVault.draw reverts NotTrusted.
//
//   AGENT_KEY=0x… bun run scripts/demo-edited-record.ts estimate            balance and what is planned, nothing is sent
//   AGENT_KEY=0x… bun run scripts/demo-edited-record.ts register            1 tx: a new identity (prints the agent id)
//   AGENT_KEY=0x… bun run scripts/demo-edited-record.ts commit <agentId>    writes public/sdk/examples/edited-record/*, then
//                                                                          1 tx: the three true hashes, 1 tx: the agentURI
//   AGENT_KEY=0x… bun run scripts/demo-edited-record.ts validate <agentId>  1 tx: asks Chord's validator to replay the record
// Deploy between `commit` and `validate`, so the endpoint the registration file names is being served.
// The key is read from AGENT_KEY only and never printed.
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AGENT_REGISTRY, APP_URL, EXPLORER, MONAD_RPC, askChordValidator, canonical, chainHead, commit, hashDoc, monad, publish, readChain, register, registrationFile, setAgentURI } from "../sdk/trackrecord";

const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const DIR = "public/sdk/examples/edited-record";
const ENDPOINT = `${APP_URL}/sdk/examples/edited-record/fills.json`;
const DOC_TYPE = "outside-agent-fill/v1";
const NAME = "Edited record (demo)";
const DESCRIPTION = "A demo agent run by Chord to show the failure case. It committed three fills, then changed the price in the third document it serves. Its record does not verify, on purpose.";

const key = process.env.AGENT_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) { console.error("AGENT_KEY is not set (0x + 64 hex)"); process.exit(2); }
const account = privateKeyToAccount(key as `0x${string}`);
const transport = http(process.env.MONAD_RPC_URL ?? MONAD_RPC);
const wallet = createWalletClient({ account, chain: monad, transport });
const pc = createPublicClient({ chain: monad, transport });
const [cmd, idArg] = process.argv.slice(2);
const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));

/** MON's last close on Chord's index: the true price the fills state. */
async function monPrice(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const j: any = await fetch(`https://api.getchord.xyz/v1/candles?chain=143&token=${WMON}&tf=1m&from=${now - 1800}&to=${now}&limit=40`).then((r) => r.json());
  const c = (j?.candles ?? []).at(-1);
  if (!c?.c) throw new Error("no MON candle on Chord's index in the last 30 minutes");
  return Number(Number(c.c).toPrecision(5));
}

if (cmd === "estimate") {
  out({ wallet: account.address, mon: formatEther(await pc.getBalance({ address: account.address })), monPriceUsd: await monPrice(), plan: ["register (1 tx)", "commit three hashes (1 tx)", "setAgentURI (1 tx)", "validationRequest (1 tx)"], endpoint: ENDPOINT });
} else if (cmd === "register") {
  const r = await register(wallet, `${APP_URL}/sdk/README.md`); // a placeholder until the registration file, which carries the id, exists
  out({ done: "register", agentId: r.agentId, owner: account.address, tx: `${EXPLORER}/tx/${r.tx}`, next: `commit ${r.agentId}` });
} else if (cmd === "commit" && /^\d+$/.test(idArg ?? "")) {
  const agentId = idArg!, px = await monPrice(), ts = Date.now();
  if ((await readChain(agentId)).count) throw new Error(`agent ${agentId} already has fills`);
  const doc = (seq: number, fill: Record<string, unknown>) => canonical({ type: DOC_TYPE, chainId: 143, seq, agent: { agentId, registry: AGENT_REGISTRY }, fill });
  const fill3 = { ts: ts + 2, side: "sell", symbol: "MON", token: WMON, usd: 50, priceUsd: px };
  const truth = [doc(1, { ts, side: "buy", symbol: "MON", token: WMON, usd: 25, priceUsd: px }), doc(2, { ts: ts + 1, side: "buy", symbol: "MON", token: WMON, usd: 25, priceUsd: px }), doc(3, fill3)];
  // the edit: the same third fill, sold 40% higher than it was
  const edited = doc(3, { ...fill3, priceUsd: Number((px * 1.4).toPrecision(5)) });
  const served = [truth[0]!, truth[1]!, edited];
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/fills.json`, `${JSON.stringify({ agentId, note: "What this agent serves. Document 3 is not the one it committed.", fills: served.map((d, i) => ({ seq: i + 1, hash: hashDoc(d), doc: d })) }, null, 2)}\n`);
  writeFileSync(`${DIR}/committed.json`, `${JSON.stringify({ agentId, note: "What this agent committed to TrackRecord on Monad. Hash these three and fold them: you get the head Monad holds.", head: chainHead(truth.map(hashDoc)), fills: truth.map((d, i) => ({ seq: i + 1, hash: hashDoc(d), doc: d })) }, null, 2)}\n`);
  const c = await commit(wallet, agentId, truth);
  // documents 1 and 2 go to Chord's host as any honest agent's would; the true third one is never published there
  await publish([truth[0]!, truth[1]!]);
  const file = registrationFile({ name: NAME, description: DESCRIPTION, endpoints: { trackRecord: ENDPOINT }, docType: DOC_TYPE, agentId });
  const [reg] = await publish([file]);
  const set = await setAgentURI(wallet, agentId, reg!.url);
  out({ done: "commit", agentId, head: c.head, count: c.count, committedPriceUsd: px, servedPriceUsd: Number((px * 1.4).toPrecision(5)), transactions: [`${EXPLORER}/tx/${c.tx}`, `${EXPLORER}/tx/${set.tx}`], agentURI: reg!.url, files: [`${DIR}/fills.json`, `${DIR}/committed.json`], next: `deploy, then: validate ${agentId}` });
} else if (cmd === "validate" && /^\d+$/.test(idArg ?? "")) {
  const v = await askChordValidator(wallet, idArg!);
  out({ done: "validate", agentId: idArg, tx: `${EXPLORER}/tx/${v.tx}`, report: v.reportURI });
} else {
  console.error("usage: estimate | register | commit <agentId> | validate <agentId>");
  process.exit(2);
}
