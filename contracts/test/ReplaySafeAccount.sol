// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @dev Test-only stand-in for an IthacaAccount-style smart account (MOSS).
/// It does not sign the application's digest directly: its key signs the
/// EIP-712 `ERC1271Sign(bytes32 digest)` wrapper under the account's own
/// domain {name "IthacaAccount", version "0.5.12", chainId, verifyingContract
/// this account}, as the MOSS SDK's account `signMessage` does, and
/// isValidSignature rebuilds that wrapper from the digest it is given. The
/// SDK's key-hash and ERC-8010 packaging around the signature are not modelled.
contract ReplaySafeAccount {
    bytes32 private constant ERC1271_SIGN_TYPEHASH = keccak256("ERC1271Sign(bytes32 digest)");
    address public immutable key;

    constructor(address signer) {
        key = signer;
    }

    function wrapped(bytes32 digest) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("IthacaAccount"),
                keccak256("0.5.12"),
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(ERC1271_SIGN_TYPEHASH, digest))));
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        address signer = ecrecover(wrapped(digest), v, r, s);
        return signer != address(0) && signer == key ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
