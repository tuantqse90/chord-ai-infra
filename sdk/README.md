# Chord TrackRecord SDK

Check, and write, an ERC-8004 agent's track record on Monad (chain 143).

Each fill an agent makes is a JSON document. The keccak-256 of the document's exact bytes is appended to the agent's chain in
the TrackRecord contract, the moment the fill happens:

```
head_0 = 0x0
head_n = keccak256(head_{n-1} ‖ hash_n)
```

To verify a record, re-hash every published document, fold the hashes and compare the result with `chains(agentId)` read
from a Monad RPC. If the heads are equal, the documents you were served are the ones committed, in order, with none
missing. The verifier never trusts the server's own hashes, heads or counts.

| Contract | Address |
| --- | --- |
| ERC-8004 Identity Registry (canonical) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| TrackRecord | `0xf5650FB475747e2766faDb46aef735F3Ee4e9f09` |
| ERC-8004 Validation Registry | `0x695CAaeD3D15212F9eC6500992f373f09439F38d` |
| TrustGate (one view a contract calls before it trusts an agent) | `0xcB30174c3Bf5f8170fA6769fe6D704F55968412A` |
| AgentVault (example: capital only for agents the gate trusts) | `0xbD0820B774D10D9B2AdbD7cDf78CfEAea064260d` |

## Verify, no install

```sh
curl -sO https://chordsi.xyz/sdk/chord-verify.mjs && node chord-verify.mjs verify 10333
```

```
agent #10333 on TrackRecord 0xf5650FB475747e2766faDb46aef735F3Ee4e9f09 (Monad, chain 143)
  fills        https://chordsi.xyz/v1/trust/agents/593f1df17678/fills
  re-hashed    15 of 15 committed documents
  rebuilt head 0xddb1b092534101f85839bb8d4ab9b2f8f26ae094f457582b6dbd31ccf7b30034
  Monad head   0xddb1b092534101f85839bb8d4ab9b2f8f26ae094f457582b6dbd31ccf7b30034 (count 15, last commit 2026-10-11T15:37:15Z)
VERIFIED: 15 documents rebuild the head Monad holds for agent #10333
```

The verifier finds the documents from the chain itself. The agent's `tokenURI` on the Identity Registry points to its
registration file, and the file's `track-record` service is the URL of its documents. Node 18 or later is needed; viem is
bundled into the file.

```sh
node chord-verify.mjs verify <agentId> [--fills <url>] [--rpc <url>]   # exit 0 = equal, 1 = not
node chord-verify.mjs chain <agentId> [--rpc <url>]                    # head, count, last commit
node chord-verify.mjs hash <file|-> [--raw]                            # keccak-256 of the canonical document
node chord-verify.mjs gate <agentId> [--rpc <url>]                     # TrustGate.check (exit 0 = trusted)
```

In Deno or a browser:

```js
import { verify } from "https://chordsi.xyz/sdk/trackrecord.mjs";
const r = await verify(10333);
// { ok, agentId, documents, badHashes, missing, rebuiltHead, onchain: { head, count, lastAt }, fillsUrl, reason }
```

`https://chordsi.xyz/sdk/*` and `https://chordsi.xyz/v1/trust/*` answer any origin. Another host's fills endpoint must send
`Access-Control-Allow-Origin` for a browser page elsewhere to read it.

## Keep your own agent's record, the short way

`sdk/examples/outside-agent.ts` does all of it with one key: registers an identity, publishes and commits three fills, has the
record verified, asks Chord's validator and reads TrustGate. Chord hosts the documents, so the agent serves nothing:

```ts
const { agentId } = await register(wallet, placeholderURI);
const [file] = await publish([registrationFile({ name, description, endpoints: { trackRecord: hostedFillsUrl(agentId) }, agentId })]);
await setAgentURI(wallet, agentId, file.url);

await publish([doc]);                                  // stored by its keccak-256, served back byte for byte
await commit(wallet, agentId, [doc]);                  // at fill time
const v = await askChordValidator(wallet, agentId);    // request published, sent on-chain, the validator told
await gateCheck(agentId);                              // { ok, fills, validations, avgScore, lastAt }
```

Chord's validator (`0x98C5d05f35Afb00B04781762c47a7676Af3056a4`) answers outside agents too: up to 20 requests a day in all,
one per agent per hour, at most 200 fills a request. A fill whose document is not published fails its hash check.

## Keep your own agent's record, the long way

You need a wallet with a little MON for gas, and somewhere to serve two JSON files. In Node or Bun, download
`trackrecord.mjs` next to your code, or copy `sdk/trackrecord.ts`, and use your own viem wallet client.

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AGENT_REGISTRY, MONAD_RPC, canonical, commit, hashDoc, monad, readChain, register, registrationFile, requestValidation } from "./trackrecord.mjs";

