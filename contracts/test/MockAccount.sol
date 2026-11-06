// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @dev Test-only stand-in for a MOSS account: an EIP-7702 delegate that
/// stores one signing key, standing in for a passkey, and answers ERC-1271
/// for it. Its storage lives at the delegating account's address.
contract MockAccount {
    bytes32 private constant KEY_SLOT = keccak256("pirate.test.mock-account.key");

    function initialize(address key) external {
        bytes32 slot = KEY_SLOT;
        address current;
        assembly {
            current := sload(slot)
        }
        require(current == address(0), "already_initialized");
        assembly {
            sstore(slot, key)
        }
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        bytes32 slot = KEY_SLOT;
        address key;
        assembly {
            key := sload(slot)
        }
        if (key == address(0) || signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ecrecover(digest, v, r, s) == key ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @dev Test-only stand-in for MOSS's orchestrator: sets an activated account
/// up, and can be told to fail so a delegated-but-uninitialized account exists.
contract MockInitializer {
    bool public failing;

    function setFailing(bool value) external {
        failing = value;
    }

    function activate(address account, address key) external {
        require(!failing, "init_failed");
        MockAccount(account).initialize(key);
    }
}
