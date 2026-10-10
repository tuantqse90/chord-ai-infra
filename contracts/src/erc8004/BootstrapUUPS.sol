// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title BootstrapUUPS
/// @notice First implementation behind a fresh ERC1967 proxy: it only sets the owner (initializer version 1). The ERC-8004
///         registries' `initialize` is `reinitializer(2) onlyOwner`, so the proxy is created on this, then upgraded to the
///         registry with `upgradeToAndCall(registry, initialize(identityRegistry))` — the 8004 team deploys the same way.
contract BootstrapUUPS is OwnableUpgradeable, UUPSUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
