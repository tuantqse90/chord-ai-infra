// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TrackRecord} from "./TrackRecord.sol";

/// @notice The read side of the ERC-8004 Validation Registry this contract uses.
interface IValidationSummary {
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse);
}

/// @title TrustGate
/// @notice One view call that says whether an ERC-8004 agent has earned trust, for any contract about to hand it
///         capital or permissions.
/// @dev Reads two public records and applies a policy to them:
///        - TrackRecord: how many fills the agent committed at fill time, and when it last committed;
///        - the Validation Registry: how many responses the trusted validators posted under `tag`, and their average.
///      A fill count alone proves little (an owner can commit any hash); the validator's score of those fills is what
///      says they were real and good, so a useful policy asks for both.
///      The validator list cannot be empty: the registry counts every validator when the list is empty, and an agent's
///      owner may name any address as its validator, including one it controls.
///      The default policy, the validator list and the tag are fixed at deployment. No owner, no admin, no upgrade:
///      a contract that relies on this address gets the same rules for as long as it exists.
contract TrustGate {
    /// @dev Every threshold must hold. With no validations the average is 0, so a `minAvgScore` above 0 also needs
    ///      at least one validation. An agent that never committed counts as idle forever.
    struct Policy {
        uint64 minFills; // fills committed in TrackRecord
        uint64 minValidations; // responses from the trusted validators under `tag`
        uint8 minAvgScore; // 0..100, integer average of those responses
        uint64 maxIdle; // seconds since the agent's last commit; 0 = no limit
    }

    TrackRecord public immutable track;
    IValidationSummary public immutable validation;

    uint64 private immutable _minFills;
    uint64 private immutable _minValidations;
    uint8 private immutable _minAvgScore;
    uint64 private immutable _maxIdle;

    /// @notice Only responses posted with this tag count ("" = any tag).
    /// @dev Written once in the constructor (Solidity has no immutable strings or arrays), like `_validators`.
    string public tag;
    address[] private _validators;

    error NoValidators();
    error ScoreAbove100();

    constructor(
        TrackRecord track_,
        IValidationSummary validation_,
        Policy memory policy_,
        address[] memory validators_,
        string memory tag_
    ) {
        if (validators_.length == 0) revert NoValidators();
        if (policy_.minAvgScore > 100) revert ScoreAbove100();
        track = track_;
        validation = validation_;
        _minFills = policy_.minFills;
        _minValidations = policy_.minValidations;
        _minAvgScore = policy_.minAvgScore;
        _maxIdle = policy_.maxIdle;
        _validators = validators_;
        tag = tag_;
    }

    /// @notice Judge an agent by the default policy.
    /// @param agentId the agent's ERC-8004 id (Identity Registry token id)
    /// @return ok whether every threshold holds
    /// @return fills fills committed in TrackRecord
    /// @return validations responses from the trusted validators under `tag`
    /// @return avgScore their integer average, 0..100 (0 when there are none)
    /// @return lastAt timestamp of the agent's last commit (0 = never)
    function check(uint256 agentId)
        external
        view
        returns (bool ok, uint64 fills, uint64 validations, uint8 avgScore, uint64 lastAt)
    {
        return _check(agentId, policy());
    }

    /// @notice Judge an agent by a caller's own thresholds, over the same validators and tag.
    function checkWith(uint256 agentId, Policy calldata p)
        external
        view
        returns (bool ok, uint64 fills, uint64 validations, uint8 avgScore, uint64 lastAt)
    {
        return _check(agentId, p);
    }

    /// @notice Whether the agent passes the default policy right now.
    function isTrusted(uint256 agentId) external view returns (bool ok) {
        (ok,,,,) = _check(agentId, policy());
    }

    /// @notice The validators whose responses count.
    function trustedValidators() external view returns (address[] memory) {
        return _validators;
    }

    /// @notice The default policy `check` and `isTrusted` apply.
    function policy() public view returns (Policy memory) {
        return Policy(_minFills, _minValidations, _minAvgScore, _maxIdle);
    }

    function _check(uint256 agentId, Policy memory p)
        internal
        view
        returns (bool ok, uint64 fills, uint64 validations, uint8 avgScore, uint64 lastAt)
    {
        (, fills, lastAt) = track.chains(agentId);
        (validations, avgScore) = validation.getSummary(agentId, _validators, tag);
        ok = fills >= p.minFills && validations >= p.minValidations && avgScore >= p.minAvgScore
            && (p.maxIdle == 0 || (lastAt != 0 && block.timestamp - lastAt <= p.maxIdle));
    }
}
