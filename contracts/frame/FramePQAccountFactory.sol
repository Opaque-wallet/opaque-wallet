// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {FrameMode, FrameParam, Scope, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

import {FramePQAccount} from "./FramePQAccount.sol";

/// @notice Brings FramePQAccounts into being without anyone holding an ECDSA
///         key: the factory is the sender of the creating frame transaction
///         and pays for it itself.
/// @dev The creating transaction is exactly two frames: this factory's VERIFY,
///      then one SENDER frame to this factory that calls create(key). VERIFY
///      approves nothing else, or anyone could spend the factory's balance on
///      calls of their own; it needs no signature, because creating an account
///      for a key gives nobody power over anything but that account. The new
///      account's address is fixed by its key (CREATE2, salt = key), so a
///      wallet knows it, and can have it funded, before it exists.
///
///      ponytail: anyone can make the factory pay for creating accounts. Fine
///      on a devnet whose faucet refills it; a real chain wants a cap or a fee.
contract FramePQAccountFactory is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    /// The account's nonce after its constructor: 1, plus HegotaSupport's seven helpers.
    uint64 public constant FIRST_NONCE = 8;

    event Created(address indexed account, bytes32 indexed key);

    error OnlyCreate();

    constructor() payable {}

    /// @notice The VERIFY frame: pays for a transaction that only creates an account.
    function verify() external {
        if (txparam(TxParam.FRAME_COUNT) != 2) revert OnlyCreate();
        if (frameparam(1, FrameParam.MODE) != uint256(FrameMode.SENDER)) revert OnlyCreate();
        if (frameparam(1, FrameParam.RESOLVED_TARGET) != uint256(uint160(address(this)))) revert OnlyCreate();
        if (frameparam(1, FrameParam.VALUE) != 0) revert OnlyCreate();
        if (bytes4(framedataload(0, 1)) != this.create.selector) revert OnlyCreate();
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// @notice Creates the account for `key`. Anyone may call it, in any
    ///         transaction: the account answers only to that key.
    function create(bytes32 key) external returns (address account) {
        account = address(new FramePQAccount{salt: key}(key, FIRST_NONCE));
        emit Created(account, key);
    }

    /// @notice Where create(key) puts the account, whether or not it exists yet.
    function accountOf(bytes32 key) external view returns (address) {
        bytes32 initCode = keccak256(abi.encodePacked(type(FramePQAccount).creationCode, abi.encode(key, FIRST_NONCE)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), key, initCode)))));
    }

    receive() external payable {}
}
