// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {
    IPQAccountFactory,
    ModifyLiquidityParams,
    PoolKey,
    PQPoolHook,
    SwapParams
} from "../src/ethereum/uniswap/PQPoolHook.sol";

contract Factory is IPQAccountFactory {
    mapping(bytes32 => address) public made;
    function set(bytes32 key, address account) external { made[key] = account; }
    function accountOf(bytes32 key) external view returns (address) { return made[key]; }
}

/// Stands in for Uniswap's PositionManager or router: reports its caller.
contract Periphery {
    address public msgSender;
    function setCaller(address who) external { msgSender = who; }
}

contract PQPoolHookTest is Test {
    address constant POOL_MANAGER = address(0x9001);
    // A hook address with exactly the four bits: before add, remove, swap, donate.
    address constant HOOK = address((uint160(5) << 156) | (1 << 11) | (1 << 9) | (1 << 7) | (1 << 5));
    bytes32 constant KEY = keccak256("first FORS+C key");
    address constant ACCOUNT = address(0xACC7);
    address constant EOA = address(0xEEEE);

    Factory factory;
    Periphery positionManager;
    Periphery router;
    PQPoolHook hook;
    PoolKey key;
    ModifyLiquidityParams lp;
    SwapParams swap;

    function setUp() public {
        factory = new Factory();
        positionManager = new Periphery();
        router = new Periphery();
        deployCodeTo("PQPoolHook.sol:PQPoolHook", abi.encode(POOL_MANAGER, address(positionManager), address(router), factory), HOOK);
        hook = PQPoolHook(HOOK);
        key = PoolKey(address(0), address(0xD011A2), 3000, 60, HOOK);
        lp = ModifyLiquidityParams(-887220, 887220, 1e18, bytes32(0));
        swap = SwapParams(true, -1e15, 4295128740);
        vm.etch(ACCOUNT, hex"00");
        factory.set(KEY, ACCOUNT);
    }

    function test_its_selectors_are_v4s() public view {
        assertEq(hook.beforeAddLiquidity.selector, bytes4(keccak256("beforeAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)")));
        assertEq(hook.beforeRemoveLiquidity.selector, bytes4(keccak256("beforeRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)")));
        assertEq(hook.beforeSwap.selector, bytes4(keccak256("beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)")));
        assertEq(hook.beforeDonate.selector, bytes4(keccak256("beforeDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)")));
    }

    function test_it_refuses_an_address_without_its_permission_bits() public {
        vm.expectRevert(PQPoolHook.WrongHookAddress.selector);
        new PQPoolHook(POOL_MANAGER, address(positionManager), address(router), factory);
    }

    function test_only_a_factory_account_that_exists_is_admitted() public {
        vm.expectRevert(PQPoolHook.NotAnAccount.selector);
        hook.register(keccak256("a key nobody made an account for"));
        assertEq(hook.register(KEY), ACCOUNT);
        assertTrue(hook.isPostQuantum(ACCOUNT));
    }

    function test_a_post_quantum_account_swaps_and_provides_through_uniswaps_periphery() public {
        hook.register(KEY);
        router.setCaller(ACCOUNT);
        positionManager.setCaller(ACCOUNT);
        vm.startPrank(POOL_MANAGER);
        (bytes4 s,,) = hook.beforeSwap(address(router), key, swap, "");
        assertEq(s, hook.beforeSwap.selector);
        assertEq(hook.beforeAddLiquidity(address(positionManager), key, lp, ""), hook.beforeAddLiquidity.selector);
        assertEq(hook.beforeRemoveLiquidity(address(positionManager), key, lp, ""), hook.beforeRemoveLiquidity.selector);
        assertEq(hook.beforeDonate(ACCOUNT, key, 1, 1, ""), hook.beforeDonate.selector);
        vm.stopPrank();
    }

    function test_an_ecdsa_wallet_cannot_swap_provide_or_withdraw() public {
        hook.register(KEY);
        router.setCaller(EOA);
        positionManager.setCaller(EOA);
        vm.startPrank(POOL_MANAGER);
        vm.expectRevert(abi.encodeWithSelector(PQPoolHook.NotPostQuantum.selector, EOA));
        hook.beforeSwap(address(router), key, swap, "");
        vm.expectRevert(abi.encodeWithSelector(PQPoolHook.NotPostQuantum.selector, EOA));
        hook.beforeAddLiquidity(address(positionManager), key, lp, "");
        // A position handed to an ECDSA wallet freezes: its owner cannot take it out.
        vm.expectRevert(abi.encodeWithSelector(PQPoolHook.NotPostQuantum.selector, EOA));
        hook.beforeRemoveLiquidity(address(positionManager), key, lp, "");
        vm.stopPrank();
    }

    function test_another_router_counts_as_itself_not_as_whoever_it_names() public {
        hook.register(KEY);
        // A contract that is not Uniswap's periphery, claiming to act for the account.
        Periphery impostor = new Periphery();
        impostor.setCaller(ACCOUNT);
        vm.prank(POOL_MANAGER);
        vm.expectRevert(abi.encodeWithSelector(PQPoolHook.NotPostQuantum.selector, address(impostor)));
        hook.beforeSwap(address(impostor), key, swap, "");
    }

    function test_only_the_pool_manager_asks() public {
        hook.register(KEY);
        vm.expectRevert(PQPoolHook.NotThePoolManager.selector);
        hook.beforeSwap(ACCOUNT, key, swap, "");
    }
}
