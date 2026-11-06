// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OpaqueNames} from "../../src/ethereum/ens/OpaqueNames.sol";

contract OpaqueNamesTest is Test {
    address internal constant IMPL = address(0x17fc96E5B93eb031B2DB2AAC415Dd507ad932DbF);
    address internal constant ETH_REGISTRY = address(0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4);
    OpaqueNames internal names;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        names = new OpaqueNames(ETH_REGISTRY, IMPL);
        // Both are PQ account clones, as PQAccountFactory makes them.
        bytes memory clone = abi.encodePacked(hex"363d3d373d3d3d363d73", IMPL, hex"5af43d82803e903d91602b57fd5bf3");
        vm.etch(alice, clone);
        vm.etch(bob, clone);
    }

    function node(string memory label) internal pure returns (bytes32) {
        bytes32 eth = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        return keccak256(abi.encodePacked(keccak256(abi.encodePacked(eth, keccak256("opaque"))), keccak256(bytes(label))));
    }

    function test_a_wallet_claims_its_name_and_it_resolves_to_the_wallet() public {
        vm.prank(alice);
        names.claim("alice");
        assertEq(names.nameOf(alice), "alice");
        assertEq(names.getResolver("alice"), address(names));
        assertEq(names.getSubregistry("alice"), address(0));
        assertEq(names.addr(node("alice")), alice);
        assertEq(names.addr(node("alice"), 60), abi.encodePacked(alice));
        assertEq(names.addr(node("alice"), 0x80000539), bytes(""));
        // ENSIP-10, as UniversalResolverV2 calls it.
        bytes memory out = names.resolve("", abi.encodeWithSignature("addr(bytes32,uint256)", node("alice"), 60));
        assertEq(abi.decode(out, (bytes)), abi.encodePacked(alice));
        (address parent, string memory label) = names.getParent();
        assertEq(parent, ETH_REGISTRY);
        assertEq(label, "opaque");
        assertTrue(names.supportsInterface(0x9061b923));
    }

    function test_only_an_opaque_pq_account_can_claim() public {
        vm.prank(address(0xE0A)); // an EOA: no code
        vm.expectRevert(OpaqueNames.NotAnOpaqueAccount.selector);
        names.claim("eoa");
        address other = address(0xC0DE);
        vm.etch(other, hex"6000");
        vm.prank(other);
        vm.expectRevert(OpaqueNames.NotAnOpaqueAccount.selector);
        names.claim("contract");
    }

    function test_a_name_is_claimed_once_and_a_wallet_holds_one() public {
        vm.prank(alice);
        names.claim("alice");
        vm.prank(bob);
        vm.expectRevert(OpaqueNames.Taken.selector);
        names.claim("alice");
        vm.prank(alice);
        vm.expectRevert(OpaqueNames.HasAName.selector);
        names.claim("alice2");
    }

    function test_labels_are_plain_lowercase() public {
        string[6] memory bad = ["ab", "Alice", "-alice", "alice-", "al.ce", "abcdefghijklmnopqrstuvwxyz0123456"];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(OpaqueNames.BadLabel.selector);
            names.claim(bad[i]);
        }
        vm.prank(alice);
        names.claim("al-1ce");
    }

    function test_a_released_name_resolves_to_nothing_and_can_be_claimed_again() public {
        vm.prank(alice);
        names.claim("alice");
        vm.prank(alice);
        names.release();
        assertEq(names.getResolver("alice"), address(0));
        assertEq(names.addr(node("alice")), address(0));
        vm.prank(bob);
        names.claim("alice");
        assertEq(names.addr(node("alice")), bob);
        vm.prank(alice);
        vm.expectRevert(OpaqueNames.NoName.selector);
        names.release();
    }

    function test_other_profiles_are_unsupported() public {
        vm.expectRevert(abi.encodeWithSelector(OpaqueNames.UnsupportedResolverProfile.selector, bytes4(keccak256("text(bytes32,string)"))));
        names.resolve("", abi.encodeWithSignature("text(bytes32,string)", node("alice"), "avatar"));
    }
}
