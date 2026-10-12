# Worked examples

Real answers from Monad mainnet on 12 Oct 2026, trimmed. Numbers move; run the calls for today's.

## "Can I trust agent 10333?"

```bash
python3 scripts/trust.py agent 10333
```

```json
{"agentId":"10333","name":"Copy trader","owner":"0x3d1F1b327a310D3988dE3C03A7eb2aF790fcaf35",
 "runByChord":"https://chordsi.xyz/app#agents/public/593f1df17678",
 "trackRecord":{"fills":32,"head":"0xe71237eeb8b4f85b9188a454d7111ab5e18c97faf5ff53348c3ea7eb0f04080b","lastCommit":"2026-10-12T06:38:47Z","published":32},
 "validation":{"summary":{"count":1,"average":98},"latest":[{"fills":"1-15","score":98,"tx":"0xf9388029fc3110931109152e75eb9cef6e4edb0cf3eae15761cce3127e6647a2","report":"https://chordsi.xyz/v1/trust/validation/responses/0x410e9310…6347.json"}]},
 "trustGate":{"ok":true,"missing":[],"policy":{"minFills":3,"minValidations":1,"minAvgScore":90,"maxIdleS":259200}},
 "verdict":"TrustGate trusts this agent today."}
```

```bash
python3 scripts/trust.py verify 10333      # exit 0
```

```json
{"ok":true,"verdict":"VERIFIED: 32 document(s) rebuild the head Monad holds for agent #10333",
 "documents":32,"committed":32,
 "rebuiltHead":"0xe71237eeb8b4f85b9188a454d7111ab5e18c97faf5ff53348c3ea7eb0f04080b",
 "monadHead":"0xe71237eeb8b4f85b9188a454d7111ab5e18c97faf5ff53348c3ea7eb0f04080b",
 "missing":[],"badHashes":[],"fills":"https://chordsi.xyz/v1/trust/agents/593f1df17678/fills","readFrom":"https://rpc.monad.xyz"}
```

A good answer to the user:

> Agent #10333 "Copy trader", owned by `0x3d1F1b327a310D3988dE3C03A7eb2aF790fcaf35`, run by Chord on paper.
> - **Record:** 32 fills on TrackRecord, last commit 12 Oct 06:38 UTC. I re-hashed all 32 documents
>   and they rebuild the head Monad holds
>   (`0xe71237eeb8b4f85b9188a454d7111ab5e18c97faf5ff53348c3ea7eb0f04080b`), read from rpc.monad.xyz.
> - **Validation:** Chord's validator `0x98C5d05f35Afb00B04781762c47a7676Af3056a4` replayed fills 1
>   to 15 and scored 98: 44 of 45 graded checks (`trust.py report 10333`). Timing 15 of 15, the
>   copied trade came first 15 of 15, price inside the candle 14 of 15 (fill 5, a buy at 2503.7
>   against a candle of 2436.3 to 2440.7). Fills 16 to 32 are not validated yet.
> - **TrustGate:** trusted today (3+ fills, 1 validation at 90+, a commit in the last 3 days).
>
> This says the record was not rewritten and that an independent key checked the first 15 fills. It
> does not say the agent will keep doing well. Its trades are simulated.

## An agent that does not pass

```bash
python3 scripts/trust.py gate 10336        # exit 1
```

```json
{"agentId":"10336","ok":false,"fills":0,"validations":0,"avgScore":0,"lastCommit":null,
 "missing":["0 of 3 fills committed","0 of 1 validations","no commit in the last 3 days"]}
```

Say what is missing; it is registered and has done nothing yet, which is not the same as untrustworthy.

## An agent run outside Chord

```bash
python3 scripts/trust.py agent 10369
```

```json
{"agentId":"10369","name":"Outside agent demo","owner":"0x629726Ce2805d8c362e664aB90C885A9e3E0fAf3","runByChord":null,
 "trackRecord":{"fills":4,"documents":"https://chordsi.xyz/v1/trust/onchain/10369/fills"},
 "validation":{"summary":{"count":1,"average":100},"latest":[{"fills":"1-3","score":100}]},
 "trustGate":{"ok":true,"missing":[]}}
```

Its report grades only timing (3 of 3): the documents carry no price and no copied trade. Say so.

## Finding an agent

```bash
python3 scripts/trust.py search grid --filter record --limit 2
```

```json
{"total":4,"agents":[
 {"agentId":"10364","name":"Grid VVV 1h","owner":"0x3d1f1b327a310d3988de3c03a7eb2af790fcaf35","fillsOnTrackRecord":6,"validations":2,"avgScore":100},
 {"agentId":"10347","name":"Grid HYPE 1h","owner":"0x3d1f1b327a310d3988de3c03a7eb2af790fcaf35","fillsOnTrackRecord":7,"validations":1,"avgScore":100}]}
```

## The layer in numbers

```bash
python3 scripts/trust.py status
```

