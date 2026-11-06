// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

/// @notice AES-128, one block, encryption only (FIPS-197): the one-way function
///         Opaque's ring notes use. commitment = AES128(noteSecret, noteBlock),
///         nullifier = AES128(noteSecret, nullifierBlock) (backend/zk/statement.ts).
/// @dev Plain and unoptimised, on purpose: it runs only when a note leaves without
///      the attester (ExitableRingVerifier), where clarity beats gas. Byte i of the
///      state is row i % 4, column i / 4, as the standard lays it out.
library AES128 {
    bytes internal constant SBOX =
        hex"637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b27509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16";

    function encrypt(bytes16 key, bytes16 input) internal pure returns (bytes16) {
        bytes memory sbox = SBOX;
        uint8[176] memory rk = _expand(key, sbox);
        uint8[16] memory s;
        for (uint256 i; i < 16; ++i) s[i] = uint8(input[i]) ^ rk[i];
        for (uint256 round = 1; round <= 10; ++round) {
            // SubBytes and ShiftRows together: row r moves r columns left.
            uint8[16] memory t;
            for (uint256 c; c < 4; ++c) {
                for (uint256 r; r < 4; ++r) t[r + 4 * c] = uint8(sbox[s[r + 4 * ((c + r) % 4)]]);
            }
            if (round < 10) {
                for (uint256 c; c < 4; ++c) {
                    uint8 a0 = t[4 * c];
                    uint8 a1 = t[4 * c + 1];
                    uint8 a2 = t[4 * c + 2];
                    uint8 a3 = t[4 * c + 3];
                    t[4 * c] = _x(a0) ^ _x(a1) ^ a1 ^ a2 ^ a3;
                    t[4 * c + 1] = a0 ^ _x(a1) ^ _x(a2) ^ a2 ^ a3;
                    t[4 * c + 2] = a0 ^ a1 ^ _x(a2) ^ _x(a3) ^ a3;
                    t[4 * c + 3] = _x(a0) ^ a0 ^ a1 ^ a2 ^ _x(a3);
                }
            }
            for (uint256 i; i < 16; ++i) s[i] = t[i] ^ rk[16 * round + i];
        }
        bytes16 out;
        for (uint256 i; i < 16; ++i) out |= bytes16(bytes1(s[i])) >> (8 * i);
        return out;
    }

    /// The 11 round keys, 16 bytes each.
    function _expand(bytes16 key, bytes memory sbox) private pure returns (uint8[176] memory w) {
        for (uint256 i; i < 16; ++i) w[i] = uint8(key[i]);
        uint8 rcon = 1;
        for (uint256 i = 16; i < 176; i += 4) {
            uint8 t0 = w[i - 4];
            uint8 t1 = w[i - 3];
            uint8 t2 = w[i - 2];
            uint8 t3 = w[i - 1];
            if (i % 16 == 0) {
                // RotWord, SubWord, then the round constant on the first byte.
                (t0, t1, t2, t3) = (uint8(sbox[t1]) ^ rcon, uint8(sbox[t2]), uint8(sbox[t3]), uint8(sbox[t0]));
                rcon = _x(rcon);
            }
            w[i] = w[i - 16] ^ t0;
            w[i + 1] = w[i - 15] ^ t1;
            w[i + 2] = w[i - 14] ^ t2;
            w[i + 3] = w[i - 13] ^ t3;
        }
    }

    /// Multiplication by x in GF(2^8), modulo x^8 + x^4 + x^3 + x + 1.
    function _x(uint8 a) private pure returns (uint8) {
        return (a & 0x80) != 0 ? uint8((uint16(a) << 1) ^ 0x11b) : a << 1;
    }
}
