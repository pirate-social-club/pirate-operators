// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

/// @dev Bounded URI shape only. The publication service must decode the CID,
/// retrieve the bytes and verify their digest before submitting a reference.
library PublicationReference {
    function valid(string calldata uri) internal pure returns (bool) {
        bytes calldata value = bytes(uri);
        if (value.length < 12 || value.length > 512) return false;
        if (bytes7(value[:7]) != bytes7("ipfs://")) return false;
        uint256 end = 7;
        while (end < value.length && value[end] != 0x2f) ++end;
        bool v0 = end == 53 && value[7] == 0x51 && value[8] == 0x6d;
        bool v1 = end >= 12 && value[7] == 0x62;
        if (!v0 && !v1) return false;
        for (uint256 i = 7; i < end; ++i) {
            uint8 c = uint8(value[i]);
            if (v0) {
                if (!(c >= 49 && c <= 57 || c >= 65 && c <= 90 && c != 73 && c != 79 || c >= 97 && c <= 122
                            && c != 108)) return false;
            } else if (!(c >= 97 && c <= 122 || c >= 50 && c <= 55)) {
                return false;
            }
        }
        // Canonical ASCII paths; no escapes, queries, fragments or dot segments.
        uint256 segment = end + 1;
        for (uint256 i = end; i <= value.length; ++i) {
            if (i == value.length || value[i] == 0x2f) {
                if (i != end) {
                    uint256 n = i - segment;
                    if (
                        n == 0 || n == 1 && value[segment] == 0x2e || n == 2 && value[segment] == 0x2e
                            && value[segment + 1] == 0x2e
                    ) return false;
                }
                segment = i + 1;
            } else {
                uint8 c = uint8(value[i]);
                if (!(c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122 || c == 45 || c == 46 || c == 95
                            || c == 126)) return false;
            }
        }
        return true;
    }
}
