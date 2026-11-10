// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

/// @notice Exact static preimages for the local Dance v5 protocol.
/// @dev Semantic packet SHA-256: 98645e345bbed9a3aeb64ebdd37a18cbfcf65c07c1998605f9459c94275ebd90
/// `referenceSelection` represents the wire field `reference`; the name is not encoded.
library DanceVerdictWire {
    bytes32 internal constant ACCOUNT = keccak256("pirate.dance-account/1");
    bytes32 internal constant GROUP = keccak256("pirate.dance-known-group/1");
    bytes32 internal constant CAPTURE = keccak256("pirate.dance-capture/1");
    bytes32 internal constant SUBMISSION_ID = keccak256("pirate.dance-submission-id/1");
    bytes32 internal constant SUBMISSION = keccak256("pirate.dance-submission/1");
    bytes32 internal constant CONSENT = keccak256("pirate.dance-consent/1");
    bytes32 internal constant SOURCE = keccak256("pirate.dance-verdict-source/1");
    bytes32 internal constant COMMAND = keccak256("pirate.dance-command/1");
    bytes32 internal constant RECORDING_REPLAY = keccak256("pirate.dance-recording-replay/1");
    bytes32 internal constant MEDIA_ID = keccak256("pirate.dance-media-id/1");
    bytes32 internal constant MEDIA_BINDING = keccak256("pirate.dance-media-binding/1");
    bytes32 internal constant RECORDING_BINDING = keccak256("pirate.dance-recording-binding/1");
    bytes32 internal constant OFFER_ID = keccak256("pirate.dance-offer-id/1");
    bytes32 internal constant POLICY = keccak256("pirate.dance-policy/1");
    bytes32 internal constant REVIEWER_CONSENT = keccak256("pirate.dance-reviewer-consent/1");

    enum Operation {
        Unknown,
        ConfigureOwner,
        GrantReviewer,
        RevokeReviewer,
        BindIdentity,
        MergeGroups,
        SetReference,
        RegisterSubmission,
        CommitVerdict,
        InvalidateSubmission,
        InvalidateRules
    }

    struct Song {
        uint256 chainId;
        address posts;
        bytes32 communityId;
        bytes32 postId;
        uint64 revision;
        bytes32 manifestSha256;
        bytes32 audioSha256;
    }

    struct Reference {
        bool present;
        bytes32 id;
        uint64 revision;
        uint64 epoch;
        bytes32 segmentLayoutSha256;
        bytes32 segmentId;
        uint64 startSample;
        uint64 durationSamples;
    }

    struct Offer {
        bool present;
        bytes32 offerIdCommitment;
        bytes32 inputHash;
        bytes32 sourceHash;
        uint64 opensAtMs;
        uint64 cutoffAtMs;
    }

    struct Capture {
        bytes32 captureId;
        bytes32 accountCommitment;
        address learner;
        uint64 identityEpoch;
        bytes32 groupId;
        uint64 groupEpoch;
        bytes32 authorizationId;
        uint64 reservedAtMs;
        Song song;
        bytes32 rulesSha256;
        bytes32 termsSha256;
        bytes32 rubricSha256;
        bytes32 mediaPolicySha256;
        Reference referenceSelection;
        Offer offer;
    }

    struct Consent {
        bool accepted;
        uint64 acceptedAtMs;
        bytes32 captureHash;
        bytes32 termsSha256;
        bytes32 publicityPolicyHash;
    }

    struct Submission {
        bytes32 submissionId;
        bytes32 captureHash;
        bytes32 consentHash;
        bytes32 mediaBindingHash;
        bytes32 mediaIdCommitment;
        uint64 mediaGeneration;
        bytes32 recordingReplayKey;
        bytes32 recordingBindingHash;
        uint64 trustedSubmittedAtMs;
        uint64 reviewDeadlineMs;
        uint64 mediaExpiresAtMs;
    }

    struct Decision {
        bytes32 submissionId;
        uint8 verdict;
        bytes32 reviewerAccountCommitment;
        address reviewerWallet;
        bytes32 reviewerAuthorizationId;
        uint64 reviewerIdentityEpoch;
        bytes32 reviewerGroupId;
        uint64 reviewerGroupEpoch;
        uint64 expectedOwnerEpoch;
        uint64 expectedReviewerRoleEpoch;
        uint64 expectedMediaEpoch;
        uint64 intentAcceptedAtMs;
        uint64 expectedConfigurationRevision;
        uint64 expectedRulesEpoch;
        bytes32 reviewerConsentHash;
    }

    struct ConfigureOwner {
        uint64 expectedOwnerEpoch;
        uint64 expectedConfigurationRevision;
        address expectedController;
        address expectedPublisher;
        address expectedV4;
        address ownerWallet;
        uint64 validFromSeconds;
        uint64 expiresAtSeconds;
        bytes32 policyHash;
    }

    struct GrantReviewer {
        uint64 expectedOwnerEpoch;
        uint64 expectedConfigurationRevision;
        address reviewerWallet;
        uint64 expectedReviewerEpoch;
        uint64 expiresAtSeconds;
    }

    struct RevokeReviewer {
        uint64 expectedOwnerEpoch;
        uint64 expectedConfigurationRevision;
        address reviewerWallet;
        uint64 expectedReviewerEpoch;
    }

    struct BindIdentity {
        uint64 expectedOwnerEpoch;
        uint64 expectedConfigurationRevision;
        bytes32 accountCommitment;
        address wallet;
        uint64 expectedIdentityEpoch;
        bytes32 sourceGroupId;
        uint64 sourceBindingGroupEpoch;
        uint64 sourceCurrentGroupEpoch;
        bytes32 destinationGroupId;
        uint64 destinationGroupEpoch;
        bool createSingleton;
        bool active;
    }

    struct MergeGroups {
        uint64 expectedOwnerEpoch;
        uint64 expectedConfigurationRevision;
        bytes32 leftGroupId;
        uint64 expectedLeftEpoch;
        bytes32 rightGroupId;
        uint64 expectedRightEpoch;
        bytes32 newGroupId;
    }

    struct SetReference {
        uint64 expectedOwnerEpoch;
        uint64 expectedConfigurationRevision;
        bytes32 referenceId;
        uint64 expectedReferenceEpoch;
        uint64 revision;
        bytes32 segmentLayoutSha256;
        bool active;
    }

    struct RegisterSubmission {
        uint64 expectedOwnerEpoch;
        uint64 expectedConfigurationRevision;
        uint64 expectedRulesEpoch;
        uint64 expectedMediaEpoch;
        Capture capture;
        Consent consent;
        Submission submission;
        bytes32 recordingSha256;
    }

    struct CommitVerdict {
        Decision decision;
    }

    struct InvalidateSubmission {
        bytes32 captureId;
        address learnerWallet;
        uint64 expectedMediaEpoch;
        uint8 reason;
    }

    struct InvalidateRules {
        uint64 expectedRulesEpoch;
        uint64 expectedOwnerEpoch;
        uint64 expectedConfigurationRevision;
    }

    struct Domain {
        uint256 chainId;
        address verifier;
        bytes32 communityId;
    }

    struct Policy {
        bytes32 rulesSha256;
        bytes32 termsSha256;
        bytes32 rubricSha256;
        bytes32 mediaPolicySha256;
        bytes32 consentDisclosureSha256;
        bytes32 privacySha256;
    }

    struct SourcePin {
        address directory;
        bytes32 directoryRuntimeHash;
        address v4;
        bytes32 v4RuntimeHash;
        address posts;
        bytes32 postsRuntimeHash;
        address fixedPublisher;
        bytes32 publicityPolicyHash;
        bytes32 rulesSha256;
        bytes32 termsSha256;
        bytes32 rubricSha256;
        bytes32 mediaPolicySha256;
        uint64 deploymentBlock;
        bytes32 runtimeCodeHash;
    }

    function captureHashAbi(Domain memory d, bytes memory payload) internal pure returns (bytes32) {
        return keccak256(bytes.concat(abi.encode(CAPTURE, d.chainId, d.verifier, d.communityId), payload));
    }

    function consentHashAbi(Domain memory d, bytes memory payload) internal pure returns (bytes32) {
        return keccak256(bytes.concat(abi.encode(CONSENT, d.chainId, d.verifier, d.communityId), payload));
    }

    function submissionHashAbi(Domain memory d, bytes memory payload) internal pure returns (bytes32) {
        return keccak256(bytes.concat(abi.encode(SUBMISSION, d.chainId, d.verifier, d.communityId), payload));
    }

    function policyHash(Policy memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(POLICY, p));
    }

    function sourceHash(Domain memory d, SourcePin memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(SOURCE, d.chainId, d.verifier, d.communityId, p));
    }

    function captureHash(Domain memory d, Capture memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(CAPTURE, d.chainId, d.verifier, d.communityId, p));
    }

    function consentHash(Domain memory d, Consent memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(CONSENT, d.chainId, d.verifier, d.communityId, p));
    }

    function submissionHash(Domain memory d, Submission memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(SUBMISSION, d.chainId, d.verifier, d.communityId, p));
    }

    function submissionId(Domain memory d, address learner, bytes32 captureId) internal pure returns (bytes32) {
        return keccak256(abi.encode(SUBMISSION_ID, d.chainId, d.verifier, d.communityId, learner, captureId));
    }

    function singletonId(Domain memory d, bytes32 accountCommitment) internal pure returns (bytes32) {
        return keccak256(abi.encode(GROUP, d.chainId, d.verifier, d.communityId, accountCommitment));
    }

    function mediaBindingHash(
        Domain memory d,
        bytes32 capture,
        bytes32 mediaId,
        uint64 generation,
        bytes32 recordingSha256
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MEDIA_BINDING, d.chainId, d.verifier, d.communityId, capture, mediaId, generation, recordingSha256
            )
        );
    }

    function recordingReplayKey(Domain memory d, bytes32 recordingSha256) internal pure returns (bytes32) {
        return keccak256(abi.encode(RECORDING_REPLAY, d.chainId, d.verifier, d.communityId, recordingSha256));
    }

    function recordingBindingHash(Domain memory d, bytes32 recordingSha256, bytes32 mediaBinding)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(RECORDING_BINDING, d.chainId, d.verifier, d.communityId, recordingSha256, mediaBinding)
        );
    }

    function reviewerConsentHash(Domain memory d, Decision memory p, bytes32 publicityPolicyHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                REVIEWER_CONSENT,
                d.chainId,
                d.verifier,
                d.communityId,
                p.reviewerAccountCommitment,
                p.reviewerWallet,
                publicityPolicyHash,
                p.intentAcceptedAtMs
            )
        );
    }

    /// @dev Every admitted payload is a static tuple encoded with abi.encode.
    /// The header and tuple consist of complete ABI words with no offsets;
    /// concatenating those encodings is the same preimage as encoding them together.
    function commandHash(Domain memory d, Operation op, address caller, bytes32 id, bytes memory encodedPayload)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            bytes.concat(
                abi.encode(COMMAND, d.chainId, d.verifier, d.communityId, uint8(op), caller, id), encodedPayload
            )
        );
    }
}
