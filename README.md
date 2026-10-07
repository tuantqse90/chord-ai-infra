# Chord Agents

Solana trading agents you can verify. Describe a strategy in plain words, replay it on the real Solana tape, run it on
paper in public, then let it trade from your own wallet. Next to the agents sits Ask, an on-chain analyst whose every
number traces back to a tool result.

Live at **https://chord.clawpot.xyz**. API reference at [/developer/reference](https://chord.clawpot.xyz/developer/reference).

## What it does

| Part | What you get |
| --- | --- |
| **Ask** | A chat analyst with 174 tools from 38 data sources. Every lookup streams to the page with its source, numbers are checked against the tool output, and addresses no tool returned are masked. |
| **Agents** | Copy traders, LP agents, alerts and custom agents. Each one shows its fills, the trade that fired each fill, and every skip with the check that said no. |
| **Strategy builder** | One sentence becomes a Strategy JSON in five blocks (trigger, filters, action, exits, limits) that you can read and edit, then a replay on the last 1, 3 or 7 days of real trades. |
| **Boards** | Smart traders and smart LPs, with bots, pool launchers and rebalancing scripts filtered out, so a copy agent follows wallets that can actually be copied. |
| **Auto-trade** | Agents trade from your own Solana wallet through a Privy session signer you grant once and can revoke. Every swap is checked before it is signed. |
| **Marketplace** | List an agent with a USDC price and a profit share. Other people and other agents buy a copy over x402. The recipe stays private, the record stays public. |
| **Trade and Wallet** | Swaps on Solana through Jupiter and on Base, BNB Chain, Avalanche, Monad, Robinhood Chain and Arc through Chord's router. A Solana wallet with deposits from EVM chains through Relay. |

The app never holds a private key. Swaps are signed in the person's wallet (a browser extension or the embedded wallet of a
Chord account), or by the session signer under the policy the person approved.

## How it fits together

```
 browser: one static page (public/) + the Privy sign-in island (web/privy.tsx)
    |
 Hono on Bun (src/server.ts), SQLite for app state
    |
    +-- Ask harness ........ src/agent.ts, src/skills.ts, src/chord/services/ask/*
    +-- Agent engine ....... src/bots/*      (copy, alert, LP, custom; paper fills; replays)
    +-- Strategies ......... src/strategy/*  (schema, compiler, runner, backtest)
    +-- Execution .......... src/autoTrade.ts, src/agentExec.ts, src/nownodes.ts
    +-- Marketplace ........ src/marketplace.ts, src/x402.ts
    +-- Trade and wallet ... src/trade/*, src/walletRoutes.ts
    |
 Chord's on-chain index (api.getchord.xyz and read-only Postgres), Jupiter, Privy, Relay, NOWNodes
```

Market history comes from Chord's own index, which decodes every swap on 11 Solana venues and on six EVM chains: about
37 million Solana swaps a day. Agents and replays read that tape, so a backtest and a live fill look at the same trades.

## The Ask harness

A question goes through five steps.

1. **Route.** A keyword router picks one of 16 playbooks and offers only that playbook's tools. The model can call
   `more_tools` to open all 174. No playbook means every tool.
2. **Look up.** Up to three rounds of tool calls. Calls in one round run in parallel, each with its own deadline (25 s by
   default), inside a call budget per question. An identical call in the same turn is answered once.
3. **Shrink.** Tool output is cut structurally to 9,000 characters for the model and always stays valid JSON.
4. **Write.** The answer streams to the page as it is written, as server-sent events (`status`, `step`, `thinking`,
   `draft`, `answer`). Tool output is data, never instructions.
5. **Verify.** Every number in the answer is traced back to the tool output. A miss gets one repair pass. Any address,
   signature or hash that no trusted tool returned is masked (`src/sanitize.ts`).

The model router uses a default model, a heavier one for deep playbooks and Grok for questions about posts on X, and fails
over when a provider refuses. If the model stalls, a last small call answers from the results already read.

## Agents and strategies

A strategy is plain JSON checked by one Zod schema (`src/strategy/schema.ts`). It is never code. The compiler, the page,
the runner and the backtest all read the type that schema produces.

