# Verifying an agent's record

## What is on Monad

Every action an agent takes becomes one JSON document. The document's exact bytes are hashed with
keccak-256 and the hash is appended to the agent's chain in the TrackRecord contract
(`0xf5650FB475747e2766faDb46aef735F3Ee4e9f09`):

```
head_0 = 0x0000…0000                      (32 zero bytes)
head_n = keccak256(head_{n-1} ‖ hash_n)   (64 bytes in, 32 out)
```

`chains(agentId)` returns `(head, count, lastAt)`. Only the identity's owner, or a wallet the owner
approved on the Identity Registry, can commit. Nothing can be removed, edited or reordered without
changing the head, and each `Committed` event carries the block it landed in.

A verification re-hashes the served documents, folds them and compares the result with
`chains(agentId)` read from an RPC. Equal heads and counts mean the documents you were served are
the ones that were committed, in that order, none missing.

## One command

```bash
python3 scripts/trust.py verify 10333          # exit 0 = equal, 1 = not, 2 = could not check
```

It reads `chains(agentId)` from the RPC, finds the documents from the chain itself (Identity
Registry `tokenURI` → registration file → its `track-record` service), hashes each document here and
folds the chain. `--fills URL` checks another endpoint; `--rpc URL` or `MONAD_RPC_URL` another node.

Answer fields: `ok`, `verdict`, `documents` (re-hashed), `committed` (count on Monad), `rebuiltHead`,
`monadHead`, `missing` (committed seqs the endpoint does not serve), `badHashes` (seqs whose listed
hash is not the document's hash), `fills` (the endpoint used), `readFrom` (the RPC).

The same check in other runtimes:

```bash
curl -sO https://chordsi.xyz/sdk/chord-verify.mjs && node chord-verify.mjs verify 10333
```

```js
import { verify } from "https://chordsi.xyz/sdk/trackrecord.mjs";   // browser, Deno
const r = await verify(10333);   // { ok, documents, badHashes, missing, rebuiltHead, onchain, fillsUrl, reason }
```

## By hand, with curl and Foundry's cast

```bash
cast call 0xf5650FB475747e2766faDb46aef735F3Ee4e9f09 "chains(uint256)(bytes32,uint64,uint64)" 10333 --rpc-url https://rpc.monad.xyz
curl -s https://chordsi.xyz/v1/trust/onchain/10333/fills > fills.json      # { fills: [{ seq, hash, doc, commitTx, … }] }
# for each fill in seq order:  h = cast keccak "<doc, the exact string>";  head = cast keccak <head ‖ h>
```

`doc` is a string: hash it as it is. Never parse and re-serialize it; key order and number
formatting would change the bytes.

## What a fill document looks like

Chord's agents write `chord-agent-fill/v1`. The sequence number and the agent sit inside the
document, so it cannot be moved to another place or another agent:

```json
{"agent":{"agentId":"10333","botId":"593f1df17678","registry":"eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"},
 "chainId":143,
 "fill":{"id":"59794aaa9cb7","mode":"paper","pnlUsd":null,"priceUsd":83056.47840531562,"side":"buy","symbol":"cbBTC",
         "token":"0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b","tokenAmount":0.0001204,"ts":1791701146398,"usd":10},
 "quote":{"priceImpactPct":0.0343,"provider":"Chord router","route":["capricorn","hanji"]},
 "seq":1,
 "source":{"detail":"0xccb9…44f6 bought $576","side":"buy","ts":1791701104000,"tx":"0x854322e6…","usd":575.63,"via":"tape","wallet":"0xccb9e1ed1ed765527366effe26486a211dc144f6"},
 "type":"chord-agent-fill/v1"}
```

`fill.mode` is `paper`: the agent did not move money; the price is a real router quote. Other
agents choose their own document type and fields.

## What the validator checks

A validator replays a range of fills from public data and posts one score (0 to 100) on the
ERC-8004 Validation Registry, with a report anyone can read. Chord's validator
(`0x98C5d05f35Afb00B04781762c47a7676Af3056a4`) runs, per fill:

| Check | Passes when | If it cannot run |
|---|---|---|
| `hash` | the published document hashes to the hash in its `Committed` event | fails (no document = no pass) |
| `onTime` | the commit landed within 10 minutes after `fill.ts`; a fill dated more than a minute after its own commit fails | not graded (no `fill.ts`) |
| `price` | the fill price sits inside the market's candle at that time, within a tolerance (2% on spot) | not graded (no price, unknown market) |
| `source` | the trade it copied is on-chain and happened before the fill | not graded (no followed trade) |

and one `chain` check: the range's hashes rebuild the head recorded at its last fill.

**The score.** If the chain check or any hash check fails, the report is `fatal` and the score is 0.
Otherwise `score = passed / graded`, rounded, over the `onTime`, `price` and `source` checks that
could run (`pass: null` means not graded). When none could run, the score is 100.

So read the report, not only the number. For one of Chord's copy agents a 98 means 44 of 45 graded
checks passed, prices and copied trades included. For an outside agent whose documents carry no
price and no copied trade, a 100 means the documents are intact and were committed on time, and
nothing more.

`trust.py report ID` reads the latest report for you: the score, how many checks were graded and
passed, a count per check (`passed`, `failed`, `notGraded`) and each failure with its note:

```json
{"agentId":"10333","range":{"fromSeq":1,"toSeq":15},"score":98,"fatal":false,"graded":45,"passed":44,
 "checks":{"hash":{"passed":15,"failed":0,"notGraded":0},"onTime":{"passed":15,"failed":0,"notGraded":0},
           "price":{"passed":14,"failed":1,"notGraded":0},"source":{"passed":15,"failed":0,"notGraded":0}},
 "failed":[{"seq":5,"check":"price","note":"outside the 11:50 UTC candle 2436.3–2440.7 (±2%), fill 2503.7"}]}
```

The full report (`report` in that answer, or `/v1/trust/validation/responses/<requestHash>.json`):

```json
{"type":"chord-agent-validation-report/v1","agentId":"10333","range":{"fromSeq":1,"toSeq":15},
 "validator":"0x98c5d05f35afb00b04781762c47a7676af3056a4","checked":45,"passed":44,"score":98,"fatal":false,
 "chain":{"pass":true,"note":"rebuilt head 0xddb1b09253… matches the chain at #15"},
 "items":[{"seq":1,"fillId":"59794aaa9cb7",
   "hash":{"pass":true,"note":"matches the event in 0x202005c2…"},
   "onTime":{"pass":true,"note":"committed 15 s after the fill (limit 10 min)"},
   "price":{"pass":true,"note":"inside the 06:45 UTC candle 82806–82841 (±2%), fill 83056"},
   "source":{"pass":true,"note":"0xccb9e1… buy at 06:45:04 UTC, before the fill"}}]}
```

The validator signs with its own key, separate from the agents' operator. It replays Chord's own
agents by itself (after 3 new fills, or 1 new fill and 12 hours), up to 36 ranges a day across all
of them, so a busy agent can have recent fills waiting: always say which fills the latest report
covers. It answers outside agents on request: 20 requests a day in all, one per agent per hour, at
most 200 fills a request.

## Telling the user

Say what was checked and what it proves, in this order: the identity (id, owner), the record (count,
last commit, verified or not, by which RPC), the validation (validator, replays, average, report
link, and what its graded checks covered), the gate (ok today or what is missing). Then the limits:
a verified record proves the documents were not rewritten; the validator's graded checks are what
speak to the fills being real, and only as far as they could run.
