// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockIdentity} from "./TrackRecord.t.sol";
import "../src/TrackRecord.sol";
import "../src/TrustGate.sol";
import "../src/examples/AgentVault.sol";
import "../src/erc8004/BootstrapUUPS.sol";
import "../src/erc8004/ValidationRegistryUpgradeable.sol";

/// getSummary with the reference registry's filters: validator list (empty = any) and tag (empty = any).
contract MockValidation {
    struct Response {
        address validator;
        uint8 response;
        string tag;
    }

    mapping(uint256 => Response[]) internal byAgent;

    function respond(uint256 agentId, address validator, uint8 response, string calldata tag) external {
        byAgent[agentId].push(Response(validator, response, tag));
    }

    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        Response[] storage rs = byAgent[agentId];
        uint256 total;
        for (uint256 i; i < rs.length; i++) {
            bool matchValidator = validatorAddresses.length == 0;
            for (uint256 j; j < validatorAddresses.length && !matchValidator; j++) {
                matchValidator = rs[i].validator == validatorAddresses[j];
            }
            bool matchTag = bytes(tag).length == 0 || keccak256(bytes(rs[i].tag)) == keccak256(bytes(tag));
            if (matchValidator && matchTag) {
                total += rs[i].response;
                count++;
            }
        }
        avgResponse = count > 0 ? uint8(total / count) : 0;
    }
}

/// Has no receive or fallback, so any MON sent to it bounces.
contract Rejecter {}

/// Calls draw again from inside the transfer it receives.
contract Reenterer {
    AgentVault public immutable vault;
    uint256 public immutable agentId;
    uint256 public amount;
    bool public tried;
    bool public succeeded;
    bytes public error_;

    constructor(AgentVault vault_, uint256 agentId_) {
        vault = vault_;
        agentId = agentId_;
    }

    function arm(uint256 amount_) external {
        amount = amount_;
    }

    receive() external payable {
        if (tried) return;
        tried = true;
        try vault.draw(agentId, payable(address(this)), amount) {
            succeeded = true;
        } catch (bytes memory err) {
            error_ = err;
        }
    }
}

abstract contract GateFixture is Test {
    MockIdentity identity;
    TrackRecord track;
    MockValidation validation;
    TrustGate gate;
    AgentVault vault;

    address owner = address(0xA11CE);
    address operator = address(0x0b);
    address stranger = address(0xBAD);
    address validator = address(0x7A1);
    address rogueValidator = address(0x666);
    address payable payee = payable(address(0xFEE));
    uint256 constant AGENT = 7;
    uint256 constant ALLOWANCE = 0.01 ether;
    uint256 constant EPOCH = 1 days;
    uint256 constant START = 1_760_000_000;

    function setUp() public virtual {
        vm.warp(START);
        identity = new MockIdentity();
        identity.mint(AGENT, owner);
        track = new TrackRecord(address(identity));
        validation = new MockValidation();
        gate = new TrustGate(track, IValidationSummary(address(validation)), defaultPolicy(), validators(), "replay");
        vault = new AgentVault(gate, ALLOWANCE, EPOCH);
        vault.deposit{value: 1 ether}();
    }

    function defaultPolicy() internal pure returns (TrustGate.Policy memory) {
        return TrustGate.Policy({minFills: 3, minValidations: 1, minAvgScore: 90, maxIdle: 3 days});
    }

    function validators() internal view returns (address[] memory vs) {
        vs = new address[](1);
        vs[0] = validator;
    }

    function commitFills(uint256 n) internal {
        (bytes32 head, uint64 count,) = track.chains(AGENT);
        bytes32[] memory h = new bytes32[](n);
        for (uint256 i; i < n; ++i) h[i] = keccak256(abi.encode("fill", count, i));
        vm.prank(owner);
        track.commit(AGENT, head, h);
    }

    /// Three fills and one "replay" score of 95 from the trusted validator: passes the default policy.
    function makeTrusted() internal {
        commitFills(3);
        validation.respond(AGENT, validator, 95, "replay");
    }
}

