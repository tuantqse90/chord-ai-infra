// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The part of the ERC-8004 Identity Registry this contract reads.
interface IIdentityAuth {
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

/// @title TrackRecord
/// @notice An ERC-8004 agent's fills, committed one by one as they happen, so its record cannot be written after the fact.
/// @dev For each fill the agent publishes a canonical JSON document; its owner (or an operator the owner approved in the
///      Identity Registry) appends the document's keccak-256 hash here at fill time. Per agent the contract keeps a chain:
///          head_0 = 0x0,   head_n = keccak256(abi.encodePacked(head_{n-1}, fillHash_n))
///      Anyone holding the published fills recomputes the chain and compares it with `chains(agentId).head`; each
///      `Committed` event carries the block it landed in, so a fill's record provably predates what happened after it.
///      Fills can only be appended: none can be removed, edited or reordered without changing every later head.
contract TrackRecord {
    struct Chain {
        bytes32 head;
        uint64 count;
        uint64 lastAt;
    }

    IIdentityAuth public immutable identity;
    mapping(uint256 agentId => Chain) public chains;

    /// @param seq 1-based position of this fill in the agent's chain
    event Committed(uint256 indexed agentId, uint64 indexed seq, bytes32 fillHash, bytes32 head);

    error NotAuthorized();
    error EmptyBatch();
    error StaleHead(bytes32 expected, bytes32 actual);

    constructor(address identity_) {
        identity = IIdentityAuth(identity_);
    }

    /// @notice Append fills to an agent's chain.
    /// @param agentId the agent's ERC-8004 id (Identity Registry token id)
    /// @param prevHead the head the caller built on (reverts on a race, so two committers never interleave silently)
    /// @param fillHashes keccak-256 of each fill's canonical JSON, oldest first
    function commit(uint256 agentId, bytes32 prevHead, bytes32[] calldata fillHashes)
        external
        returns (bytes32 head, uint64 count)
    {
        if (!identity.isAuthorizedOrOwner(msg.sender, agentId)) revert NotAuthorized();
        uint256 n = fillHashes.length;
        if (n == 0) revert EmptyBatch();
        Chain storage c = chains[agentId];
        head = c.head;
        if (head != prevHead) revert StaleHead(head, prevHead);
        count = c.count;
        for (uint256 i; i < n; ++i) {
            head = keccak256(abi.encodePacked(head, fillHashes[i]));
            unchecked {
                ++count;
            }
            emit Committed(agentId, count, fillHashes[i], head);
        }
        c.head = head;
        c.count = count;
        c.lastAt = uint64(block.timestamp);
    }

    /// @notice The head a list of fill hashes builds from the empty chain (for off-chain checks and tests).
    function chainOf(bytes32[] calldata fillHashes) external pure returns (bytes32 head) {
        for (uint256 i; i < fillHashes.length; ++i) {
            head = keccak256(abi.encodePacked(head, fillHashes[i]));
        }
    }
}
