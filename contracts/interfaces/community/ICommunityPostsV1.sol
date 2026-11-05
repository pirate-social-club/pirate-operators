// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

/// @notice V1 post ABI. Stores publication references, never media or grades.
/// @dev Normative authorization and manifest: docs/contracts/community-posts.md.
interface ICommunityPostsV1 {
    enum Kind {
        Song,
        Video
    }

    struct PostRevision {
        bytes32 authorId;
        Kind kind;
        uint64 revision;
        uint64 configurationRevision;
        bytes32 manifestSha256;
        string manifestURI;
    }

    event PostRevisionPublished(
        bytes32 indexed communityId,
        bytes32 indexed postId,
        bytes32 indexed authorId,
        Kind kind,
        uint64 revision,
        uint64 configurationRevision,
        bytes32 manifestSha256,
        string manifestURI
    );

    error UnauthorizedPublisher();
    error StaleConfiguration();
    error StalePostRevision();
    error InvalidPublication();
    error ImmutableIdentity();
    error UnknownPost();

    /// @dev Only the current directory-configured publisher. expectedRevision=0 creates.
    /// New revision is expectedRevision+1. Author and kind never change on an existing ID.
    /// An implementation MUST check current directory revision and publisher on every call.
    function publishRevision(
        bytes32 communityId,
        bytes32 postId,
        uint64 expectedRevision,
        uint64 configurationRevision,
        bytes32 authorId,
        Kind kind,
        bytes32 manifestSha256,
        string calldata manifestURI
    ) external;

    function getPost(bytes32 communityId, bytes32 postId) external view returns (PostRevision memory);
    function directory() external view returns (address);
}
