// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IIdentityAuth} from "../TrackRecord.sol";
import {TrustGate} from "../TrustGate.sol";

/// @title AgentVault
/// @notice Example TrustGate consumer: a pool of native MON that trusted ERC-8004 agents may draw from, a capped
///         amount per agent per epoch.
/// @dev Anyone can deposit; a deposit is a grant and cannot be taken back. An agent's owner (or an operator the owner
///      approved in the Identity Registry) draws up to `allowancePerEpoch` per epoch, and only while the gate trusts
///      the agent, so an agent that stops committing fills or loses its validator's approval is cut off with no one
///      having to act.
///      Epochs are fixed windows (`block.timestamp / epochLength`), so an agent can draw a full allowance at the end of
///      one epoch and another at the start of the next.
///      The Identity Registry is read from the gate's TrackRecord, so "owner" means the same agent here as in the
///      record being judged. No owner, no admin.
contract AgentVault {
    TrustGate public immutable gate;
    IIdentityAuth public immutable identity;
    uint256 public immutable allowancePerEpoch;
    uint256 public immutable epochLength;

    mapping(uint256 agentId => mapping(uint256 epoch => uint256 amount)) public drawn;

    event Deposited(address indexed from, uint256 amount);
    event Drawn(uint256 indexed agentId, address indexed to, uint256 amount, uint256 indexed epoch);

    error NotAuthorized();
    error NotTrusted();
    error OverAllowance(uint256 remaining);
    error TransferFailed();
    error BadConfig();

    constructor(TrustGate gate_, uint256 allowancePerEpoch_, uint256 epochLength_) {
        // A zero epoch would make every draw revert, and with no admin the deposits would be stuck for good.
        if (allowancePerEpoch_ == 0 || epochLength_ == 0) revert BadConfig();
        gate = gate_;
        identity = gate_.track().identity();
        allowancePerEpoch = allowancePerEpoch_;
        epochLength = epochLength_;
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function deposit() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Send MON from the pool on behalf of a trusted agent.
    /// @param agentId the agent's ERC-8004 id; the caller must be its owner or an approved operator
    /// @param to who receives the MON
    /// @param amount wei, at most what is left of this epoch's allowance
    function draw(uint256 agentId, address payable to, uint256 amount) external {
        if (!identity.isAuthorizedOrOwner(msg.sender, agentId)) revert NotAuthorized();
        if (!gate.isTrusted(agentId)) revert NotTrusted();
        uint256 epoch = block.timestamp / epochLength;
        uint256 used = drawn[agentId][epoch];
        if (amount > allowancePerEpoch - used) revert OverAllowance(allowancePerEpoch - used);
        // Record the draw before sending, so a receiver that calls back in sees the allowance already spent.
        drawn[agentId][epoch] = used + amount;
        emit Drawn(agentId, to, amount, epoch);
        (bool sent,) = to.call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / epochLength;
    }

    /// @notice What the agent may still draw this epoch (ignores whether it is trusted and the pool's balance).
    function remaining(uint256 agentId) external view returns (uint256) {
        return allowancePerEpoch - drawn[agentId][currentEpoch()];
    }
}
