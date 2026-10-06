# Tapeline Ask: an on-chain analyst on NOWNodes

Ask a question about a wallet, a transaction, a token or a payment. The model answers only through tools that read the chain
live through **NOWNodes** (Solana JSON-RPC, Cardano Blockfrost-compatible API) and, when connected, Chord's own index of every
DEX swap. Every answer lists the lookups it made and links each source to the explorer. Asks are paid per question in USDC on
Solana or ADA on Cardano, and every payment is verified on-chain through NOWNodes. The app never signs and never holds funds.

## Requirements

[Bun](https://bun.sh) 1.3+, a NOWNodes API key (Solana and Cardano mainnet), an OpenAI-compatible LLM endpoint with tool calls,
and optionally read-only Postgres URLs for the Chord DEX indexes.

## Run

```bash
bun install
cp .env.example .env      # NOWNODES_API_KEY, LLM_API_KEY, treasuries; database URLs optional
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

`GET /v1/status` shows every call by method with its latency, so the use of the infra is visible live.

## Architecture

```
public/            one static page: composer, live lookup list, answer, explorer-linked sources, pay sheet
src/server.ts      Hono: /v1/ask (SSE) · /v1/pay · /v1/session · /v1/config · /v1/status
src/agent.ts       tool loop: parallel calls per round, 25 s deadline each, ≤4 rounds, same-call dedupe
src/sanitize.ts    the answer may only name addresses / hashes a tool returned (or the person typed)
src/rpc/           NOWNodes clients (Solana JSON-RPC, Cardano REST) + per-method ledger
src/solana/        transaction parsing, token metadata, Solana tools
src/cardano/       Cardano tools
src/db/            direct read-only Postgres access to the Chord indexes (main + Solana) and the index tools
src/payments.ts    payment checks + SQLite store (sessions, credits, one redemption per transaction)
```

Pay per call for agents: `POST /v1/ask` with `X-Payment: solana:<signature>` or `X-Payment: cardano:<txhash>`. The payment is
verified, the call is served, leftover credits stay on the session returned in `X-Session`.

## Data honesty

- Index tools read hourly / daily rollups and index-bounded raw reads only. A token-hour above $5B is treated as a pricing error
  and left out, and the answer says how much was excluded (the Solana index had one such token on 06/10/2026).
- Every database query runs in a READ ONLY transaction with a 15 s statement timeout, on top of a read-only role.

## Next

Swaps via Jupiter (prepare, then sign in the user's wallet), live WebSocket feeds from NOWNodes, deploy.
