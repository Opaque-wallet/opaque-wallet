// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {IPQKeyRegistry} from "../../opaque/interfaces/IPQKeyRegistry.sol";
import {IMsgSender, ModifyLiquidityParams, PoolKey} from "./PQPoolHook.sol";

interface IPoolManagerTake {
    function take(address currency, address to, uint256 amount) external;
}

/// @notice A FORS+C second factor for liquidity anyone provides, ECDSA wallets
///         included: a position's withdrawals need a post-quantum signature as
///         well as its owner's, so the day an ECDSA key falls, the liquidity it
///         owns still cannot be taken out by whoever broke it.
/// @dev A position is bound, when it is first funded, to the account that funds
///      it (through Uniswap's PositionManager, the caller it reports): that
///      account must already hold a FORS+C key in PQKeyRegistry, which any
///      wallet registers once with an ordinary transaction. Every removal after
///      that, fee collection included, carries in its hookData a recipient, a
///      deadline and a FORS+C signature over the position, the exact liquidity
///      change, the recipient and the deadline; the registry checks it at the
///      key's use count and counts the use, so it works once.
///
///      The signature names a recipient, and the hook pays the recipient itself:
///      afterRemoveLiquidity takes everything the removal released, fees too,
///      straight to it, and leaves the caller nothing. So a signature seen in
///      the mempool is worth nothing to a front-runner holding the cracked ECDSA
///      key: replayed in their own transaction, it still pays the signed
///      recipient. And a position moved to another wallet stays bound to the key.
contract PQGuardHook {
    /// Before add, before remove, after remove, and after remove returning a delta.
    uint160 public constant FLAGS = (1 << 11) | (1 << 9) | (1 << 8) | (1 << 0);
    uint160 internal constant ALL_FLAGS = (1 << 14) - 1;
    string public constant DOMAIN = "opaque/v1/uniswap/remove";
    /// Where a removal's signed recipient waits, between before and after, in one call.
    bytes32 internal constant RECIPIENT_SLOT = keccak256("opaque/v1/uniswap/remove/recipient");

    address public immutable poolManager;
    address public immutable positionManager;
    IPQKeyRegistry public immutable registry;

    /// Position (PoolManager's own key for it) => the account whose FORS+C key signs its removals.
    mapping(bytes32 => address) public guardianOf;

    event Guarded(bytes32 indexed position, address indexed guardian);
    event Released(bytes32 indexed position, address indexed recipient, int256 delta);

    error WrongHookAddress();
    error NotThePoolManager();
    error NoGuardKey(address who);
    error Unguarded();
    error Expired();
    error OwesThePool();

    constructor(address poolManager_, address positionManager_, IPQKeyRegistry registry_) {
        if (uint160(address(this)) & ALL_FLAGS != FLAGS) revert WrongHookAddress();
        poolManager = poolManager_;
        positionManager = positionManager_;
        registry = registry_;
    }

    /// @notice v4's own key for a position: its pool, its owner at the PoolManager, its range and salt.
    function positionOf(address owner, PoolKey calldata key, ModifyLiquidityParams calldata params) public pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(abi.encode(key)), owner, params.tickLower, params.tickUpper, params.salt));
    }

    /// @notice What a removal's FORS+C key signs, inside the registry's user-action domain.
    function payload(bytes32 position, int256 liquidityDelta, address recipient, uint256 deadline) public view returns (bytes memory) {
        return abi.encode(DOMAIN, block.chainid, address(this), position, liquidityDelta, recipient, deadline);
    }

    function _actor(address sender) internal view returns (address) {
        return sender == positionManager ? IMsgSender(sender).msgSender() : sender;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata params, bytes calldata)
        external
        returns (bytes4)
    {
        if (msg.sender != poolManager) revert NotThePoolManager();
        bytes32 position = positionOf(sender, key, params);
        if (guardianOf[position] == address(0)) {
            address guardian = _actor(sender);
            if (registry.stateOf(guardian).pkCommitment == bytes32(0)) revert NoGuardKey(guardian);
            guardianOf[position] = guardian;
            emit Guarded(position, guardian);
        }
        return this.beforeAddLiquidity.selector;
    }

    function beforeRemoveLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata params, bytes calldata hookData)
        external
        returns (bytes4)
    {
        if (msg.sender != poolManager) revert NotThePoolManager();
        bytes32 position = positionOf(sender, key, params);
        address guardian = guardianOf[position];
        if (guardian == address(0)) revert Unguarded();
        (address recipient, uint256 deadline, bytes memory signature) = abi.decode(hookData, (address, uint256, bytes));
        if (block.timestamp > deadline) revert Expired();
        // Reverts unless the guardian's key signed exactly this, at its use count; counts the use.
        registry.consume(guardian, payload(position, params.liquidityDelta, recipient, deadline), signature);
        bytes32 slot = RECIPIENT_SLOT;
        assembly ("memory-safe") { tstore(slot, recipient) }
        return this.beforeRemoveLiquidity.selector;
    }

    /// @dev `delta` is what the removal released to its caller, principal and fees. The hook
    ///      claims all of it (the returned delta) and takes it to the signed recipient.
    function afterRemoveLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata params, int256 delta, int256, bytes calldata)
        external
        returns (bytes4, int256)
    {
        if (msg.sender != poolManager) revert NotThePoolManager();
        address recipient;
        bytes32 slot = RECIPIENT_SLOT;
        assembly ("memory-safe") {
            recipient := tload(slot)
            tstore(slot, 0)
        }
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        // A removal only ever releases tokens; anything else would leave the hook owing the pool.
        if (amount0 < 0 || amount1 < 0) revert OwesThePool();
        if (amount0 > 0) IPoolManagerTake(poolManager).take(key.currency0, recipient, uint128(amount0));
        if (amount1 > 0) IPoolManagerTake(poolManager).take(key.currency1, recipient, uint128(amount1));
        emit Released(positionOf(sender, key, params), recipient, delta);
        return (this.afterRemoveLiquidity.selector, delta);
    }
}
