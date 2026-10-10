// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/TrackRecord.sol";
import "../src/erc8004/BootstrapUUPS.sol";
import "../src/erc8004/ValidationRegistryUpgradeable.sol";

/// Deploys, over the canonical ERC-8004 Identity Registry on Monad:
///   1. TrackRecord(identity)
///   2. the ERC-8004 Validation Registry behind an ERC1967 proxy (BootstrapUUPS sets the owner, then the upgrade initializes)
/// forge script script/Deploy.s.sol --rpc-url $MONAD_RPC_URL --broadcast --legacy   (OPERATOR_PRIVATE_KEY in the env)
contract Deploy is Script {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    function run() external returns (address track, address validation) {
        uint256 key = vm.envUint("OPERATOR_PRIVATE_KEY");
        address owner = vm.addr(key);
        vm.startBroadcast(key);
        track = address(new TrackRecord(IDENTITY));
        BootstrapUUPS boot = new BootstrapUUPS();
        ValidationRegistryUpgradeable impl = new ValidationRegistryUpgradeable();
        ERC1967Proxy proxy = new ERC1967Proxy(address(boot), abi.encodeCall(BootstrapUUPS.initialize, (owner)));
        BootstrapUUPS(address(proxy)).upgradeToAndCall(address(impl), abi.encodeCall(ValidationRegistryUpgradeable.initialize, (IDENTITY)));
        validation = address(proxy);
        vm.stopBroadcast();
        require(ValidationRegistryUpgradeable(validation).getIdentityRegistry() == IDENTITY, "validation not initialized");
        console2.log("TrackRecord", track);
        console2.log("ValidationRegistry (proxy)", validation);
        console2.log("ValidationRegistry (implementation)", address(impl));
    }
}
