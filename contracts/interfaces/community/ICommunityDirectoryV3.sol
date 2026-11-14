// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ICommunityDirectoryV1} from "./ICommunityDirectoryV1.sol";

/// @notice Web2-first successor. Only the V1 read/configuration/Posts wire is retained.
/// @dev Old registration, ID and verification entrypoints refuse; select V3 explicitly.
interface ICommunityDirectoryV3 is ICommunityDirectoryV1 {
    struct HostingBinding {
        bytes32 communityKey;
        bytes32 installationId;
    }

    struct RegistrarPermission {
        address account;
        uint64 revision;
        uint64 validUntil;
        uint64 totalLimit;
        uint64 totalRegistered;
    }

    struct OriginState {
        bytes32 sha256Digest;
        uint64 revision;
        uint64 controllerRevision;
    }

    struct Web2Verification {
        uint64 originRevision;
        uint64 controllerRevision;
        uint64 observedAt;
        uint64 validUntil;
        bytes32 evidenceSha256;
    }

    struct RegistrySource {
        bytes32 runtimeCodeHash;
        bytes20 sourceCommit;
        bytes32 abiSha256;
    }

    struct HnsAttachment {
        address registry;
        bytes32 namespaceId;
        bytes32 namespaceAuthorizationHash;
        uint64 namespaceAuthorizationRevision;
        uint64 controllerRevision;
        uint64 hnsHeight;
        bytes32 hnsBlockHash;
        uint64 observedAt;
        uint64 validUntil;
        bytes32 evidenceSha256;
    }
    error InvalidDeploymentProfile();
    error InvalidBinding();
    error LegacyEntryPoint();
    error RegistrarUnavailable();
    event AdminProposed(address indexed previousAdmin, address indexed proposedAdmin);
    event AdminAccepted(address indexed previousAdmin, address indexed newAdmin);
    event VerificationRolesChanged(address web2Verifier, address namespaceVerifier, address listingAuthority);
    event RegistrarConfigured(RegistrarPermission permission);
    event RegistrarConsumed(bytes32 indexed communityId, uint64 registrarRevision, uint64 totalRegistered);
    event CommunityBound(bytes32 indexed communityId, HostingBinding binding);
    event OriginConfigured(bytes32 indexed communityId, uint64 configurationRevision, OriginState origin);
    event Web2Verified(bytes32 indexed communityId, uint64 verificationRevision, Web2Verification verification);
    event Web2Revoked(bytes32 indexed communityId, uint64 verificationRevision, bytes32 reasonSha256);
    event RegistryAdmitted(address indexed registry, RegistrySource source);
    event HnsAttached(bytes32 indexed communityId, uint64 attachmentRevision, HnsAttachment attachment);
    event HnsRevoked(bytes32 indexed communityId, uint64 attachmentRevision, bytes32 reasonSha256);
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function proposeAdmin(address next) external;
    function acceptAdmin() external;
    function web2Verifier() external view returns (address);
    function setVerificationRoles(address web2, address hns, address listing) external;
    function configureRegistrar(address account, uint64 validUntil, uint64 totalLimit, uint64 expectedRevision) external;
    function registrarPermission() external view returns (RegistrarPermission memory);
    function registerHostedCommunity(
        HostingBinding calldata binding,
        Configuration calldata configuration,
        bytes32 originSha256,
        uint64 expectedRegistrarRevision
    ) external returns (bytes32);
    function communityIdFor(bytes32 key) external view returns (bytes32);
    function namespaceIdFor(string memory tld) external pure returns (bytes32);
    function getBinding(bytes32 communityId) external view returns (HostingBinding memory);
    function getOrigin(bytes32 communityId) external view returns (OriginState memory);
    function configureHostedCommunity(
        bytes32 communityId,
        uint64 expectedRevision,
        Configuration calldata configuration,
        bytes32 originSha256
    ) external;
    function verifyWeb2(bytes32 communityId, uint64 expectedRevision, Web2Verification calldata verification) external;
    function revokeWeb2(bytes32 communityId, uint64 expectedRevision, bytes32 reasonSha256) external;
    function getWeb2Verification(bytes32 communityId)
        external
        view
        returns (uint64 revision, Web2Verification memory verification);
    function admitRegistry(address registry, RegistrySource calldata source) external;
    function registrySource(address registry) external view returns (RegistrySource memory);
    function attachHns(
        bytes32 communityId,
        string calldata tld,
        uint64 expectedRevision,
        HnsAttachment calldata attachment
    ) external;
    function revokeHns(bytes32 communityId, uint64 expectedRevision, bytes32 reasonSha256) external;
    function getHnsAttachment(bytes32 communityId)
        external
        view
        returns (uint64 revision, HnsAttachment memory attachment);
    function isWeb2Verified(bytes32 communityId) external view returns (bool);
    function isHnsVerified(bytes32 communityId) external view returns (bool);
}
