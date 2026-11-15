// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {DanceCapturePolicyV2} from "./DanceCapturePolicyV2.sol";
import {DanceVerdictAuthorityV2} from "./DanceVerdictAuthorityV2.sol";
import {DanceVerdictWireV2 as Wire} from "./DanceVerdictWireV2.sol";

/// @notice One community's categorical Dance decisions. The current Directory publisher
/// attests authenticated intent and private media facts; this contract orders
/// and checks canonical fences. It does not determine payout eligibility.
contract DanceVerdictsV2 is DanceVerdictAuthorityV2 {
    uint64 public constant REVIEW_WINDOW_MS = 604_800_000;
    // ABI lengths of the V2 static tuples. No offsets or trailing words are admitted.
    uint256 private constant CAPTURE_OFFSET = 4 * 32;
    uint256 private constant CONSENT_OFFSET = CAPTURE_OFFSET + 33 * 32;
    uint256 private constant SUBMISSION_OFFSET = CONSENT_OFFSET + 5 * 32;
    uint256 private constant RECORDING_OFFSET = SUBMISSION_OFFSET + 11 * 32;
    uint256 private constant REGISTRATION_BYTES = RECORDING_OFFSET + 32;
    uint256 private constant DECISION_BYTES = 15 * 32;
    uint8 public constant PASS = 1;
    uint8 public constant NOT_PASSED = 2;

    struct Registration {
        bytes captureAbi;
        bytes submissionAbi;
        bytes32 submissionHash;
        uint64 trustedSubmittedAtMs;
        uint64 reviewDeadlineMs;
    }

    struct MediaState {
        uint64 epoch;
        bool ready;
        uint8 invalidationReason;
    }

    struct Verdict {
        bytes32 commandHash;
        bytes32 submissionHash;
        bytes32 reviewerAccountCommitment;
        address reviewerWallet;
        uint64 committedAtSeconds;
        uint8 category;
        bool withinFrozenOfferWindow;
    }

    error InvalidSubmission();
    error RecordingAlreadyUsed();
    error MediaUnavailable();
    error InvalidVerdict();
    error VerdictAlreadyCommitted();

    mapping(bytes32 => Registration) private registrations;
    mapping(bytes32 => MediaState) public media;
    mapping(bytes32 => Verdict) public verdicts;
    mapping(bytes32 => bool) public recordingUsed;

    event SubmissionRegisteredV2(
        bytes32 indexed submissionId,
        bytes32 indexed commandId,
        address indexed learner,
        bytes32 captureHash,
        bytes32 submissionHash,
        uint64 trustedSubmittedAtMs,
        uint64 reviewDeadlineMs,
        bytes32 publicationGrantId,
        bytes32 privateConsentHash,
        uint64 configurationRevision
    );
    event SubmissionInvalidatedV2(
        bytes32 indexed submissionId, bytes32 indexed commandId, uint64 mediaEpoch, uint8 reason
    );
    event VerdictCommittedV2(
        bytes32 indexed submissionId,
        bytes32 indexed commandId,
        address indexed learner,
        bytes32 learnerAccountCommitment,
        bytes32 sourceHash,
        Verdict verdict,
        bytes32 learnerPublicationGrantId,
        bytes32 reviewerPublicationGrantId,
        uint64 configurationRevision
    );

    DanceCapturePolicyV2 public immutable capturePolicy;
    bytes32 public immutable capturePolicyRuntimeHash;

    constructor(
        Deployment memory deployment,
        Wire.Policy memory docs,
        DanceCapturePolicyV2 verifier,
        bytes32 verifierHash
    ) DanceVerdictAuthorityV2(deployment, docs) {
        if (address(verifier).code.length == 0 || address(verifier).codehash != verifierHash || verifier.VERSION() != 2)
        {
            revert InvalidSource();
        }
        // The immutable verifier address and hash are both bound by this
        // contract's runtime code hash and thus by the V2 source hash.
        capturePolicy = verifier;
        capturePolicyRuntimeHash = verifierHash;
    }

    function _pinnedCapturePolicy() private view returns (DanceCapturePolicyV2 verifier) {
        verifier = capturePolicy;
        if (address(verifier).codehash != capturePolicyRuntimeHash) revert InvalidSource();
    }

    function submissionId(address learner, bytes32 captureId) public view returns (bytes32) {
        return Wire.submissionId(_domain(), learner, captureId);
    }

    function registrationOf(bytes32 id)
        external
        view
        returns (bytes memory captureAbi, bytes memory submissionAbi, bytes32 submissionHash)
    {
        Registration storage saved = registrations[id];
        return (saved.captureAbi, saved.submissionAbi, saved.submissionHash);
    }

    function _rules(uint64 expected) private view {
        if (expected != 0 || rulesEpoch != 0) revert InvalidRules();
    }

    /// @param encoded Exact ABI encoding of the static RegisterSubmission tuple.
    function registerSubmission(bytes32 id, bytes32 hash, bytes calldata encoded) external returns (Receipt memory) {
        if (encoded.length != REGISTRATION_BYTES) revert InvalidCommand();
        Receipt memory prior = _existing(id, hash, Wire.Operation.RegisterSubmission, encoded);
        if (prior.operation != Wire.Operation.Unknown) return prior;
        (uint64 owner, uint64 configuration, uint64 expectedRules, uint64 expectedMedia) =
            abi.decode(encoded, (uint64, uint64, uint64, uint64));
        _publisher(owner, configuration);
        _rules(expectedRules);
        if (expectedMedia != 0) revert MediaUnavailable();
        DanceCapturePolicyV2.RegistrationFacts memory facts = _pinnedCapturePolicy().verifyRegistration(encoded);
        bytes32 subId = facts.submissionId;
        if (media[subId].epoch != 0) revert MediaUnavailable();
        if (recordingUsed[facts.recordingReplayKey]) revert RecordingAlreadyUsed();
        recordingUsed[facts.recordingReplayKey] = true;
        registrations[subId] = Registration(
            encoded[CAPTURE_OFFSET:CONSENT_OFFSET],
            encoded[SUBMISSION_OFFSET:RECORDING_OFFSET],
            facts.submissionHash,
            facts.trustedSubmittedAtMs,
            facts.reviewDeadlineMs
        );
        media[subId] = MediaState(1, true, 0);
        emit SubmissionRegisteredV2(
            subId,
            id,
            facts.learner,
            facts.captureHash,
            facts.submissionHash,
            facts.trustedSubmittedAtMs,
            facts.reviewDeadlineMs,
            facts.publicationGrantId,
            facts.privateConsentHash,
            configuration
        );
        return _remember(id, hash, Wire.Operation.RegisterSubmission, subId, 1);
    }

    /// @param encoded Exact ABI encoding of the static CommitVerdict tuple.
    function commitVerdict(bytes32 id, bytes32 hash, bytes calldata encoded) external returns (Receipt memory) {
        if (encoded.length != DECISION_BYTES) revert InvalidCommand();
        Wire.Decision memory decision = abi.decode(encoded, (Wire.CommitVerdict)).decision;
        Receipt memory prior = _existing(id, hash, Wire.Operation.CommitVerdict, encoded);
        if (prior.operation != Wire.Operation.Unknown) return prior;
        OwnerContext memory owner = _publisher(decision.expectedOwnerEpoch, decision.expectedConfigurationRevision);
        _rules(decision.expectedRulesEpoch);
        Registration storage registered = registrations[decision.submissionId];
        MediaState memory current = media[decision.submissionId];
        if (!current.ready || current.epoch != decision.expectedMediaEpoch) revert MediaUnavailable();
        if (verdicts[decision.submissionId].category != 0) revert VerdictAlreadyCommitted();
        if (decision.verdict != PASS && decision.verdict != NOT_PASSED) revert InvalidVerdict();
        uint64 seconds_ = _seconds();
        uint64 nowMs = seconds_ * 1000;
        if (
            decision.intentAcceptedAtMs < registered.trustedSubmittedAtMs || decision.intentAcceptedAtMs > nowMs
                || nowMs >= registered.reviewDeadlineMs
        ) revert InvalidWindow();
        _reviewerRole(owner, decision, seconds_);
        DanceCapturePolicyV2.CaptureFacts memory captured =
            _pinnedCapturePolicy().verifyVerdictContext(registered.captureAbi, encoded);
        Verdict memory verdict = Verdict(
            hash,
            registered.submissionHash,
            decision.reviewerAccountCommitment,
            decision.reviewerWallet,
            seconds_,
            decision.verdict,
            decision.verdict == PASS && nowMs >= captured.opensAtMs && nowMs < captured.cutoffAtMs
        );
        verdicts[decision.submissionId] = verdict;
        emit VerdictCommittedV2(
            decision.submissionId,
            id,
            captured.learner,
            captured.accountCommitment,
            sourceHash(),
            verdict,
            captured.publicationGrantId,
            decision.reviewerPublicationGrantId,
            decision.expectedConfigurationRevision
        );
        return _remember(id, hash, Wire.Operation.CommitVerdict, decision.submissionId, current.epoch);
    }

    function _reviewerRole(OwnerContext memory owner, Wire.Decision memory decision, uint64 nowSeconds) private view {
        if (decision.reviewerWallet == owner.wallet) {
            if (decision.expectedReviewerRoleEpoch != owner.epoch) revert StaleContext();
        } else {
            ReviewerRole memory role = reviewerRoles[decision.reviewerWallet];
            if (
                !role.active || role.ownerEpoch != owner.epoch || role.epoch != decision.expectedReviewerRoleEpoch
                    || nowSeconds >= role.expiresAtSeconds
            ) revert Unauthorized();
        }
    }

    function invalidateSubmission(bytes32 id, bytes32 hash, Wire.InvalidateSubmission calldata p)
        external
        returns (Receipt memory)
    {
        Wire.Domain memory scope = _domain();
        Receipt memory prior = _existing(id, hash, Wire.Operation.InvalidateSubmission, abi.encode(p));
        if (prior.operation != Wire.Operation.Unknown) return prior;
        if (p.learnerWallet == address(0) || p.captureId == 0 || p.reason == 0 || p.reason > 5) {
            revert InvalidSubmission();
        }
        if (msg.sender != p.learnerWallet && msg.sender != _directoryCommunity().configuration.publisher) {
            revert Unauthorized();
        }
        bytes32 subId = Wire.submissionId(scope, p.learnerWallet, p.captureId);
        MediaState memory current = media[subId];
        if (current.epoch != p.expectedMediaEpoch || (current.epoch != 0 && !current.ready)) revert MediaUnavailable();
        uint64 epoch = current.epoch + 1;
        media[subId] = MediaState(epoch, false, p.reason);
        emit SubmissionInvalidatedV2(subId, id, epoch, p.reason);
        return _remember(id, hash, Wire.Operation.InvalidateSubmission, subId, epoch);
    }
}
