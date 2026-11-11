// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {DanceFixture} from "./DanceFixture.sol";
import {DanceVerdictAuthority} from "../../../contracts/dance/DanceVerdictAuthority.sol";
import {DanceCapturePolicyV1} from "../../../contracts/dance/DanceCapturePolicyV1.sol";
import {DanceVerdictsV1} from "../../../contracts/dance/DanceVerdictsV1.sol";
import {DanceVerdictWire as Wire} from "../../../contracts/dance/DanceVerdictWire.sol";
import {ICommunityPostsV1 as Posts} from "../../../contracts/interfaces/community/ICommunityPostsV1.sol";

contract DanceVerdictsTest is DanceFixture {
    function testOpeningIsInclusiveAndLaterPrivacyInvalidationPreservesVerdictAndReplay() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, nowMs(), nowMs() + 1000);
        bytes32 sub = p.submission.submissionId;
        DanceVerdictAuthority.Receipt memory registered = submit(p);
        require(registered.resourceId == sub && registered.resourceEpoch == 1);
        (bytes memory capAbi, bytes memory subAbi, bytes32 subHash) = dance.registrationOf(sub);
        require(keccak256(capAbi) == keccak256(abi.encode(p.capture)));
        require(keccak256(subAbi) == keccak256(abi.encode(p.submission)));
        require(subHash == Wire.submissionHash(domain(), p.submission));
        Wire.CommitVerdict memory verdict = decision(sub, 1);
        bytes memory encoded = abi.encode(verdict);
        bytes32 command = id();
        // Independent whole-tuple ABI encoding; the contract joins static ABI words.
        bytes32 digest = keccak256(
            abi.encode(
                keccak256("pirate.dance-command/1"),
                block.chainid,
                address(dance),
                communityId,
                uint8(8),
                PUBLISHER,
                command,
                verdict
            )
        );
        vm.prank(PUBLISHER);
        DanceVerdictAuthority.Receipt memory committed = dance.commitVerdict(command, digest, encoded);
        require(committed.committedAtSeconds == block.timestamp);
        (,,,, uint64 at, uint8 category, bool withinWindow) = dance.verdicts(sub);
        require(at == block.timestamp && category == 1 && withinWindow);

        invalidate(CAPTURE, learner, learner, 1);
        (uint64 epoch, bool ready,) = dance.media(sub);
        require(epoch == 2 && !ready);
        vm.prank(learner);
        learning.revoke(learner, 0, "");
        vm.warp(block.timestamp + 15 days);
        vm.recordLogs();
        vm.prank(PUBLISHER);
        DanceVerdictAuthority.Receipt memory repeated = dance.commitVerdict(command, digest, encoded);
        require(keccak256(abi.encode(committed)) == keccak256(abi.encode(repeated)));
        require(vm.getRecordedLogs().length == 0);
        (,,,, uint64 retainedAt, uint8 retainedCategory, bool retainedWindow) = dance.verdicts(sub);
        require(retainedAt == at && retainedCategory == category && retainedWindow);
    }

    function testCutoffIsExclusiveEvenWhenIntentWasAcceptedBeforeIt() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, nowMs(), nowMs() + 1000);
        submit(p);
        Wire.CommitVerdict memory verdict = decision(p.submission.submissionId, 1);
        vm.warp(block.timestamp + 1);
        review(verdict);
        (,,,, uint64 at, uint8 category, bool withinWindow) = dance.verdicts(p.submission.submissionId);
        require(at * 1000 == p.capture.offer.cutoffAtMs && category == 1 && !withinWindow);
    }

    function testPassBeforeOpeningAndNotPassedWithoutOfferAreHistoricalOnly() public {
        Wire.RegisterSubmission memory early = registration(CAPTURE, RECORDING, nowMs() + 1000, nowMs() + 2000);
        submit(early);
        review(decision(early.submission.submissionId, 1));
        (,,,,, uint8 category, bool inWindow) = dance.verdicts(early.submission.submissionId);
        require(category == 1 && !inWindow);
        Wire.RegisterSubmission memory noOffer =
            registration(keccak256("different-capture"), sha256("different-recording"), 0, 0);
        submit(noOffer);
        review(decision(noOffer.submission.submissionId, 2));
        (,,,,, category, inWindow) = dance.verdicts(noOffer.submission.submissionId);
        require(category == 2 && !inWindow);
    }

    function testSevenDayDeadlineIsExclusive() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        Wire.CommitVerdict memory verdict = decision(p.submission.submissionId, 1);
        vm.warp(p.submission.reviewDeadlineMs / 1000);
        vm.expectRevert(DanceVerdictAuthority.InvalidWindow.selector);
        review(verdict);
    }

    function testOnlyLearnerOrPublisherCanCancelAndPreRegistrationTombstoneIsTerminal() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        vm.expectRevert(DanceVerdictAuthority.Unauthorized.selector);
        invalidate(CAPTURE, learner, reviewer, 0);
        require(invalidate(CAPTURE, learner, learner, 0).resourceEpoch == 1);
        vm.expectRevert(DanceVerdictsV1.MediaUnavailable.selector);
        submit(p);
    }

    function testV4WithdrawalAndReauthorizationNeverRebindOldCapture() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        Wire.CommitVerdict memory verdict = decision(p.submission.submissionId, 1);
        vm.prank(learner);
        learning.revoke(learner, 0, "");
        vm.warp(block.timestamp + 1);
        bytes32 reauthorized = authorize(LEARNER_KEY, keccak256("new-sign-in"), uint64(block.timestamp));
        require(reauthorized != learnerAuth);
        vm.expectRevert(DanceCapturePolicyV1.AuthorizationChanged.selector);
        review(verdict);
    }

    function testCurrentSongRevisionMustStillMatchAtVerdict() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        Wire.CommitVerdict memory verdict = decision(p.submission.submissionId, 1);
        vm.prank(PUBLISHER);
        publish(communityId, POST, 1, 1, AUTHOR, Posts.Kind.Song);
        vm.expectRevert(DanceCapturePolicyV1.InvalidCapture.selector);
        review(verdict);
    }

    function testDigestCannotBeReusedForAnotherCapture() public {
        submit(registration(CAPTURE, RECORDING, 0, 0));
        Wire.RegisterSubmission memory retry = registration(keccak256("another-capture"), RECORDING, 0, 0);
        vm.expectRevert(DanceVerdictsV1.RecordingAlreadyUsed.selector);
        submit(retry);
    }

    function testPayloadLengthAndChangedFieldsFailBeforeReplay() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        bytes memory encoded = abi.encode(p);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.RegisterSubmission, PUBLISHER, command, encoded);
        vm.prank(PUBLISHER);
        dance.registerSubmission(command, digest, encoded);
        bytes memory padded = bytes.concat(encoded, bytes32(0));
        vm.expectRevert(DanceVerdictAuthority.InvalidCommand.selector);
        vm.prank(PUBLISHER);
        dance.registerSubmission(command, digest, padded);
        p.submission.mediaGeneration++;
        bytes memory changed = abi.encode(seal(p));
        vm.expectRevert(DanceVerdictAuthority.InvalidCommand.selector);
        vm.prank(PUBLISHER);
        dance.registerSubmission(command, digest, changed);
        bytes32 changedHash = hash(Wire.Operation.RegisterSubmission, PUBLISHER, command, changed);
        vm.expectRevert(DanceVerdictAuthority.CommandConflict.selector);
        vm.prank(PUBLISHER);
        dance.registerSubmission(command, changedHash, changed);
    }

    function testVerifierCodeDriftHoldsNewVerdict() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        Wire.CommitVerdict memory verdict = decision(p.submission.submissionId, 1);
        vm.etch(address(policy), hex"60006000f3");
        vm.expectRevert(DanceVerdictAuthority.InvalidSource.selector);
        review(verdict);
    }
}
