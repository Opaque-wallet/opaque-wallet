// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

/// @notice ForsVerifier.recoverCommitment for a signature held in memory, with
///         the whole hot loop in assembly.
/// @dev An EIP-8141 transaction gets 100,000 gas to validate, VERIFY frames and
///      signature costs together (MAX_VERIFY_GAS, enforced by the devnet's
///      mempool for staked and unstaked senders alike). ForsVerifier spends
///      167k on k=13,a=13, and by its own measurement only about 41k of a
///      run like that is keccak: the rest is bounds-checked calldata slices and
///      checked arithmetic around it. This is the same wire format, the same
///      preimages and the same commitment, minus that overhead. It also takes
///      the signature from memory, which is where SIGDATACOPY puts it.
///
///      It is a second implementation of one function, so it is held to the
///      first: test/LeanFors.t.sol checks it against ForsVerifier on real
///      signatures, tampered ones and malformed ones.
library LeanFors {
    // The domains ForsVerifier hashes under. The offsets in the loop below
    // follow from their lengths: 20 bytes for INDEX_DOMAIN, 19 for LEAF and
    // NODE, 20 for ROOTS.
    string internal constant LEAF_DOMAIN = "opaque/v1/fors/leaf";
    string internal constant NODE_DOMAIN = "opaque/v1/fors/node";
    string internal constant ROOTS_DOMAIN = "opaque/v1/fors/roots";
    string internal constant INDEX_DOMAIN = "opaque/v1/fors/index";
    string internal constant PK_COMMITMENT_DOMAIN = "opaque/v1/fors/pk-commitment";

    error MalformedSignature();
    error UnsupportedParameters();

    /// @notice The pkCommitment a FORS+C signature over `digest` proves, or zero
    ///         when it proves none. Reverts on a signature that is not even
    ///         well formed, as ForsVerifier does.
    /// @dev Wire format: k (uint16 BE) | a (uint8) | pk value (32) | k * (leaf 32 | path a*32).
    function recoverCommitment(bytes memory sig, bytes32 digest) internal pure returns (bytes32) {
        if (sig.length < 3) revert MalformedSignature();
        uint256 k = (uint256(uint8(sig[0])) << 8) | uint8(sig[1]);
        uint256 a = uint8(sig[2]);
        if (k < 1 || k > 64 || a < 1 || a > 20) revert UnsupportedParameters();
        if (sig.length != 35 + k * 32 * (1 + a)) revert MalformedSignature();

        // Each preimage is laid out once by abi.encodePacked, with its varying
        // fields zeroed, exactly as ForsVerifier lays it out; the loop then
        // overwrites only those fields.
        bytes memory ib = abi.encodePacked(
            uint32(bytes(INDEX_DOMAIN).length), INDEX_DOMAIN,
            uint32(4), uint32(k), uint32(4), uint32(a), uint32(32), digest, uint32(4), uint32(0)
        );
        bytes memory lb = abi.encodePacked(
            uint32(bytes(LEAF_DOMAIN).length), LEAF_DOMAIN,
            uint32(4), uint32(0), uint32(4), uint32(0), uint32(32), bytes32(0)
        );
        bytes memory nb = abi.encodePacked(
            uint32(bytes(NODE_DOMAIN).length), NODE_DOMAIN,
            uint32(4), uint32(0), uint32(4), uint32(0), uint32(32), bytes32(0), uint32(32), bytes32(0)
        );
        bytes memory rb = abi.encodePacked(
            uint32(bytes(ROOTS_DOMAIN).length), ROOTS_DOMAIN,
            uint32(4), uint32(k), uint32(4), uint32(a), new bytes(k * 36)
        );

        bytes32 pkValue;
        bool ok;
        assembly ("memory-safe") {
            let ip := add(ib, 32)
            let iLen := mload(ib)
            // ib: ... | uint32(4) at 76 | i at 80..83. The word at 52 ends on i.
            let iWord := mload(add(ip, 52))
            let lp := add(lb, 32)
            let lLen := mload(lb)
            // lb: len 0..3 | domain 4..22 | 4 | tree 27..30 | 4 | index 35..38 | 32 | secret 43..74.
            // The word at 7 ends on the index, with the tree 8 bytes above it.
            let lWord := mload(add(lp, 7))
            let np := add(nb, 32)
            let nLen := mload(nb)
            // nb: the same header, level where the index was | 32 | left 43..74 | 32 | right 79..110.
            let nWord := mload(add(np, 7))
            let rp := add(rb, 32)
            let slot := add(rp, sub(mload(rb), mul(k, 36)))
            let mask := sub(shl(a, 1), 1)
            let base := add(sig, 32)
            let at := add(base, 35)

            for { let i := 0 } lt(i, k) { i := add(i, 1) } {
                mstore(add(ip, 52), or(iWord, i))
                // One leaf index per tree: the top 64 bits of its hash, cut to a bits.
                let index := and(shr(192, keccak256(ip, iLen)), mask)
                let tree := shl(64, i)
                mstore(add(lp, 7), or(lWord, or(tree, index)))
                mstore(add(lp, 43), mload(at))
                let node := keccak256(lp, lLen)
                for { let l := 0 } lt(l, a) { l := add(l, 1) } {
                    at := add(at, 32)
                    mstore(add(np, 7), or(nWord, or(tree, l)))
                    // The index bit at this level says which side the sibling is on.
                    switch and(shr(l, index), 1)
                    case 0 {
                        mstore(add(np, 43), node)
                        mstore(add(np, 79), mload(at))
                    }
                    default {
                        mstore(add(np, 43), mload(at))
                        mstore(add(np, 79), node)
                    }
                    node := keccak256(np, nLen)
                }
                at := add(at, 32)
                mstore(slot, shl(224, 32))
                mstore(add(slot, 4), node)
                slot := add(slot, 36)
            }

            pkValue := mload(add(base, 3))
            ok := eq(keccak256(rp, mload(rb)), pkValue)
        }
        // The recomputed roots must reproduce the public key value the
        // signature carries; only then is that value worth committing to.
        if (!ok) return bytes32(0);
        return keccak256(
            abi.encodePacked(
                uint32(bytes(PK_COMMITMENT_DOMAIN).length), PK_COMMITMENT_DOMAIN,
                uint32(4), uint32(k), uint32(4), uint32(a), uint32(32), pkValue
            )
        );
    }
}
