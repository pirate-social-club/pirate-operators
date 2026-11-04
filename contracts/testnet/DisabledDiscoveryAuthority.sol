// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

/// @notice Inert authority for an explicitly disposable, permanently unlisted directory.
/// @dev Deploy two distinct instances for verifier/listing. No calls can be forwarded,
///      and there is no owner, upgrade, initialization, fallback or destruction path.
///      This is not a governance account and cannot later enable Pirate discovery.
contract DisabledDiscoveryAuthority {}
