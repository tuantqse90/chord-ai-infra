// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../src/TrackRecord.sol";
import "../src/TrustGate.sol";
import "../src/examples/AgentVault.sol";

/// Deploys, over the live TrackRecord and Validation Registry on Monad:
///   1. TrustGate: default policy 3 fills, 1 validation, average >= 90, last commit within 3 days;
///      counts only "replay" responses from our validator
///   2. AgentVault(gate): 0.01 MON per agent per 1-day epoch
/// then reads gate.check for agent 10333 to prove the live wiring answers.
/// forge script script/DeployTrustGate.s.sol --rpc-url $MONAD_RPC_URL --broadcast --legacy   (OPERATOR_PRIVATE_KEY in the env)
contract DeployTrustGate is Script {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant TRACK = 0xf5650FB475747e2766faDb46aef735F3Ee4e9f09;
    address constant VALIDATION = 0x695CAaeD3D15212F9eC6500992f373f09439F38d;
    address constant VALIDATOR = 0x98C5d05f35Afb00B04781762c47a7676Af3056a4;
    uint256 constant PROBE_AGENT = 10333;

    function run() external returns (address gate, address vault) {
        uint256 key = vm.envUint("OPERATOR_PRIVATE_KEY");
        require(address(TrackRecord(TRACK).identity()) == IDENTITY, "TrackRecord reads another identity registry");
        address[] memory validators = new address[](1);
        validators[0] = VALIDATOR;
        TrustGate.Policy memory policy =
            TrustGate.Policy({minFills: 3, minValidations: 1, minAvgScore: 90, maxIdle: 3 days});

        vm.startBroadcast(key);
        TrustGate g = new TrustGate(TrackRecord(TRACK), IValidationSummary(VALIDATION), policy, validators, "replay");
        AgentVault v = new AgentVault(g, 0.01 ether, 1 days);
        vm.stopBroadcast();
        gate = address(g);
        vault = address(v);

        require(address(v.identity()) == IDENTITY, "vault reads another identity registry");
        console2.log("TrustGate", gate);
        console2.log("AgentVault", vault);
        try g.check(PROBE_AGENT) returns (bool ok, uint64 fills, uint64 validations, uint8 avgScore, uint64 lastAt) {
            console2.log("agent", PROBE_AGENT);
            console2.log("  trusted", ok);
            console2.log("  fills", uint256(fills));
            console2.log("  validations", uint256(validations));
            console2.log("  avgScore", uint256(avgScore));
            console2.log("  lastAt", uint256(lastAt));
        } catch {
            revert("gate.check reverted for agent 10333");
        }
    }
}
