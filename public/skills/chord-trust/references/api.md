# HTTP API

Base `https://chordsi.xyz`. JSON, no key, any origin (CORS open on `/v1/trust/*`, `/sdk/*`, `/mcp`).
Every path below is a GET unless marked. `trust.py get PATH` fetches any of them.

The API is a convenience over public data. For anything that decides trust, prefer what is read
from Monad's RPC (`trust.py verify`, `trust.py gate`), and treat an API number that disagrees with
the chain as wrong.

## The layer

| Path | Answers |
|---|---|
| `/v1/trust/status` | contracts, operator and validator addresses with their MON, counts (`agents`, `committed`, `pending`, `validations`), `commitLag` (median and p90 ms from a fill to its block), `validation` (count, average), `lastCommit`, and `open` (chain index, validator service, gate summary) |
| `/v1/trust/registry/stats` | every ERC-8004 agent on Monad, counted: `agents`, `owners`, `withUri`, `cardsRead`, `cardsOk`, `trackRecordService`, `withRecord`, `validated`, `topHosts`, `topOwners` |
| `/v1/trust/registry?q=&filter=&page=&size=` | search the Identity Registry. `q`: name, description, id or owner prefix (`0x…`). `filter`: `all`, `record` (keeps fills on TrackRecord), `validated`, `card` (publishes a readable agent card). `size` up to 100 (default 50), `page` from 0. The answer also carries `total` and `stats`. Rows: `agentId`, `owner`, `uri`, `name`, `description`, `card`, `services`, `trackRecordService`, `commits`, `validations`, `avgScore`, `ours` |
| `/v1/trust/outside` | agents not run by Chord that keep a record: `agentId`, `fills`, `published`, `lastCommitTx`, `owner`, `name`, `fillsUrl` |

## One agent, by its ERC-8004 id

| Path | Answers |
|---|---|
| `/v1/trust/onchain/{agentId}` | `identity` (owner, agentURI, name, description), `chain` (head, count, lastAt in unix ms, read from Monad), `indexed`, `published`, `fillsUrl`, `validationSummary` (count, average), `validations` (range, response, responseTx, responseURI), `ours` (set when Chord runs the agent) |
| `/v1/trust/onchain/{agentId}/fills` | `{ fills: [{ seq, hash, doc, fillTs, commitTx, commitBlock, head, explorer }] }`: the agent's commits joined with the documents published on the host. `doc` is the exact text. Pages with `from` / `to` (1,000 a page). The track-record endpoint for any agent that publishes here |
| `/v1/trust/gate/{agentId}` | `TrustGate.check` plus the policy and what is missing: `ok`, `fills`, `validations`, `avgScore`, `lastAt`, `policy { minFills, minValidations, minAvgScore, maxIdleS }`, `missing[]` |
| `/v1/trust/validation/requests/{requestHash}.json` | the request document a validation answered |
| `/v1/trust/validation/responses/{requestHash}.json` | the validator's report (`references/verify.md`) |

## Documents

| Path | Does |
|---|---|
| `POST /v1/trust/docs` `{ "docs": [ … ] }` or `{ "doc": … }` | stores each document by its keccak-256 and answers `201 { docs: [{ hash, url, committed }] }`. Each entry is a JSON object or its canonical text (sorted keys, no whitespace), up to 16 KB; up to 50 a request, 200 a minute per address. A stored document can never be swapped: its address is its hash |
| `/v1/trust/docs/{hash}` | the document, byte for byte |
| `POST /v1/trust/validation/notify` `{ "tx": "0x…" }` | tells Chord's validator about a `validationRequest` transaction (it also polls) |

Publishing is not a commit: only the hash appended on TrackRecord, by the identity's owner, puts a
document on an agent's record. `record.mjs` does both.

## Agents Chord runs

These take the app's own id (`botId`, 12 hex), shown as `ours.botId` in `/v1/trust/onchain/{agentId}`:

| Path | Answers |
|---|---|
| `/v1/trust/agents/{botId}` | the agent's identity, chain, fills with their commits, validations |
| `/v1/trust/agents/{botId}/fills` | its track-record endpoint (`{ fills: [{ seq, hash, doc, … }] }`) |
| `/v1/trust/agents/{botId}/registration.json` | its ERC-8004 registration file |
| `/v1/trust/agents/{botId}/reputation` | feedback on the canonical Reputation Registry |

## MCP

`POST https://chordsi.xyz/mcp` (Streamable HTTP, stateless JSON-RPC, read-only). Install:
`claude mcp add --transport http chord-trust https://chordsi.xyz/mcp`.

| Tool | Arguments | Answers |
|---|---|---|
| `trust_status` | none | the layer in numbers |
| `agent_record` | `agentId` | identity, record, validations, gate, a one-line verdict |
| `verify_agent` | `agentId` | the re-hash against Monad's head, run on the server (run `trust.py verify` to check it yourself) |
| `gate_check` | `agentId` | `TrustGate.check` with the policy and what is missing |
| `search_agents` | `query`, `filter`, `limit` | agents in the Identity Registry |
| `best_backtests` | `limit` | strategy setups that were up over 1, 3 and 6 months of history (not part of the trust layer; history, not a forecast) |

## Limits

- Chord's validator: 20 outside requests a day in all, one per agent per hour, at most 200 fills a
  request.
- The registry index reads the Identity Registry in batches; a new agent shows within minutes.
- Monad's public RPC is shared: on a busy answer, retry or use your own (`--rpc`, `MONAD_RPC_URL`).
