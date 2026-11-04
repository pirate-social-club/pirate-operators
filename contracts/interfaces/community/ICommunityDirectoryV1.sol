// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

/// @notice Proposed ABI only. No implementation or deployment is supplied.
/// @dev Normative authorization and hashing: docs/contracts/community-directory.md.
interface ICommunityDirectoryV1 {
    struct Configuration {
        address controller;
        address publisher;
        address operatorPayments;
        address learningRecords;
        bytes32 sha256Digest;
        string uri;
    }

    struct NamespaceVerification {
        uint64 configurationRevision;
        uint64 hnsHeight;
        bytes32 hnsBlockHash;
        uint64 observedAt;
        uint64 validUntil;
        bytes32 evidenceSha256;
    }

    struct Community {
        address registry;
        bytes32 tldHash;
        uint64 configurationRevision;
        Configuration configuration;
        uint64 verificationRevision;
        NamespaceVerification verification;
        uint64 listingRevision;
        bool listed;
    }

    event CommunityRegistered(bytes32 indexed communityId, address indexed registry, bytes32 tldHash);
    event ConfigurationPublished(
        bytes32 indexed communityId,
        uint64 revision,
        address controller,
        address publisher,
        address operatorPayments,
        address learningRecords,
        bytes32 sha256Digest,
        string uri
    );
    event NamespaceVerified(
        bytes32 indexed communityId, uint64 verificationRevision, NamespaceVerification verification
    );
    event ListingChanged(bytes32 indexed communityId, uint64 revision, bool listed, bytes32 reasonSha256);

    error Unauthorized();
    error UnknownCommunity();
    error AlreadyRegistered();
    error StaleRevision();
    error InvalidConfiguration();
    error InvalidConsent();
    error InvalidVerification();

    /// @dev Only the namespace verifier; requires initial controller consent.
    /// Registration creates revision 1, emits ConfigurationPublished and starts unlisted.
    function registerCommunity(
        address registry,
        bytes32 tldHash,
        Configuration calldata configuration,
        uint64 consentDeadline,
        bytes calldata controllerConsent
    ) external returns (bytes32 communityId);

    /// @dev Only the current controller. A new controller must additionally consent.
    /// The expected revision is consumed once; configuration changes stale verification.
    function configure(
        bytes32 communityId,
        uint64 expectedRevision,
        Configuration calldata configuration,
        uint64 consentDeadline,
        bytes calldata newControllerConsent
    ) external;

    /// @dev Only the namespace verifier; binds evidence to the exact current config.
    function verifyNamespace(
        bytes32 communityId,
        uint64 expectedVerificationRevision,
        NamespaceVerification calldata verification
    ) external;

    /// @dev Only Pirate's listing authority. Cannot change community configuration.
    function setListed(bytes32 communityId, uint64 expectedRevision, bool listed, bytes32 reasonSha256) external;

    /// @dev keccak256(abi.encode(block.chainid, registry)); not proof of HNS ownership.
    function communityIdFor(address registry) external view returns (bytes32);
    function getCommunity(bytes32 communityId) external view returns (Community memory);

    /// @dev Discovery status only; never the authorization to publish a community post.
    function isDiscoverable(bytes32 communityId) external view returns (bool);
    function namespaceVerifier() external view returns (address);
    function listingAuthority() external view returns (address);
}
