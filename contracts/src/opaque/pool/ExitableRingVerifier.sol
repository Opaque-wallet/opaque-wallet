// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {AES128} from "../lib/AES128.sol";
import {Canonical} from "../lib/Canonical.sol";
import {ISpendVerifier} from "../interfaces/ISpendVerifier.sol";
import {AttestedRingVerifier} from "./AttestedRingVerifier.sol";

/// @notice A ring pool's verifier with a way out that needs nobody: the private
///         path is AttestedRingVerifier's, unchanged; beside it, a note's owner can
///         always withdraw it alone, after a public delay, with no attester, relay
///         or server of Opaque's anywhere in the path.
/// @dev The exit, for a note whose 16-byte secret S the owner holds:
///        1. announceExit(nullifier, keccak256(S, paymentContext)): binds the payout,
///           reveals nothing about which deposit the note is. Anyone may send it.
///        2. after `exitDelay`, the pool's spend() with proof = EXIT_TAG ‖ S: this
///           recomputes the commitment and nullifier from S with AES-128, exactly as
///           the ring circuit derives them, checks the commitment is in the ring and
///           the announcement is old enough, and the pool pays. The note's privacy is
///           gone (S is public); the funds are not.
///      Once a nullifier is announced its private path is closed, so a secret
///      revealed in step 2 cannot be raced through the attester: a racer would need
///      an announcement of their own, `exitDelay` old, for a secret they had not seen.
///      Announcing someone else's nullifier needs that nullifier, which is secret
///      until its note is spent.
contract ExitableRingVerifier is ISpendVerifier {
    bytes32 public constant EXIT_TAG = keccak256("opaque/v1/ring-exit");
    string internal constant NOTE_DOMAIN = "opaque/v1/note";
    string internal constant NULLIFIER_DOMAIN = "opaque/v1/nullifier";
    uint8 internal constant RING = 8;

    /// The private path: every non-exit spend is this verifier's to approve.
    AttestedRingVerifier public immutable attested;
    /// The one pool that may call verifySpend.
    address public immutable pool;
    /// Seconds between an exit's announcement and its payout.
    uint256 public immutable exitDelay;
    /// The pool's public AES blocks (backend/zk/statement.ts noteBlock, nullifierBlock).
    bytes16 public immutable noteBlock;
    bytes16 public immutable nullifierBlock;

    mapping(bytes32 nullifier => mapping(bytes32 claim => uint256 at)) public announcedAt;
    mapping(bytes32 nullifier => bool) public exiting;

    event ExitAnnounced(bytes32 indexed nullifier, bytes32 claim, uint256 payableAt);
    event Exited(bytes32 indexed nullifier, bytes32 commitment);

    error NotThePool();
    error WrongRingSize();
    error NotInRing();
    error NotAnnounced();
    error TooEarly(uint256 payableAt);
    error AlreadyAnnounced();
    error NoteIsExiting();

    constructor(AttestedRingVerifier attested_, address pool_, uint256 exitDelay_) {
        attested = attested_;
        pool = pool_;
        exitDelay = exitDelay_;
        bytes32 id = attested_.poolId();
        noteBlock = bytes16(keccak256(abi.encodePacked(
            Canonical.field(bytes(NOTE_DOMAIN)), Canonical.field(id), Canonical.field(Canonical.decimal(attested_.denomination()))
        )));
        nullifierBlock = bytes16(keccak256(abi.encodePacked(Canonical.field(bytes(NULLIFIER_DOMAIN)), Canonical.field(id))));
    }

    // ── what the pool and clients read: the private path's own answers ─────

    function verifierId() external view returns (bytes32) {
        return attested.verifierId();
    }

    function proofMode() external pure returns (ProofMode) {
        return ProofMode.RING_8;
    }

    function ringSize() external pure returns (uint8) {
        return RING;
    }

    function requiresCommitReveal() external pure returns (bool) {
        return false;
    }

    // ── the exit ──────────────────────────────────────────────────────────

    /// @notice Step 1: `claim` = keccak256(abi.encode(secret, pool.paymentContext(recipient))).
    function announceExit(bytes32 nullifier, bytes32 claim) external {
        if (announcedAt[nullifier][claim] != 0) revert AlreadyAnnounced();
        announcedAt[nullifier][claim] = block.timestamp;
        exiting[nullifier] = true;
        emit ExitAnnounced(nullifier, claim, block.timestamp + exitDelay);
    }

    /// @notice What a note with `secret` commits to and spends as, in this pool.
    function noteOf(bytes16 secret) public view returns (bytes32 commitment, bytes32 nullifier) {
        commitment = bytes32(AES128.encrypt(secret, noteBlock));
        nullifier = bytes32(AES128.encrypt(secret, nullifierBlock));
    }

    function verifySpend(bytes32[] calldata ring, bytes calldata proof, bytes32 paymentContext) external returns (bytes32) {
        if (msg.sender != pool) revert NotThePool();
        if (proof.length == 48 && bytes32(proof[0:32]) == EXIT_TAG) {
            if (ring.length != RING) revert WrongRingSize();
            bytes16 secret = bytes16(proof[32:48]);
            (bytes32 commitment, bytes32 nullifier) = noteOf(secret);
            bool member;
            for (uint256 i; i < RING; ++i) if (ring[i] == commitment) member = true;
            if (!member) revert NotInRing();
            uint256 at = announcedAt[nullifier][keccak256(abi.encode(secret, paymentContext))];
            if (at == 0) revert NotAnnounced();
            if (block.timestamp < at + exitDelay) revert TooEarly(at + exitDelay);
            emit Exited(nullifier, commitment);
            return nullifier;
        }
        // The private path. Its first 32 bytes are the nullifier (AttestedRingVerifier).
        if (proof.length >= 32 && exiting[bytes32(proof[0:32])]) revert NoteIsExiting();
        return attested.verifySpend(ring, proof, paymentContext);
    }
}
