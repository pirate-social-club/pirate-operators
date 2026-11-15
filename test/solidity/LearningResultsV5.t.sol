// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {PublicationFixture, ConsentVm} from "./PublicationConsentV1.t.sol";
import {LearningResultsV5 as L} from "../../contracts/LearningResultsV5.sol";
import {
    ICommunityPublicationConsentV1 as C
} from "../../contracts/interfaces/community/ICommunityPublicationConsentV1.sol";

contract LearningResultsV5Test is PublicationFixture {
    function setUp() public override {
        super.setUp();
        descriptor("karaoke-results", address(learning), POLICY);
        descriptor(
            "study-results",
            address(learning),
            bytes32(0x1215c64424664674e8d270589f47e1df306361d0cf0aec3c43787f62f3673b70)
        );
        vm.prank(OWNER);
        learning.setGrader(PUBLISHER, 1, true, 1);
        vm.prank(OWNER);
        learning.setGrader(PUBLISHER, 2, true, 1);
    }

    function result(bytes32 grantId) internal view returns (L.Result memory r) {
        r = L.Result(
            keccak256("session"),
            learner,
            grantId,
            L.Song(block.chainid, address(posts), communityId, keccak256("song")),
            bytes32(0xed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73),
            keccak256(hex"0001"),
            1,
            1,
            PUBLISHER,
            bytes32(0x6c95538d8e8c70504d144272598e7682d7c215f8b0f7359261ba3d828c36ce49),
            bytes32(0),
            uint64(block.timestamp),
            uint64(block.timestamp),
            1,
            1,
            bytes32(0)
        );
    }

    function initial() internal returns (L.Result memory r, bytes memory outcomes) {
        bytes32 id = authorize(LEARNER_KEY, "karaoke-results", address(learning), POLICY, keccak256("first"));
        r = result(id);
        outcomes = hex"0001012710";
        vm.prank(PUBLISHER);
        learning.publish(r, outcomes, 1);
    }

    function permitFor(L.Result memory previous, bytes memory outcomes, uint8 status, bytes32 reason)
        internal
        view
        returns (C.PublicationCorrection memory p, L.Result memory next)
    {
        next = abi.decode(abi.encode(previous), (L.Result));
        next.revision++;
        next.supersedes = learning.commitments(previous.sessionId);
        next.status = status;
        p = C.PublicationCorrection(
            learner,
            communityId,
            "karaoke-results",
            address(learning),
            address(learning).codehash,
            1,
            POLICY,
            learning.withdrawalEpoch(learner, keccak256("karaoke-results")),
            previous.sessionId,
            previous.grantId,
            next.supersedes,
            learning.commitmentOf(next, outcomes),
            reason,
            keccak256("exact-correction"),
            uint64(block.timestamp),
            uint64(block.timestamp + 60)
        );
    }

    function testPublicationRequiresOriginalActivePurposeAndUnchangedCoverage() public {
        L.Result memory vector = L.Result(
            0x7777777777777777777777777777777777777777777777777777777777777777,
            0x1111111111111111111111111111111111111111,
            0x8888888888888888888888888888888888888888888888888888888888888888,
            L.Song(
                31337,
                0x2222222222222222222222222222222222222222,
                0x3333333333333333333333333333333333333333333333333333333333333333,
                0x9999999999999999999999999999999999999999999999999999999999999999
            ),
            0x1111111111111111111111111111111111111111111111111111111111111111,
            keccak256(hex"0001"),
            1,
            1,
            0x1111111111111111111111111111111111111111,
            0x2222222222222222222222222222222222222222222222222222222222222222,
            bytes32(0),
            1800000000,
            1800000000,
            1,
            1,
            bytes32(0)
        );
        require(
            learning.commitmentOf(vector, hex"0001012710")
                == 0x066c04db3a8f8825ad46458c8694dbe5b1cc64e1da5010596595d183afed7786
        );
        bytes32 wrong = authorize(
            LEARNER_KEY,
            "study-results",
            address(learning),
            bytes32(0x1215c64424664674e8d270589f47e1df306361d0cf0aec3c43787f62f3673b70),
            bytes32(uint256(1))
        );
        L.Result memory r = result(wrong);
        vm.prank(PUBLISHER);
        vm.expectRevert(bytes("publication_consent_inactive"));
        learning.publish(r, hex"0001012710", 1);
        r.grantId = authorize(LEARNER_KEY, "karaoke-results", address(learning), POLICY, bytes32(uint256(2)));
        vm.prank(PUBLISHER);
        vm.expectRevert(bytes("invalid_order"));
        learning.publish(r, hex"0002012710", 1);
        vm.prank(PUBLISHER);
        learning.publish(r, hex"0001012710", 1);
        require(learning.commitments(r.sessionId) == learning.commitmentOf(r, hex"0001012710"));
    }

    function testWithdrawnOriginalAndFreshGeneralGrantCannotAuthorizeOldAttempt() public {
        bytes32 old = authorize(LEARNER_KEY, "karaoke-results", address(learning), POLICY, bytes32(uint256(1)));
        L.Result memory r = result(old);
        withdraw(learner, "karaoke-results");
        vm.warp(block.timestamp + 1);
        bytes32 fresh = authorize(LEARNER_KEY, "karaoke-results", address(learning), POLICY, bytes32(uint256(2)));
        vm.prank(PUBLISHER);
        vm.expectRevert(bytes("publication_consent_inactive"));
        learning.publish(r, hex"0001012710", 1);
        r.grantId = fresh;
        vm.prank(PUBLISHER);
        vm.expectRevert(bytes("publication_consent_inactive"));
        learning.publish(r, hex"0001012710", 1);
    }

    function testCorrectionAfterWithdrawalNeedsFreshExactPermitAndPreservesOriginal() public {
        (L.Result memory r, bytes memory old) = initial();
        (C.PublicationCorrection memory stale,) = permitFor(r, hex"0001011388", 1, 0);
        bytes memory staleSig = signature(LEARNER_KEY, learning.correctionDigest(stale));
        withdraw(learner, "karaoke-results");
        vm.prank(PUBLISHER);
        vm.expectRevert(C.InvalidCorrection.selector);
        learning.correct(r, old, hex"0001011388", 1, stale, staleSig, 1);
        (C.PublicationCorrection memory p, L.Result memory next) = permitFor(r, hex"0001011388", 1, 0);
        bytes memory sig = signature(LEARNER_KEY, learning.correctionDigest(p));
        vm.prank(PUBLISHER);
        learning.correct(r, old, hex"0001011388", 1, p, sig, 1);
        require(next.grantId == r.grantId && learning.commitments(r.sessionId) == p.correctedCommitment);
        vm.prank(PUBLISHER);
        vm.expectRevert(bytes("stale_result"));
        learning.correct(r, old, hex"0001011388", 1, p, sig, 1);
    }

    function testPublisherRotationRetainsOriginatingGraderAndRecordsExecutor() public {
        (L.Result memory r, bytes memory old) = initial();
        address b = address(0x222);
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(b, address(learning)));
        (C.PublicationCorrection memory p, L.Result memory next) = permitFor(r, hex"0001011388", 1, 0);
        bytes memory sig = signature(LEARNER_KEY, learning.correctionDigest(p));
        vm.prank(b);
        vm.expectRevert(bytes("not_publisher_grader"));
        learning.correct(r, old, hex"0001011388", 1, p, sig, 2);
        vm.prank(OWNER);
        learning.setGrader(b, 1, true, 2);
        vm.prank(PUBLISHER);
        vm.expectRevert(bytes("not_publisher_grader"));
        learning.correct(r, old, hex"0001011388", 1, p, sig, 2);
        vm.prank(b);
        vm.expectRevert(C.StaleRevision.selector);
        learning.correct(r, old, hex"0001011388", 1, p, sig, 1);
        vm.recordLogs();
        vm.prank(b);
        learning.correct(r, old, hex"0001011388", 1, p, sig, 2);
        ConsentVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2);
        (L.Result memory emitted, bytes memory outcomes, bytes32 commitment, address publisher, uint64 revision) =
            abi.decode(logs[0].data, (L.Result, bytes, bytes32, address, uint64));
        require(emitted.grader == PUBLISHER && publisher == b && revision == 2 && emitted.grantId == r.grantId);
        require(commitment == p.correctedCommitment && commitment == learning.commitmentOf(emitted, outcomes));
        require(keccak256(abi.encode(emitted)) == keccak256(abi.encode(next)));
        L.Result memory altered = next;
        altered.grader = b;
        vm.prank(b);
        vm.expectRevert(bytes("stale_result"));
        learning.correct(altered, outcomes, old, 1, p, sig, 2);
    }

    function testInvalidationReasonCannotBeChangedAndControllerHasNoBypass() public {
        (L.Result memory r, bytes memory old) = initial();
        bytes32 reason = bytes32(0x8fcfccf675b1f0bfd39dcbb13015052fe82bc51c003c165a410945c913dbb2be);
        (C.PublicationCorrection memory p,) = permitFor(r, old, 5, reason);
        bytes memory sig = signature(LEARNER_KEY, learning.correctionDigest(p));
        vm.prank(OWNER);
        vm.expectRevert(bytes("not_publisher_grader"));
        learning.invalidate(r, old, reason, p, sig, 1);
        vm.prank(PUBLISHER);
        vm.expectRevert(C.InvalidCorrection.selector);
        learning.invalidate(
            r, old, bytes32(0xd9298a10d1b0735837dc4bd85dac641b0f3cef27a47e5d53a54f2f3f5b2fcffa), p, sig, 1
        );
        vm.prank(PUBLISHER);
        learning.invalidate(r, old, reason, p, sig, 1);
        require(learning.commitments(r.sessionId) == p.correctedCommitment);
    }

    function testExpiredCorrectionAndDifferentNextCommitmentAreRefused() public {
        (L.Result memory r, bytes memory old) = initial();
        (C.PublicationCorrection memory p,) = permitFor(r, hex"0001011388", 1, 0);
        bytes memory sig = signature(LEARNER_KEY, learning.correctionDigest(p));
        vm.prank(PUBLISHER);
        vm.expectRevert(C.InvalidCorrection.selector);
        learning.correct(r, old, hex"0001011389", 1, p, sig, 1);
        vm.warp(p.submitBefore);
        vm.prank(PUBLISHER);
        vm.expectRevert(C.InvalidWindow.selector);
        learning.correct(r, old, hex"0001011388", 1, p, sig, 1);
    }

    function testStudyCoverageAndQualificationPolicyRemainDistinctFromConsentPolicy() public {
        bytes32 id = authorize(
            LEARNER_KEY,
            "study-results",
            address(learning),
            bytes32(0x1215c64424664674e8d270589f47e1df306361d0cf0aec3c43787f62f3673b70),
            bytes32(uint256(1))
        );
        L.Result memory r = result(id);
        r.activity = 2;
        r.linesTotal = 4;
        r.exercisesHash = keccak256(hex"0001000200030004");
        bytes memory outcomes = hex"000101000202000301000402";
        vm.prank(PUBLISHER);
        learning.publish(r, outcomes, 1);
        require(learning.commitments(r.sessionId) == learning.commitmentOf(r, outcomes));
    }
}
