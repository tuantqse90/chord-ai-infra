# chord-trust agent skill

An [Agent Skill](https://agentskills.io) that lets Claude Code, Codex, OpenClaw, Hermes, Cursor or
any agent that reads `SKILL.md` use [Chord](https://chordsi.xyz)'s trust layer for AI agents on
Monad (chain 143), built on ERC-8004:

- **check an agent before trusting it**: its identity, its record, a validator's replay, and what
  the TrustGate contract answers for it today;
- **verify a record yourself**: re-hash an agent's published fills and compare the chain with the
  head Monad holds, with no trust in the server's numbers;
- **find agents** among every ERC-8004 identity on Monad;
- **gate a contract** on agent trust with one view call;
- **put your own agent on the record**: register an identity, commit each fill at fill time, ask
  for a validation.

Reads need no key. Writes sign only the user's own record transactions, with the user's key from
their environment, after the user has seen a plan and said yes in a separate message. The skill
never holds funds and never transfers anything.

## Install

```bash
curl -fsSL https://chordsi.xyz/skills/chord-trust/scripts/install.sh | bash
```

or, from a copy of this folder:

```bash
bash scripts/install.sh                  # ~/.claude/skills/chord-trust and ~/.agents/skills/chord-trust
bash scripts/install.sh --project .      # ./.claude/skills/chord-trust (one project only)
bash scripts/install.sh --uninstall
```

The skill is just this directory; copying it by hand works too. OpenClaw: `~/.openclaw/skills/chord-trust`;
Hermes: `~/.hermes/skills/chord-trust`.

Requirements: outbound HTTPS to `chordsi.xyz` and a Monad RPC (default `rpc.monad.xyz`);
`python3` 3.8+ (standard library only) for the reads; Node 18+ for the writes, plus a wallet holding
a little MON.

## Try it

```bash
python3 scripts/trust.py verify 10333      # re-hash an agent's record against Monad (exit 0 = equal)
python3 scripts/trust.py agent 10333       # identity, record, validations, TrustGate
python3 scripts/trust.py gate 10333        # what a contract gets, read from the RPC
python3 scripts/trust.py report 10333      # what the validator graded, and what failed
python3 scripts/trust.py search grid --filter record
python3 scripts/trust.py status
```

Then ask your agent: "Should I give agent 10333 a budget?" or "Put my agent on the record."

## Contents

| Path | What it is |
|---|---|
| `SKILL.md` | triggers, the four parts, intent routing, how to read a verdict, the write boundary and flow, answer rules, errors |
| `references/verify.md` | how the chain is built, verifying by command or by hand, fill documents, what the validator checks and how it scores |
| `references/trustgate.md` | the Solidity interface, the policy, `checkWith`, the AgentVault example, reading the gate off-chain |
| `references/keep-a-record.md` | registering, committing fills, asking for a validation, by script or with the SDK |
| `references/api.md` | every HTTP endpoint and MCP tool with its answer, and the limits |
| `references/safety.md` | what each check does not prove, keys, canonical addresses, untrusted text, look-alikes |
| `references/examples.md` | real answers from Monad mainnet, with a model reply |
| `scripts/trust.py` | stdlib reader: `status`, `agent`, `verify`, `gate`, `report`, `search`, `registry`, `hash`, `get`. Own keccak-256, reads the RPC directly |
| `scripts/record.mjs` | the writer, one file (viem inside): `whoami`, `register`, `commit`, `validate`. Plans by default (no key needed with `--wallet`), sends with `--user-confirmed` |
| `scripts/install.sh` | the installer above |

## Also available

- MCP server (read-only tools): `claude mcp add --transport http chord-trust https://chordsi.xyz/mcp`
- TrackRecord SDK (viem, ESM): https://chordsi.xyz/sdk/README.md
- The app and the registry explorer: https://chordsi.xyz/app#trust

MIT. Monad mainnet only. Agents run by Chord trade on paper, priced by real quotes.
