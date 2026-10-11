# Chord Agents on Monad

Trading agents whose track record cannot be written after the fact.

Each agent that trades gets an [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) identity on Monad. Every fill it makes
becomes a JSON document. The document's hash is appended to the agent's on-chain hash chain within seconds, while the
outcome of the trade is still unknown. Anyone can re-hash the published documents and compare them with the chain, in the
browser or from the command line, without trusting this server. A separate validator replays the fills against public
market data and posts a score to the ERC-8004 Validation Registry. People rate agents from their own wallet on the canonical
Reputation Registry.

Live at **https://chordmonad.clawpot.xyz**. Market data comes from [Chord](https://getchord.xyz)'s Monad API.

## What it does

| Part | What you get |
| --- | --- |
| **Agents** | Copy traders (follow Monad wallets), custom strategies and alerts, run in public on paper. Each fill shows the trade that fired it, the router quote that priced it, and every skip with the check that said no. |
| **Classic strategies** | Ten textbook systems (golden cross, EMA cross, RSI reversion, Bollinger reversion and squeeze breakout, MACD cross, Donchian / Turtle, Supertrend, funding carry, grid), backtested side by side on Binance, OKX, Hyperliquid and Perpl candles and funding, then run as perps on [Perpl](https://app.perpl.xyz) (Monad's order-book perps exchange) or as spot through Chord's router. |
| **LP agents** | Paper liquidity in Monad pools from Chord's LP index: every range (tight ±5%, balanced ±15%, wide ±40%, full) replayed against holding the tokens on the pool's own hours, then run hour by hour with re-centring after 6 hours out of range. |
| **Marketplace** | Owners list their trading agents with a one-line pitch; listings are ranked by a score built only from what can be checked: fills committed on Monad, the validator's average, on-chain ratings and the 7-day paper PnL. |
| **Strategy builder** | One sentence becomes a Strategy JSON in five blocks (trigger, filters, action, exits, limits) that you can read and edit, then a replay on recent Monad trades. Triggers on Monad: a followed wallet trades, several smart wallets buy the same token, a price move, a schedule. |
| **Identity** | Every trading agent is registered on the canonical ERC-8004 Identity Registry. Its `agentURI` is a registration-v1 file that lists its services and the trust models it supports. |
| **TrackRecord** | Per agent, a hash chain of its fills: `head_n = keccak256(head_{n-1} ‖ fillHash_n)`. Only the agent's owner or an approved operator can append, and nothing can be removed or reordered. |
| **Verification** | The agent page rebuilds the chain in the browser from the published documents and reads the head from Monad. `scripts/verify.ts` runs the same checks from anyone's machine. |
| **Validation** | On request, the validator (its own key) replays a range of fills. It checks the hashes, the chain, the commit time, the fill price against Chord's candles (a Perpl perp fill: against Perpl's own 1-minute candle) and the copied trade against Chord's index. The score (0–100) and the full report go to the ERC-8004 Validation Registry. |
| **Reputation** | Star ratings signed by the rater's own wallet with `giveFeedback` on the canonical Reputation Registry, read back with `readAllFeedback`. Self-feedback is refused by the registry. |
| **Ask** | A chat analyst with tool calls over Chord's data. It can build, replay and start agents from a sentence. |

The server never holds a user's key. The operator and validator keys are hot keys funded with a little MON. Agents trade
on paper: every fill is priced by a real Chord router quote for that size and nothing is sent.

## How trust works

```
 fill (paper, priced by a Chord router quote)
   │
   ▼
 canonical JSON document ──keccak256──► fillHash
   │ stored and served byte for byte            │
   │                                            ▼
   │                    TrackRecord.commit(agentId, prevHead, [fillHash…])   (operator, every 15 s, ≤ 40 per tx)
   │                                            │ emits Committed(agentId, seq, fillHash, head)
   ▼                                            ▼
 /v1/trust/agents/:id/fills ───────► anyone: re-hash, rebuild head, compare with chains(agentId) on Monad
                                                │
 operator: validationRequest(validator, agentId, requestURI, requestHash)      (ERC-8004 Validation Registry)
 validator: replay → validationResponse(requestHash, score, reportURI, reportHash, "replay")
 people:    giveFeedback(agentId, stars × 20, "starred", …)                     (ERC-8004 Reputation Registry)
```

1. **Register.** The committer gives every trading agent an ERC-8004 identity (`register(agentURI)`), up to 3 per tick.
   Alert agents do not trade, so they get none.
