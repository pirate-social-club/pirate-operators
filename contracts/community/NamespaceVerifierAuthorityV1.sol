// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ICommunityDirectoryV1} from "../interfaces/community/ICommunityDirectoryV1.sol";

/// @notice Governance rotates a service key restricted to namespace attestations.
/// @dev Binding checks roles, not target bytecode or the truth of HNS evidence.
/// Governance must verify the deployment profile before binding its directory.
contract NamespaceVerifierAuthorityV1 {
    address public immutable governance;
    ICommunityDirectoryV1 public directory;
    address public operator;

    error Unauthorized();
    error InvalidGovernance();
    error InvalidDirectory();
    error AlreadyBound();
    error Unbound();
    error InvalidOperator();

    event DirectoryBound(address indexed directory);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);

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
        address listing = candidate.listingAuthority();
        if (
            candidate.namespaceVerifier() != address(this) || listing.code.length == 0 || listing == address(this)
                || listing == governance || listing == target
        ) revert InvalidDirectory();
        directory = candidate;
        emit DirectoryBound(target);
    }

    function setOperator(address next) external onlyGovernance {
        if (next != address(0)) {
            if (address(directory) == address(0)) revert Unbound();
            if (next == governance || next == address(this) || next == address(directory)) revert InvalidOperator();
        }
        address previous = operator;
        operator = next;
        emit OperatorChanged(previous, next);
    }

    function verifyNamespace(
        bytes32 communityId,
        uint64 expectedVerificationRevision,
        ICommunityDirectoryV1.NamespaceVerification calldata verification
    ) external {
        if (operator == address(0) || msg.sender != operator) revert Unauthorized();
        // A nonzero operator cannot be configured before the one-time binding.
        directory.verifyNamespace(communityId, expectedVerificationRevision, verification);
    }
}
