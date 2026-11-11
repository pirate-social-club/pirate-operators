// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ICommunityPostsV1 as Posts} from "../interfaces/community/ICommunityPostsV1.sol";
import {DanceLearningV4} from "./DanceVerdictAuthority.sol";
import {DanceVerdictWire as Wire} from "./DanceVerdictWire.sol";

interface DanceCaptureContext {
    function communityId() external view returns (bytes32);
    function posts() external view returns (Posts);
    function sourceHash() external view returns (bytes32);
    function publicityPolicyHash() external view returns (bytes32);
    function rulesSha256() external view returns (bytes32);
    function termsSha256() external view returns (bytes32);
    function rubricSha256() external view returns (bytes32);
    function mediaPolicySha256() external view returns (bytes32);
    function references(bytes32 id) external view returns (uint64, uint64, bytes32, bool);
    function identities(bytes32 account) external view returns (address, uint64, bytes32, uint64, bool);
    function groups(bytes32 group) external view returns (uint64, uint64, uint64, bytes32, bool);
    function v4() external view returns (DanceLearningV4);
}

/// @notice Stateless validator pinned by the verdict contract's immutable
/// address and runtime digest. It cannot commit or order a command.
contract DanceCapturePolicyV1 {
    uint8 public constant VERSION = 1;
    uint64 private constant MAX_SAFE_MS = 9_007_199_254_740_991;
    uint64 private constant REVIEW_WINDOW_MS = 604_800_000;
    uint256 private constant CAPTURE_OFFSET = 4 * 32;
    uint256 private constant CONSENT_OFFSET = CAPTURE_OFFSET + 33 * 32;
    uint256 private constant SUBMISSION_OFFSET = CONSENT_OFFSET + 5 * 32;
    uint256 private constant RECORDING_OFFSET = SUBMISSION_OFFSET + 11 * 32;
    uint256 private constant REGISTRATION_BYTES = RECORDING_OFFSET + 32;

    struct CaptureFacts {
        address learner;
        bytes32 accountCommitment;
        bytes32 groupId;
        uint64 opensAtMs;
        uint64 cutoffAtMs;
    }

    struct RegistrationFacts {
        address learner;
        bytes32 submissionId;
        bytes32 captureHash;
        bytes32 submissionHash;
        bytes32 recordingReplayKey;
        uint64 trustedSubmittedAtMs;
        uint64 reviewDeadlineMs;
    }

    error InvalidCapture();
    error InvalidConsent();
    error InvalidReference();
    error InvalidSubmission();
    error InvalidWindow();
    error InvalidIdentity();
    error AuthorizationChanged();
    error SelfReview();

    function _scope(DanceCaptureContext ctx) private view returns (Wire.Domain memory) {
        return Wire.Domain(block.chainid, address(ctx), ctx.communityId());
    }

    function _nowMs() private view returns (uint64) {
        if (block.timestamp == 0 || block.timestamp > MAX_SAFE_MS / 1000) revert InvalidWindow();
        return uint64(block.timestamp) * 1000;
    }

    function _validMs(uint64 ms) private pure returns (bool) {
        return ms != 0 && ms <= MAX_SAFE_MS;
    }

    function _identity(
        DanceCaptureContext ctx,
        bytes32 account,
        address wallet,
        uint64 epoch,
        bytes32 group,
        uint64 groupEpoch
    ) private view {
        (address boundWallet, uint64 boundEpoch, bytes32 boundGroup, uint64 boundGroupEpoch, bool active) =
            ctx.identities(account);
        (uint64 currentGroupEpoch,,,, bool groupActive) = ctx.groups(group);
        if (
            account == 0 || wallet == address(0) || epoch == 0 || group == 0 || groupEpoch == 0 || !active
                || boundWallet != wallet || boundEpoch != epoch || boundGroup != group || boundGroupEpoch != groupEpoch
                || !groupActive || currentGroupEpoch != groupEpoch
        ) revert InvalidIdentity();
    }

    function _authorization(DanceLearningV4 learning, address wallet, bytes32 id, uint64 boundMs) private view {
        uint64 since = learning.authorizedSince(wallet);
        uint64 issued = learning.authorizationIssuedAt(id);
        if (
            id == 0 || since == 0 || learning.authorizationLearner(id) != wallet || issued < since
                || issued > boundMs / 1000
        ) {
            revert AuthorizationChanged();
        }
    }

    function _reference(DanceCaptureContext ctx, Wire.Reference memory ref) private view {
        if (
            ref.durationSamples < 288_000 || ref.durationSamples > 1_440_000
                || ref.startSample > type(uint64).max - ref.durationSamples
        ) revert InvalidReference();
        if (!ref.present) {
            if (
                ref.id != 0 || ref.revision != 0 || ref.epoch != 0 || ref.segmentLayoutSha256 != 0 || ref.segmentId != 0
            ) {
                revert InvalidReference();
            }
            return;
        }
        (uint64 epoch, uint64 revision, bytes32 layout, bool active) = ctx.references(ref.id);
        if (
            ref.id == 0 || ref.segmentId == 0 || !active || ref.epoch != epoch || ref.revision != revision
                || ref.segmentLayoutSha256 != layout
        ) revert InvalidReference();
    }

    function _offer(DanceCaptureContext ctx, Wire.Offer memory offer) private view {
        if (!offer.present) {
            if (
                offer.offerIdCommitment != 0 || offer.inputHash != 0 || offer.sourceHash != 0 || offer.opensAtMs != 0
                    || offer.cutoffAtMs != 0
            ) revert InvalidCapture();
            return;
        }
        if (
            offer.offerIdCommitment == 0 || offer.inputHash == 0 || offer.sourceHash != ctx.sourceHash()
                || !_validMs(offer.opensAtMs) || !_validMs(offer.cutoffAtMs) || offer.opensAtMs >= offer.cutoffAtMs
        ) {
            revert InvalidCapture();
        }
    }

    function _capture(DanceCaptureContext ctx, Wire.Domain memory scope, Wire.Capture memory cap, uint64 nowMs)
        private
        view
        returns (CaptureFacts memory)
    {
        if (
            cap.captureId == 0 || !_validMs(cap.reservedAtMs) || cap.reservedAtMs > nowMs
                || cap.rulesSha256 != ctx.rulesSha256() || cap.termsSha256 != ctx.termsSha256()
                || cap.rubricSha256 != ctx.rubricSha256() || cap.mediaPolicySha256 != ctx.mediaPolicySha256()
        ) {
            revert InvalidCapture();
        }
        _identity(ctx, cap.accountCommitment, cap.learner, cap.identityEpoch, cap.groupId, cap.groupEpoch);
        _authorization(ctx.v4(), cap.learner, cap.authorizationId, cap.reservedAtMs);
        Wire.Song memory song = cap.song;
        Posts posts = ctx.posts();
        if (
            song.chainId != scope.chainId || song.posts != address(posts) || song.communityId != scope.communityId
                || song.postId == 0 || song.revision == 0 || song.manifestSha256 == 0 || song.audioSha256 == 0
        ) {
            revert InvalidCapture();
        }
        Posts.PostRevision memory published = posts.getPost(scope.communityId, song.postId);
        if (
            published.kind != Posts.Kind.Song || published.revision != song.revision
                || published.manifestSha256 != song.manifestSha256
        ) revert InvalidCapture();
        _reference(ctx, cap.referenceSelection);
        _offer(ctx, cap.offer);
        return CaptureFacts(cap.learner, cap.accountCommitment, cap.groupId, cap.offer.opensAtMs, cap.offer.cutoffAtMs);
    }

    function verifyVerdictContext(bytes calldata captureAbi, bytes calldata decisionAbi)
        external
        view
        returns (CaptureFacts memory facts)
    {
        DanceCaptureContext ctx = DanceCaptureContext(msg.sender);
        if (captureAbi.length != CONSENT_OFFSET - CAPTURE_OFFSET || decisionAbi.length != 15 * 32) {
            revert InvalidCapture();
        }
        Wire.Domain memory scope = _scope(ctx);
        facts = _capture(ctx, scope, abi.decode(captureAbi, (Wire.Capture)), _nowMs());
        Wire.Decision memory d = abi.decode(decisionAbi, (Wire.CommitVerdict)).decision;
        _identity(
            ctx,
            d.reviewerAccountCommitment,
            d.reviewerWallet,
            d.reviewerIdentityEpoch,
            d.reviewerGroupId,
            d.reviewerGroupEpoch
        );
        if (
            d.reviewerAccountCommitment == facts.accountCommitment || d.reviewerWallet == facts.learner
                || d.reviewerGroupId == facts.groupId
        ) revert SelfReview();
        _authorization(ctx.v4(), d.reviewerWallet, d.reviewerAuthorizationId, d.intentAcceptedAtMs);
        if (d.reviewerConsentHash != Wire.reviewerConsentHash(scope, d, ctx.publicityPolicyHash())) {
            revert InvalidConsent();
        }
    }

    function verifyRegistration(bytes calldata encoded) external view returns (RegistrationFacts memory) {
        DanceCaptureContext ctx = DanceCaptureContext(msg.sender);
        if (encoded.length != REGISTRATION_BYTES) revert InvalidSubmission();
        Wire.Domain memory scope = _scope(ctx);
        Wire.RegisterSubmission memory p = abi.decode(encoded, (Wire.RegisterSubmission));
        uint64 nowMs = _nowMs();
        _capture(ctx, scope, p.capture, nowMs);
        bytes32 capHash = Wire.captureHashAbi(scope, encoded[CAPTURE_OFFSET:CONSENT_OFFSET]);
        _submission(
            ctx, scope, p, nowMs, capHash, Wire.consentHashAbi(scope, encoded[CONSENT_OFFSET:SUBMISSION_OFFSET])
        );
        Wire.Submission memory sub = p.submission;
        return RegistrationFacts(
            p.capture.learner,
            sub.submissionId,
            capHash,
            Wire.submissionHashAbi(scope, encoded[SUBMISSION_OFFSET:RECORDING_OFFSET]),
            sub.recordingReplayKey,
            sub.trustedSubmittedAtMs,
            sub.reviewDeadlineMs
        );
    }

    function _submission(
        DanceCaptureContext ctx,
        Wire.Domain memory scope,
        Wire.RegisterSubmission memory p,
        uint64 nowMs,
        bytes32 capHash,
        bytes32 consentHash
    ) private view {
        Wire.Submission memory sub = p.submission;
        if (
            sub.submissionId != Wire.submissionId(scope, p.capture.learner, p.capture.captureId)
                || sub.captureHash != capHash || sub.mediaIdCommitment == 0 || sub.mediaGeneration == 0
                || p.recordingSha256 == 0
        ) revert InvalidSubmission();
        if (
            !p.consent.accepted || p.consent.captureHash != capHash || p.consent.termsSha256 != p.capture.termsSha256
                || p.consent.publicityPolicyHash != ctx.publicityPolicyHash()
                || p.consent.acceptedAtMs < p.capture.reservedAtMs || p.consent.acceptedAtMs > sub.trustedSubmittedAtMs
                || sub.consentHash != consentHash
        ) revert InvalidConsent();
        if (
            !_validMs(sub.trustedSubmittedAtMs) || sub.trustedSubmittedAtMs > nowMs
                || sub.trustedSubmittedAtMs > MAX_SAFE_MS - REVIEW_WINDOW_MS
                || sub.reviewDeadlineMs != sub.trustedSubmittedAtMs + REVIEW_WINDOW_MS || nowMs >= sub.reviewDeadlineMs
                || !_validMs(sub.mediaExpiresAtMs) || sub.mediaExpiresAtMs < sub.reviewDeadlineMs
        ) revert InvalidWindow();
        bytes32 binding =
            Wire.mediaBindingHash(scope, capHash, sub.mediaIdCommitment, sub.mediaGeneration, p.recordingSha256);
        if (
            sub.mediaBindingHash != binding
                || sub.recordingReplayKey != Wire.recordingReplayKey(scope, p.recordingSha256)
                || sub.recordingBindingHash != Wire.recordingBindingHash(scope, p.recordingSha256, binding)
        ) {
            revert InvalidSubmission();
        }
    }
}
