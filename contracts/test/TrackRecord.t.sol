// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/TrackRecord.sol";
import "../src/erc8004/BootstrapUUPS.sol";
import "../src/erc8004/ValidationRegistryUpgradeable.sol";

/// The slice of the ERC-8004 Identity Registry both contracts read: owner, per-token approval, operator approval.
contract MockIdentity {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(uint256 id, address to) external { ownerOf[id] = to; }
    function approve(uint256 id, address to) external { require(msg.sender == ownerOf[id], "owner"); getApproved[id] = to; }
    function setApprovalForAll(address op, bool ok) external { isApprovedForAll[msg.sender][op] = ok; }

    function isAuthorizedOrOwner(address spender, uint256 id) external view returns (bool) {
        address o = ownerOf[id];
        require(o != address(0), "ERC721NonexistentToken");
        return spender == o || getApproved[id] == spender || isApprovedForAll[o][spender];
    }
}

contract TrackRecordTest is Test {
    MockIdentity identity;
    TrackRecord track;
    address owner = address(0xA11CE);
    address operator = address(0x0b);
    address stranger = address(0xBAD);
    uint256 constant AGENT = 7;

    event Committed(uint256 indexed agentId, uint64 indexed seq, bytes32 fillHash, bytes32 head);

    function setUp() public {
        identity = new MockIdentity();
        track = new TrackRecord(address(identity));
        identity.mint(AGENT, owner);
    }

    function hashes(uint256 n, uint256 salt) internal pure returns (bytes32[] memory h) {
        h = new bytes32[](n);
        for (uint256 i; i < n; ++i) h[i] = keccak256(abi.encode("fill", salt, i));
    }

    function test_chainMatchesOffChainRecompute() public {
        bytes32[] memory a = hashes(3, 1);
        bytes32[] memory b = hashes(2, 2);
        vm.prank(owner);
        (bytes32 h1, uint64 c1) = track.commit(AGENT, bytes32(0), a);
        assertEq(c1, 3);
        vm.prank(owner);
        (bytes32 h2, uint64 c2) = track.commit(AGENT, h1, b);
        assertEq(c2, 5);

        bytes32[] memory all = new bytes32[](5);
        for (uint256 i; i < 3; ++i) all[i] = a[i];
        for (uint256 i; i < 2; ++i) all[3 + i] = b[i];
        bytes32 expect;
        for (uint256 i; i < 5; ++i) expect = keccak256(abi.encodePacked(expect, all[i]));
        assertEq(h2, expect);
        assertEq(track.chainOf(all), expect);
        (bytes32 head, uint64 count, uint64 lastAt) = track.chains(AGENT);
        assertEq(head, expect);
        assertEq(count, 5);
        assertEq(lastAt, uint64(block.timestamp));
    }

    function test_emitsOneEventPerFill() public {
        bytes32[] memory a = hashes(2, 3);
        bytes32 h0 = keccak256(abi.encodePacked(bytes32(0), a[0]));
        bytes32 h1 = keccak256(abi.encodePacked(h0, a[1]));
        vm.expectEmit(true, true, false, true);
        emit Committed(AGENT, 1, a[0], h0);
        vm.expectEmit(true, true, false, true);
        emit Committed(AGENT, 2, a[1], h1);
        vm.prank(owner);
        track.commit(AGENT, bytes32(0), a);
    }

    function test_approvedOperatorsMayCommit() public {
        vm.prank(owner);
        identity.setApprovalForAll(operator, true);
        vm.prank(operator);
        track.commit(AGENT, bytes32(0), hashes(1, 4));
        (, uint64 count,) = track.chains(AGENT);
        assertEq(count, 1);
    }

    function test_strangerCannotCommit() public {
        vm.prank(stranger);
        vm.expectRevert(TrackRecord.NotAuthorized.selector);
        track.commit(AGENT, bytes32(0), hashes(1, 5));
    }

    function test_unknownAgentReverts() public {
        vm.prank(owner);
        vm.expectRevert();
        track.commit(999, bytes32(0), hashes(1, 6));
    }

    function test_staleHeadReverts() public {
        vm.prank(owner);
        (bytes32 h1,) = track.commit(AGENT, bytes32(0), hashes(1, 7));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TrackRecord.StaleHead.selector, h1, bytes32(0)));
        track.commit(AGENT, bytes32(0), hashes(1, 8));
    }

    function test_emptyBatchReverts() public {
        vm.prank(owner);
        vm.expectRevert(TrackRecord.EmptyBatch.selector);
        track.commit(AGENT, bytes32(0), new bytes32[](0));
    }
}

contract ValidationDeployTest is Test {
    MockIdentity identity;
    ValidationRegistryUpgradeable registry;
    address deployer = address(this);
    address agentOwner = address(0xA11CE);
    address validator = address(0x7A1);
    uint256 constant AGENT = 3;

    function setUp() public {
        identity = new MockIdentity();
        identity.mint(AGENT, agentOwner);
        BootstrapUUPS boot = new BootstrapUUPS();
        ValidationRegistryUpgradeable impl = new ValidationRegistryUpgradeable();
        ERC1967Proxy proxy = new ERC1967Proxy(address(boot), abi.encodeCall(BootstrapUUPS.initialize, (deployer)));
        BootstrapUUPS(address(proxy)).upgradeToAndCall(
            address(impl), abi.encodeCall(ValidationRegistryUpgradeable.initialize, (address(identity)))
        );
        registry = ValidationRegistryUpgradeable(address(proxy));
    }

    function test_deployedOverTheIdentityRegistry() public view {
        assertEq(registry.getIdentityRegistry(), address(identity));
        assertEq(registry.owner(), deployer);
    }

    function test_requestThenResponse() public {
        bytes32 req = keccak256("replay of fills 1..20");
        vm.prank(agentOwner);
        registry.validationRequest(validator, AGENT, "https://example.test/req.json", req);
        vm.prank(validator);
        registry.validationResponse(req, 92, "https://example.test/res.json", keccak256("res"), "replay");
        (address v, uint256 agentId, uint8 response,,, ) = registry.getValidationStatus(req);
        assertEq(v, validator);
        assertEq(agentId, AGENT);
        assertEq(response, 92);
        address[] memory vs = new address[](1);
        vs[0] = validator;
        (uint64 n, uint8 avg) = registry.getSummary(AGENT, vs, "replay");
        assertEq(n, 1);
        assertEq(avg, 92);
    }

    function test_onlyTheNamedValidatorResponds() public {
        bytes32 req = keccak256("r2");
        vm.prank(agentOwner);
        registry.validationRequest(validator, AGENT, "u", req);
        vm.expectRevert(bytes("not validator"));
        registry.validationResponse(req, 50, "u", bytes32(0), "replay");
    }

    function test_onlyTheAgentOwnerRequests() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("Not authorized"));
        registry.validationRequest(validator, AGENT, "u", keccak256("r3"));
    }
}
