// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {ICommunityDirectoryV1} from "./ICommunityDirectoryV1.sol";

/// @notice Explicit shared-directory successor. Inherited read/configuration tuples
/// retain PostsV1 wire compatibility; inherited V1 registration/ID selectors refuse.
interface ICommunityDirectoryV2 is ICommunityDirectoryV1 {
    struct RegistrySource { bytes32 runtimeCodeHash; bytes20 sourceCommit; bytes32 abiSha256; }
    struct Binding {
        bytes32 communityKey;
        bytes32 installationId;
        bytes32 originSha256;
        bytes32 namespaceId;
        bytes32 registryCodeHash;
        bytes20 sourceCommit;
        bytes32 abiSha256;
    }
    error InvalidDeploymentProfile();
    error InvalidBinding();
    error LegacyEntryPoint();
    event RegistryAdmitted(address indexed registry, RegistrySource source);
    event CommunityBound(bytes32 indexed communityId, Binding binding);
    event AdminProposed(address indexed previousAdmin, address indexed proposedAdmin);
    event AdminAccepted(address indexed previousAdmin, address indexed newAdmin);
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function proposeAdmin(address next) external;
    function acceptAdmin() external;
    function admitRegistry(address registry, RegistrySource calldata source) external;
    function registrySource(address registry) external view returns (RegistrySource memory);
    function registerSharedCommunity(address registry, string calldata tld, Binding calldata binding, Configuration calldata configuration)
        external returns (bytes32 communityId);
    function communityIdFor(bytes32 key) external view returns (bytes32);
    function namespaceIdFor(string memory tld) external pure returns (bytes32);
    function getBinding(bytes32 communityId) external view returns (Binding memory);
}
