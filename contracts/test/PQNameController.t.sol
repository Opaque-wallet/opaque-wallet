// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPQKeyRegistry} from "../src/opaque/interfaces/IPQKeyRegistry.sol";
import {PQKeyRegistry} from "../src/opaque/wallet/PQKeyRegistry.sol";
import {PQNameController} from "../src/ethereum/ens/PQNameController.sol";

/// Stands in for an ENS resolver: records who set what.
contract RecordKeeper {
    address public lastCaller;
    mapping(bytes32 => mapping(string => string)) public text;

    function setText(bytes32 node, string calldata key, string calldata value) external {
        lastCaller = msg.sender;
        text[node][key] = value;
    }
}

/// Signatures come from packages/pq-wallet (backend/scripts/ens-vectors.ts), as a
/// wallet makes them: the test runs the real cross-language path.
contract PQNameControllerTest is Test {
    PQKeyRegistry internal reg;
    PQNameController internal ctl;
    RecordKeeper internal keeper;

    bytes32 internal pkA;
    bytes internal call0;
    bytes internal call1;
    bytes internal sig0;
    bytes internal sig1;
    bytes internal sigWrongKey;
    uint256 internal deadline;
    bytes32 internal constant NODE = keccak256("opaquepq.eth");

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_800_000_000);
        string memory j = vm.readFile("test/fixtures/ens-controller-vectors.json");
        pkA = vm.parseJsonBytes32(j, ".pkA");
        call0 = vm.parseJsonBytes(j, ".call0");
        call1 = vm.parseJsonBytes(j, ".call1");
        sig0 = vm.parseJsonBytes(j, ".sig0");
        sig1 = vm.parseJsonBytes(j, ".sig1");
        sigWrongKey = vm.parseJsonBytes(j, ".sigWrongKey");
        deadline = vm.parseJsonUint(j, ".deadline");
        reg = new PQKeyRegistry();
        deployCodeTo("PQNameController.t.sol:RecordKeeper", vm.parseJsonAddress(j, ".target"));
        keeper = RecordKeeper(vm.parseJsonAddress(j, ".target"));
        deployCodeTo(
            "PQNameController.sol:PQNameController",
            abi.encode(IPQKeyRegistry(address(reg)), pkA, vm.parseJsonBytes32(j, ".pkB"), uint64(32), uint64(2_000_000_000)),
            vm.parseJsonAddress(j, ".controller")
        );
        ctl = PQNameController(vm.parseJsonAddress(j, ".controller"));
    }

    function test_itsKeyIsRegisteredUnderTheControllerItself() public view {
        assertEq(reg.stateOf(address(ctl)).pkCommitment, pkA);
        assertEq(reg.stateOf(address(ctl)).maxUses, 32);
    }

    function test_aForsSignatureActsAsTheNamesOwner() public {
        // Submitted by an arbitrary ECDSA account: paying for the call authorises nothing.
        vm.prank(address(0xBEEF));
        ctl.execute(address(keeper), call0, deadline, sig0);
        assertEq(keeper.lastCaller(), address(ctl));
        assertEq(reg.stateOf(address(ctl)).useCount, 1);
        // The next signature is good at the next use count.
        ctl.execute(address(keeper), call1, deadline, sig1);
        assertEq(keeper.text(NODE, "url"), "https://opaque.credit");
    }

    function test_aSignatureIsGoodOnce() public {
        ctl.execute(address(keeper), call0, deadline, sig0);
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        ctl.execute(address(keeper), call0, deadline, sig0);
    }

    function test_anotherKeyGetsNothing() public {
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        ctl.execute(address(keeper), call0, deadline, sigWrongKey);
    }

    function test_theSignatureBindsTargetDataAndDeadline() public {
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        ctl.execute(address(keeper), call1, deadline, sig0);
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        ctl.execute(address(0xD00D), call0, deadline, sig0);
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        ctl.execute(address(keeper), call0, deadline - 1, sig0);
    }

    function test_aLateSignatureIsRefused() public {
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(PQNameController.Expired.selector, deadline));
        ctl.execute(address(keeper), call0, deadline, sig0);
    }

    function test_itAcceptsTheNameAsAnErc1155Token() public view {
        assertEq(ctl.onERC1155Received(address(0), address(0), 1, 1, ""), PQNameController.onERC1155Received.selector);
        assertTrue(ctl.supportsInterface(0x4e2312e0));
    }
}
