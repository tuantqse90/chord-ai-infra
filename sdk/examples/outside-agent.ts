// An agent that is not Chord's puts its record on TrackRecord, end to end, with its own key:
//   1. register an ERC-8004 identity (the wallet owns it), then point it at a registration file naming its track-record endpoint;
//   2. for each fill: publish the canonical document, commit its hash at fill time;
//   3. ask Chord's validator to replay the fills; the score lands in the ERC-8004 Validation Registry;
//   4. read TrustGate, the one view a contract calls before it trusts the agent with capital.
// AGENT_KEY=0x… bun sdk/examples/outside-agent.ts            (the key pays a few small transactions on Monad)
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { askChordValidator, canonical, commit, gateCheck, hostedFillsUrl, MONAD_RPC, monad, publish, register, registrationFile, setAgentURI, verify } from "../trackrecord";

const key = process.env.AGENT_KEY as Hex | undefined;
if (!key) { console.error("AGENT_KEY is not set"); process.exit(1); }
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: monad, transport: http(process.env.MONAD_RPC_URL || MONAD_RPC) });
const name = process.env.AGENT_NAME || "Outside agent";

// 1. identity: register with a placeholder, then the real file (its endpoints carry the agentId)
const reg = await register(wallet, "https://chordsi.xyz/sdk/README.md");
console.log("registered agent", reg.agentId, reg.tx);
const file = registrationFile({ name, description: "An agent run outside Chord, keeping its fills on TrackRecord with its own key.", endpoints: { trackRecord: hostedFillsUrl(reg.agentId) }, docType: "outside-agent-fill/v1", agentId: reg.agentId });
const [regDoc] = await publish([file]);
await setAgentURI(wallet, reg.agentId, regDoc!.url);
console.log("agentURI", regDoc!.url);

// 2. fills: publish each document, commit its hash as it happens
const docs = [1, 2, 3].map((seq) => canonical({ type: "outside-agent-fill/v1", agentId: reg.agentId, seq, fill: { ts: Date.now() + seq, side: seq % 2 ? "buy" : "sell", symbol: "MON", usd: 10 * seq } }));
for (const d of docs) {
  await publish([d]);
  const c = await commit(wallet, reg.agentId, [d]);
  console.log("committed fill", c.count, c.tx);
}

// 3. anyone can check it, then Chord's validator replays it
const v = await verify(reg.agentId);
console.log("verify:", v.ok ? `equal (${v.documents} documents)` : v.reason);
const ask = await askChordValidator(wallet, reg.agentId);
console.log("validation asked", ask.tx, "report at", ask.reportURI);

// 4. the gate (the validator's answer takes a few seconds to land)
await new Promise((r) => setTimeout(r, 30_000));
console.log("TrustGate.check:", await gateCheck(reg.agentId));
