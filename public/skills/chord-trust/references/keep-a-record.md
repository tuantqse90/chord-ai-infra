# Putting your own agent on the record

Any ERC-8004 agent can keep its record on TrackRecord with its own key. Chord hosts the documents,
so the agent serves nothing. What it costs: a little MON for gas (a commit used 0.008 MON on
12 Oct 2026), and one transaction per fill.

Every step below sends transactions from the user's wallet and is permanent. Follow the write flow
in `SKILL.md`: plan, show, wait for an explicit yes, then `--user-confirmed`.

## The key

A plan needs no key. Name the wallet that will sign and the script shows everything first:

```bash
node scripts/record.mjs commit --agent 10369 --fill fill.json --wallet 0x629726Ce2805d8c362e664aB90C885A9e3E0fAf3
```

Sending (`--user-confirmed`) reads the agent's private key from the `AGENT_KEY` environment variable
and uses it only to sign, here. It has to be in the environment of the shell that runs the command.
Two ways, both the user's doing:

- the user runs `export AGENT_KEY=0x...` in their terminal and starts the agent from that terminal,
  so the agent's commands inherit it; or
- the user runs the confirmed command themselves (copy it for them, with `--user-confirmed`) and
  pastes the output back.

```bash
node scripts/record.mjs whoami --wallet 0x…     # address and MON, no key needed
node scripts/record.mjs whoami                  # with AGENT_KEY set: the key's own address; prints no key
```

Never ask for the key in the conversation, never write it to a file, never echo it, never put it on
a command line. If `AGENT_KEY` is missing when it is time to send, say the two ways above and stop.
Use a wallet made for the agent, holding only gas money.

## 1. Register an identity (once)

```bash
node scripts/record.mjs register --name "My agent" --description "Buys Monad majors on a 4h trend signal"
```

The plan lists two transactions: `register` on the canonical Identity Registry (the wallet becomes
the owner), then `setAgentURI` pointing the identity at a registration file published on
chordsi.xyz. That file names the agent's `track-record` endpoint,
`https://chordsi.xyz/v1/trust/onchain/<agentId>/fills`, which is how a verifier finds the documents
from the chain alone. After `--user-confirmed` the answer carries the new `agentId`.

`--doc-type` sets the type the fill documents will declare (default `agent-fill/v1`); it is written
into the registration file, and `commit` reads it from there afterwards.

## 2. Commit each fill, as it happens

Write the fill as one JSON object. `ts` is required: the time the fill happened, in unix
milliseconds. If the user did not say when, ask; "just now" is the current time, stated back to
them. Everything else is yours to define; price, token and size make it useful to a reader.

```bash
echo '{"ts":1791788647000,"side":"buy","symbol":"MON","usd":25,"priceUsd":0.0265}' > fill.json
node scripts/record.mjs commit --agent 10369 --fill fill.json --wallet 0x629726Ce2805d8c362e664aB90C885A9e3E0fAf3
```

The plan shows the exact document, with the sequence number and the agent inside it so it cannot be
moved elsewhere, its hash, and the document before it (a real plan, 12 Oct 2026):

```json
{"plan":"commit","agentId":"10369","seq":5,"wallet":"0x629726Ce2805d8c362e664aB90C885A9e3E0fAf3","keyInEnvironment":false,
 "mon":"0.054131628","walletIsOwner":true,"simulation":"ok","warnings":[],
 "document":"{\"agent\":{\"agentId\":\"10369\",\"registry\":\"eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432\"},\"chainId\":143,\"fill\":{\"priceUsd\":0.0265,\"side\":\"buy\",\"symbol\":\"MON\",\"ts\":1791788647000,\"usd\":25},\"seq\":5,\"type\":\"outside-agent-fill/v1\"}",
 "hash":"0x…","previousHead":"0xfb7f11e39b6ce82eb29716cfd4b0cb51b24f3d6c1ec612fc5b80fb9bd073f1f0",
 "lastDocument":"{\"agent\":{…},\"fill\":{…},\"seq\":4,\"type\":\"outside-agent-fill/v1\"}"}
```

- `type` is the one the agent's registration file declares for its documents (`--doc-type` overrides).
- `simulation` is the same contract call run as a read: `ok`, or why it would revert
  (`NotAuthorized`: the wallet does not own the identity and is not approved; `StaleHead`: another
  commit landed first).
- `lastDocument` is the fill before this one. A warning says so when the new fill has the same
  fields apart from its time: a commit cannot be taken back, so make sure it is not the same fill.
- `walletIsOwner: false` with `simulation: ok` is an operator the owner approved on the Identity
  Registry (`approve` or `setApprovalForAll`, as with any ERC-721).

With `--user-confirmed` the document is published (stored by its hash, served back byte for byte)
and its hash is appended to the chain in one transaction.

Rules that keep a record worth something:

- **Commit at fill time, with the real time.** The validator's on-time check wants the commit within
  10 minutes after `ts`; a fill dated more than a minute after its own commit fails it. The plan
  warns when a fill is already too old and refuses one dated in the future. Never move `ts` to pass.
  (Fill #4 of the demo agent 10369 was committed with a time 39 minutes ahead of its block, by
  mistake, before this rule existed; it is on the record for good and fails that check.)
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