2. **Document.** Each filled fill becomes a document of type `chord-agent-fill/v1`. It holds the chain id, its sequence
   number, the agent (bot id, agent id, registry), the fill (time, side, token, USD, amount, price, PnL), what fired it
   (the followed wallet and its transaction, or the strategy rule) and the quote (route, price impact). Keys are sorted
   and there is no whitespace. The exact text is stored when the document is built and served as is, so a checker hashes
   the bytes it receives and never has to serialize anything the same way.
3. **Commit.** Every 15 s the operator appends each agent's pending hashes in one transaction. It reads the head from
   the chain first and refuses to commit if the chain's count does not match the next sequence number. The contract
   reverts on a stale head too.
4. **Verify.** The agent page shows the identity, the chain and each fill's commit transaction. **Verify** re-hashes
   every document in the browser (keccak from `@noble/hashes`), rebuilds the head and reads `chains(agentId)` from
   `rpc.monad.xyz` with an `eth_call`.
5. **Validate.** **Ask for validation** sends a request document whose keccak-256 is the on-chain `requestHash`. The
   validator checks each fill in the range:
   - **hash:** the served document hashes to the `fillHash` of the `Committed` event at its sequence. Failing this zeroes the score.
   - **chain:** the hashes rebuild the head recorded after the range. Failing this zeroes the score.
   - **on time:** the commit landed within 10 minutes of the fill.
   - **price:** the fill price sits inside that minute's candle on Chord's Monad index, ±2 %.
   - **source:** a copied trade is in Chord's index for that wallet and token, before the fill.

   The score is the share of checked items that passed (0 if a fatal check failed). The report is published at the
   response URI, and its hash is on-chain.
6. **Rate.** Anyone with a wallet on Monad can rate an agent from 1 to 5 stars. The page sends `giveFeedback` from that
   wallet; the server signs nothing.

## Verify an agent yourself

In the browser: open an agent and press **Verify in your browser** on its Track record card. The **Trust** tab lists every agent with its
identity, committed fills, latest validation and rating.

From a terminal, against Monad only:

```bash
bun scripts/verify.ts <botId>                       # --api https://chordmonad.clawpot.xyz --rpc https://rpc.monad.xyz
```

It prints one line per check (identity, document hashes, `Committed` events and commit lag, the rebuilt head) and exits
with 0 when everything matches. If one byte of one document changes, the hash check, the `Committed` event check and the head check all fail, and the
script exits with 1.

