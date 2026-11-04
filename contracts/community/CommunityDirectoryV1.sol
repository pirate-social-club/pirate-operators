// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ICommunityDirectoryV1} from "../interfaces/community/ICommunityDirectoryV1.sol";
import {PublicationReference} from "./PublicationReference.sol";

interface IRegistryIdentityV1 {
    function factory() external view returns (address);
    function admin() external view returns (address);
    function tld() external view returns (string memory);
}

interface IRegistryFactoryV1 {
    function implementation() external view returns (address);
    function isRegistry(address registry) external view returns (bool);
}

/// @notice Community configuration authority is independent of Pirate discovery.
/// @dev Immutable deployment profile; no admin, upgrade or recovery override.
contract CommunityDirectoryV1 is ICommunityDirectoryV1 {
    struct FactoryProfile {
        address implementation;
        bytes32 factoryCodeHash;
        bytes32 implementationCodeHash;
        bytes32 cloneCodeHash;
    }

    address public immutable override namespaceVerifier;
    address public immutable override listingAuthority;
    uint64 public immutable maxVerificationAge;
    mapping(address => FactoryProfile) public factoryProfiles;
    mapping(bytes32 => Community) private communities;
    mapping(bytes32 => ControllerTransfer) private transfers;
    mapping(bytes32 => uint64) private proposalCounters;

    error InvalidDeploymentProfile();
    event FactoryApproved(address indexed factory, FactoryProfile profile);

    constructor(address[] memory factories, address verifier, address listing, uint64 maximumAge) {
        if (
            factories.length == 0 || verifier == listing || verifier.code.length == 0 || listing.code.length == 0
                || maximumAge == 0
        ) revert InvalidDeploymentProfile();
        namespaceVerifier = verifier;
        listingAuthority = listing;
        maxVerificationAge = maximumAge;
        for (uint256 i; i < factories.length; ++i) {
            address factory = factories[i];
            if (factory.code.length == 0 || factoryProfiles[factory].implementation != address(0)) {
                revert InvalidDeploymentProfile();
            }
            address implementation = IRegistryFactoryV1(factory).implementation();
            if (implementation.code.length == 0) revert InvalidDeploymentProfile();
            FactoryProfile memory profile = FactoryProfile(
                implementation,
                factory.codehash,
                implementation.codehash,
                keccak256(
                    abi.encodePacked(hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3")
                )
            );
            factoryProfiles[factory] = profile;
            emit FactoryApproved(factory, profile);
        }
    }

    function registerCommunity(address registry, Configuration calldata configuration)
        external
        override
        returns (bytes32 communityId)
    {
        communityId = communityIdFor(registry);
        if (communities[communityId].registry != address(0)) revert AlreadyRegistered();
        if (registry.code.length == 0) revert InvalidRegistry();
        address factory = IRegistryIdentityV1(registry).factory();
        FactoryProfile memory profile = factoryProfiles[factory];
        if (
            profile.implementation == address(0) || factory.codehash != profile.factoryCodeHash
                || profile.implementation.codehash != profile.implementationCodeHash
                || registry.codehash != profile.cloneCodeHash
                || IRegistryFactoryV1(factory).implementation() != profile.implementation
                || !IRegistryFactoryV1(factory).isRegistry(registry)
        ) revert InvalidRegistry();
        if (msg.sender != IRegistryIdentityV1(registry).admin() || configuration.controller != msg.sender) {
            revert Unauthorized();
        }
        _validateConfiguration(configuration);
        bytes memory label = bytes(IRegistryIdentityV1(registry).tld());
        // Label validity is enforced by the pinned registry implementation.
        if (label.length == 0) revert InvalidRegistry();
        Community storage community = communities[communityId];
        community.registry = registry;
        community.tldHash = sha256(label);
        emit CommunityRegistered(communityId, registry, community.tldHash);
        _publishConfiguration(communityId, community, configuration);
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
        if (msg.sender != namespaceVerifier) revert Unauthorized();
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
        if (msg.sender != listingAuthority) revert Unauthorized();
        Community storage community = _community(communityId);
        if (expectedRevision != community.listingRevision) revert StaleRevision();
        if (listed && !_verified(community)) revert InvalidVerification();
        community.listed = listed;
        emit ListingChanged(communityId, ++community.listingRevision, listed, reasonSha256);
    }

    function communityIdFor(address registry) public view override returns (bytes32) {
        return keccak256(abi.encode(block.chainid, registry));
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
        return community.verificationRevision != 0
            && community.verification.configurationRevision == community.configurationRevision
            && community.verification.validUntil > block.timestamp;
    }
}
