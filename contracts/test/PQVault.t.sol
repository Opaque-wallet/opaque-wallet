// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPQKeyRegistry} from "../src/opaque/interfaces/IPQKeyRegistry.sol";
import {PQVault} from "../src/ethereum/vault/PQVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// The registry's two calls the vault makes; the test "signs" a payload by marking it.
contract Registry {
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

contract PQVaultTest is Test {
    address constant OWNER = address(0xEC05A);   // a MetaMask address
    address constant THIEF = address(0xBAD);
    address constant HEIR = address(0xFEED);
    Registry registry;
    PQVault vault;
    MockUSDC usdc;

    function setUp() public {
        registry = new Registry();
        vault = new PQVault(IPQKeyRegistry(address(registry)));
        usdc = new MockUSDC();
        vm.deal(OWNER, 10 ether);
        usdc.mint(OWNER, 1_000e6);
    }

    function _guard() internal { registry.setKey(OWNER, keccak256("owner's FORS+C key")); }

    function test_no_deposit_without_a_guard_key() public {
        vm.prank(OWNER);
        vm.expectRevert(PQVault.NoGuardKey.selector);
        vault.deposit{value: 1 ether}(address(0), 1 ether);
    }

    function test_eth_and_tokens_go_in() public {
        _guard();
        vm.startPrank(OWNER);
        vault.deposit{value: 1 ether}(address(0), 1 ether);
        usdc.approve(address(vault), 500e6);
        vault.deposit(address(usdc), 500e6);
        vm.expectRevert(PQVault.WrongValue.selector);
        vault.deposit{value: 1}(address(0), 2);
        vm.stopPrank();
        assertEq(vault.balanceOf(OWNER, address(0)), 1 ether);
        assertEq(vault.balanceOf(OWNER, address(usdc)), 500e6);
    }

    function test_the_ecdsa_key_alone_takes_nothing_out() public {
        _guard();
        vm.prank(OWNER);
        vault.deposit{value: 1 ether}(address(0), 1 ether);
        // Q-Day: whoever broke the owner's ECDSA key calls as the owner, with no FORS+C signature.
        vm.prank(OWNER);
        vm.expectRevert(bytes("BadSignature"));
        vault.withdraw(OWNER, address(0), 1 ether, THIEF, block.timestamp + 60, hex"");
        assertEq(vault.balanceOf(OWNER, address(0)), 1 ether);
    }

    function test_a_signed_withdrawal_pays_its_recipient_once_whoever_sends_it() public {
        _guard();
        vm.prank(OWNER);
        vault.deposit{value: 1 ether}(address(0), 1 ether);
        uint256 deadline = block.timestamp + 60;
        registry.sign(OWNER, vault.payload(OWNER, address(0), 0.4 ether, HEIR, deadline));
        // A front-runner reusing the signature for their own address: refused.
        vm.expectRevert(bytes("BadSignature"));
        vault.withdraw(OWNER, address(0), 0.4 ether, THIEF, deadline, hex"f0f5");
        // Anyone relays the real one; it pays only its recipient.
        vm.prank(address(0x5E1A7));
        vault.withdraw(OWNER, address(0), 0.4 ether, HEIR, deadline, hex"f0f5");
        assertEq(HEIR.balance, 0.4 ether);
        assertEq(vault.balanceOf(OWNER, address(0)), 0.6 ether);
        // Once.
        vm.expectRevert(bytes("BadSignature"));
        vault.withdraw(OWNER, address(0), 0.4 ether, HEIR, deadline, hex"f0f5");
    }

    function test_tokens_come_out_the_same_way() public {
        _guard();
        vm.startPrank(OWNER);
        usdc.approve(address(vault), 500e6);
        vault.deposit(address(usdc), 500e6);
        vm.stopPrank();
        uint256 deadline = block.timestamp + 60;
        registry.sign(OWNER, vault.payload(OWNER, address(usdc), 200e6, HEIR, deadline));
        vault.withdraw(OWNER, address(usdc), 200e6, HEIR, deadline, hex"f0f5");
        assertEq(usdc.balanceOf(HEIR), 200e6);
    }

    function test_late_and_too_large_withdrawals_are_refused() public {
        _guard();
        vm.prank(OWNER);
        vault.deposit{value: 1 ether}(address(0), 1 ether);
        vm.expectRevert(PQVault.TooMuch.selector);
        vault.withdraw(OWNER, address(0), 2 ether, HEIR, block.timestamp + 60, hex"");
        uint256 deadline = block.timestamp + 60;
        registry.sign(OWNER, vault.payload(OWNER, address(0), 1 ether, HEIR, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(PQVault.Expired.selector);
        vault.withdraw(OWNER, address(0), 1 ether, HEIR, deadline, hex"f0f5");
    }
}
