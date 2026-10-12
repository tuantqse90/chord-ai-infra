# TrustGate: one view before a contract trusts an agent

`TrustGate` at `0xcB30174c3Bf5f8170fA6769fe6D704F55968412A` (Monad mainnet, verified source) reads
two public records and applies a policy:

- TrackRecord: how many fills the agent committed, and when it last committed;
- the ERC-8004 Validation Registry: how many responses the trusted validators posted under the tag
  `replay`, and their integer average.

A fill count alone proves little (an owner can commit any hash). The validator's score of those
fills is what says they were real, so the policy asks for both. The policy, the validator list and
the tag are fixed at deployment: no owner, no admin, no upgrade. The validator list cannot be empty
(the registry would otherwise count every validator, including one the agent's owner controls).

## Interface

```solidity
interface ITrustGate {
    struct Policy {
        uint64 minFills;        // fills committed in TrackRecord
        uint64 minValidations;  // responses from the trusted validators under the tag
        uint8 minAvgScore;      // 0..100, integer average of those responses
        uint64 maxIdle;         // seconds since the agent's last commit; 0 = no limit
    }

    /// Whether the agent passes the default policy right now.
    function isTrusted(uint256 agentId) external view returns (bool ok);

    /// The same, with the numbers behind it.
    function check(uint256 agentId)
        external view returns (bool ok, uint64 fills, uint64 validations, uint8 avgScore, uint64 lastAt);

    /// Judge by the caller's own thresholds, over the same validators and tag.
    function checkWith(uint256 agentId, Policy calldata p)
        external view returns (bool ok, uint64 fills, uint64 validations, uint8 avgScore, uint64 lastAt);

    function policy() external view returns (Policy memory);
    function trustedValidators() external view returns (address[] memory);
    function tag() external view returns (string memory);
}
```

Default policy: `minFills 3`, `minValidations 1`, `minAvgScore 90`, `maxIdle 259200` (3 days).
Trusted validator: `0x98C5d05f35Afb00B04781762c47a7676Af3056a4`. `agentId` is the token id on the
canonical ERC-8004 Identity Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.

With no validations the average is 0, so any `minAvgScore` above 0 also needs at least one
validation. An agent that never committed counts as idle forever.

## Use it

```solidity
contract AgentBudget {
    ITrustGate constant GATE = ITrustGate(0xcB30174c3Bf5f8170fA6769fe6D704F55968412A);

    function fund(uint256 agentId, address payable to) external payable {
        require(GATE.isTrusted(agentId), "agent not trusted");
        (bool sent,) = to.call{value: msg.value}("");
        require(sent, "transfer failed");
    }
}
```

`isTrusted` only says the agent passes. It does not say the caller speaks for the agent: check that
yourself, as the example below does with the Identity Registry's `isAuthorizedOrOwner`.

A stricter rule without a new deployment:

```solidity
(bool ok,,,,) = GATE.checkWith(agentId, ITrustGate.Policy({minFills: 50, minValidations: 3, minAvgScore: 95, maxIdle: 1 days}));
```

## A full example: AgentVault

`AgentVault` at `0xbD0820B774D10D9B2AdbD7cDf78CfEAea064260d` is a pool of MON that trusted agents may
draw from, 0.01 MON per agent per epoch. Anyone can deposit (a deposit is a grant). The owner of an
agent, or an operator the owner approved, draws only while the gate trusts the agent, so an agent
that stops committing or loses its validator's approval is cut off with no one acting:

```solidity
function draw(uint256 agentId, address payable to, uint256 amount) external {
    if (!identity.isAuthorizedOrOwner(msg.sender, agentId)) revert NotAuthorized();
    if (!gate.isTrusted(agentId)) revert NotTrusted();
    uint256 epoch = block.timestamp / epochLength;
    uint256 used = drawn[agentId][epoch];
    if (amount > allowancePerEpoch - used) revert OverAllowance(allowancePerEpoch - used);
    drawn[agentId][epoch] = used + amount;          // recorded before sending
    emit Drawn(agentId, to, amount, epoch);
    (bool sent,) = to.call{value: amount}("");
    if (!sent) revert TransferFailed();
}
```

## Read it off-chain

```bash
python3 scripts/trust.py gate 10333        # from the RPC; exit 0 = trusted
cast call 0xcB30174c3Bf5f8170fA6769fe6D704F55968412A "check(uint256)(bool,uint64,uint64,uint8,uint64)" 10333 --rpc-url https://rpc.monad.xyz
curl -s https://chordsi.xyz/v1/trust/gate/10333      # the same numbers, plus the policy and what is missing
```

`trust.py gate` answers `ok`, `fills`, `validations`, `avgScore`, `lastCommit`, `policy` and
`missing`, for example `["2 of 3 fills committed", "0 of 1 validations", "no commit in the last 3 days"]`.

## Notes for integrators

- `ok` is a statement about now. Read it in the same transaction that acts on it; do not cache it.
- The gate trusts one validator today. A rule with other validators needs another gate deployment
  (the source is `contracts/src/TrustGate.sol`: constructor `(track, validation, policy, validators, tag)`).
- Monad mainnet is chain 143. Sending a transaction with `forge` or `cast` may need `--legacy`.
- The gate reads the validator's score as a number. What that number covers depends on the
  agent's documents (`references/verify.md`, "The score"); a contract that needs price-checked fills
  should also read the reports off-chain before it relies on an agent.
