// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

// Configuration/controller lifecycle adapted from CommunityDirectoryV1 at b25b402f.
// V1 itself and its deployed identities remain untouched.
import {ICommunityDirectoryV2} from "../interfaces/community/ICommunityDirectoryV2.sol";
import {PublicationReference} from "./PublicationReference.sol";

contract CommunityDirectoryV2 is ICommunityDirectoryV2 {
    bytes32 private constant COMMUNITY_DOMAIN = keccak256("pirate.community/2");
    bytes32 private constant NAMESPACE_DOMAIN = keccak256("pirate.namespace/1");
    address public override admin;
    address public override pendingAdmin;
    uint64 public immutable maxVerificationAge;
    mapping(address => RegistrySource) private sources;
    mapping(bytes32 => Binding) private bindings;
    mapping(bytes32 => Community) private communities;
    mapping(bytes32 => ControllerTransfer) private transfers;
    mapping(bytes32 => uint64) private proposalCounters;

    constructor(address initialAdmin, uint64 maximumAge) {
        if (
            (block.chainid != 6343 && block.chainid != 31337) || initialAdmin == address(0) || maximumAge == 0
                || maximumAge > 1 days
        ) revert InvalidDeploymentProfile();
        admin = initialAdmin;
        maxVerificationAge = maximumAge;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    function proposeAdmin(address next) external override onlyAdmin {
        if (next == address(0) || next == admin) revert InvalidConfiguration();
        pendingAdmin = next;
        emit AdminProposed(admin, next);
    }

    function acceptAdmin() external override {
        if (msg.sender != pendingAdmin) revert Unauthorized();
        address previous = admin;
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminAccepted(previous, msg.sender);
    }

    function namespaceVerifier() external view override returns (address) {
        return admin;
    }

    function listingAuthority() external view override returns (address) {
        return admin;
    }

    // Source admission is not an HNS ownership observation or issuance grant.
    function admitRegistry(address registry, RegistrySource calldata source) external override onlyAdmin {
        if (
            registry.code.length == 0 || registry.codehash != source.runtimeCodeHash
                || source.sourceCommit == bytes20(0) || source.abiSha256 == bytes32(0)
                || sources[registry].runtimeCodeHash != bytes32(0)
        ) revert InvalidRegistry();
        sources[registry] = source;
        emit RegistryAdmitted(registry, source);
    }

    function registrySource(address registry) external view override returns (RegistrySource memory) {
        return sources[registry];
    }

    function registerSharedCommunity(
        address registry,
        string calldata tld,
        Binding calldata binding,
        Configuration calldata configuration
    ) external override onlyAdmin returns (bytes32 id) {
        RegistrySource memory source = sources[registry];
        if (
            source.runtimeCodeHash == bytes32(0) || registry.codehash != source.runtimeCodeHash
                || binding.registryCodeHash != source.runtimeCodeHash || binding.sourceCommit != source.sourceCommit
                || binding.abiSha256 != source.abiSha256
        ) revert InvalidRegistry();
        if (
            binding.communityKey == bytes32(0) || binding.installationId == bytes32(0)
                || binding.originSha256 == bytes32(0) || binding.namespaceId != namespaceIdFor(tld)
        ) {
            revert InvalidBinding();
        }
        id = communityIdFor(binding.communityKey);
        if (communities[id].registry != address(0)) revert AlreadyRegistered();
        _validateConfiguration(configuration);
        Community storage community = communities[id];
        community.registry = registry;
        community.tldHash = sha256(bytes(tld));
        bindings[id] = binding;
        emit CommunityRegistered(id, registry, community.tldHash);
        emit CommunityBound(id, binding);
        _publishConfiguration(id, community, configuration);
    }

    function communityIdFor(bytes32 key) public view override returns (bytes32) {
        if (key == bytes32(0)) revert InvalidBinding();
        return keccak256(abi.encode(COMMUNITY_DOMAIN, block.chainid, key));
    }

    function namespaceIdFor(string memory tld) public pure override returns (bytes32) {
        bytes memory label = bytes(tld);
        uint256 n = label.length;
        if (n == 0 || n > 63 || label[0] == 0x2d || label[n - 1] == 0x2d) revert InvalidBinding();
        if (n >= 4 && label[0] == "x" && label[1] == "n" && label[2] == "-" && label[3] == "-") {
            revert InvalidBinding();
        }
        for (uint256 i; i < n; ++i) {
            bytes1 c = label[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) revert InvalidBinding();
        }
        return keccak256(abi.encode(NAMESPACE_DOMAIN, keccak256(label)));
    }

    function getBinding(bytes32 id) external view override returns (Binding memory) {
        _community(id);
        return bindings[id];
    }

    // Deliberate refusal: selector compatibility must never reinterpret a V1 ID.
    function registerCommunity(address, Configuration calldata) external pure override returns (bytes32) {
        revert LegacyEntryPoint();
    }

    function configure(bytes32 communityId, uint64 expectedRevision, Configuration calldata configuration)
        external
        override
    {
        Community storage community = _controlled(communityId, expectedRevision);
        if (configuration.controller != community.configuration.controller) revert InvalidConfiguration();
        _validateConfiguration(configuration);
        _publishConfiguration(communityId, community, configuration);
    }

    function proposeControllerTransfer(
        bytes32 communityId,
        uint64 expectedRevision,
        Configuration calldata configuration,
        uint64 deadline
    ) external override returns (uint64 proposalId) {
        Community storage community = _controlled(communityId, expectedRevision);
        _validateConfiguration(configuration);
        if (configuration.controller == community.configuration.controller || deadline <= block.timestamp) {
            revert InvalidControllerTransfer();
        }
        _clearTransfer(communityId);
        proposalId = ++proposalCounters[communityId];
        ControllerTransfer memory proposal = ControllerTransfer(
            proposalId, expectedRevision, deadline, configuration.controller, keccak256(abi.encode(configuration))
        );
        transfers[communityId] = proposal;
        emit ControllerTransferProposed(communityId, proposal);
    }

    function acceptControllerTransfer(bytes32 communityId, uint64 proposalId, Configuration calldata configuration)
        external
        override
    {
        Community storage community = _community(communityId);
        ControllerTransfer memory proposal = transfers[communityId];
        if (
            proposalId == 0 || proposal.proposalId != proposalId
                || proposal.baseRevision != community.configurationRevision || block.timestamp > proposal.deadline
                || msg.sender != proposal.proposedController
                || keccak256(abi.encode(configuration)) != proposal.configurationHash
        ) revert InvalidControllerTransfer();
        _validateConfiguration(configuration);
        _publishConfiguration(communityId, community, configuration);
    }

    function cancelControllerTransfer(bytes32 communityId, uint64 proposalId) external override {
        Community storage community = _community(communityId);
        if (msg.sender != community.configuration.controller) revert Unauthorized();
        if (proposalId == 0 || transfers[communityId].proposalId != proposalId) revert InvalidControllerTransfer();
        _clearTransfer(communityId);
    }

    function getControllerTransfer(bytes32 communityId) external view override returns (ControllerTransfer memory) {
        _community(communityId);
        return transfers[communityId];
    }

    function verifyNamespace(
        bytes32 communityId,
        uint64 expectedVerificationRevision,
        NamespaceVerification calldata verification
    ) external override {
        if (msg.sender != admin) revert Unauthorized();
        Community storage community = _community(communityId);
        if (expectedVerificationRevision != community.verificationRevision) revert StaleRevision();
        if (
            verification.configurationRevision != community.configurationRevision
                || verification.hnsBlockHash == bytes32(0) || verification.evidenceSha256 == bytes32(0)
                || verification.observedAt > block.timestamp || verification.validUntil <= block.timestamp
                || verification.observedAt < community.verification.observedAt
                || verification.validUntil - verification.observedAt > maxVerificationAge
        ) revert InvalidVerification();
        community.verification = verification;
        emit NamespaceVerified(communityId, ++community.verificationRevision, verification);
    }

    function setListed(bytes32 communityId, uint64 expectedRevision, bool listed, bytes32 reasonSha256)
        external
        override
    {
        if (msg.sender != admin) revert Unauthorized();
        Community storage community = _community(communityId);
        if (expectedRevision != community.listingRevision) revert StaleRevision();
        if (listed && !_verified(community)) revert InvalidVerification();
        community.listed = listed;
        emit ListingChanged(communityId, ++community.listingRevision, listed, reasonSha256);
    }

    function communityIdFor(address) public pure override returns (bytes32) {
        revert LegacyEntryPoint();
    }

    function getCommunity(bytes32 communityId) external view override returns (Community memory) {
        return _community(communityId);
    }

    function isDiscoverable(bytes32 communityId) external view override returns (bool) {
        Community storage community = communities[communityId];
        return community.registry != address(0) && community.listed && _verified(community);
    }

    function _community(bytes32 id) private view returns (Community storage community) {
        community = communities[id];
        if (community.registry == address(0)) revert UnknownCommunity();
    }

    function _controlled(bytes32 id, uint64 revision) private view returns (Community storage community) {
        community = _community(id);
        if (msg.sender != community.configuration.controller) revert Unauthorized();
        if (revision != community.configurationRevision) revert StaleRevision();
    }

    function _validateConfiguration(Configuration calldata configuration) private view {
        if (
            configuration.controller == address(0) || configuration.publisher == address(0)
                || configuration.sha256Digest == bytes32(0) || !PublicationReference.valid(configuration.uri)
                || configuration.operatorPayments != address(0) && configuration.operatorPayments.code.length == 0
                || configuration.learningRecords != address(0) && configuration.learningRecords.code.length == 0
        ) {
            revert InvalidConfiguration();
        }
    }

    function _publishConfiguration(bytes32 id, Community storage community, Configuration calldata configuration)
        private
    {
        _clearTransfer(id);
        community.configuration = configuration;
        uint64 revision = ++community.configurationRevision;
        emit ConfigurationPublished(
            id,
            revision,
            configuration.controller,
            configuration.publisher,
            configuration.operatorPayments,
            configuration.learningRecords,
            configuration.sha256Digest,
            configuration.uri
        );
    }

    function _clearTransfer(bytes32 id) private {
        uint64 proposalId = transfers[id].proposalId;
        if (proposalId != 0) {
            delete transfers[id];
            emit ControllerTransferCleared(id, proposalId);
        }
    }

    function _verified(Community storage community) private view returns (bool) {
        return community.registry.codehash == sources[community.registry].runtimeCodeHash
            && community.verificationRevision != 0
            && community.verification.configurationRevision == community.configurationRevision
            && community.verification.validUntil > block.timestamp;
    }
}
