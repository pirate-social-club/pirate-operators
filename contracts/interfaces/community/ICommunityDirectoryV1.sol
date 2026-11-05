// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

/// @notice V1 directory ABI; local implementation is CommunityDirectoryV1. No deployment is implied.
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

    struct ControllerTransfer {
        uint64 proposalId;
        uint64 baseRevision;
        uint64 deadline;
        address proposedController;
        bytes32 configurationHash;
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
    event ControllerTransferProposed(bytes32 indexed communityId, ControllerTransfer proposal);
    event ControllerTransferCleared(bytes32 indexed communityId, uint64 proposalId);
    event NamespaceVerified(
        bytes32 indexed communityId, uint64 verificationRevision, NamespaceVerification verification
    );
    event ListingChanged(bytes32 indexed communityId, uint64 revision, bool listed, bytes32 reasonSha256);

    error Unauthorized();
    error UnknownCommunity();
    error AlreadyRegistered();
    error InvalidRegistry();
    error StaleRevision();
    error InvalidConfiguration();
    error InvalidControllerTransfer();
    error InvalidVerification();

    /// @dev Current registry.admin() calls from its own account, also the initial controller.
    /// Checks approved factory provenance and derives tldHash on chain; no Pirate consent.
    /// Creates config revision 1 and starts unverified and unlisted.
    function registerCommunity(address registry, Configuration calldata configuration)
        external
        returns (bytes32 communityId);

    /// @dev Only the current controller; this call cannot change the controller address.
    /// Consumes the expected revision and clears a pending transfer. Verification becomes stale.
    function configure(bytes32 communityId, uint64 expectedRevision, Configuration calldata configuration) external;

    /// @dev Current controller commits exact next config at current revision, with an expiry.
    /// Returns a monotonically increasing proposal ID; replacing a proposal invalidates the old one.
    function proposeControllerTransfer(
        bytes32 communityId,
        uint64 expectedRevision,
        Configuration calldata configuration,
        uint64 deadline
    ) external returns (uint64 proposalId);

    /// @dev Only the proposed controller, by account transaction; no detached signature parsing.
    /// Requires unexpired proposal ID, unchanged base revision and exact proposed config hash.
    function acceptControllerTransfer(bytes32 communityId, uint64 proposalId, Configuration calldata configuration)
        external;

    function cancelControllerTransfer(bytes32 communityId, uint64 proposalId) external;
    function getControllerTransfer(bytes32 communityId) external view returns (ControllerTransfer memory);

    /// @dev Only the namespace-verifier governance account; binds exact current config.
    function verifyNamespace(
        bytes32 communityId,
        uint64 expectedVerificationRevision,
        NamespaceVerification calldata verification
    ) external;

    /// @dev Only Pirate's listing governance account. Cannot change community configuration.
    function setListed(bytes32 communityId, uint64 expectedRevision, bool listed, bytes32 reasonSha256) external;

    /// @dev keccak256(abi.encode(block.chainid, registry)); not proof of HNS ownership.
    function communityIdFor(address registry) external view returns (bytes32);
    function getCommunity(bytes32 communityId) external view returns (Community memory);

    /// @dev Discovery status only; never the authorization to register or publish.
    function isDiscoverable(bytes32 communityId) external view returns (bool);
    function namespaceVerifier() external view returns (address);
    function listingAuthority() external view returns (address);
}
