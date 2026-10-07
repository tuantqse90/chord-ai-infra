# Tapeline Ask: an on-chain analyst on NOWNodes

Ask a question about a wallet, a transaction, a token or a payment. The model answers only through tools that read the chain
live through **NOWNodes** (Solana JSON-RPC, Cardano Blockfrost-compatible API) and, when connected, Chord's own index of every
DEX swap, plus market data from public and keyed sources: CoinGecko / CoinMarketCap, Hyperliquid and cross-exchange
derivatives, CoinGlass, DefiLlama, Pendle / Morpho, GeckoTerminal / DexScreener / GoPlus, Jupiter, prediction markets, news
feeds, X and the web. Every answer lists the lookups it made and links each source. Asks are paid per question in USDC on
Solana or ADA on Cardano, and every payment is verified on-chain through NOWNodes. Swaps are priced on Solana (Jupiter) and six
EVM chains (Chord's router) and signed in the person's own wallet: a browser extension, or the embedded wallet of a Chord
account (email sign-in through Privy). The app never holds keys or funds.

## Requirements

[Bun](https://bun.sh) 1.3+, a NOWNodes API key (Solana and Cardano mainnet), an OpenAI-compatible LLM endpoint with tool calls,
and optionally read-only Postgres URLs for the Chord DEX indexes.

## Run

```bash
bun install
cp .env.example .env      # NOWNODES_API_KEY, LLM_API_KEY, treasuries; database URLs optional
bun run build:web         # sign-in bundle (React + Privy) into public/privy/; only needed when PRIVY_APP_ID is set
bun run dev               # http://localhost:8799
bun test                  # offline suite (the DB suite runs when TEST_INDEX_URL / TEST_SOLANA_URL are set)
bun run smoke             # every Solana tool once against the live endpoint, latency per method
```

## How NOWNodes is used

| Need | Method / endpoint |
| --- | --- |
| Wallet balance and holdings | `getBalance`, `getTokenAccountsByOwner` (SPL Token + Token-2022, jsonParsed) |
| Token names on-chain | `getMultipleAccounts` on Metaplex metadata PDAs (≤100 mints per call), Token-2022 metadata extension |
| Recent activity | `getSignaturesForAddress` + `getTransaction` (JSON-RPC batch when the node takes it) |
| One transaction explained | `getTransaction` (jsonParsed, finalized): SOL and token balance changes per owner from pre/post balances |
| Token supply and concentration | `getAccountInfo` (mint), `getTokenLargestAccounts`, `getMultipleAccounts` (owners of the largest accounts) |
| Payment verification (Solana) | `getTransaction`: finalized, succeeded, treasury's USDC balance up by at least the price |
| Cardano address / tx / payment | `/addresses/{a}`, `/addresses/{a}/transactions`, `/txs/{h}`, `/txs/{h}/utxos` |

`GET /v1/status` shows every call by method with its latency. The page names the provider each lookup really used: "NOWNodes" appears
only when the endpoint is NOWNodes and a key is set.

## Deploy

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build   # .env next to it, data/ owned by uid 1000
```

`docker-compose.vps.yml` joins the network of the index database. Put a reverse proxy in front of `127.0.0.1:8799` and keep
`/v1/ask` uncompressed (it is a server-sent event stream). `INDEX_CHAINS` must list only chains the database role can read.

## Architecture

```
public/            one static page: composer, live lookup list, answer, explorer-linked sources, pay sheet, swap screen
web/privy.tsx      sign-in island: Privy email login + embedded EVM / Solana wallets, exposed to the page as window.askPrivy
src/server.ts      Hono: /v1/ask (SSE) · /v1/pay · /v1/session · /v1/config · /v1/status
src/agent.ts       tool loop: playbook per question (src/skills.ts) + more_tools, parallel calls, per-tool deadlines and call
                   budget, structural output shrink, language pin, number check, last-resort answer
src/chord/         tool families + harness modules shared with Chord Ask (same layout; utils/redis is an in-process cache)
src/chord/adapter.ts  Chord tool families → this app's tools (sources, vouched addresses, untrusted text)
src/sanitize.ts    the answer may only name addresses / hashes a tool returned (or the person typed)
src/rpc/           NOWNodes clients (Solana JSON-RPC, Cardano REST) + per-method ledger
src/solana/        transaction parsing, token metadata, Solana tools
src/cardano/       Cardano tools
src/db/            direct read-only Postgres access to the Chord indexes (main + Solana) and the index tools
src/payments.ts    payment checks + SQLite store (sessions, credits, one redemption per transaction)
src/trade/         swap quotes (Jupiter, Chord /v1/meta), Solana build → relay of only what it built → status, swap_quote tool
src/agentExec.ts   agent signals executed for real, signed in the page (prepare → sign → send on NOWNodes → status)
src/autoTrade.ts   auto-trade: agent fills executed without a per-trade approval through a Privy session signer (/v1/agents/auto)
src/privyWallets.ts  Privy server API: the person's embedded Solana wallet, our signer on it, signTransaction with our key
```

## Auto-trade

A signed-in person grants once: their Chord account's Solana wallet gets our key quorum as a session signer under our policy
(`useSigners().addSigners` in `web/privy.tsx`), then `POST /v1/agents/auto/enable` records their limits (per trade $1–100, per day
$1–500, slippage ≤ 3%, 1–30 days). Every FILLED buy / sell of an agent they mark auto-execute is then mirrored on that wallet:
Jupiter quote and build (`wrapAndUnwrapSol: false`), a pre-sign check (fee payer and only signer = the wallet; top-level programs
only Jupiter v6 exact-in swaps, ComputeBudget and an idempotent ATA create for the person; the output lands in the person's own
token account), simulation on NOWNodes, `signTransaction` through Privy's wallet RPC with our authorization key, a check of the
returned signature, send and confirm on NOWNodes, an `agent_executions` row (mode `auto`) and an event on the agent. Agents stay
in paper mode (their fills are the signals; "auto-execute" is a row in `auto_agents`, the engine is unchanged). Sells only sell
what auto-trade bought for that agent; caps count buys. Three failures in a row, expiry, `POST /disable` or pausing the agent stop
it. Needs `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `PRIVY_SIGNER_QUORUM_ID`, `PRIVY_SIGNER_POLICY_ID` (+ `PRIVY_APP_ID`,
`NOWNODES_API_KEY`); without them it is off and says so. `bun scripts/auto-trade-check.ts [wallet] [usd] [mint …]` runs the
pre-sign check on real Jupiter swaps and simulates them, read-only.

Pay per call for agents: `POST /v1/ask` with `X-Payment: solana:<signature>` or `X-Payment: cardano:<txhash>`. The payment is
verified, the call is served, leftover credits stay on the session returned in `X-Session`.

## Data honesty

- Index tools read hourly / daily rollups and index-bounded raw reads only. A token-hour above $5B is treated as a pricing error
  and left out, and the answer says how much was excluded (the Solana index had one such token on 06/10/2026).
- Every database query runs in a READ ONLY transaction with a 15 s statement timeout, on top of a read-only role.

## Next

Live WebSocket feeds from NOWNodes; free asks tied to a signed-in account instead of a browser session; a web search
provider key.