A run on 11 October 2026 against the DCA demo agent (ERC-8004 agent #10335), right after its first fill:

```
agent 946e0b147135 = ERC-8004 agent #10335 · TrackRecord 0xf5650FB475747e2766faDb46aef735F3Ee4e9f09
identity
  ok    owner 0x3d1F1b327a310D3988dE3C03A7eb2aF790fcaf35
  ok    agentURI https://chordmonad.clawpot.xyz/v1/trust/agents/946e0b147135/registration.json
documents: 1 committed
  ok    1 documents hash to their committed hashes and name their own place
transactions
  ok    1 transactions carry all 1 Committed events
  ok    fill → block: median 1.8 s, worst 1.8 s
chain
  ok    1 fills rebuild the on-chain head 0x5f11b9a4719bdc67535bc2cf88832316e7ac8975070e75bddc490359f9ceee9e

verified: the record on Monad matches every published fill
```

The validator then replayed that fill and scored it 100 in the Validation Registry: request
[`0xb2e3192b…9164`](https://monadscan.com/tx/0xb2e3192b7beae9d9f8a1d2e94da706244a5c69920a6d5450b12cbdff8de79164), response
[`0x4ca0ea6c…7d34`](https://monadscan.com/tx/0x4ca0ea6c159558cb49065b35388c19d7604d3fc3ae2dc775ea2d89a606dd7d34).

## Contracts (Monad, chain 143)

| Contract | Address |
| --- | --- |
| ERC-8004 Identity Registry (canonical) | [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://monadscan.com/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) |
| ERC-8004 Reputation Registry (canonical) | [`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`](https://monadscan.com/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63) |
| TrackRecord | [`0xf5650FB475747e2766faDb46aef735F3Ee4e9f09`](https://monadscan.com/address/0xf5650FB475747e2766faDb46aef735F3Ee4e9f09) |
| ERC-8004 Validation Registry (proxy) | [`0x695CAaeD3D15212F9eC6500992f373f09439F38d`](https://monadscan.com/address/0x695CAaeD3D15212F9eC6500992f373f09439F38d) |
| Validation Registry implementation | [`0xABE4855f8E71FE6a9ED308C75C2aFF9Cd56B6CbE`](https://monadscan.com/address/0xABE4855f8E71FE6a9ED308C75C2aFF9Cd56B6CbE), the reference code from [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts), unchanged |
| BootstrapUUPS (first implementation) | [`0xEd78C6093482cA25dCd502cba27d417Dbc490f5F`](https://monadscan.com/address/0xEd78C6093482cA25dCd502cba27d417Dbc490f5F) |

Monad has no canonical Validation Registry yet, so the script deploys the reference one behind an ERC-1967 proxy. Its
`initialize` is `reinitializer(2) onlyOwner`, so the proxy starts on a small bootstrap implementation that sets the owner,
then upgrades to the registry and initializes it in the same transaction. See [contracts/README.md](contracts/README.md).

Deployed on 11 October 2026 from the operator wallet `0x3d1F1b327a310D3988dE3C03A7eb2aF790fcaf35` (transactions in
`contracts/broadcast/Deploy.s.sol/143/`). All four contracts are verified on Sourcify (exact match).

## Market data

Every market read goes through Chord's API (`CHORD_API`, Monad = chain 143):

| Read | Endpoint |
| --- | --- |
| The trades agents follow: every Monad swap of $50 or more with its wallet, kept 24 h, read every 10 s | `/v1/smart-money/whales` |
| Smart-traders board, bots removed, 24 h and 7 d | `/v1/smart-money/top` |
| Token list (decimals, liquidity, transfer tax, verified mark), prices, per-token stats | `/v1/tokens`, `/v1/tokens/market`, `/v1/tokens/stats/:token` |
| A token's swaps, candles | `/v1/tokens/trades/:token`, `/v1/candles` |
| Router quotes that price every paper fill, and the $10 round trip of the "sellable" safety check | `/v1/quote` |

A token passes the `not_flagged` safety check when it has no transfer tax and a $10 buy sold straight back returns at
least 90 %. Chord has no Monad launch board or LP tape, so the `new_token` and `lp_event` triggers are refused on Monad,
along with the filters it has no data for (market cap, holders, organic score).

## Classic strategies and Perpl

Each strategy turns closed candles into a target position (long, short, flat; the grid holds a share of the size).

- **Backtest** (`POST /v1/classic/backtest`): the target of a bar is traded at the next bar's open, with the venue's fee
  (Perpl taker 3.45 bps, read from Perpl's context; Chord's router 5 bps on Monad spot), a slippage allowance, and every
  funding print of the data source (a long pays positive funding). Fixed size, no compounding, no parameter search on the
  reported window. `source: "all"` runs Binance, OKX, Hyperliquid and Perpl on the same window and says when they disagree
  on the sign. Every assumption comes back in `notes` (Hyperliquid keeps ~5000 candles, OKX ~3 months of funding).
- **Agents** (`type: "classic"`): on each closed candle of their timeframe they read their signal source and move the paper
  position. A Perpl fill walks Perpl's live order book for its notional (VWAP) and pays the taker fee; a short is a negative
  quantity with a negative cost, funding events move the cost, positions are marked to Perpl's mark price. No order is
  sent. Every fill is committed to the agent's TrackRecord like any other; the validator checks a perp fill against
  Perpl's own 1-minute candle (±0.5 %). First one on mainnet: [request](https://monadscan.com/tx/0x6f2aa2e9483c4a99beb702eeab1f2c30ad570914c929f885fb97cbbf6f854949),
  [response](https://monadscan.com/tx/0x0a82409a60fbf091bd56343acbaf4605753c9b9f0a9afa720a057fdbda25f8e8) (Supertrend on MON perps, ERC-8004 agent #10340).

Data sources: Binance futures (`fapi/v1/klines`, `fundingRate`), OKX swaps (`history-candles`, `funding-rate-history`),
Hyperliquid (`candleSnapshot`, `fundingHistory`) and Perpl (`app.perpl.xyz/api/v1/market-data/{id}/candles|funding`,
`/book`, `/ticker`, `/v1/pub/context`); public endpoints, no keys. Perpl's Exchange on Monad is
`0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` (collateral AUSD).

## LP agents

`POST /v1/agents/lp/backtest` replays a position on one Monad pool with Uniswap V3 math: token amounts from the range
and liquidity, the side token priced in the anchor (WMON or a dollar stable) from the pool's hourly price, the anchor's
dollar price from Chord's WMON candles. Each hour in range pays the hour's volume × the pool fee × the position's share of
TVL, scaled by how concentrated its range is against a ±15% range (the pool's own liquidity is assumed about that
concentrated; today's TVL is held constant). Out of range for 6 hours, the position can re-centre and pays the pool fee on
half its value. The result shows PnL, fees, value against holding the deposited tokens, hours in range and re-centres for
every range. LP agents (`type: "lp"`) do the same hour by hour on live data; their range, liquidity and fees live in
SQLite, and their fills are committed to TrackRecord like any other.

## API

| Route | What it answers |
| --- | --- |
| `GET /v1/trust/status` | contracts, operator and validator balances, committer state, counts |
| `GET /v1/trust/agents/:botId` | identity, the chain (read live from Monad), committed fills, validations |
| `GET /v1/trust/agents/:botId/registration.json` | the ERC-8004 registration file the agent's `agentURI` points at |
| `GET /v1/trust/agents/:botId/fills?from=&to=` | the committed documents (exact text), hashes, transactions, commit lag |
| `POST /v1/trust/agents/:botId/validate` | ask the validator to replay the fills not validated yet |
| `GET /v1/trust/validation/requests/:hash.json` | a request document (its keccak-256 is the on-chain `requestHash`) |
| `GET /v1/trust/validation/responses/:hash.json` | the validator's report (its keccak-256 is the on-chain `responseHash`) |
| `GET /v1/trust/agents/:botId/reputation` | feedback from the canonical Reputation Registry |
| `GET /v1/agents/board`, `/v1/agents/public/:id`, `/v1/agents/stats` | the public agents, their fills and the live feed |
| `POST /v1/bots`, `/v1/strategies/compile`, `/v1/strategies/backtest` | create agents, turn a sentence into a strategy, replay it |
| `GET /v1/classic/strategies`, `/v1/classic/symbols`, `/v1/classic/templates`; `POST /v1/classic/backtest` | the classic catalog, Perpl's markets, headline replays, a backtest on one or all four sources |
| `GET /v1/market`; `POST /v1/market/listings`, `DELETE /v1/market/listings/:botId` | the marketplace ranking, list or unlist one of your agents |
| `GET /v1/agents/lp/scan`, `/v1/agents/lp/state/:id`; `POST /v1/agents/lp/backtest` | Monad pools from Chord's LP index, an LP agent's range and fees, every range replayed on a pool |

## Run

Requirements: [Bun](https://bun.sh) 1.3+, [Foundry](https://getfoundry.sh) for the contracts, an OpenAI-compatible LLM
endpoint with tool calls for Ask.

```bash
bun install
cp .env.example .env            # Monad keys and contract addresses, Chord API, LLM
bun run dev                     # http://localhost:8798
```

Contracts:

```bash
cd contracts
git submodule update --init --recursive
forge test
forge script script/Deploy.s.sol --rpc-url $MONAD_RPC_URL --broadcast --legacy   # reads OPERATOR_PRIVATE_KEY
```

Put the two addresses it prints in `.env` (`TRACK_RECORD_ADDRESS`, `VALIDATION_REGISTRY_ADDRESS`) and restart. Fund the
operator with enough MON for registrations and commits; below `TRUST_MIN_OPERATOR_MON` (0.05) it waits.

## Test

```bash
bun test                        # the offline suite
bun run typecheck
cd contracts && forge test      # TrackRecord and the Validation Registry deployment
```

## Deploy

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build   # .env next to it, data/ owned by uid 1000
```

`docker-compose.vps.yml` joins the network of Chord's API, so `CHORD_API` can point at it directly. Put a reverse proxy in
front of `127.0.0.1:8798` and keep `/v1/ask` and the agent feeds uncompressed (they are server-sent event streams).

## Layout

```
contracts/           TrackRecord, the ERC-8004 Validation Registry deployment, tests, deploy script
public/              the page: Agents (bots.js, builder.js, classic.js, lp.js), Marketplace (market.js), Trust (trust.js), Ask, Trade
scripts/verify.ts    check an agent's record against Monad from anyone's machine
src/trust/           identities, fill documents, the commit loop, validation, reputation reads, /v1/trust routes
src/monad/           chain constants, Chord API client, viem clients
src/bots/            agent engine: triggers on Chord's Monad feed, paper executor, backtests, store
src/strategy/        Strategy v1 schema, compiler, runner, backtest, templates
src/classic/         candles and funding from four sources, indicators, the classic catalog, backtest, the classic agent runner
src/perpl/           Perpl market data: markets, ticker, book walk, candles, funding
src/lp/              LP agents on Monad: Chord LP data, V3 range math, backtest, the hourly runner
src/market.ts        the marketplace: listings and the score
src/agent.ts         the Ask loop; src/skills.ts playbook router; src/chord/ tool families
```

