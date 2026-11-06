// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {IPQKeyRegistry} from "../../src/opaque/interfaces/IPQKeyRegistry.sol";
import {PQAdmin, PQAdminFactory} from "../../src/ethereum/admin/PQAdmin.sol";
import {DemoProtocolFactory, DemoProtocolV1, DemoProtocolV2} from "../../src/ethereum/admin/DemoProtocol.sol";
import {DemoRolesFactory, DemoRolesV1, DemoRolesV2} from "../../src/ethereum/admin/DemoRolesProtocol.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/// The registry's two calls PQAdmin makes; the test "signs" a payload by marking it. The real
/// registry and real FORS+C signatures are on Sepolia (backend/ethereum/admin-sepolia.ts).
contract MarkRegistry {
    mapping(address => bytes32) public key;
    mapping(bytes32 => bool) public signed;
    function setKey(address who, bytes32 k) external { key[who] = k; }
    function sign(address who, bytes calldata payload) external { signed[keccak256(abi.encode(who, payload))] = true; }
    function stateOf(address who) external view returns (IPQKeyRegistry.PQKeyState memory s) { s.pkCommitment = key[who]; }
    function consume(address who, bytes calldata payload, bytes calldata) external {
        bytes32 id = keccak256(abi.encode(who, payload));
        require(signed[id], "BadSignature");
        delete signed[id];
    }
}

/// OpenZeppelin's own two-step owner and role admin, unchanged.
contract TwoStep is Ownable2Step {
    uint256 public paused;
    constructor(address owner_) Ownable(owner_) {}
    function pause() external onlyOwner { paused = 1; }
}
contract Roles is AccessControl {
    constructor(address admin) { _grantRole(DEFAULT_ADMIN_ROLE, admin); }
}