contract TrustGateTest is GateFixture {
    function test_passesWhenEveryThresholdHolds() public {
        makeTrusted();
        (bool ok, uint64 fills, uint64 validations, uint8 avg, uint64 lastAt) = gate.check(AGENT);
        assertTrue(ok);
        assertEq(fills, 3);
        assertEq(validations, 1);
        assertEq(avg, 95);
        assertEq(lastAt, uint64(START));
        assertTrue(gate.isTrusted(AGENT));
    }

    function test_failsBelowMinFills() public {
        commitFills(2);
        validation.respond(AGENT, validator, 95, "replay");
        (bool ok, uint64 fills,,,) = gate.check(AGENT);
        assertFalse(ok);
        assertEq(fills, 2);
        commitFills(1);
        assertTrue(gate.isTrusted(AGENT));
    }

    function test_failsBelowMinValidations() public {
        commitFills(3);
        (bool ok,, uint64 validations,,) = gate.check(AGENT);
        assertFalse(ok);
        assertEq(validations, 0);
    }

    function test_failsBelowMinAvgScore() public {
        commitFills(3);
        validation.respond(AGENT, validator, 95, "replay");
        validation.respond(AGENT, validator, 80, "replay");
        (bool ok,, uint64 validations, uint8 avg,) = gate.check(AGENT);
        assertFalse(ok);
        assertEq(validations, 2);
        assertEq(avg, 87);
        validation.respond(AGENT, validator, 95, "replay"); // (95 + 80 + 95) / 3 = 90, exactly the bar
        (ok,,, avg,) = gate.check(AGENT);
        assertTrue(ok);
        assertEq(avg, 90);
    }

    function test_maxIdleCutsOffAQuietAgent() public {
        makeTrusted();
        vm.warp(START + 3 days);
        assertTrue(gate.isTrusted(AGENT));
        vm.warp(START + 3 days + 1);
        assertFalse(gate.isTrusted(AGENT));
        commitFills(1);
        (bool ok,,,, uint64 lastAt) = gate.check(AGENT);
        assertTrue(ok);
        assertEq(lastAt, uint64(START + 3 days + 1));
    }

    function test_neverCommittedIsIdleForever() public {
        validation.respond(AGENT, validator, 100, "replay");
        TrustGate.Policy memory p = TrustGate.Policy({minFills: 0, minValidations: 1, minAvgScore: 90, maxIdle: 1});
        (bool ok,,,,) = gate.checkWith(AGENT, p);
        assertFalse(ok);
        p.maxIdle = 0;
        (ok,,,,) = gate.checkWith(AGENT, p);
        assertTrue(ok);
    }

    function test_untrustedValidatorDoesNotCount() public {
        commitFills(3);
        for (uint256 i; i < 5; ++i) validation.respond(AGENT, rogueValidator, 100, "replay");
        (bool ok,, uint64 validations, uint8 avg,) = gate.check(AGENT);
        assertFalse(ok);
        assertEq(validations, 0);
        assertEq(avg, 0);
        // nor does it lift a low score from the trusted one
        validation.respond(AGENT, validator, 80, "replay");
        (ok,, validations, avg,) = gate.check(AGENT);
        assertFalse(ok);
        assertEq(validations, 1);
        assertEq(avg, 80);
    }

    function test_otherTagDoesNotCount() public {
        commitFills(3);
        validation.respond(AGENT, validator, 100, "uptime");
        (bool ok,, uint64 validations,,) = gate.check(AGENT);
        assertFalse(ok);
        assertEq(validations, 0);
    }

    function test_emptyTagCountsEveryTag() public {
        TrustGate anyTag =
            new TrustGate(track, IValidationSummary(address(validation)), defaultPolicy(), validators(), "");
        commitFills(3);
        validation.respond(AGENT, validator, 100, "uptime");
        assertTrue(anyTag.isTrusted(AGENT));
        assertFalse(gate.isTrusted(AGENT));
    }

    function test_checkWithOverridesTheDefault() public {
        commitFills(1);
        assertFalse(gate.isTrusted(AGENT));
        TrustGate.Policy memory loose = TrustGate.Policy({minFills: 1, minValidations: 0, minAvgScore: 0, maxIdle: 0});
        (bool ok, uint64 fills,,,) = gate.checkWith(AGENT, loose);
        assertTrue(ok);
        assertEq(fills, 1);

        commitFills(2);
        validation.respond(AGENT, validator, 95, "replay");
        assertTrue(gate.isTrusted(AGENT));
        TrustGate.Policy memory strict =
            TrustGate.Policy({minFills: 10, minValidations: 1, minAvgScore: 90, maxIdle: 3 days});
        (ok,,,,) = gate.checkWith(AGENT, strict);
        assertFalse(ok);
        strict = TrustGate.Policy({minFills: 3, minValidations: 1, minAvgScore: 96, maxIdle: 3 days});
        (ok,,,,) = gate.checkWith(AGENT, strict);
        assertFalse(ok);
        strict = TrustGate.Policy({minFills: 3, minValidations: 2, minAvgScore: 90, maxIdle: 3 days});
        (ok,,,,) = gate.checkWith(AGENT, strict);
        assertFalse(ok);
    }

    function test_unknownAgentReadsWithoutReverting() public view {
        (bool ok, uint64 fills, uint64 validations, uint8 avg, uint64 lastAt) = gate.check(424242);
        assertFalse(ok);
        assertEq(fills, 0);
        assertEq(validations, 0);
        assertEq(avg, 0);
        assertEq(lastAt, 0);
    }

    function test_settingsAreReadable() public view {
        address[] memory vs = gate.trustedValidators();
        assertEq(vs.length, 1);
        assertEq(vs[0], validator);
        assertEq(gate.tag(), "replay");
        TrustGate.Policy memory p = gate.policy();
        assertEq(p.minFills, 3);
        assertEq(p.minValidations, 1);
        assertEq(p.minAvgScore, 90);
        assertEq(p.maxIdle, 3 days);
        assertEq(address(gate.track()), address(track));
        assertEq(address(gate.validation()), address(validation));
    }

    function test_rejectsAnEmptyValidatorList() public {
        vm.expectRevert(TrustGate.NoValidators.selector);
        new TrustGate(track, IValidationSummary(address(validation)), defaultPolicy(), new address[](0), "replay");
    }

    function test_rejectsAScoreAbove100() public {
        TrustGate.Policy memory p = defaultPolicy();
        p.minAvgScore = 101;
        vm.expectRevert(TrustGate.ScoreAbove100.selector);
        new TrustGate(track, IValidationSummary(address(validation)), p, validators(), "replay");
    }

    /// The same gate over the reference Validation Registry: a request without a response does not count.
    function test_overTheReferenceValidationRegistry() public {
        BootstrapUUPS boot = new BootstrapUUPS();
        ValidationRegistryUpgradeable impl = new ValidationRegistryUpgradeable();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(boot), abi.encodeCall(BootstrapUUPS.initialize, (address(this))));
        BootstrapUUPS(address(proxy)).upgradeToAndCall(
            address(impl), abi.encodeCall(ValidationRegistryUpgradeable.initialize, (address(identity)))
        );
        ValidationRegistryUpgradeable registry = ValidationRegistryUpgradeable(address(proxy));
        TrustGate real = new TrustGate(track, IValidationSummary(address(registry)), defaultPolicy(), validators(), "replay");

        commitFills(3);
        vm.startPrank(owner);
        registry.validationRequest(validator, AGENT, "u", keccak256("pending"));
        registry.validationRequest(validator, AGENT, "u", keccak256("answered"));
        registry.validationRequest(rogueValidator, AGENT, "u", keccak256("rogue"));
        vm.stopPrank();
        assertFalse(real.isTrusted(AGENT));

        vm.prank(rogueValidator);
        registry.validationResponse(keccak256("rogue"), 100, "u", bytes32(0), "replay");
        assertFalse(real.isTrusted(AGENT));

        vm.prank(validator);
        registry.validationResponse(keccak256("answered"), 92, "u", bytes32(0), "replay");
        (bool ok,, uint64 validations, uint8 avg,) = real.check(AGENT);
        assertTrue(ok);
        assertEq(validations, 1);
        assertEq(avg, 92);
    }
}

