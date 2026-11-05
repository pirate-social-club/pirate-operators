// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ICommunityDirectoryV1} from "../interfaces/community/ICommunityDirectoryV1.sol";

/// @notice Governance controls listings; a separate emergency key can only delist.
/// @dev Role getters do not authenticate deployment bytecode or governance custody.
contract CommunityListingAuthorityV1 {
    address public immutable governance;
    ICommunityDirectoryV1 public directory;
    address public emergencyKey;

    error Unauthorized();
    error InvalidGovernance();
    error InvalidDirectory();
    error AlreadyBound();
    error Unbound();
    error InvalidEmergencyKey();
    error InvalidReason();

    event DirectoryBound(address indexed directory);
    event EmergencyKeyChanged(address indexed previousKey, address indexed newKey);

    constructor(address governance_) {
        if (governance_.code.length == 0) revert InvalidGovernance();
        governance = governance_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    function bindDirectory(address target) external onlyGovernance {
        if (address(directory) != address(0)) revert AlreadyBound();
        if (target.code.length == 0 || target == address(this) || target == governance) revert InvalidDirectory();
        ICommunityDirectoryV1 candidate = ICommunityDirectoryV1(target);
        address verifier = candidate.namespaceVerifier();
        if (
            candidate.listingAuthority() != address(this) || verifier.code.length == 0 || verifier == address(this)
                || verifier == governance || verifier == target
        ) revert InvalidDirectory();
        directory = candidate;
        emit DirectoryBound(target);
    }

    function setEmergencyKey(address next) external onlyGovernance {
        if (next != address(0)) {
            if (address(directory) == address(0)) revert Unbound();
            if (
                next == governance || next == address(this) || next == address(directory)
                    || next == directory.namespaceVerifier()
            ) revert InvalidEmergencyKey();
        }
        address previous = emergencyKey;
        emergencyKey = next;
        emit EmergencyKeyChanged(previous, next);
    }

    function setListed(bytes32 communityId, uint64 expectedRevision, bool listed, bytes32 reasonSha256)
        external
        onlyGovernance
    {
        if (address(directory) == address(0)) revert Unbound();
        directory.setListed(communityId, expectedRevision, listed, reasonSha256);
    }

    function emergencyDelist(bytes32 communityId, bytes32 reasonSha256) external {
        if (emergencyKey == address(0) || msg.sender != emergencyKey) revert Unauthorized();
        if (reasonSha256 == bytes32(0)) revert InvalidReason();
        // Read and consume the canonical revision within this same transaction.
        uint64 revision = directory.getCommunity(communityId).listingRevision;
        directory.setListed(communityId, revision, false, reasonSha256);
    }
}