```json
{"chain":"Monad mainnet (143)","agentsWithIdentity":42,"fillsCommitted":113,"pending":0,"medianSecondsFillToBlock":12.3,
 "validations":{"count":37,"avgScore":99.3},"trustGate":{"passing":10,"checked":42},
 "everyErc8004AgentOnMonad":{"agents":10377,"owners":8681,"cardsOk":1266,"withRecord":40,"validated":36}}
```

## Committing a fill (a write)

The user: "Put a new fill on my agent 10369: I just bought $25 of MON at 0.0265."

Plan first, with the owner's address and no key
(`node scripts/record.mjs commit --agent 10369 --fill fill.json --wallet 0x629726Ce2805d8c362e664aB90C885A9e3E0fAf3`).
Here the plan carried a warning, because fill #4 on the record states the same things:

```json
{"plan":"commit","agentId":"10369","seq":5,"keyInEnvironment":false,"walletIsOwner":true,"simulation":"ok",
 "warnings":["fill #4 states the same side, symbol, usd, priceUsd: make sure this is another fill, not the same one again"]}
```

Message 1 says that first, then gives the plan and one question:

> Fill #4, the last on this record, is also a buy of $25 of MON at 0.0265, committed today at
> 06:47:11 UTC ([transaction](https://monadscan.com/tx/0xd978b27101125a17f56b38331c1b49d561fd33119ed261e950afb22d88766d20)).
> If that is this purchase, cancel: a commit cannot be taken back. If it is another one, the plan:
>
> | | |
> |---|---|
> | Action | Commit fill #5 to agent 10369's record on Monad |
> | Wallet | `0x629726Ce2805d8c362e664aB90C885A9e3E0fAf3` (owns the identity; 0.054131628 MON) |
> | Fill time | 2026-10-12 07:04:07 UTC (you said "just now": the time I prepared this) |
> | Document | `{"agent":{"agentId":"10369","registry":"eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"},"chainId":143,"fill":{"priceUsd":0.0265,"side":"buy","symbol":"MON","ts":1791788647000,"usd":25},"seq":5,"type":"outside-agent-fill/v1"}` |
> | Transactions | 1, on TrackRecord `0xf5650FB475747e2766faDb46aef735F3Ee4e9f09` |
> | Checks | simulation ok |
> | Cannot be undone | a committed hash stays on the record |
>
> The signing key is not in my environment and I will not ask for it: after a confirm you run the
> command yourself, or export `AGENT_KEY` and start me from that terminal.
>
> Reply **confirm** to send, or **cancel**.

After the user's yes, the same command with `--user-confirmed`, run where `AGENT_KEY` is set. What
a sent commit answers (this one is the real fill #4, 12 Oct 2026):

```json
{"done":"commit","agentId":"10369","seq":4,"hash":"0xb9da53e452c563984b5bcc8bc781ba4730d5ce19bc3b8554b12d62211a3fb83b",
 "head":"0xfb7f11e39b6ce82eb29716cfd4b0cb51b24f3d6c1ec612fc5b80fb9bd073f1f0",
 "transaction":"https://monadscan.com/tx/0xd978b27101125a17f56b38331c1b49d561fd33119ed261e950afb22d88766d20"}
```

Then `python3 scripts/trust.py verify 10369` answered `VERIFIED: 4 document(s) rebuild the head Monad holds`.

## Gating a contract

The user asks "only let trusted agents draw from my treasury". No call is needed; hand over the
interface and the address from `references/trustgate.md`:

```solidity
require(ITrustGate(0xcB30174c3Bf5f8170fA6769fe6D704F55968412A).isTrusted(agentId), "agent not trusted");
```

and remind them to check that the caller owns or is approved for that agent id on the Identity
Registry, and that the answer is about now.

## A record that does not verify

Agent `10381` (`Edited record (demo)`, run by Chord) committed three fills, then served a different
third document. Use it to see what a failure looks like (12 Oct 2026):

```bash
python3 scripts/trust.py verify 10381
# "verdict": "MISMATCH: the documents rebuild 0xb0b801751f7377ebf52257304ab77947f33edd823c290e520b28db5ce4118bdb,
#             Monad holds 0x2539f7e7c4cf3397b8ce9a7985825e432cf72666f718f2342a5f404c4b68635d"      (exit 1)

python3 scripts/trust.py get /v1/trust/vault/check/10381
# "gate": { "ok": false, "fills": 3, "validations": 1, "avgScore": 0, "missing": ["average score 0, the gate asks 90"] },
# "draw": { "ok": false, "revert": "NotTrusted", "reason": "TrustGate does not trust this agent today" }
```

The validator's report says why: the hash check passes for fills 1 and 2 and fails for fill 3 (no
published document hashes to what was committed), which is fatal, so the score is 0. What it
committed and what it serves are side by side at
`https://chordsi.xyz/sdk/examples/edited-record/` (`committed.json`, `fills.json`).
