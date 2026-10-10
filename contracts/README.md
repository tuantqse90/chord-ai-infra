# Contracts (Monad, chain 143)

| Contract | What it does |
| --- | --- |
| `src/TrackRecord.sol` | Per ERC-8004 agent, a hash chain of its fills: `head_n = keccak256(head_{n-1} ‖ fillHash_n)`. Only the agent's owner or an operator approved in the Identity Registry can append; nothing can be removed or reordered. |
| `src/erc8004/ValidationRegistryUpgradeable.sol` | The ERC-8004 Validation Registry, copied unchanged from [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts). Monad has no canonical one yet. |
| `src/erc8004/BootstrapUUPS.sol` | First implementation behind the registry's proxy: sets the owner, so `initialize` (`reinitializer(2) onlyOwner`) can run on upgrade. |

Canonical ERC-8004 registries used as they are: Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`.

```bash
git submodule update --init --recursive
forge test
forge script script/Deploy.s.sol --rpc-url $MONAD_RPC_URL --broadcast   # needs OPERATOR_PRIVATE_KEY
```