const wallet = createWalletClient({ account: privateKeyToAccount(process.env.AGENT_KEY), chain: monad, transport: http(MONAD_RPC) });
```

**1. Register.** Serve a registration file, then register its URL. Your wallet then owns the identity.

```ts
const file = registrationFile({
  name: "My agent",
  description: "Buys Monad majors on a 4h trend signal",
  docType: "my-agent-fill/v1",
  endpoints: { trackRecord: "https://my.agent/fills", web: "https://my.agent" },
});
// serve `file` at https://my.agent/registration.json, then:
const { agentId } = await register(wallet, "https://my.agent/registration.json");
// serve registrationFile({ ...same, agentId }) from now on, so it lists its registration
```

**2. Publish each fill as a document.** Put the sequence number and agent id inside the document, so it cannot be moved
to another place or another agent. Store the exact string and serve it as is. Never re-serialize it.

```ts
const seq = (await readChain(agentId)).count + 1;
const doc = canonical({
  type: "my-agent-fill/v1", chainId: 143, seq,
  agent: { agentId, registry: AGENT_REGISTRY },
  fill: { ts: Date.now(), side: "buy", token: "0x...", usd: 10, priceUsd: 1.23 },
});
// GET https://my.agent/fills answers { "fills": [{ "seq": 1, "hash": hashDoc(doc), "doc": doc }, ...] } in seq order
```

**3. Commit it right away.** The wallet must own the identity, or be approved for it on the Identity Registry
(`approve` or `setApprovalForAll`, as with any ERC-721).

```ts
const c = await commit(wallet, agentId, [doc]);   // { tx, head, count, committed: [{ seq, fillHash, head }] }
```

`commit` reads the current head and passes it on-chain. If another commit lands first, the contract reverts with
`StaleHead`: rebuild the documents with the new sequence numbers and commit again. Several documents can go in one call,
oldest first.

**4. Ask for a validation.** Write a request document naming the range, serve it, and put its hash on-chain. The
validator you name replays the fills and answers on the Validation Registry with a 0 to 100 score.

```ts
const request = canonical({ type: "my-agent-validation-request/v1", agentId, range: { fromSeq: 1, toSeq: c.count }, headAtToSeq: c.head, fills: "https://my.agent/fills" });
const requestHash = hashDoc(request);
// serve `request` at https://my.agent/validation/<requestHash>.json, then:
await requestValidation(wallet, { agentId, validator: "0xValidator...", requestURI: `https://my.agent/validation/${requestHash}.json`, requestHash });
```

Name Chord's validator (`0x98C5d05f35Afb00B04781762c47a7676Af3056a4`) and tell it about the transaction with
`POST https://chordsi.xyz/v1/trust/validation/notify { "tx": "0x..." }` (it also polls), or run your own validator.

**5. Check it.** Run `node chord-verify.mjs verify <agentId>`.

## API

| Function | Does |
| --- | --- |
| `canonical(value)` | JSON with keys sorted at every level and no whitespace; undefined and non-finite numbers become `null`. Byte-identical to the server. |
| `hashDoc(text)` | keccak-256 of the exact UTF-8 bytes |
| `chainHead(hashes, from?)` | Folds the hashes onto `from` (default `0x0`) |
| `readChain(agentId, { rpcUrl? })` | `{ head, count, lastAt }` from TrackRecord (`lastAt` in unix ms) |
| `agentURI(agentId)`, `registration(agentId)`, `fillsUrl(agentId)` | Identity `tokenURI`, the parsed registration file, its `track-record` endpoint |
| `fetchFills(url)` | The served `{ seq, hash, doc }` entries, sorted. Pages with `from`/`to` past 1,000. |
| `verify(agentId, { fillsUrl?, rpcUrl?, fetch? })` | The full check |
| `register(wallet, agentURI)` | Returns `{ tx, agentId }`, the id parsed from the `Registered` event |
| `commit(wallet, agentId, docs)` | Returns `{ tx, prevHead, head, count, committed }` |
| `requestValidation(wallet, { agentId, validator, requestURI, requestHash })` | Sends `validationRequest` on the Validation Registry |
| `registrationFile({ name, description, endpoints, docType?, agentId?, ... })` | An ERC-8004 registration-v1 object |
| `setAgentURI(wallet, agentId, uri)` | Points the identity at a new registration file |
| `publish(docs, { host? })` | Stores documents on Chord's host: `[{ hash, url, committed }]` |
| `hostedFillsUrl(agentId)` | The track-record endpoint Chord serves for any agent (commits joined with published documents) |
| `askChordValidator(wallet, agentId, { fromSeq?, toSeq? })` | Publishes the request, sends it on-chain, tells the validator; `{ tx, requestHash, reportURI }` |
| `gateCheck(agentId)` | `TrustGate.check`: `{ ok, fills, validations, avgScore, lastAt }` |

Every read takes `{ rpcUrl, fetch }`. The writes check the transaction with a simulation before signing, wait for the
receipt and throw if it reverted.

## For AI agents

The same checks as an [Agent Skill](https://chordsi.xyz/skills/chord-trust/SKILL.md) for Claude Code, Codex and other agents
that read `SKILL.md`: a reader with its own keccak-256 (`trust.py`, Python standard library, reads Monad's RPC directly) and a
writer that plans first and sends only after the user's yes (`record.mjs`).

```sh
curl -fsSL https://chordsi.xyz/skills/chord-trust/scripts/install.sh | bash
```

Or as MCP tools: `claude mcp add --transport http chord-trust https://chordsi.xyz/mcp`.

## Build

```sh
bun build sdk/cli.ts --target node --outfile public/sdk/chord-verify.mjs
bun build sdk/trackrecord.ts --target browser --format esm --outfile public/sdk/trackrecord.mjs
bun build sdk/record.ts --target node --outfile public/skills/chord-trust/scripts/record.mjs
bun test test/sdk.test.ts test/skill.test.ts
```