- **Triggers:** wallet trade, confluence (N of a set of wallets buy the same token within a window), new token, price,
  schedule, LP event.
- **Filters:** 13 market fields (liquidity, market cap, FDV, 24 h volume, age, holders, top 10 share, price change, organic
  score, buy share, smart buyers) and four safety checks (no mint authority, no freeze authority, verified, not flagged).
- **Actions:** buy, sell, alert or webhook, with exits (take profit, stop loss, trailing, max hold) and limits (open
  positions, daily budget, trades a day, cooldown, per token).

```json
{
  "trigger": { "type": "confluence", "wallets": { "smartTraders": { "top": 20, "days": 1 } },
               "minWallets": 3, "windowMin": 15, "side": "buy" },
  "filters": [ { "field": "liquidityUsd", "op": ">=", "value": 30000 },
               { "safety": "no_mint_authority" }, { "safety": "no_freeze_authority" } ],
  "action": { "type": "buy", "usd": 20 },
  "exits": { "takeProfitPct": 100, "stopLossPct": 30, "trailingPct": 25, "maxHoldMin": 1440 },
  "limits": { "maxOpenPositions": 5, "dailyBudgetUsd": 100 }
}
```

If the model leaves out exits, the compiler adds default exits and says so. Every validation error names the block and
the field. A replay reads followed wallets four at a time, retries a failed one once, and names any wallet it still could
not read.

The engine (`src/bots/`) watches followed wallets over a Solana WebSocket and polls Chord's tape as a backup, with events
deduplicated. Before a fill it checks mint and freeze authority, the liquidity floor, size per token, the daily budget and
open positions. Paper fills are priced at a real Jupiter quote. LP agents compute ranges from the pool's volatility,
rebalance after the price stays out of range, and exit on an LP exodus: an hour's withdrawals at least twice its deposits
and above 10% of the pool's TVL.

## Auto-trade

A signed-in person grants once: our key quorum becomes a session signer on their Privy Solana wallet, under a policy that
only allows signing. They set their limits (per trade $1 to $100, per day $1 to $500, slippage up to 3%, for 1 to 30 days).
Every filled buy or sell of an agent they mark auto-execute then becomes a real swap:

1. Jupiter quote and build for the person's wallet.
2. Pre-sign check. The fee payer and only signer is the person's wallet. Top-level programs are only Jupiter exact-in
   swaps, ComputeBudget and an idempotent token account create for the person. The output lands in the person's own token
   account. The priority fee is capped.
3. Simulation on NOWNodes.
4. `signTransaction` through Privy's wallet API with our authorization key, then a check of the returned signature.
5. Send and confirm on NOWNodes, then an execution row and an event on the agent.

Sells only sell what auto-trade bought for that agent. Three failures in a row, expiry, `POST /v1/agents/auto/disable` or
pausing the agent stop it. `bun scripts/auto-trade-check.ts [wallet] [usd] [mint …]` runs the pre-sign check on real
Jupiter swaps and simulates them, read-only.

## Marketplace and x402

The owner of an agent lists it with a title, a pitch, a price in USDC and a profit share (up to 30%). A priced listing
hides its wallets and rules; its live fills and its replay stay public.

Buying a copy is one x402 payment. `POST /v1/agents/:id/copy` answers `402` with the terms (price, pay-to wallet, a
one-time nonce). This server is an x402 facilitator for the `exact` scheme on Solana (v2 and v1): the buyer signs a USDC
`TransferChecked` whose fee payer is our key and sends it in `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1). We check the
spec's rules (instruction set, exact amount into the payee's token account, one memo equal to `x402:<nonce>`, fee payer
not touched, compute limits), co-sign as fee payer, then simulate, send and confirm through NOWNodes. One payload settles
once. `GET /v1/x402/supported`, `POST /v1/x402/verify` and `POST /v1/x402/settle` expose the facilitator. The older flow,
where the buyer sends the USDC and retries with `X-PAYMENT: solana:<signature>`, still works.

## How NOWNodes is used

NOWNodes carries the transactions that move money.

| Lane | Calls |
| --- | --- |
| Agent swaps (auto-trade and Sign and execute) | `simulateTransaction`, `sendTransaction`, `getSignatureStatuses`, `getMultipleAccounts` (lookup tables), `getTokenAccountsByOwner` (balance before a sell) |
| x402 payments | facilitator simulate, send and confirm; `getTransaction` for the legacy signature flow |
| Cardano pay-per-ask | Blockfrost-compatible API: addresses, transactions, UTXOs |

Reads for Ask tools and agent triggers go through `SOLANA_RPC_URL` (NOWNodes by default, any Solana RPC works). Without a
NOWNodes key the swap lane is off and says so; it never falls back to the read RPC. `GET /v1/status` lists every call by
provider and method with its latency, and the page labels a lookup "NOWNodes" only when it really went there.

## API

Every read answers without a key. Accounts get API keys at `/developer` (60 requests a minute, 5 keys per account).

An agent in three calls:

```bash
API=https://chord.clawpot.xyz; J='content-type: application/json'

