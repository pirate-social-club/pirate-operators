// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ICommunityDirectoryV1} from "../interfaces/community/ICommunityDirectoryV1.sol";
import {ICommunityPostsV1} from "../interfaces/community/ICommunityPostsV1.sol";
import {PublicationReference} from "./PublicationReference.sol";

/// @notice Revisioned references submitted by each community's current publisher.
/// @dev The publisher is trusted for user consent, attribution and admission.
contract CommunityPostsV1 is ICommunityPostsV1 {
    address public immutable override directory;
    mapping(bytes32 => mapping(bytes32 => PostRevision)) private posts;

    constructor(address directoryAddress) {
        if (directoryAddress.code.length == 0) revert InvalidPublication();
        directory = directoryAddress;
    }

    function publishRevision(
        bytes32 communityId,
        bytes32 postId,
        uint64 expectedRevision,
        uint64 configurationRevision,
        bytes32 authorId,
        Kind kind,
        bytes32 manifestSha256,
        string calldata manifestURI
    ) external override {
        ICommunityDirectoryV1.Community memory community = ICommunityDirectoryV1(directory).getCommunity(communityId);
        if (msg.sender != community.configuration.publisher) revert UnauthorizedPublisher();
        if (configurationRevision != community.configurationRevision) revert StaleConfiguration();
        if (
            postId == bytes32(0) || authorId == bytes32(0) || manifestSha256 == bytes32(0)
                || !PublicationReference.valid(manifestURI)
        ) revert InvalidPublication();
        PostRevision storage post = posts[communityId][postId];
        if (expectedRevision != post.revision) revert StalePostRevision();
        if (post.revision != 0 && (post.authorId != authorId || post.kind != kind)) revert ImmutableIdentity();
        post.authorId = authorId;
        post.kind = kind;
        post.revision = expectedRevision + 1;
        post.configurationRevision = configurationRevision;
        post.manifestSha256 = manifestSha256;
        post.manifestURI = manifestURI;
        emit PostRevisionPublished(
            communityId, postId, authorId, kind, post.revision, configurationRevision, manifestSha256, manifestURI
        );
    }

    function getPost(bytes32 communityId, bytes32 postId) external view override returns (PostRevision memory) {
        PostRevision storage post = posts[communityId][postId];
        if (post.revision == 0) revert UnknownPost();
        return post;
    }
}
