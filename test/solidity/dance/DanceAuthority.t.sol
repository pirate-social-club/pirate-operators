// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {DanceFixture} from "./DanceFixture.sol";
import {DanceVerdictAuthority} from "../../../contracts/dance/DanceVerdictAuthority.sol";
import {DanceCapturePolicyV1} from "../../../contracts/dance/DanceCapturePolicyV1.sol";
import {DanceVerdictWire as Wire} from "../../../contracts/dance/DanceVerdictWire.sol";
import {ICommunityDirectoryV1 as Directory} from "../../../contracts/interfaces/community/ICommunityDirectoryV1.sol";

contract DanceAuthorityTest is DanceFixture {
    function testRevocationWinsAtCommitAndExactOldGrantReplayCannotRestoreIt() public {
        uint64 expiry = uint64(block.timestamp + 10 days);
        (bytes32 command, bytes32 digest) = grant(1, expiry);
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        Wire.CommitVerdict memory pending = decision(p.submission.submissionId, 1);
        pending.decision.expectedReviewerRoleEpoch = 2;
        revoke(2);
        vm.prank(OWNER);
        DanceVerdictAuthority.Receipt memory old =
            dance.grantReviewer(command, digest, Wire.GrantReviewer(1, 1, reviewer, 1, expiry));
        require(old.resourceEpoch == 2);
        (uint64 epoch,,, bool active) = dance.reviewerRoles(reviewer);
        require(epoch == 3 && !active);
        vm.expectRevert(DanceVerdictAuthority.Unauthorized.selector);
        review(pending);
    }

    function testCurrentControllerCanRecoverAfterConfigurationChangeAndOldDelegateCannotAct() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        Wire.CommitVerdict memory pending = decision(p.submission.submissionId, 1);
        Directory.Configuration memory next = config(OWNER, PUBLISHER);
        next.learningRecords = address(learning);
        vm.prank(OWNER);
        directory.configure(communityId, 1, next);
        vm.expectRevert(DanceVerdictAuthority.StaleContext.selector);
        review(pending);
        configure(1, 2, OWNER, NEXT);
        pending.decision.expectedOwnerEpoch = 2;
        pending.decision.expectedConfigurationRevision = 2;
        vm.expectRevert(DanceVerdictAuthority.Unauthorized.selector);
        review(pending);
    }

    function testAliasMergeFencesOldBindingsAndReboundAliasesCannotReviewEachOther() public {
        bytes32 left = Wire.singletonId(domain(), learnerAccount);
        bytes32 right = Wire.singletonId(domain(), reviewerAccount);
        bytes32 successor = keccak256("fixture-merged-group");
        Wire.MergeGroups memory m = Wire.MergeGroups(1, 1, left, 1, right, 1, successor);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.MergeGroups, PUBLISHER, command, abi.encode(m));
        vm.prank(PUBLISHER);
        dance.mergeGroups(command, digest, m);
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        vm.expectRevert(DanceCapturePolicyV1.InvalidIdentity.selector);
        submit(p);
        mutateBinding(Wire.BindIdentity(1, 1, learnerAccount, learner, 1, left, 1, 2, successor, 1, false, true));
        mutateBinding(Wire.BindIdentity(1, 1, reviewerAccount, reviewer, 1, right, 1, 2, successor, 1, false, true));
        (, uint64 members, uint64 pending,, bool active) = dance.groups(successor);
        require(active && members == 2 && pending == 0);
        p.capture.identityEpoch = 2;
        p.capture.groupId = successor;
        p = seal(p);
        submit(p);
        Wire.CommitVerdict memory verdict = decision(p.submission.submissionId, 1);
        verdict.decision.reviewerIdentityEpoch = 2;
        verdict.decision.reviewerGroupId = successor;
        vm.expectRevert(DanceCapturePolicyV1.SelfReview.selector);
        review(verdict);
    }

    function testRulesCannotBeReenabledByOwnerConfiguration() public {
        Wire.InvalidateRules memory p = Wire.InvalidateRules(0, 0, 1);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.InvalidateRules, OWNER, command, abi.encode(p));
        vm.prank(OWNER);
        dance.invalidateRules(command, digest, p);
        configure(1, 1, OWNER, OWNER);
        Wire.RegisterSubmission memory submitted = registration(CAPTURE, RECORDING, 0, 0);
        submitted.expectedOwnerEpoch = 2;
        vm.expectRevert(DanceVerdictAuthority.InvalidRules.selector);
        submit(submitted);
        require(dance.rulesEpoch() == 1);
    }
}
