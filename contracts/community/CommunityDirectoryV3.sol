// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

// Configuration/controller lifecycle retained from V2 at a0b4999.
// V1/V2 source, deployments and historic identity are untouched.
import {ICommunityDirectoryV3} from "../interfaces/community/ICommunityDirectoryV3.sol";
import {PublicationReference} from "./PublicationReference.sol";

contract CommunityDirectoryV3 is ICommunityDirectoryV3 {
    bytes32 private constant COMMUNITY_DOMAIN = keccak256("pirate.community/2");
    bytes32 private constant NAMESPACE_DOMAIN = keccak256("pirate.namespace/1");
    address public override admin;
    address public override pendingAdmin;
    uint64 public constant MAX_WEB2_AGE = 30 days;
    uint64 public constant MAX_HNS_AGE = 1 days;
    address public override web2Verifier;
    address public override namespaceVerifier;
    address public override listingAuthority;
    RegistrarPermission private registrar;
    mapping(bytes32 => OriginState) private origins;
    mapping(bytes32 => uint64) private originUpdatedAt;
    mapping(bytes32 => uint64) private controllerUpdatedAt;
    mapping(bytes32 => Web2Verification) private web2;
    mapping(bytes32 => uint64) private web2Revisions;
    mapping(bytes32 => uint64) private web2RevokedAt;
    uint64 private web2Generation = 1;
    uint64 private web2InvalidatedAt;
    mapping(bytes32 => uint64) private web2AcceptedGenerations;
    mapping(bytes32 => HnsAttachment) private hns;
    mapping(bytes32 => uint64) private hnsRevisions;
    mapping(bytes32 => uint64) private hnsRevokedAt;
    uint64 private hnsGeneration = 1;
    uint64 private hnsInvalidatedAt;
    mapping(bytes32 => uint64) private hnsAcceptedGenerations;
    mapping(address => RegistrySource) private sources;
    mapping(bytes32 => HostingBinding) private bindings;
    mapping(bytes32 => Community) private communities;
    mapping(bytes32 => ControllerTransfer) private transfers;
    mapping(bytes32 => uint64) private proposalCounters;

    constructor(address initialAdmin) {
        if ((block.chainid != 6343 && block.chainid != 31337) || initialAdmin == address(0)) {
            revert InvalidDeploymentProfile();
        }
        admin = initialAdmin;
        web2Verifier = initialAdmin;
        namespaceVerifier = initialAdmin;
        listingAuthority = initialAdmin;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    function proposeAdmin(address next) external override onlyAdmin {
        if (next == address(0) || next == admin || next == registrar.account) revert InvalidConfiguration();
        pendingAdmin = next;
        emit AdminProposed(admin, next);
    }

    function acceptAdmin() external override {
        if (msg.sender != pendingAdmin || msg.sender == registrar.account) revert Unauthorized();
        address previous = admin;
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminAccepted(previous, msg.sender);
    }

    function setVerificationRoles(address web2Role, address hnsRole, address listingRole) external override onlyAdmin {
        if (
            web2Role == address(0) || hnsRole == address(0) || listingRole == address(0)
                || web2Role == registrar.account || hnsRole == registrar.account || listingRole == registrar.account
        ) {
            revert InvalidConfiguration();
        }
        web2Verifier = web2Role;
        namespaceVerifier = hnsRole;
        listingAuthority = listingRole;
        emit VerificationRolesChanged(web2Role, hnsRole, listingRole);
    }

    function invalidateWeb2Proofs(address replacementVerifier) external override onlyAdmin {
        if (
            replacementVerifier == address(0) || replacementVerifier == web2Verifier
                || replacementVerifier == registrar.account
        ) revert InvalidConfiguration();
        address previous = web2Verifier;
        web2Verifier = replacementVerifier;
        web2InvalidatedAt = uint64(block.timestamp);
        emit Web2ProofsInvalidated(previous, replacementVerifier, ++web2Generation, web2InvalidatedAt);
    }

    function invalidateHnsProofs(address replacementVerifier) external override onlyAdmin {
        if (
            replacementVerifier == address(0) || replacementVerifier == namespaceVerifier
                || replacementVerifier == registrar.account
        ) revert InvalidConfiguration();
        address previous = namespaceVerifier;
        namespaceVerifier = replacementVerifier;
        hnsInvalidatedAt = uint64(block.timestamp);
        emit HnsProofsInvalidated(previous, replacementVerifier, ++hnsGeneration, hnsInvalidatedAt);
    }

    function getWeb2ProofAuthority() external view override returns (address, uint64, uint64) {
        return (web2Verifier, web2Generation, web2InvalidatedAt);
    }

    function getHnsProofAuthority() external view override returns (address, uint64, uint64) {
        return (namespaceVerifier, hnsGeneration, hnsInvalidatedAt);
    }

    function getWeb2ProofGeneration(bytes32 id) external view override returns (uint64) {
        _community(id);
        return web2AcceptedGenerations[id];
    }

    function getHnsProofGeneration(bytes32 id) external view override returns (uint64) {
        _community(id);
        return hnsAcceptedGenerations[id];
    }

    function configureRegistrar(address account, uint64 validUntil, uint64 totalLimit, uint64 expectedRevision)
        external
        override
        onlyAdmin
    {
        if (expectedRevision != registrar.revision) revert StaleRevision();
        if (
            totalLimit == 0 || totalLimit < registrar.totalRegistered
                || (account == address(0) ? validUntil != 0 : validUntil <= block.timestamp) || account == admin
                || account == pendingAdmin && account != address(0) || account == web2Verifier
                || account == namespaceVerifier || account == listingAuthority
        ) {
            revert InvalidConfiguration();
        }
        registrar.account = account;
        registrar.validUntil = validUntil;
        registrar.totalLimit = totalLimit;
        ++registrar.revision;
        emit RegistrarConfigured(registrar);
    }

    function registrarPermission() external view override returns (RegistrarPermission memory) {
        return registrar;
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

    function registerHostedCommunity(
        HostingBinding calldata binding,
        Configuration calldata configuration,
        bytes32 originSha256,
        uint64 expectedRegistrarRevision
    ) external override returns (bytes32 id) {
        if (
            msg.sender != registrar.account || block.timestamp >= registrar.validUntil
                || registrar.totalRegistered >= registrar.totalLimit
        ) revert RegistrarUnavailable();
        if (expectedRegistrarRevision != registrar.revision) revert StaleRevision();
        if (binding.communityKey == bytes32(0) || binding.installationId == bytes32(0) || originSha256 == bytes32(0)) {
            revert InvalidBinding();
        }
        id = communityIdFor(binding.communityKey);
        if (communities[id].configurationRevision != 0) revert AlreadyRegistered();
        _validateConfiguration(configuration);
        bindings[id] = binding;
        origins[id].sha256Digest = originSha256;
        origins[id].revision = 1;
        // Initial publication increments controller revision from zero to one.
        emit CommunityRegistered(id, address(0), bytes32(0));
        emit CommunityBound(id, binding);
        _publishConfiguration(id, communities[id], configuration);
        emit RegistrarConsumed(id, registrar.revision, ++registrar.totalRegistered);
    }

    function communityIdFor(bytes32 key) public view override returns (bytes32) {
        if (key == bytes32(0)) revert InvalidBinding();
        return keccak256(abi.encode(COMMUNITY_DOMAIN, block.chainid, key));
    }

    function namespaceIdFor(string memory tld) public pure override returns (bytes32) {
        bytes memory label = bytes(tld);
        uint256 n = label.length;
        if (n == 0 || n > 63 || label[0] == 0x2d || label[n - 1] == 0x2d) revert InvalidBinding();
        if (n >= 4 && label[2] == "-" && label[3] == "-") {
            revert InvalidBinding();
        }
        for (uint256 i; i < n; ++i) {
            bytes1 c = label[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) revert InvalidBinding();
        }
        return keccak256(abi.encode(NAMESPACE_DOMAIN, keccak256(label)));
    }

    function getBinding(bytes32 id) external view override returns (HostingBinding memory) {
        _community(id);
        return bindings[id];
    }

    function getOrigin(bytes32 id) external view override returns (OriginState memory) {
        _community(id);
        return origins[id];
    }

    function configureHostedCommunity(
        bytes32 id,
        uint64 expectedRevision,
        Configuration calldata configuration,
        bytes32 originSha256
    ) external override {
        Community storage community = _controlled(id, expectedRevision);
        if (configuration.controller != community.configuration.controller || originSha256 == bytes32(0)) {
            revert InvalidConfiguration();
        }
        _validateConfiguration(configuration);
        if (origins[id].sha256Digest != originSha256) {
            origins[id].sha256Digest = originSha256;
            originUpdatedAt[id] = uint64(block.timestamp);
            ++origins[id].revision;
        }
        _publishConfiguration(id, community, configuration);
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

    function verifyNamespace(bytes32, uint64, NamespaceVerification calldata) external pure override {
        revert LegacyEntryPoint();
    }

    function verifyWeb2(bytes32 id, uint64 expectedRevision, Web2Verification calldata proof) external override {
        if (msg.sender != web2Verifier) revert Unauthorized();
        _community(id);
        if (expectedRevision != web2Revisions[id]) revert StaleRevision();
        OriginState memory origin = origins[id];
        if (
            proof.originRevision != origin.revision || proof.controllerRevision != origin.controllerRevision
                || proof.evidenceSha256 == bytes32(0)
        ) revert InvalidVerification();
        _validateTime(proof.observedAt, proof.validUntil, web2[id].observedAt, MAX_WEB2_AGE, web2Revisions[id] != 0);
        if (
            proof.observedAt < originUpdatedAt[id] || (web2Revisions[id] != 0 && proof.observedAt <= web2RevokedAt[id])
                || (web2Generation > 1 && proof.observedAt <= web2InvalidatedAt)
        ) {
            revert InvalidVerification();
        }
        web2[id] = proof;
        web2AcceptedGenerations[id] = web2Generation;
        emit Web2Verified(id, ++web2Revisions[id], proof);
        emit Web2ProofGenerationAccepted(id, web2Revisions[id], web2Generation);
    }

    function revokeWeb2(bytes32 id, uint64 expectedRevision, bytes32 reasonSha256) external override {
        if (msg.sender != web2Verifier) revert Unauthorized();
        _community(id);
        if (expectedRevision != web2Revisions[id]) revert StaleRevision();
        web2[id].validUntil = 0;
        web2RevokedAt[id] = uint64(block.timestamp);
        emit Web2Revoked(id, ++web2Revisions[id], reasonSha256);
    }

    function getWeb2Verification(bytes32 id) external view override returns (uint64, Web2Verification memory) {
        _community(id);
        return (web2Revisions[id], web2[id]);
    }

    function attachHns(bytes32 id, string calldata tld, uint64 expectedRevision, HnsAttachment calldata proof)
        external
        override
    {
        if (msg.sender != namespaceVerifier) revert Unauthorized();
        Community storage community = _community(id);
        if (expectedRevision != hnsRevisions[id]) revert StaleRevision();
        RegistrySource memory source = sources[proof.registry];
        if (source.runtimeCodeHash == bytes32(0) || proof.registry.codehash != source.runtimeCodeHash) {
            revert InvalidRegistry();
        }
        if (
            proof.namespaceId != namespaceIdFor(tld) || proof.namespaceAuthorizationHash == bytes32(0)
                || proof.namespaceAuthorizationRevision == 0
                || proof.controllerRevision != origins[id].controllerRevision || proof.hnsBlockHash == bytes32(0)
                || proof.evidenceSha256 == bytes32(0)
        ) revert InvalidVerification();
        _validateTime(proof.observedAt, proof.validUntil, hns[id].observedAt, MAX_HNS_AGE, hnsRevisions[id] != 0);
        if (
            proof.observedAt < controllerUpdatedAt[id]
                || (hnsRevisions[id] != 0 && proof.observedAt <= hnsRevokedAt[id])
                || (hnsGeneration > 1 && proof.observedAt <= hnsInvalidatedAt)
        ) revert InvalidVerification();
        hns[id] = proof;
        hnsAcceptedGenerations[id] = hnsGeneration;
        community.registry = proof.registry;
        community.tldHash = sha256(bytes(tld));
        // These V1 fields are informational compatibility only. V3 verification
        // is the separate attachment, never the V1 configuration-coupled predicate.
        community.verification = NamespaceVerification(
            community.configurationRevision,
            proof.hnsHeight,
            proof.hnsBlockHash,
            proof.observedAt,
            proof.validUntil,
            proof.evidenceSha256
        );
        community.verificationRevision = ++hnsRevisions[id];
        emit HnsAttached(id, hnsRevisions[id], proof);
        emit HnsProofGenerationAccepted(id, hnsRevisions[id], hnsGeneration);
    }

    function revokeHns(bytes32 id, uint64 expectedRevision, bytes32 reasonSha256) external override {
        if (msg.sender != namespaceVerifier) revert Unauthorized();
        Community storage community = _community(id);
        if (expectedRevision != hnsRevisions[id]) revert StaleRevision();
        hns[id].validUntil = 0;
        hnsRevokedAt[id] = uint64(block.timestamp);
        community.verification.validUntil = 0;
        community.verificationRevision = ++hnsRevisions[id];
        emit HnsRevoked(id, hnsRevisions[id], reasonSha256);
    }

    function getHnsAttachment(bytes32 id) external view override returns (uint64, HnsAttachment memory) {
        _community(id);
        return (hnsRevisions[id], hns[id]);
    }

    function _validateTime(uint64 observedAt, uint64 validUntil, uint64 previous, uint64 maxAge, bool existed)
        private
        view
    {
        if (
            observedAt > block.timestamp || validUntil <= block.timestamp || observedAt < previous
                || (existed && observedAt == previous) || validUntil - observedAt > maxAge
        ) {
            revert InvalidVerification();
        }
    }

    function setListed(bytes32 communityId, uint64 expectedRevision, bool listed, bytes32 reasonSha256)
        external
        override
    {
        if (msg.sender != listingAuthority) revert Unauthorized();
        Community storage community = _community(communityId);
        if (expectedRevision != community.listingRevision) revert StaleRevision();
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
        return community.configurationRevision != 0 && community.listed
            && (isWeb2Verified(communityId) || isHnsVerified(communityId));
    }

    function _community(bytes32 id) private view returns (Community storage community) {
        community = communities[id];
        if (community.configurationRevision == 0) revert UnknownCommunity();
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
        if (community.configuration.controller != configuration.controller) {
            ++origins[id].controllerRevision;
            controllerUpdatedAt[id] = uint64(block.timestamp);
            originUpdatedAt[id] = uint64(block.timestamp);
            if (community.configurationRevision != 0) {
                ++origins[id].revision;
                community.listed = false;
                emit ListingChanged(
                    id, ++community.listingRevision, false, keccak256("pirate.directory/controller-transfer")
                );
            }
        }
        community.configuration = configuration;
        uint64 revision = ++community.configurationRevision;
        emit OriginConfigured(id, revision, origins[id]);
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

    function isWeb2Verified(bytes32 id) public view override returns (bool) {
        Web2Verification memory proof = web2[id];
        return communities[id].configurationRevision != 0 && web2Revisions[id] != 0
            && web2AcceptedGenerations[id] == web2Generation && proof.originRevision == origins[id].revision
            && proof.controllerRevision == origins[id].controllerRevision && block.timestamp < proof.validUntil;
    }

    function isHnsVerified(bytes32 id) public view override returns (bool) {
        HnsAttachment memory proof = hns[id];
        return communities[id].configurationRevision != 0 && hnsRevisions[id] != 0
            && hnsAcceptedGenerations[id] == hnsGeneration && proof.controllerRevision == origins[id].controllerRevision
            && block.timestamp < proof.validUntil && sources[proof.registry].runtimeCodeHash != bytes32(0)
            && proof.registry.codehash == sources[proof.registry].runtimeCodeHash;
    }
}
