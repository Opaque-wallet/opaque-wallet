// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AES128} from "../src/opaque/lib/AES128.sol";
import {Canonical} from "../src/opaque/lib/Canonical.sol";
import {IPQKeyRegistry} from "../src/opaque/interfaces/IPQKeyRegistry.sol";
import {IERC20, PrivatePool} from "../src/opaque/pool/PrivatePool.sol";
import {AttestedRingVerifier} from "../src/opaque/pool/AttestedRingVerifier.sol";
import {ExitableRingVerifier} from "../src/opaque/pool/ExitableRingVerifier.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract AesHarness {
    function encrypt(bytes16 key, bytes16 block_) external pure returns (bytes16) {
        return AES128.encrypt(key, block_);
    }
}

/// Vectors: backend/zk/exit-vectors.ts, from the wallet's own derivations.
contract ExitableRingVerifierTest is Test {
    string internal j;
    AesHarness internal aes;
    address internal constant REGISTRY = address(0x5EC);
    address internal constant ATTESTER = address(0xA77E);

    function setUp() public {
        j = vm.readFile("test/fixtures/exit-vectors.json");
        aes = new AesHarness();
    }

    function b16(string memory path) internal view returns (bytes16) {
        return bytes16(vm.parseJsonBytes32(string.concat(vm.toString(vm.parseJsonBytes(j, path)), "00000000000000000000000000000000"), ""));
    }

    function test_aes128_matches_fips197_and_the_wallet() public view {
        assertEq(aes.encrypt(bytes16(vm.parseJsonBytes(j, ".fips.key")), bytes16(vm.parseJsonBytes(j, ".fips.block"))), bytes16(vm.parseJsonBytes(j, ".fips.out")));
        for (uint256 i; i < 3; ++i) {
            string memory p = string.concat(".pairs[", vm.toString(i), "]");
            assertEq(aes.encrypt(bytes16(vm.parseJsonBytes(j, string.concat(p, ".key"))), bytes16(vm.parseJsonBytes(j, string.concat(p, ".block")))), bytes16(vm.parseJsonBytes(j, string.concat(p, ".out"))));
        }
    }

    function test_a_pools_blocks_and_notes_are_the_wallets() public {
        bytes32 id = vm.parseJsonBytes32(j, ".pool.poolId");
        uint256 denomination = vm.parseJsonUint(j, ".pool.denomination");
        AttestedRingVerifier attested = new AttestedRingVerifier(IPQKeyRegistry(REGISTRY), ATTESTER, id, denomination);
        ExitableRingVerifier v = new ExitableRingVerifier(attested, address(this), 600);
        assertEq(v.noteBlock(), bytes16(vm.parseJsonBytes(j, ".pool.noteBlock")));
        assertEq(v.nullifierBlock(), bytes16(vm.parseJsonBytes(j, ".pool.nullifierBlock")));
        for (uint256 i; i < 2; ++i) {
            string memory p = string.concat(".pool.notes[", vm.toString(i), "]");
            (bytes32 c, bytes32 n) = v.noteOf(bytes16(vm.parseJsonBytes(j, string.concat(p, ".secret"))));
            assertEq(c, vm.parseJsonBytes32(j, string.concat(p, ".commitment")));
            assertEq(n, vm.parseJsonBytes32(j, string.concat(p, ".nullifier")));
        }
        assertEq(v.verifierId(), attested.verifierId());
        assertEq(v.ringSize(), 8);
        assertFalse(v.requiresCommitReveal());
    }

    // ── the exit, through a real pool ─────────────────────────────────────

    MockUSDC internal usdc;
    PrivatePool internal pool;
    ExitableRingVerifier internal verifier;
    uint256 internal constant SIZE = 5_000_000;
    uint256 internal constant DELAY = 600;
    bytes16 internal constant SECRET = 0x0f1e2d3c4b5a69788796a5b4c3d2e1f0;
    address internal constant RECIPIENT = address(0xBEEF);

    function deployPool() internal {
        usdc = new MockUSDC();
        // The verifiers bind the pool before it exists: its address from this contract's nonce.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        bytes32 id = keccak256(abi.encodePacked(
            Canonical.field(bytes("opaque/v1/pool-id")), Canonical.field(Canonical.decimal(block.chainid)), abi.encodePacked(uint32(20), predicted)
        ));
        AttestedRingVerifier attested = new AttestedRingVerifier(IPQKeyRegistry(REGISTRY), ATTESTER, id, SIZE);
        verifier = new ExitableRingVerifier(attested, predicted, DELAY);
        pool = new PrivatePool(IERC20(address(usdc)), SIZE, verifier);
        assertEq(address(pool), predicted);
        assertEq(pool.poolId(), id);
    }

    function ringWith(bytes32 mine) internal returns (bytes32[] memory ring) {
        ring = new bytes32[](8);
        usdc.mint(address(this), 8 * SIZE);
        usdc.approve(address(pool), 8 * SIZE);
        for (uint256 i; i < 8; ++i) {
            ring[i] = i == 3 ? mine : bytes32(uint256(keccak256(abi.encode("decoy", i))) << 128);
            pool.deposit(ring[i]);
        }
    }

    function test_a_note_leaves_with_no_attester_after_the_delay() public {
        deployPool();
        (bytes32 commitment, bytes32 nullifier) = verifier.noteOf(SECRET);
        bytes32[] memory ring = ringWith(commitment);
        bytes memory exitProof = abi.encodePacked(verifier.EXIT_TAG(), SECRET);

        // Not announced: refused.
        vm.expectRevert(ExitableRingVerifier.NotAnnounced.selector);
        pool.spend(ring, exitProof, RECIPIENT, bytes32(0));

        verifier.announceExit(nullifier, keccak256(abi.encode(SECRET, pool.paymentContext(RECIPIENT))));
        vm.expectRevert(abi.encodeWithSelector(ExitableRingVerifier.TooEarly.selector, block.timestamp + DELAY));
        pool.spend(ring, exitProof, RECIPIENT, bytes32(0));

        vm.warp(block.timestamp + DELAY);
        // The announcement names its payee: another recipient is not announced.
        vm.expectRevert(ExitableRingVerifier.NotAnnounced.selector);
        pool.spend(ring, exitProof, address(0xBAD), bytes32(0));

        pool.spend(ring, exitProof, RECIPIENT, bytes32(0));
        assertEq(usdc.balanceOf(RECIPIENT), SIZE);
        assertTrue(pool.isNullifierSpent(nullifier));

        // Once, like any spend.
        vm.expectRevert(PrivatePool.NullifierAlreadySpent.selector);
        pool.spend(ring, exitProof, RECIPIENT, bytes32(0));
    }

    function test_the_secret_must_open_a_ring_member() public {
        deployPool();
        (bytes32 commitment,) = verifier.noteOf(SECRET);
        bytes32[] memory ring = ringWith(commitment);
        bytes16 other = 0x00000000000000000000000000000001;
        (, bytes32 otherNullifier) = verifier.noteOf(other);
        verifier.announceExit(otherNullifier, keccak256(abi.encode(other, pool.paymentContext(RECIPIENT))));
        vm.warp(block.timestamp + DELAY);
        bytes memory proof = abi.encodePacked(verifier.EXIT_TAG(), other);
        vm.expectRevert(ExitableRingVerifier.NotInRing.selector);
        pool.spend(ring, proof, RECIPIENT, bytes32(0));
    }

    function test_an_exiting_note_cannot_be_raced_through_the_attester() public {
        deployPool();
        (bytes32 commitment, bytes32 nullifier) = verifier.noteOf(SECRET);
        bytes32[] memory ring = ringWith(commitment);
        bytes32 claim = keccak256(abi.encode(SECRET, pool.paymentContext(RECIPIENT)));
        verifier.announceExit(nullifier, claim);
        // A private-path proof for the same nullifier (any attestation): refused before the attester is asked.
        vm.expectRevert(ExitableRingVerifier.NoteIsExiting.selector);
        pool.spend(ring, abi.encodePacked(nullifier, hex"00"), address(0xBAD), bytes32(0));
        // Nor can an announcement be overwritten.
        vm.expectRevert(ExitableRingVerifier.AlreadyAnnounced.selector);
        verifier.announceExit(nullifier, claim);
    }

    function test_only_its_pool_may_ask() public {
        deployPool();
        vm.expectRevert(ExitableRingVerifier.NotThePool.selector);
        verifier.verifySpend(new bytes32[](8), hex"00", bytes32(0));
    }
}
