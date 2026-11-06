// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPQKeyRegistry} from "../src/opaque/interfaces/IPQKeyRegistry.sol";
import {ModifyLiquidityParams, PoolKey, SwapParams} from "../src/ethereum/uniswap/PQPoolHook.sol";
import {PQAccountPoolHook} from "../src/ethereum/uniswap/PQAccountPoolHook.sol";
import {PQGuardHook} from "../src/ethereum/uniswap/PQGuardHook.sol";

/// The registry's two calls the guard makes: who holds a key, and one signature consumed.
contract Registry {
    mapping(address => bytes32) public key;
    mapping(bytes32 => bool) public signed;
    function setKey(address who, bytes32 k) external { key[who] = k; }
    /// Stands in for a FORS+C signature over `payload`: the test "signs" by marking it.
    function sign(address who, bytes calldata payload) external { signed[keccak256(abi.encode(who, payload))] = true; }
    function stateOf(address who) external view returns (IPQKeyRegistry.PQKeyState memory s) { s.pkCommitment = key[who]; }
    function consume(address who, bytes calldata payload, bytes calldata) external {
        bytes32 id = keccak256(abi.encode(who, payload));
        require(signed[id], "BadSignature");
        delete signed[id]; // once
    }
}

contract PoolManager {
    struct Take { address currency; address to; uint256 amount; }
    Take[] public takes;
    function take(address currency, address to, uint256 amount) external { takes.push(Take(currency, to, amount)); }
    function count() external view returns (uint256) { return takes.length; }
}

contract Periphery {
    address public msgSender;
    function setCaller(address who) external { msgSender = who; }
}

contract PQGuardHookTest is Test {
    address constant GUARD = address((uint160(7) << 156) | (1 << 11) | (1 << 9) | (1 << 8) | (1 << 0));
    address constant LP = address(0xEC05A);      // an ECDSA wallet
    address constant THIEF = address(0xBAD);     // whoever cracks its ECDSA key
    address constant TOKEN = address(0x70C3);

    Registry registry;
    PoolManager pm;
    Periphery posm;
    PQGuardHook guard;
    PoolKey key;
    ModifyLiquidityParams add;
    ModifyLiquidityParams remove;

    function setUp() public {
        registry = new Registry();
        pm = new PoolManager();
        posm = new Periphery();
        deployCodeTo("PQGuardHook.sol:PQGuardHook", abi.encode(address(pm), address(posm), address(registry)), GUARD);
        guard = PQGuardHook(GUARD);
        key = PoolKey(address(0), TOKEN, 3000, 60, GUARD);
        add = ModifyLiquidityParams(-887220, 887220, 1e18, bytes32(uint256(42)));
        remove = ModifyLiquidityParams(-887220, 887220, -1e18, bytes32(uint256(42)));
        posm.setCaller(LP);
    }

    function _fund() internal {
        registry.setKey(LP, keccak256("LP's FORS+C key"));
        vm.prank(address(pm));
        guard.beforeAddLiquidity(address(posm), key, add, "");
    }

    function _signedRemoval(address recipient, uint256 deadline) internal returns (bytes memory hookData) {
        bytes32 position = guard.positionOf(address(posm), key, remove);
        registry.sign(LP, guard.payload(position, remove.liquidityDelta, recipient, deadline));
        hookData = abi.encode(recipient, deadline, hex"f0f5");
    }

    function test_its_selectors_are_v4s() public view {
        assertEq(guard.beforeAddLiquidity.selector, bytes4(keccak256("beforeAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)")));
        assertEq(guard.beforeRemoveLiquidity.selector, bytes4(keccak256("beforeRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)")));
        assertEq(guard.afterRemoveLiquidity.selector, bytes4(keccak256("afterRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)")));
    }

    function test_a_position_needs_a_guard_key_to_be_funded() public {
        vm.prank(address(pm));
        vm.expectRevert(abi.encodeWithSelector(PQGuardHook.NoGuardKey.selector, LP));
        guard.beforeAddLiquidity(address(posm), key, add, "");
        _fund();
        assertEq(guard.guardianOf(guard.positionOf(address(posm), key, add)), LP);
    }

    function test_without_the_fors_signature_nothing_comes_out() public {
        _fund();
        // The ECDSA owner, or whoever cracked its key, with no FORS+C signature.
        vm.prank(address(pm));
        vm.expectRevert(bytes("BadSignature"));
        guard.beforeRemoveLiquidity(address(posm), key, remove, abi.encode(THIEF, block.timestamp + 60, hex""));
    }

    function test_a_signed_removal_pays_only_its_signed_recipient_once() public {
        _fund();
        address recipient = address(0xFEED);
        bytes memory hookData = _signedRemoval(recipient, block.timestamp + 60);
        // A front-runner reusing the signature with their own recipient: refused.
        vm.prank(address(pm));
        vm.expectRevert(bytes("BadSignature"));
        guard.beforeRemoveLiquidity(address(posm), key, remove, abi.encode(THIEF, block.timestamp + 60, hex"f0f5"));
        // The signed removal: before checks it, after pays its recipient everything released.
        int256 delta = (int256(5e15) << 128) | int256(uint256(10e6));
        vm.startPrank(address(pm));
        guard.beforeRemoveLiquidity(address(posm), key, remove, hookData);
        (bytes4 s, int256 hookDelta) = guard.afterRemoveLiquidity(address(posm), key, remove, delta, 0, hookData);
        vm.stopPrank();
        assertEq(s, guard.afterRemoveLiquidity.selector);
        assertEq(hookDelta, delta, "the hook claims all of it, so the caller is left nothing");
        assertEq(pm.count(), 2);
        (address c0, address to0, uint256 a0) = pm.takes(0);
        (address c1, address to1, uint256 a1) = pm.takes(1);
        assertEq(abi.encode(c0, to0, a0, c1, to1, a1), abi.encode(address(0), recipient, uint256(5e15), TOKEN, recipient, uint256(10e6)));
        // Once: the same signature again is refused.
        vm.prank(address(pm));
        vm.expectRevert(bytes("BadSignature"));
        guard.beforeRemoveLiquidity(address(posm), key, remove, hookData);
    }

    function test_a_removal_after_its_deadline_is_refused() public {
        _fund();
        bytes memory hookData = _signedRemoval(address(0xFEED), block.timestamp + 60);
        vm.warp(block.timestamp + 61);
        vm.prank(address(pm));
        vm.expectRevert(PQGuardHook.Expired.selector);
        guard.beforeRemoveLiquidity(address(posm), key, remove, hookData);
    }

    function test_only_the_pool_manager_asks() public {
        vm.expectRevert(PQGuardHook.NotThePoolManager.selector);
        guard.beforeAddLiquidity(address(posm), key, add, "");
    }
}