contract PQAdminTest is Test {
    bytes32 constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103; // EIP-1967
    address constant OWNER = address(0xEC05A); // a protocol team's MetaMask address
    address constant OTHER = address(0x07E4);
    address constant ANYONE = address(0xA11);

    MarkRegistry registry;
    PQAdminFactory factory;
    DemoProtocolV1 protocol;
    ProxyAdmin proxyAdmin;
    DemoProtocolV2 v2;

    function setUp() public {
        registry = new MarkRegistry();
        factory = new PQAdminFactory(IPQKeyRegistry(address(registry)));
        DemoProtocolFactory demos = new DemoProtocolFactory(address(new DemoProtocolV1()));
        v2 = new DemoProtocolV2();
        vm.prank(OWNER);
        protocol = DemoProtocolV1(demos.create());
        proxyAdmin = ProxyAdmin(address(uint160(uint256(vm.load(address(protocol), ADMIN_SLOT)))));
    }

    function _admin(address guardian) internal returns (PQAdmin) {
        registry.setKey(guardian, keccak256(abi.encode("FORS+C key of", guardian)));
        return factory.create(guardian);
    }

    /// The button: both of the protocol's admin keys handed to the owner's PQAdmin.
    function _handover() internal returns (PQAdmin a) {
        a = _admin(OWNER);
        vm.startPrank(OWNER);
        proxyAdmin.transferOwnership(address(a));
        protocol.transferOwnership(address(a));
        vm.stopPrank();
    }

    function _sign(PQAdmin a, address guardian, address target, bytes memory data) internal returns (uint256 deadline) {
        deadline = block.timestamp + 1 hours;
        registry.sign(guardian, a.payload(target, data, deadline));
    }

    function _upgrade() internal view returns (bytes memory) {
        return abi.encodeCall(ProxyAdmin.upgradeAndCall, (ITransparentUpgradeableProxy(address(protocol)), address(v2), ""));
    }

    function test_the_demo_starts_with_two_ecdsa_admin_keys() public view {
        assertEq(proxyAdmin.owner(), OWNER);
        assertEq(protocol.owner(), OWNER);
        assertEq(protocol.version(), 1);
    }

    function test_no_admin_without_a_guard_key() public {
        vm.expectRevert(PQAdminFactory.NoGuardKey.selector);
        factory.create(OWNER);
    }

    function test_its_address_is_known_before_it_exists() public {
        address predicted = factory.adminOf(OWNER);
        assertEq(predicted.code.length, 0);
        assertEq(address(_admin(OWNER)), predicted);
        assertEq(PQAdmin(predicted).guardian(), OWNER);
    }

    function test_after_the_handover_the_ecdsa_key_alone_changes_nothing() public {
        _handover();
        // Q-Day: the old owner's key, cracked or not, is no admin any more.
        vm.startPrank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OWNER));
        proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(address(protocol)), address(v2), "");
        vm.expectRevert(abi.encodeWithSelector(DemoProtocolV1.OwnableUnauthorizedAccount.selector, OWNER));
        protocol.setFee(666);
        vm.stopPrank();
        assertEq(protocol.version(), 1);
        assertEq(protocol.fee(), 0);
    }

    function test_a_signed_upgrade_goes_through_sent_by_anyone() public {
        PQAdmin a = _handover();
        uint256 deadline = _sign(a, OWNER, address(proxyAdmin), _upgrade());
        vm.prank(ANYONE); // paying authorises nothing: the signature is the authority
        a.execute(address(proxyAdmin), _upgrade(), deadline, "fors");
        assertEq(protocol.version(), 2);
    }

    function test_a_signature_runs_once_and_only_the_call_it_names() public {
        PQAdmin a = _handover();
        bytes memory set1 = abi.encodeCall(DemoProtocolV1.setFee, (1));
        uint256 deadline = _sign(a, OWNER, address(protocol), set1);
        vm.expectRevert(bytes("BadSignature")); // the signature names setFee(1)
        a.execute(address(protocol), abi.encodeCall(DemoProtocolV1.setFee, (2)), deadline, "fors");
        vm.expectRevert(bytes("BadSignature")); // and this protocol, not another target
        a.execute(address(proxyAdmin), set1, deadline, "fors");
        a.execute(address(protocol), set1, deadline, "fors");
        assertEq(protocol.fee(), 1);
        vm.expectRevert(bytes("BadSignature")); // used: the registry has moved past it
        a.execute(address(protocol), set1, deadline, "fors");
    }

    function test_one_admins_signature_cannot_drive_another() public {
        PQAdmin mine = _handover();
        PQAdmin theirs = _admin(OTHER);
        bytes memory set1 = abi.encodeCall(DemoProtocolV1.setFee, (1));
        uint256 deadline = _sign(theirs, OTHER, address(protocol), set1);
        vm.expectRevert(bytes("BadSignature")); // signed for their admin, which owns nothing here
        mine.execute(address(protocol), set1, deadline, "fors");
    }

    function test_an_expired_signature_is_refused() public {
        PQAdmin a = _handover();
        uint256 deadline = _sign(a, OWNER, address(protocol), abi.encodeCall(DemoProtocolV1.setFee, (1)));
        vm.warp(deadline + 1);
        vm.expectRevert(PQAdmin.Expired.selector);
        a.execute(address(protocol), abi.encodeCall(DemoProtocolV1.setFee, (1)), deadline, "fors");
    }

    function test_a_failed_call_reverts_and_keeps_the_signature() public {
        PQAdmin a = _admin(OWNER); // created, but nothing handed to it yet
        bytes memory set1 = abi.encodeCall(DemoProtocolV1.setFee, (1));
        uint256 deadline = _sign(a, OWNER, address(protocol), set1);
        vm.expectRevert(abi.encodeWithSelector(PQAdmin.CallFailed.selector, abi.encodeWithSelector(DemoProtocolV1.OwnableUnauthorizedAccount.selector, address(a))));
        a.execute(address(protocol), set1, deadline, "fors");
        vm.prank(OWNER);
        protocol.transferOwnership(address(a));
        a.execute(address(protocol), set1, deadline, "fors"); // the revert left the use unspent
        assertEq(protocol.fee(), 1);
    }

    function test_openzeppelin_ownable2step_hands_over_with_a_signed_accept() public {
        PQAdmin a = _admin(OWNER);
        TwoStep thing = new TwoStep(OWNER);
        vm.prank(OWNER);
        thing.transferOwnership(address(a));
        uint256 deadline = _sign(a, OWNER, address(thing), abi.encodeCall(Ownable2Step.acceptOwnership, ()));
        a.execute(address(thing), abi.encodeCall(Ownable2Step.acceptOwnership, ()), deadline, "fors");
        assertEq(thing.owner(), address(a));
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OWNER));
        thing.pause();
        deadline = _sign(a, OWNER, address(thing), abi.encodeCall(TwoStep.pause, ()));
        a.execute(address(thing), abi.encodeCall(TwoStep.pause, ()), deadline, "fors");
        assertEq(thing.paused(), 1);
    }

    function test_openzeppelin_access_control_admin_role_hands_over() public {
        PQAdmin a = _admin(OWNER);
        Roles roles = new Roles(OWNER);
        bytes32 adminRole = roles.DEFAULT_ADMIN_ROLE();
        vm.startPrank(OWNER);
        roles.grantRole(adminRole, address(a));
        roles.renounceRole(adminRole, OWNER);
        vm.expectRevert(); // AccessControlUnauthorizedAccount: the ECDSA key holds no role now
        roles.grantRole(adminRole, OWNER);
        vm.stopPrank();
        bytes memory grant = abi.encodeCall(AccessControl.grantRole, (keccak256("MINTER"), ANYONE));
        uint256 deadline = _sign(a, OWNER, address(roles), grant);
        a.execute(address(roles), grant, deadline, "fors");
        assertTrue(roles.hasRole(keccak256("MINTER"), ANYONE));
    }

    bytes32 constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50; // EIP-1967

    function test_every_role_and_a_beacon_hand_over_in_the_order_the_page_uses() public {
        PQAdmin a = _admin(OWNER);
        DemoRolesFactory roles = new DemoRolesFactory(address(new DemoRolesV1()));
        DemoRolesV2 rolesV2 = new DemoRolesV2();
        vm.prank(OWNER);
        DemoRolesV1 p = DemoRolesV1(roles.create());
        UpgradeableBeacon beacon = UpgradeableBeacon(address(uint160(uint256(vm.load(address(p), BEACON_SLOT)))));
        assertEq(beacon.owner(), OWNER);
        bytes32 admin = p.DEFAULT_ADMIN_ROLE();

        vm.startPrank(OWNER);
        beacon.transferOwnership(address(a));
        // Every role the admin role manages first, while the wallet still holds it; the admin role last.
        p.grantRole(p.FEE_ROLE(), address(a));
        p.renounceRole(p.FEE_ROLE(), OWNER);
        p.grantRole(p.PAUSER_ROLE(), address(a));
        p.renounceRole(p.PAUSER_ROLE(), OWNER);
        p.grantRole(admin, address(a));
        p.renounceRole(admin, OWNER);
        // Q-Day: the ECDSA key alone can't upgrade, set the fee, pause, or take any role back.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OWNER));
        beacon.upgradeTo(address(rolesV2));
        vm.expectRevert();
        p.setFee(1);
        vm.expectRevert();
        p.pause();
        vm.expectRevert();
        p.grantRole(admin, OWNER);
        vm.stopPrank();

        bytes memory fee = abi.encodeCall(DemoRolesV1.setFee, (9));
        a.execute(address(p), fee, _sign(a, OWNER, address(p), fee), "fors");
        bytes memory up = abi.encodeCall(UpgradeableBeacon.upgradeTo, (address(rolesV2)));
        a.execute(address(beacon), up, _sign(a, OWNER, address(beacon), up), "fors");
        assertEq(p.fee(), 9);
        assertEq(p.version(), 2);
        assertTrue(p.hasRole(admin, address(a)) && !p.hasRole(admin, OWNER));
    }
}
