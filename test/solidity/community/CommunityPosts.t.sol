// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import "./CommunityFixture.sol";

contract CommunityPostsTest is CommunityFixture {
    function setUp() public override {
        super.setUp();
        register();
    }

    function testUnverifiedAndDelistedCommunitiesCanPublish() public {
        vm.prank(PUBLISHER);
        publish(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        require(posts.getPost(communityId, POST).revision == 1 && !directory.isDiscoverable(communityId));
        verify(1, 0);
        list(true, 0);
        list(false, 1);
        vm.prank(PUBLISHER);
        publish(communityId, POST, 1, 1, AUTHOR, Posts.Kind.Song);
        require(posts.getPost(communityId, POST).revision == 2 && !directory.isDiscoverable(communityId));
        vm.prank(address(listing));
        vm.expectRevert(Posts.UnauthorizedPublisher.selector);
        publish(communityId, POST, 2, 1, AUTHOR, Posts.Kind.Song);
    }

    function testPublisherRotationAndStaleConfiguration() public {
        vm.prank(PUBLISHER);
        publish(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(OWNER, OTHER_PUBLISHER));
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.UnauthorizedPublisher.selector);
        publish(communityId, POST, 1, 2, AUTHOR, Posts.Kind.Song);
        vm.prank(OTHER_PUBLISHER);
        vm.expectRevert(Posts.StaleConfiguration.selector);
        publish(communityId, POST, 1, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(OTHER_PUBLISHER);
        publish(communityId, POST, 1, 2, AUTHOR, Posts.Kind.Song);
        require(posts.getPost(communityId, POST).configurationRevision == 2);
    }

    function testTransferImmediatelyRevokesFormerPublisher() public {
        Directory.Configuration memory c = config(NEXT, OTHER_PUBLISHER);
        vm.prank(OWNER);
        uint64 id = directory.proposeControllerTransfer(communityId, 1, c, uint64(block.timestamp + 30));
        vm.prank(NEXT);
        directory.acceptControllerTransfer(communityId, id, c);
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.UnauthorizedPublisher.selector);
        publish(communityId, POST, 0, 2, AUTHOR, Posts.Kind.Song);
        vm.prank(OTHER_PUBLISHER);
        publish(communityId, POST, 0, 2, AUTHOR, Posts.Kind.Song);
    }

    function testFuzzArbitraryPublisherCannotWrite(address caller) public {
        vm.assume(caller != PUBLISHER);
        vm.prank(caller);
        vm.expectRevert(Posts.UnauthorizedPublisher.selector);
        publish(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.expectRevert(Posts.UnknownPost.selector);
        posts.getPost(communityId, POST);
    }

    function testRetriesCannotDuplicateOrChangeAuthorOrKind() public {
        vm.prank(PUBLISHER);
        publish(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        bytes32 previous = keccak256(abi.encode(posts.getPost(communityId, POST)));
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.StalePostRevision.selector);
        publish(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.ImmutableIdentity.selector);
        publish(communityId, POST, 1, 1, DIGEST, Posts.Kind.Song);
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.ImmutableIdentity.selector);
        publish(communityId, POST, 1, 1, AUTHOR, Posts.Kind.Video);
        require(keccak256(abi.encode(posts.getPost(communityId, POST))) == previous);
    }

    function testFuzzRevisionsCannotSkip(uint64 wrong) public {
        vm.assume(wrong != 1);
        vm.prank(PUBLISHER);
        publish(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.StalePostRevision.selector);
        publish(communityId, POST, wrong, 1, AUTHOR, Posts.Kind.Song);
        require(posts.getPost(communityId, POST).revision == 1);
    }

    function testFuzzIdenticalPostIdsStayIsolated(bytes32 postId) public {
        vm.assume(postId != bytes32(0));
        address otherRegistry = factory.deploy("sample", NEXT);
        vm.prank(NEXT);
        bytes32 other = directory.registerCommunity(otherRegistry, config(NEXT, OTHER_PUBLISHER));
        vm.prank(PUBLISHER);
        publish(communityId, postId, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.UnauthorizedPublisher.selector);
        publish(other, postId, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(OTHER_PUBLISHER);
        publish(other, postId, 0, 1, DIGEST, Posts.Kind.Video);
        require(other != communityId && posts.getPost(communityId, postId).authorId == AUTHOR);
        require(posts.getPost(other, postId).authorId == DIGEST);
    }

    function testUnknownCommunityAndInvalidPublicationRefused() public {
        vm.prank(PUBLISHER);
        vm.expectRevert(Directory.UnknownCommunity.selector);
        publish(DIGEST, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.InvalidPublication.selector);
        publish(communityId, 0, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.InvalidPublication.selector);
        publish(communityId, POST, 0, 1, 0, Posts.Kind.Song);
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.InvalidPublication.selector);
        posts.publishRevision(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song, 0, URI);
        vm.prank(PUBLISHER);
        vm.expectRevert(Posts.InvalidPublication.selector);
        posts.publishRevision(
            communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song, DIGEST, string.concat(URI, "?mutable=1")
        );
        vm.expectRevert(Posts.UnknownPost.selector);
        posts.getPost(communityId, POST);
    }

    function testOutOfRangeKindIsRejectedByABI() public {
        vm.prank(PUBLISHER);
        (bool ok,) = address(posts)
            .call(
                abi.encodeWithSelector(
                    Posts.publishRevision.selector,
                    communityId,
                    POST,
                    uint64(0),
                    uint64(1),
                    AUTHOR,
                    uint8(2),
                    DIGEST,
                    URI
                )
            );
        require(!ok);
    }

    function testReplayEventsReconstructsLatestPostAfterConfigRotation() public {
        vm.recordLogs();
        vm.prank(PUBLISHER);
        publish(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(OWNER, OTHER_PUBLISHER));
        vm.prank(OTHER_PUBLISHER);
        posts.publishRevision(
            communityId, POST, 1, 2, AUTHOR, Posts.Kind.Song, keccak256("revised"), string.concat(URI, "/revision.json")
        );
        CommunityVm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("PostRevisionPublished(bytes32,bytes32,bytes32,uint8,uint64,uint64,bytes32,string)");
        Posts.PostRevision memory reconstructed;
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(posts) || logs[i].topics[0] != topic) continue;
            require(logs[i].topics.length == 4 && logs[i].topics[1] == communityId && logs[i].topics[2] == POST);
            (uint8 kind, uint64 revision, uint64 configRevision, bytes32 digest, string memory uri) =
                abi.decode(logs[i].data, (uint8, uint64, uint64, bytes32, string));
            require(revision == ++seen);
            reconstructed =
                Posts.PostRevision(logs[i].topics[3], Posts.Kind(kind), revision, configRevision, digest, uri);
        }
        require(
            seen == 2 && keccak256(abi.encode(reconstructed)) == keccak256(abi.encode(posts.getPost(communityId, POST)))
        );
    }

    function testContractControllerUsesAccountTransactionAndEOAKeepsControlUntilAcceptance() public {
        GovernanceAccountFixture receivingAccount = new GovernanceAccountFixture(NEXT, OWNER);
        Directory.Configuration memory c = config(address(receivingAccount), OTHER_PUBLISHER);
        vm.prank(OWNER);
        uint64 id = directory.proposeControllerTransfer(communityId, 1, c, uint64(block.timestamp + 60));
        vm.expectRevert();
        receivingAccount.execute(
            address(directory), abi.encodeCall(Directory.acceptControllerTransfer, (communityId, id, c))
        );
        require(directory.getCommunity(communityId).configuration.controller == OWNER);
        vm.prank(NEXT);
        receivingAccount.execute(
            address(directory), abi.encodeCall(Directory.acceptControllerTransfer, (communityId, id, c))
        );
        require(directory.getCommunity(communityId).configuration.controller == address(receivingAccount));
        require(posts.directory() == address(directory));
    }
}