contract AgentVaultTest is GateFixture {
    event Deposited(address indexed from, uint256 amount);
    event Drawn(uint256 indexed agentId, address indexed to, uint256 amount, uint256 indexed epoch);

    function test_depositAndPlainTransferBothCount() public {
        vm.deal(stranger, 2 ether);
        vm.expectEmit(true, false, false, true);
        emit Deposited(stranger, 0.5 ether);
        vm.prank(stranger);
        vault.deposit{value: 0.5 ether}();
        vm.expectEmit(true, false, false, true);
        emit Deposited(stranger, 0.25 ether);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 0.25 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 1.75 ether);
    }

    function test_drawWithinAllowance() public {
        makeTrusted();
        uint256 epoch = START / EPOCH;
        vm.expectEmit(true, true, true, true);
        emit Drawn(AGENT, payee, 0.004 ether, epoch);
        vm.prank(owner);
        vault.draw(AGENT, payee, 0.004 ether);
        vm.prank(owner);
        vault.draw(AGENT, payee, 0.006 ether);
        assertEq(payee.balance, ALLOWANCE);
        assertEq(vault.drawn(AGENT, epoch), ALLOWANCE);
        assertEq(vault.remaining(AGENT), 0);
        assertEq(address(vault).balance, 1 ether - ALLOWANCE);
    }

    function test_overAllowanceReverts() public {
        makeTrusted();
        vm.prank(owner);
        vault.draw(AGENT, payee, 0.006 ether);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.OverAllowance.selector, 0.004 ether));
        vault.draw(AGENT, payee, 0.005 ether);
        assertEq(vault.remaining(AGENT), 0.004 ether);
        assertEq(payee.balance, 0.006 ether);
    }

    function test_singleDrawOverAllowanceReverts() public {
        makeTrusted();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.OverAllowance.selector, ALLOWANCE));
        vault.draw(AGENT, payee, ALLOWANCE + 1);
    }

    function test_newEpochResetsTheAllowance() public {
        makeTrusted();
        vm.prank(owner);
        vault.draw(AGENT, payee, ALLOWANCE);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.OverAllowance.selector, 0));
        vault.draw(AGENT, payee, 1);

        uint256 next = (START / EPOCH + 1) * EPOCH; // first second of the next epoch, still within maxIdle
        vm.warp(next);
        assertEq(vault.remaining(AGENT), ALLOWANCE);
        vm.prank(owner);
        vault.draw(AGENT, payee, ALLOWANCE);
        assertEq(payee.balance, 2 * ALLOWANCE);
        assertEq(vault.drawn(AGENT, START / EPOCH), ALLOWANCE);
        assertEq(vault.drawn(AGENT, START / EPOCH + 1), ALLOWANCE);
    }

    function test_untrustedAgentReverts() public {
        commitFills(3); // no validation yet
        vm.prank(owner);
        vm.expectRevert(AgentVault.NotTrusted.selector);
        vault.draw(AGENT, payee, 1);
    }

    function test_agentGoingQuietLosesAccess() public {
        makeTrusted();
        vm.prank(owner);
        vault.draw(AGENT, payee, 1);
        vm.warp(START + 3 days + 1);
        vm.prank(owner);
        vm.expectRevert(AgentVault.NotTrusted.selector);
        vault.draw(AGENT, payee, 1);
    }

    function test_strangerCannotDraw() public {
        makeTrusted();
        vm.prank(stranger);
        vm.expectRevert(AgentVault.NotAuthorized.selector);
        vault.draw(AGENT, payee, 1);
    }

    function test_approvedOperatorMayDraw() public {
        makeTrusted();
        vm.prank(owner);
        identity.setApprovalForAll(operator, true);
        vm.prank(operator);
        vault.draw(AGENT, payee, 0.003 ether);
        assertEq(payee.balance, 0.003 ether);
    }

    function test_revertingReceiverRevertsWithTransferFailed() public {
        makeTrusted();
        Rejecter r = new Rejecter();
        vm.prank(owner);
        vm.expectRevert(AgentVault.TransferFailed.selector);
        vault.draw(AGENT, payable(address(r)), 0.001 ether);
        assertEq(vault.drawn(AGENT, START / EPOCH), 0);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_drawingMoreThanThePoolHoldsReverts() public {
        makeTrusted();
        AgentVault small = new AgentVault(gate, 2 ether, EPOCH);
        small.deposit{value: 1 ether}();
        vm.prank(owner);
        vm.expectRevert(AgentVault.TransferFailed.selector);
        small.draw(AGENT, payee, 1.5 ether);
    }

    function test_reentrantDrawCannotExceedTheAllowance() public {
        makeTrusted();
        Reenterer r = new Reenterer(vault, AGENT);
        vm.prank(owner);
        identity.setApprovalForAll(address(r), true);
        r.arm(0.006 ether);
        vm.prank(owner);
        vault.draw(AGENT, payable(address(r)), 0.006 ether);
        assertTrue(r.tried());
        assertFalse(r.succeeded());
        assertEq(r.error_(), abi.encodeWithSelector(AgentVault.OverAllowance.selector, 0.004 ether));
        assertEq(vault.drawn(AGENT, START / EPOCH), 0.006 ether);
        assertEq(address(r).balance, 0.006 ether);
    }

    function test_identityComesFromTheGate() public view {
        assertEq(address(vault.identity()), address(identity));
        assertEq(address(vault.gate()), address(gate));
        assertEq(vault.allowancePerEpoch(), ALLOWANCE);
        assertEq(vault.epochLength(), EPOCH);
    }

    function test_rejectsAZeroEpochOrAllowance() public {
        vm.expectRevert(AgentVault.BadConfig.selector);
        new AgentVault(gate, ALLOWANCE, 0);
        vm.expectRevert(AgentVault.BadConfig.selector);
        new AgentVault(gate, 0, EPOCH);
    }
}
