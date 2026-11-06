// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {FrameMode, FrameParam, Scope, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// @notice Opaque's own faucet on the EIP-8141 devnet, for when the devnet's
///         runs dry: `drip` ETH per address, once an hour.
/// @dev Like FramePQAccountFactory, it is the sender of the transaction that
///      calls it and pays for that itself, so a wallet page asks for ETH with
///      no key and no server. VERIFY approves exactly one shape: one drip(to)
///      frame to this contract, with no value. The hourly limit is in drip(),
///      not VERIFY: validation may not read the clock.
///
///      ponytail: anyone can make it pay gas for a drip that the hourly limit
///      then refuses. Fine for test ETH on a devnet; a real chain wants more.
contract DevnetFaucet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    /// Set at deploy: 0.01 ETH pays for hundreds of frame transactions at a 0.1 gwei tip.
    uint256 public immutable drip_;
    uint256 public constant EVERY = 1 hours;

    mapping(address => uint256) public lastDrip;

    event Dripped(address indexed to, uint256 amount);

    error OnlyDrip();
    error TooSoon(uint256 next);
    error Dry();

    constructor(uint256 dripAmount) payable {
        drip_ = dripAmount;
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

    /// @notice `drip_` ETH to `to`, at most once an hour per address.
    function drip(address to) external {
        uint256 next = lastDrip[to] + EVERY;
        if (lastDrip[to] != 0 && block.timestamp < next) revert TooSoon(next);
        lastDrip[to] = block.timestamp;
        (bool ok,) = to.call{value: drip_}("");
        if (!ok) revert Dry();
        emit Dripped(to, drip_);
    }

    receive() external payable {}
}
