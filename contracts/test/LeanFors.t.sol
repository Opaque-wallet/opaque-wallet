// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ForsVerifier} from "../src/opaque/wallet/ForsVerifier.sol";
import {LeanFors} from "../src/ethereum/frame/LeanFors.sol";

/// LeanFors is a second implementation of ForsVerifier.recoverCommitment, so
/// it is held to the first: same answer on the TypeScript signer's vectors, on
/// every tampering, and on malformed input. Plus the reason it exists: it has
/// to fit EIP-8141's 100,000-gas validation budget with room to spare.
contract LeanForsTest is Test {
    struct Vector {
        bytes signature;
        bytes32 digest;
        bytes32 pkCommitment;
    }

    function _vector(string memory file) internal view returns (Vector memory v) {
        string memory json = vm.readFile(file);
        v.signature = vm.parseJsonBytes(json, ".signature");
        v.digest = vm.parseJsonBytes32(json, ".digest");
        v.pkCommitment = vm.parseJsonBytes32(json, ".pkCommitment");
    }

    function lean(bytes calldata sig, bytes32 digest) external pure returns (bytes32) {
        return LeanFors.recoverCommitment(sig, digest);
    }

    function reference_(bytes calldata sig, bytes32 digest) external pure returns (bytes32 c) {
        (c,) = ForsVerifier.recoverCommitment(sig, digest);
    }

    /// Measured inside the call, so it is verification and not the test's own
    /// cost of copying the signature in.
    function measure(bytes calldata sig, bytes32 digest) external view returns (uint256 used, bytes32 c) {
        bytes memory m = sig;
        uint256 before = gasleft();
        c = LeanFors.recoverCommitment(m, digest);
        used = before - gasleft();
    }

    function test_agreesOnBothParameterSets() public view {
        string[2] memory files = ["test/fixtures/fors-vectors.json", "test/fixtures/fors-k13a13.json"];
        for (uint256 f = 0; f < files.length; f++) {
            Vector memory v = _vector(files[f]);
            bytes32 c = this.lean(v.signature, v.digest);
            assertEq(c, v.pkCommitment, "the commitment the TypeScript signer computed");
            assertEq(c, this.reference_(v.signature, v.digest), "and ForsVerifier's");
        }
    }

    function test_fitsTheValidationBudget() public view {
        Vector memory big = _vector("test/fixtures/fors-vectors.json");
        Vector memory small = _vector("test/fixtures/fors-k13a13.json");
        (uint256 k32, bytes32 c1) = this.measure(big.signature, big.digest);
        (uint256 k13, bytes32 c2) = this.measure(small.signature, small.digest);
        assertEq(c1, big.pkCommitment);
        assertEq(c2, small.pkCommitment);
        console2.log("LeanFors k=32,a=8  execution gas:", k32);
        console2.log("LeanFors k=13,a=13 execution gas:", k13);
        // The account adds SIGDATACOPY, TXPARAM, two storage reads and APPROVE
        // on top, about 15-20k; 60k for the signature leaves room for them
        // under MAX_VERIFY_GAS. k=32,a=8 (83k) does not, so the frame account
        // signs with k=13,a=13. ForsVerifier spends 167k on the same signature.
        assertLt(k13, 60_000, "k=13,a=13 must leave room in MAX_VERIFY_GAS");
    }

    /// Every byte of the signature, flipped one at a time across a sample that
    /// covers the header, the public key, leaves and every path level: both
    /// implementations must give the same answer, and it must not be the key.
    function testFuzz_tamperingAgrees(uint256 position, uint8 bit) public view {
        Vector memory v = _vector("test/fixtures/fors-k13a13.json");
        bytes memory sig = v.signature;
        position = bound(position, 3, sig.length - 1);
        sig[position] = bytes1(uint8(sig[position]) ^ uint8(1 << (bit % 8)));
        bytes32 got = this.lean(sig, v.digest);
        assertEq(got, this.reference_(sig, v.digest), "same verdict as ForsVerifier");
        assertTrue(got != v.pkCommitment, "a tampered signature proves nothing");
    }

    function test_rejectsAnotherDigest() public view {
        Vector memory v = _vector("test/fixtures/fors-k13a13.json");
        bytes32 other = keccak256(abi.encode(v.digest));
        assertEq(this.lean(v.signature, other), bytes32(0));
        assertEq(this.reference_(v.signature, other), bytes32(0));
    }

    function test_revertsWhereForsVerifierReverts() public {
        Vector memory v = _vector("test/fixtures/fors-k13a13.json");
        bytes memory truncated = new bytes(v.signature.length - 1);
        for (uint256 i = 0; i < truncated.length; i++) truncated[i] = v.signature[i];
        vm.expectRevert(LeanFors.MalformedSignature.selector);
        this.lean(truncated, v.digest);
        vm.expectRevert(ForsVerifier.MalformedSignature.selector);
        this.reference_(truncated, v.digest);

        bytes memory k0 = v.signature;
        k0[0] = 0;
        k0[1] = 0;
        vm.expectRevert(LeanFors.UnsupportedParameters.selector);
        this.lean(k0, v.digest);

        vm.expectRevert(LeanFors.MalformedSignature.selector);
        this.lean(hex"0001", v.digest);
    }
}
