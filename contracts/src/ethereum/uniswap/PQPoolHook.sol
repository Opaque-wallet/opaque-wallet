// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

// Uniswap v4's types as the PoolManager hands them to a hook. Declared here
// rather than imported from v4-core: the hook needs their ABI and nothing else,
// and the selectors it must return are computed from exactly these shapes
// (test/PQPoolHook.t.sol checks them against v4's own signatures).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// Uniswap's PositionManager and UniversalRouter: who called them, while they hold the PoolManager's lock.
interface IMsgSender {
    function msgSender() external view returns (address);
}

/// FramePQAccountFactory (contracts/frame/): where create(key) put an account.
interface IPQAccountFactory {
    function accountOf(bytes32 key) external view returns (address);
}

/// @notice A Uniswap v4 hook for post-quantum pools: only an account whose one
///         authority is a FORS+C key may swap in, add to, remove from or donate
///         to a pool that names it. A cracked ECDSA key cannot touch the pool,
///         and a position moved to an ECDSA wallet freezes rather than leaves.
/// @dev Who acts is the caller of Uniswap's own PositionManager or router, which
///      report it with msgSender(), and otherwise the contract that called the
///      PoolManager itself. An account counts as post-quantum once registered:
///      register(key) admits factory.accountOf(key), the CREATE2 address of a
///      FramePQAccount made for that FORS+C key, if it exists. That address
///      commits to the account's code, so nothing else can be admitted, and it
///      stays admitted when its key rotates. Anyone may register any account.
contract PQPoolHook {
    /// v4's permission bits, in the hook's own address: before add, remove, swap and donate.
    uint160 public constant FLAGS = (1 << 11) | (1 << 9) | (1 << 7) | (1 << 5);
    uint160 internal constant ALL_FLAGS = (1 << 14) - 1;

    address public immutable poolManager;
    address public immutable positionManager;
    address public immutable router;
    IPQAccountFactory public immutable factory;

    mapping(address => bool) public isPostQuantum;

    event Registered(address indexed account, bytes32 firstKey);

    error WrongHookAddress();
    error NotThePoolManager();
    error NotAnAccount();
    error NotPostQuantum(address who);

    constructor(address poolManager_, address positionManager_, address router_, IPQAccountFactory factory_) {
        // The PoolManager calls only the hooks whose bits the address carries: deployed elsewhere, it would check nothing.
        if (uint160(address(this)) & ALL_FLAGS != FLAGS) revert WrongHookAddress();
        poolManager = poolManager_;
        positionManager = positionManager_;
        router = router_;
        factory = factory_;
    }

    /// @notice Admits the FramePQAccount the factory made for `firstKey`, its first FORS+C key.
    function register(bytes32 firstKey) external returns (address account) {
        account = factory.accountOf(firstKey);
        if (account.code.length == 0) revert NotAnAccount();
        isPostQuantum[account] = true;
        emit Registered(account, firstKey);
    }

    /// @notice Who a PoolManager call is for.
    function actor(address sender) public view returns (address) {
        return sender == positionManager || sender == router ? IMsgSender(sender).msgSender() : sender;
    }

    function _only(address sender) internal view {
        if (msg.sender != poolManager) revert NotThePoolManager();
        address who = actor(sender);
        if (!isPostQuantum[who]) revert NotPostQuantum(who);
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

    /// @dev No delta and no fee override: the pool's own fee applies.
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