# 1. words to strategy
curl -s $API/v1/strategies/compile -H "$J" \
  -d '{"text":"Buy $15 when 3 of the top 20 smart traders buy the same token within 15 minutes, liquidity above $30k"}' > s.json

# 2. replay it on the last 3 days
curl -s $API/v1/strategies/backtest -H "$J" \
  -d "{\"strategy\": $(jq .strategy s.json), \"days\": 3}" | jq '{signals, trades, realizedUsd, winRate}'

# 3. start it on paper and watch it trade
curl -s $API/v1/agents -H "$J" -H "Authorization: Bearer $CHORD_KEY" \
  -d "{\"type\":\"custom\",\"params\":{\"strategy\": $(jq .strategy s.json)}}"
curl -N $API/v1/agents/feed
```

| Group | Endpoints |
| --- | --- |
| Ask | `POST /v1/ask` (SSE; pay per call with `X-Payment`), `GET /v1/suggest`, `GET /v1/config`, `GET /v1/session`, `POST /v1/pay`, `POST /v1/share`, `GET /v1/share/:id`, `POST /v1/feedback` |
| Agents | `GET /v1/agents/stats`, `/board`, `/feed` (SSE), `/smart-now`, `/templates`, `/traders`, `/market`; `POST /v1/agents`; `GET /v1/agents`, `/:id`, `/:id/stream`; `POST /v1/agents/:id/pause`, `/resume`, `/copy`; `DELETE /v1/agents/:id` |
| LP | `GET /v1/agents/lp/scan`, `/lp/range`, `/lp/smart`; `POST /v1/agents/lp/backtest`, `/lp/copy/backtest` |
| Strategies | `POST /v1/strategies/compile`, `/validate`, `/backtest`; `GET /v1/strategies/templates` |
| Execution | `GET /v1/agents/auto/status`; `POST /v1/agents/auto/enable`, `/disable`, `/agents/:botId`; `POST /v1/agents/execute/prepare`, `/send`; `GET /v1/agents/execute/status/:sig`, `/mine` |
| Marketplace | `GET`, `POST`, `DELETE /v1/agents/:id/listing`; `POST /v1/agents/:id/copy`; `GET /v1/x402/supported`; `POST /v1/x402/verify`, `/settle` |
| Trade | `GET /v1/trade/chains`, `/tokens`, `/quote`; `POST /v1/trade/sol/build`, `/sol/send`; `GET /v1/trade/sol/status` |
| Wallet | `GET /v1/wallet/solana/:address`, `/activity`, `/solana/status/:sig`; `POST /v1/wallet/solana/withdraw/build`, `/solana/send`; Relay deposits under `/v1/wallet/relay/*` |
| Developer | `GET /v1/dev/account`, `POST /v1/dev/keys`, `DELETE /v1/dev/keys/:id`, `GET /v1/status` |

## Data honesty

- Paper is labeled paper everywhere. Losing agents stay on the board next to the winners.
- Each fill links to the trade that caused it, and each skip carries its reason.
- A replay says how many hours it covers and which wallets it could not read. A template's 3-day headline is kept across
  restarts, and a replay that could not read its data never replaces a clean one.
- The smart-trader and smart-LP boards drop wallets whose profit cannot be copied: pool launchers that deposit both sides
  and pull out in minutes, vaults and rebalancing scripts.
- Index tools read hourly and daily rollups and index-bounded raw reads. A token-hour above $5B is treated as a pricing
  error and left out, and the answer says how much was excluded.
- Every database query runs in a READ ONLY transaction with a 15 s statement timeout, on a read-only role.

## Run

Requirements: [Bun](https://bun.sh) 1.3+, an OpenAI-compatible LLM endpoint with tool calls, a Solana RPC. Optional: a
NOWNodes API key (swap lane, x402, Cardano), read-only Postgres URLs for the Chord indexes, a Privy app for sign-in and
auto-trade.

```bash
bun install
cp .env.example .env      # see below
bun run build:web         # sign-in bundle (React + Privy) into public/privy/; only needed when PRIVY_APP_ID is set
bun run dev               # http://localhost:8799
```

| Variables | For |
| --- | --- |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `ASK_MODEL_HEAVY`, `ASK_MODEL_X`, `XAI_API_KEY` | the models |
| `SOLANA_RPC_URL`, `SOLANA_WS_URL` | reads and agent triggers |
| `NOWNODES_API_KEY` | the swap lane, x402 settlement, Cardano |
| `CHORD_API`, `CHORD_API_KEY`, `INDEX_DATABASE_URL`, `SOLANA_DATABASE_URL`, `INDEX_CHAINS` | Chord's index |
| `PRIVY_APP_ID`, `PRIVY_CLIENT_ID` | sign-in and embedded wallets |
| `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `PRIVY_SIGNER_QUORUM_ID`, `PRIVY_SIGNER_POLICY_ID` | auto-trade (any missing turns it off) |
| `X402_FEE_PAYER_SECRET` | the x402 facilitator's fee payer (advertised only while it holds at least 0.002 SOL) |
| `TREASURY_SOL`, `TREASURY_ADA`, `PRICE_USDC`, `PRICE_ADA`, `FREE_ASKS`, `UNLIMITED_ASKS` | pay per ask |
| `JUPITER_API_URL`, `JUPITER_API_KEY`, `RELAY_API_URL`, `RELAY_API_KEY` | swaps and deposits |
| `APP_NAME`, `PORT`, `DB_PATH` | the server |

Optional data families (CoinGlass, CoinMarketCap, X, web search) appear only when their keys are set; `.env.example` lists
them.

## Test

```bash
bun test              # offline suite, 700+ tests (the database suites run when TEST_INDEX_URL / TEST_SOLANA_URL are set)
bun run typecheck     # server and the Privy island
bun run smoke         # every Solana tool once against the live endpoint, latency per method
```

## Deploy

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build   # .env next to it, data/ owned by uid 1000
```

`docker-compose.vps.yml` joins the network of the index database. Put a reverse proxy in front of `127.0.0.1:8799` and
keep `/v1/ask` and the agent feeds uncompressed (they are server-sent event streams). `INDEX_CHAINS` must list only chains
the database role can read.

## Layout

```
public/              the page: Ask, Agents (bots.js, builder.js, lpcopy.js, mascot.js), Trade, Wallet, /developer
web/privy.tsx        sign-in island: Privy login, embedded EVM and Solana wallets, session signer grant
src/server.ts        Hono app and routes
src/agent.ts         the Ask loop; src/skills.ts playbook router; src/sanitize.ts address masking
src/chord/           tool families and harness modules shared with Chord Ask
src/bots/            agent engine: triggers, detection, executor, LP math and runner, backtests, store
src/strategy/        Strategy v1 schema, compiler, runner, backtest, templates
src/autoTrade.ts     auto-trade through a Privy session signer
src/agentExec.ts     Sign and execute: prepare, sign in the page, send on NOWNodes
src/nownodes.ts      the NOWNodes lane and its call counters
src/x402.ts          x402 facilitator (exact, Solana)
src/marketplace.ts   listings, paid copies, profit share ledger
src/trade/           Jupiter and Chord router quotes, Solana build, relay and status
src/solana/ src/cardano/ src/rpc/   chain clients, transaction parsing, token metadata
src/db/              read-only Postgres access to the Chord indexes
test/, src/**/*.test.ts             offline tests
```
