// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

/// @notice Explicit purpose-scoped publication consent. Never browser authentication.
interface ICommunityPublicationConsentV1 {
    struct PublicationGrant {
        address learner;
        bytes32 communityId;
        string purpose;
        address publicationTarget;
        bytes32 publicationTargetRuntimeHash;
        uint64 permissionRevision;
        bytes32 policyHash;
        uint64 withdrawalEpoch;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 validAfter;
        uint64 expiresAt;
        uint64 submitBefore;
    }

    struct PublicationWithdrawal {
        address learner;
        bytes32 communityId;
        string purpose;
        uint64 expectedEpoch;
        bytes32 nonce;
        uint64 submitBefore;
    }

    struct PublicationCorrection {
        address learner;
        bytes32 communityId;
        string purpose;
        address publicationTarget;
        bytes32 publicationTargetRuntimeHash;
        uint64 permissionRevision;
        bytes32 policyHash;
        uint64 withdrawalEpoch;
        bytes32 resultId;
        bytes32 originalGrantId;
        bytes32 previousCommitment;
        bytes32 correctedCommitment;
        bytes32 reasonHash;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 submitBefore;
    }

    struct PurposeDescriptor {
        address target;
        bytes32 runtimeHash;
        bytes32 policyHash;
        uint64 maxGrantDurationSeconds;
        uint64 maxSubmissionDelaySeconds;
        bool enabled;
    }
    enum Denial {
        None,
        UnknownGrant,
        WrongScope,
        InactiveRegistry,
        SupersededDescriptor,
        ChangedTargetCode,
        Withdrawn,
        NotEffective,
        Expired
    }
    error InvalidSource();
    error InvalidPurpose();
    error InvalidDescriptor();
    error StaleRevision();
    error Unauthorized();
    error InvalidConsent();
    error InvalidWindow();
    error NonceUsed();
    error InvalidCorrection();
    event PurposeConfigured(
        bytes32 indexed purposeHash,
        uint64 permissionRevision,
        address target,
        bytes32 runtimeHash,
        bytes32 policyHash,
        uint64 maxGrantDurationSeconds,
        uint64 maxSubmissionDelaySeconds,
        bool enabled
    );
    event PublicationGranted(
        bytes32 indexed grantId,
        address indexed learner,
        bytes32 indexed purposeHash,
        PublicationGrant grant,
        uint64 recordedAt
    );
    event PublicationWithdrawn(
        address indexed learner,
        bytes32 indexed purposeHash,
        uint64 previousEpoch,
        uint64 nextEpoch,
        bytes32 withdrawalId
    );
    function consentVersion() external pure returns (uint8);
    function communityId() external view returns (bytes32);
    function configurePurpose(
        string calldata purpose,
        uint64 expectedPermissionRevision,
        uint64 expectedConfigurationRevision,
        PurposeDescriptor calldata descriptor
    ) external;
    function purpose(bytes32 purposeHash) external view returns (uint64 revision, PurposeDescriptor memory descriptor);
    function grantDigest(PublicationGrant calldata g) external view returns (bytes32);
    function withdrawalDigest(PublicationWithdrawal calldata w) external view returns (bytes32);
    function correctionDigest(PublicationCorrection calldata c) external view returns (bytes32);
    function grant(PublicationGrant calldata g, bytes calldata signature) external;
    function withdraw(PublicationWithdrawal calldata w, bytes calldata signature) external;
    function withdrawalEpoch(address learner, bytes32 purposeHash) external view returns (uint64);
    function grantOf(bytes32 id) external view returns (PublicationGrant memory, uint64 recordedAt);
    function checkGrant(
        bytes32 id,
        address learner,
        bytes32 purposeHash,
        address publicationTarget,
        bytes32 policyHash,
        uint64 boundAt
    ) external view returns (bool allowed, uint8 reason);
}
