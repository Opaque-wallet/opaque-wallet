// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {FrameMode, FrameParam, Scope, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice Test pqUSDC on the EIP-8141 devnet, for the privacy pools: 100 per
///         address, once an hour.
/// @dev DevnetFaucet's shape, for a token. It is the sender of the transaction
///      that calls it and pays for that itself, so a wallet page asks with no
///      key and no server; VERIFY approves exactly one drip(to) frame to this
///      contract, with no value. The hourly limit is in drip(): validation may
///      not read the clock.
///
///      ponytail: anyone can make it pay gas for a drip the hourly limit then
///      refuses. Fine for a test token on a devnet.
contract TokenFaucet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    uint256 public constant EVERY = 1 hours;

    IERC20 public immutable token;
    uint256 public immutable amount;
    mapping(address => uint256) public lastDrip;

    event Dripped(address indexed to, uint256 amount);

    error OnlyDrip();
    error TooSoon(uint256 next);
    error Dry();

    constructor(IERC20 token_, uint256 amount_) payable {
        token = token_;
        amount = amount_;
    }

    /// @notice The VERIFY frame: pays for a transaction that only drips.
    function verify() external {
        if (txparam(TxParam.FRAME_COUNT) != 2) revert OnlyDrip();
        if (frameparam(1, FrameParam.MODE) != uint256(FrameMode.SENDER)) revert OnlyDrip();
        if (frameparam(1, FrameParam.RESOLVED_TARGET) != uint256(uint160(address(this)))) revert OnlyDrip();
        if (frameparam(1, FrameParam.VALUE) != 0) revert OnlyDrip();
        if (bytes4(framedataload(0, 1)) != this.drip.selector) revert OnlyDrip();
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// @notice `amount` of the token to `to`, at most once an hour per address.
    function drip(address to) external {
        uint256 next = lastDrip[to] + EVERY;
        if (lastDrip[to] != 0 && block.timestamp < next) revert TooSoon(next);
        lastDrip[to] = block.timestamp;
        if (!token.transfer(to, amount)) revert Dry();
        emit Dripped(to, amount);
    }

    receive() external payable {}
}
