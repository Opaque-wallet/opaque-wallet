// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, SigParam, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

import {LeanFors} from "../src/ethereum/frame/LeanFors.sol";

/// @notice An EIP-8141 account whose only authority is a FORS+C key: no ECDSA
///         key signs anything, not the account and not a bundler, because a
///         frame transaction has no envelope signature to need one.
/// @dev The transaction carries one ARBITRARY signature entry: the FORS+C
///      signature over this account's digest of the signature hash. The
///      protocol elides that entry's bytes from the signature hash, so the
///      signature can cover everything else, frames included. The VERIFY frame
///      lands in `verify()`, which copies the entry out with SIGDATACOPY,
///      recovers its key with LeanFors and approves execution and payment.
///      SENDER frames then call any contract with this account as msg.sender:
///      the frames are the batch, so there is no execute().
///
///      FORS+C is few-time. A VERIFY frame runs as a STATICCALL, so it cannot
///      count uses in storage; the protocol nonce counts them instead. It goes
///      up exactly once per transaction whose payment this account approved,
///      whatever its later frames do, so a key signs nonces
///      [keyFirstNonce, keyFirstNonce + MAX_USES) and no others.
///
///      Built for the ERC-8421 workshop devnet (chain 1337): HegotaSupport
///      reaches its opcodes through helper contracts, deployed by this
///      constructor, so the account's own nonce starts at 1 + the helper count.
contract FramePQAccount is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    /// k=13,a=13 keeps 128-bit forgery resistance for 8 signatures:
    /// k * (a - log2(8)) = 130. It is also the set that fits MAX_VERIFY_GAS
    /// (test/LeanFors.t.sol).
    uint256 public constant MAX_USES = 8;
    uint256 private constant ARBITRARY = 0;
    /// What the key signs is this domain and the signature hash, never the bare
    /// hash: the same key must not be replayable as a signature for anything else.
    bytes32 public constant DOMAIN = keccak256("opaque/v1/eip8141/sighash");

    /// The pkCommitment (LeanFors, ForsVerifier) of the key that signs now.
    bytes32 public key;
    /// The first nonce that key signs.
    uint64 public keyFirstNonce;

    event KeyRotated(bytes32 indexed key, uint64 firstNonce);

    error WrongScheme();
    error OnlyTheAccountNonce();
    error KeyExhausted();
    error BadSignature();
    error NotSelf();

    constructor(bytes32 key_, uint64 firstNonce) payable {
        key = key_;
        keyFirstNonce = firstNonce;
        emit KeyRotated(key_, firstNonce);
    }

    /// @notice The VERIFY frame. Reverting here makes the transaction invalid,
    ///         so nothing is paid for a signature that does not hold.
    function verify() external {
        if (sigparam(0, SigParam.SCHEME) != ARBITRARY) revert WrongScheme();
        // Keyed nonces (EIP-8250) would give one key many sequences to sign
        // under; the use count only holds on the account's one linear nonce.
        if (txparam(TxParam.NONCE_KEY_COUNT) != 1 || txparam(TxParam.NONCE_KEY_0) != 0) revert OnlyTheAccountNonce();
        uint256 nonce = txparam(TxParam.NONCE);
        if (nonce < keyFirstNonce || nonce - keyFirstNonce >= MAX_USES) revert KeyExhausted();

        bytes memory signature = sigdatacopy(0, sigparam(0, SigParam.SIGNATURE_LENGTH), 0);
        bytes32 digest = keccak256(abi.encode(DOMAIN, txparam(TxParam.SIG_HASH)));
        if (LeanFors.recoverCommitment(signature, digest) != key) revert BadSignature();
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// @notice Hands the account to the next key from the next nonce on. Only
    ///         a SENDER frame of this account's own transaction reaches it, so
    ///         the current key signs the handover along with everything else.
    function rotate(bytes32 next) external {
        if (msg.sender != address(this)) revert NotSelf();
        key = next;
        keyFirstNonce = uint64(txparam(TxParam.NONCE)) + 1;
        emit KeyRotated(next, keyFirstNonce);
    }

    receive() external payable {}
}