contract PQAccountPoolHookTest is Test {
    address constant HOOK = address((uint160(9) << 156) | (1 << 11) | (1 << 9) | (1 << 7) | (1 << 5));
    address constant IMPL = address(0x17fc96E5B93eb031B2DB2AAC415Dd507ad932DbF);
    address constant ACCOUNT = address(0xACC7);
    address constant EOA = address(0xEEEE);
    Periphery router;
    PQAccountPoolHook hook;
    PoolKey key;
    SwapParams swap;

    function setUp() public {
        router = new Periphery();
        deployCodeTo("PQAccountPoolHook.sol:PQAccountPoolHook", abi.encode(address(this), address(new Periphery()), address(router), IMPL), HOOK);
        hook = PQAccountPoolHook(HOOK);
        // A PQ account: the EIP-1167 proxy to the implementation, as PQAccountFactory makes it.
        vm.etch(ACCOUNT, abi.encodePacked(hex"363d3d373d3d3d363d73", IMPL, hex"5af43d82803e903d91602b57fd5bf3"));
        key = PoolKey(address(0), address(0x70C3), 3000, 60, HOOK);
        swap = SwapParams(true, -1e15, 4295128740);
    }

    function test_a_pq_account_swaps_and_an_ecdsa_wallet_does_not() public {
        router.setCaller(ACCOUNT);
        (bytes4 s,,) = hook.beforeSwap(address(router), key, swap, "");
        assertEq(s, hook.beforeSwap.selector);
        router.setCaller(EOA);
        vm.expectRevert(abi.encodeWithSelector(PQAccountPoolHook.NotPostQuantum.selector, EOA));
        hook.beforeSwap(address(router), key, swap, "");
    }

    function test_a_proxy_to_another_implementation_is_not_admitted() public {
        address other = address(0x0711E2);
        vm.etch(other, abi.encodePacked(hex"363d3d373d3d3d363d73", address(0xBEEF), hex"5af43d82803e903d91602b57fd5bf3"));
        router.setCaller(other);
        vm.expectRevert(abi.encodeWithSelector(PQAccountPoolHook.NotPostQuantum.selector, other));
        hook.beforeSwap(address(router), key, swap, "");
    }
}
