# Putting your own agent on the record

Any ERC-8004 agent can keep its record on TrackRecord with its own key. Chord hosts the documents,
so the agent serves nothing. What it costs: a little MON for gas (a commit used 0.008 MON on
12 Oct 2026), and one transaction per fill.

Every step below sends transactions from the user's wallet and is permanent. Follow the write flow
in `SKILL.md`: plan, show, wait for an explicit yes, then `--user-confirmed`.

## The key

`record.mjs` reads the agent's private key from the `AGENT_KEY` environment variable and uses it
only to sign here. The user sets it in their own shell:

```bash
export AGENT_KEY=0x...        # 32 bytes, hex. Typed by the user, in their terminal.
node scripts/record.mjs whoami    # the wallet address and its MON; prints no key
```

Never ask for the key in the conversation, never write it to a file, never echo it. If `AGENT_KEY`
is not set, say how to set it and stop. Use a wallet made for the agent, holding only gas money.

## 1. Register an identity (once)

```bash
node scripts/record.mjs register --name "My agent" --description "Buys Monad majors on a 4h trend signal"
```

The plan lists two transactions: `register` on the canonical Identity Registry (the wallet becomes
the owner), then `setAgentURI` pointing the identity at a registration file published on
chordsi.xyz. That file names the agent's `track-record` endpoint,
`https://chordsi.xyz/v1/trust/onchain/<agentId>/fills`, which is how a verifier finds the documents
from the chain alone. After `--user-confirmed` the answer carries the new `agentId`.

`--doc-type` sets the type the fill documents will declare (default `agent-fill/v1`).

## 2. Commit each fill, as it happens

Write the fill as one JSON object. `ts` is required: the time the fill happened, in unix
milliseconds. Everything else is yours to define; price, token and size make it useful to a reader.

```bash
echo '{"ts":1791787600000,"side":"buy","symbol":"MON","usd":25,"priceUsd":0.0265}' > fill.json
node scripts/record.mjs commit --agent 10369 --fill fill.json
```

The plan shows the exact document, with the sequence number and the agent inside it so it cannot be
moved elsewhere, and its hash:

```json
{"plan":"commit","agentId":"10369","seq":4,"walletIsOwner":true,"simulation":"ok","warnings":[],
 "document":"{\"agent\":{\"agentId\":\"10369\",\"registry\":\"eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432\"},\"chainId\":143,\"fill\":{\"priceUsd\":0.0265,\"side\":\"buy\",\"symbol\":\"MON\",\"ts\":1791787600000,\"usd\":25},\"seq\":4,\"type\":\"agent-fill/v1\"}",
 "hash":"0x…", "previousHead":"0x4e2c773fefcc67ca990a206f1c9f3185fa4916d12c8e53a81b2b90f7f5ff7745"}
```

`simulation` is the same contract call run as a read: `ok`, or why it would revert
(`NotAuthorized`: the wallet does not own the identity; `StaleHead`: another commit landed first).
With `--user-confirmed` the document is published (stored by its hash, served back byte for byte)
and its hash is appended to the chain in one transaction.

Rules that keep a record worth something:

- **Commit at fill time.** The validator's on-time check wants the commit within 10 minutes after
  `ts`. A fill dated after its own commit fails it. The plan warns when a fill is already too old.
- **One fill, one document, never edited.** A wrong fill stays on the record; commit a correcting
  one after it.
- **Only fills that happened.** A commit is a public, permanent claim by the agent's owner.

## 3. Ask for a validation

```bash
node scripts/record.mjs validate --agent 10369           # the whole chain, or --from N --to N
```

It publishes a request document naming the range, sends `validationRequest` on the ERC-8004
Validation Registry naming Chord's validator, and tells the validator. The score lands on-chain
within a minute or two; the report is at the `report` URL of the answer. Limits: 20 outside
requests a day in all, one per agent per hour, at most 200 fills a request.

What the validator can grade depends on the documents: with `ts` it grades timing; with a price and
a known market it grades the price; `references/verify.md` has the table.

## 4. Check it

```bash
python3 scripts/trust.py verify 10369     # the documents rebuild the head Monad holds
python3 scripts/trust.py gate 10369       # what a contract gets from TrustGate today
```

The gate asks for 3 committed fills, 1 validation averaging 90 or more, and a commit in the last
3 days.

## With the SDK instead

`record.mjs` is a thin wrapper over the TrackRecord SDK (viem). In your own agent's code:

```js
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { askChordValidator, canonical, commit, gateCheck, hostedFillsUrl, monad, MONAD_RPC, publish, readChain, register, registrationFile, setAgentURI }
  from "./trackrecord.mjs";      // curl -sO https://chordsi.xyz/sdk/trackrecord.mjs

const wallet = createWalletClient({ account: privateKeyToAccount(process.env.AGENT_KEY), chain: monad, transport: http(MONAD_RPC) });

const { agentId } = await register(wallet, "https://chordsi.xyz/sdk/README.md");            // placeholder first: the file needs the id
const [file] = await publish([registrationFile({ name, description, endpoints: { trackRecord: hostedFillsUrl(agentId) }, agentId })]);
await setAgentURI(wallet, agentId, file.url);

const seq = (await readChain(agentId)).count + 1;
const doc = canonical({ type: "agent-fill/v1", chainId: 143, seq, agent: { agentId, registry: "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }, fill });
await publish([doc]);                     // same exact string that is committed
await commit(wallet, agentId, [doc]);     // { tx, head, count }; reverts with StaleHead if another commit landed first
await askChordValidator(wallet, agentId); // { tx, requestURI, reportURI }
await gateCheck(agentId);                 // { ok, fills, validations, avgScore, lastAt }
```

`canonical(value)` gives JSON with keys sorted at every level and no whitespace. Store and serve that
exact string; never re-serialize it. Full SDK reference, and how to host the documents yourself
instead of on chordsi.xyz: https://chordsi.xyz/sdk/README.md .

## Hashing a document yourself

```bash
python3 scripts/trust.py hash fill-document.json     # keccak-256 of the file's exact bytes
```

This hashes bytes as they are. It does not canonicalize: build the document with the SDK's
`canonical()` (or `record.mjs`, whose plan prints it) and hash that text.
