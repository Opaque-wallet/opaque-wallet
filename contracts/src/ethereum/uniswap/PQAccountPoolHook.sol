// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {IMsgSender, ModifyLiquidityParams, PoolKey, SwapParams} from "./PQPoolHook.sol";

/// @notice PQPoolHook's rule for ERC-4337 accounts: only Opaque's PQ accounts may
///         swap in, add to, remove from or donate to a pool that names this hook.
///         Each is an EIP-1167 clone of one PQAccount implementation, whose only
///         authority is a FORS+C key held in PQKeyRegistry, so the clone's code
///         hash says what the account is, with nothing to register.
/// @dev Who acts is the caller of Uniswap's own PositionManager or router (their
///      msgSender()), otherwise the contract that called the PoolManager. An
///      account not yet deployed has no code, so it is refused until its first
///      operation has made it.
contract PQAccountPoolHook {
    uint160 public constant FLAGS = (1 << 11) | (1 << 9) | (1 << 7) | (1 << 5);
    uint160 internal constant ALL_FLAGS = (1 << 14) - 1;

    address public immutable poolManager;
    address public immutable positionManager;
    address public immutable router;
    /// keccak256 of the runtime code every PQ account has: the EIP-1167 proxy to the implementation.
    bytes32 public immutable accountCodehash;

    error WrongHookAddress();
    error NotThePoolManager();
    error NotPostQuantum(address who);

    constructor(address poolManager_, address positionManager_, address router_, address implementation) {
        if (uint160(address(this)) & ALL_FLAGS != FLAGS) revert WrongHookAddress();
        poolManager = poolManager_;
        positionManager = positionManager_;
        router = router_;
        accountCodehash = keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"));
    }

    function isPostQuantum(address who) public view returns (bool) {
        return who.codehash == accountCodehash;
    }

    function actor(address sender) public view returns (address) {
        return sender == positionManager || sender == router ? IMsgSender(sender).msgSender() : sender;
    }

    function _only(address sender) internal view {
        if (msg.sender != poolManager) revert NotThePoolManager();
        address who = actor(sender);
        if (!isPostQuantum(who)) revert NotPostQuantum(who);
    }

    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        _only(sender);
        return this.beforeAddLiquidity.selector;
    }

    function beforeRemoveLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        _only(sender);
        return this.beforeRemoveLiquidity.selector;
    }

    function beforeSwap(address sender, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        view
        returns (bytes4, int256, uint24)
    {
        _only(sender);
        return (this.beforeSwap.selector, 0, 0);
    }

    function beforeDonate(address sender, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        _only(sender);
        return this.beforeDonate.selector;
    }
}
