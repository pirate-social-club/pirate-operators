import { keccak256, stringToHex, zeroHash, type Hex } from "viem";
import {
  bytes32,
  canonical,
  hashJson,
  insist,
} from "../packages/community/common.ts";
import { address } from "../packages/community/manifest-core.ts";
import {
  verifyDanceVerdict,
  type DanceCanonicalSource,
  type DanceLog,
  type DanceReadPort,
  type VerifiedDanceVerdict,
} from "../packages/dance-chain/reader.ts";
import {
  danceAccountCommitment,
  danceCaptureHash,
  danceCommand,
  danceConsentHash,
  danceMediaBinding,
  danceMediaId,
  danceOfferId,
  danceRecordingBinding,
  danceRecordingReplay,
  danceReviewerConsent,
  danceSubmissionHash,
  danceSubmissionId,
  type DanceCapture as WireCapture,
  type DanceConsent as WireConsent,
  type DanceSubmission as WireSubmission,
} from "../packages/dance-chain/wire.ts";
import type {
  DanceCanonicalEvidence,
  DanceCapture,
  DanceDecisionIntent,
  DanceOutbox,
  DanceReview,
} from "../packages/dance/contracts.ts";
import {
  decisionIntegrityHash,
  submissionIntentPreimage,
} from "../packages/dance/intent.ts";
import {
  danceId,
  reviewDeadline,
  validateCapture,
} from "../packages/dance/validation.ts";
import { songKeyOf } from "../packages/protocol/records.ts";

const uint = (value: number) => {
  insist(
    Number.isSafeInteger(value) && value >= 0,
    "dance_wire_integer_invalid",
    503,
  );
  return BigInt(value);
};
const wireCommandId = (id: string) => keccak256(stringToHex(danceId(id)));
const namedCaptureId = (id: string) => bytes32(`0x${danceId(id)}`);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function localSource(
  source: DanceCanonicalSource,
  capture: Omit<DanceCapture, "captureHash" | "consent">,
) {
  const pinned = capture.source;
  insist(
    source.domain.chainId === BigInt(pinned.chainId) &&
      source.domain.communityId === capture.communityId &&
      pinned.communityId === capture.communityId &&
      same(source.domain.verifier, pinned.address) &&
      source.pin.deploymentBlock.toString() === pinned.fromBlock &&
      same(source.pin.runtimeCodeHash, pinned.runtimeCodeHash) &&
      same(source.pin.fixedPublisher, pinned.publisher) &&
      same(source.pin.publicityPolicyHash, pinned.policyHash) &&
      same(source.sourceHash, pinned.sourceHash) &&
      same(source.pin.rulesSha256, capture.rulesHash) &&
      same(source.pin.termsSha256, capture.termsHash) &&
      same(source.pin.rubricSha256, capture.rubricHash) &&
      same(source.pin.mediaPolicySha256, capture.mediaPolicyHash),
    "dance_canonical_source_changed",
    503,
  );
}

/** postId must come from the verified canonical song lookup. The song key
 * and revision/manifest/audio captured in the local record are cross-checked. */
export function canonicalDanceCapture(
  source: DanceCanonicalSource,
  capture: Omit<DanceCapture, "captureHash" | "consent">,
  postId: Hex,
): WireCapture {
  localSource(source, capture);
  const { domain } = source;
  const learner = address(capture.learner.wallet);
  const commitment = danceAccountCommitment(
    domain,
    capture.learner.accountId,
    learner,
  );
  const song = {
    chainId: domain.chainId,
    posts: source.pin.posts,
    communityId: domain.communityId,
    postId: bytes32(postId),
    revision: uint(capture.songRevision),
    manifestSha256: bytes32(capture.manifestSha256),
    audioSha256: bytes32(capture.audioSha256),
  };
  insist(
    same(capture.learner.accountCommitment, commitment) &&
      songKeyOf({ ...song, chainId: Number(song.chainId) }) ===
        capture.songKey &&
      capture.durationSamples >= 288000 &&
      capture.durationSamples <= 1440000 &&
      Number.isSafeInteger(capture.startSample + capture.durationSamples) &&
      capture.startSample + capture.durationSamples <=
        capture.songDurationSamples &&
      capture.expected.rulesEpoch === 0 &&
      capture.expected.mediaEpoch === 0,
    "dance_canonical_capture_changed",
    503,
  );
  const r = capture.reference,
    o = capture.offer;
  if (o)
    insist(
      same(danceOfferId(domain, o.offerId), o.offerIdCommitment) &&
        same(o.sourceHash, source.sourceHash) &&
        o.opensAtMs < o.cutoffAtMs,
      "dance_offer_binding_mismatch",
      409,
    );
  return {
    captureId: namedCaptureId(capture.captureId),
    accountCommitment: commitment,
    learner,
    identityEpoch: uint(capture.learner.identityEpoch),
    groupId: bytes32(capture.learner.groupId),
    groupEpoch: uint(capture.learner.groupEpoch),
    authorizationId: bytes32(capture.learner.authorizationId),
    reservedAtMs: uint(capture.reservedAtMs),
    song,
    rulesSha256: source.pin.rulesSha256,
    termsSha256: source.pin.termsSha256,
    rubricSha256: source.pin.rubricSha256,
    mediaPolicySha256: source.pin.mediaPolicySha256,
    referenceSelection: {
      present: !!r,
      id: r ? bytes32(r.id) : zeroHash,
      revision: r ? uint(r.revision) : 0n,
      epoch: r ? uint(r.epoch) : 0n,
      segmentLayoutSha256: r ? bytes32(r.segmentLayoutSha256) : zeroHash,
      segmentId: r ? bytes32(r.segmentId) : zeroHash,
      startSample: uint(capture.startSample),
      durationSamples: uint(capture.durationSamples),
    },
    offer: {
      present: !!o,
      offerIdCommitment: o ? bytes32(o.offerIdCommitment) : zeroHash,
      inputHash: o ? bytes32(o.inputHash) : zeroHash,
      sourceHash: o ? bytes32(o.sourceHash) : zeroHash,
      opensAtMs: o ? uint(o.opensAtMs) : 0n,
      cutoffAtMs: o ? uint(o.cutoffAtMs) : 0n,
    },
  };
}

export function canonicalDanceRegistration(
  source: DanceCanonicalSource,
  review: DanceReview,
  postId: Hex,
  outbox: DanceOutbox,
) {
  const c = review.capture,
    r = review.receipt,
    { domain } = source;
  validateCapture(c);
  const preimage = submissionIntentPreimage(review, outbox.commandId);
  insist(
    outbox.kind === "submission" &&
      outbox.subjectId === review.reviewId &&
      outbox.communityId === source.domain.communityId &&
      outbox.payloadJson === JSON.stringify(preimage) &&
      outbox.localIntegrityHash === hashJson(preimage),
    "dance_outbox_conflict",
    409,
  );
  const capture = canonicalDanceCapture(source, c, postId);
  const captureHash = danceCaptureHash(domain, capture);
  const accepted = c.consent!;
  const mediaIdCommitment = danceMediaId(domain, r.mediaId);
  const generation = uint(r.mediaRevision);
  const recordingSha256 = bytes32(review.media.recordingSha256);
  const binding = danceMediaBinding(
    domain,
    captureHash,
    mediaIdCommitment,
    generation,
    recordingSha256,
  );
  insist(
    same(c.captureHash, captureHash) &&
      same(accepted.captureHash, captureHash) &&
      same(accepted.termsHash, source.pin.termsSha256) &&
      same(accepted.publicityPolicyHash, source.pin.publicityPolicyHash) &&
      review.reviewId === c.captureId &&
      accepted.captureId === c.captureId &&
      accepted.accountId === c.learner.accountId &&
      r.accountId === c.learner.accountId &&
      r.communityId === c.communityId &&
      r.submissionId === c.captureId &&
      c.reservedAtMs <= accepted.acceptedAtMs &&
      accepted.acceptedAtMs <= r.trustedSubmittedAtMs &&
      r.reviewDeadlineMs === reviewDeadline(r.trustedSubmittedAtMs) &&
      r.trustedSubmittedAtMs < c.expiresAtMs &&
      generation > 1n &&
      same(r.bindingCommitment, binding),
    "dance_canonical_submission_changed",
    503,
  );
  insist(
    canonical(review.media) ===
      canonical({
        communityId: c.communityId,
        accountId: c.learner.accountId,
        songKey: c.songKey,
        songRevision: c.songRevision,
        audioSha256: c.audioSha256,
        recordingSha256,
        mediaPolicyVersion: c.mediaPolicyVersion,
        startSample: c.startSample,
        durationSamples: c.durationSamples,
      }),
    "dance_media_binding_mismatch",
    503,
  );
  const consent: WireConsent = {
    accepted: true,
    acceptedAtMs: uint(accepted.acceptedAtMs),
    captureHash,
    termsSha256: source.pin.termsSha256,
    publicityPolicyHash: source.pin.publicityPolicyHash,
  };
  const submission: WireSubmission = {
    submissionId: danceSubmissionId(domain, capture.learner, capture.captureId),
    captureHash,
    consentHash: danceConsentHash(domain, consent),
    mediaBindingHash: binding,
    mediaIdCommitment,
    mediaGeneration: generation,
    recordingReplayKey: danceRecordingReplay(domain, recordingSha256),
    recordingBindingHash: danceRecordingBinding(
      domain,
      recordingSha256,
      binding,
    ),
    trustedSubmittedAtMs: uint(r.trustedSubmittedAtMs),
    reviewDeadlineMs: uint(r.reviewDeadlineMs),
    mediaExpiresAtMs: uint(r.reviewDeadlineMs),
  };
  const command = danceCommand(
    domain,
    "registerSubmission",
    source.pin.fixedPublisher,
    wireCommandId(outbox.commandId),
    {
      expectedOwnerEpoch: uint(c.expected.ownerEpoch),
      expectedConfigurationRevision: uint(c.expected.configurationRevision),
      expectedRulesEpoch: 0n,
      expectedMediaEpoch: 0n,
      capture,
      consent,
      submission,
      recordingSha256,
    },
  );
  return {
    command,
    submission,
    submissionHash: danceSubmissionHash(domain, submission),
  };
}

export function canonicalDanceDecision(
  source: DanceCanonicalSource,
  intent: DanceDecisionIntent,
) {
  const { domain } = source,
    p = intent.preimage,
    c = p.capture,
    reviewer = p.reviewer;
  localSource(source, c);
  const learner = address(c.learner.wallet),
    wallet = address(reviewer.wallet);
  const account = danceAccountCommitment(domain, reviewer.accountId, wallet);
  insist(
    intent.commandId === p.commandId &&
      p.submissionId === c.captureId &&
      intent.localIntegrityHash === decisionIntegrityHash(p) &&
      p.intentAcceptedAtMs >= p.trustedSubmittedAtMs &&
      p.intentAcceptedAtMs < p.reviewDeadlineMs &&
      same(reviewer.accountCommitment, account) &&
      same(reviewer.publicityPolicyHash, source.pin.publicityPolicyHash) &&
      reviewer.consentAccepted === true &&
      reviewer.expectedRulesEpoch === 0 &&
      reviewer.expectedMediaEpoch === 1 &&
      (p.verdict === "pass" || p.verdict === "not_passed"),
    "dance_canonical_decision_changed",
    503,
  );
  const submissionId = danceSubmissionId(
    domain,
    learner,
    namedCaptureId(c.captureId),
  );
  return {
    submissionId,
    command: danceCommand(
      domain,
      "commitVerdict",
      source.pin.fixedPublisher,
      wireCommandId(intent.commandId),
      {
        decision: {
          submissionId,
          verdict: p.verdict === "pass" ? 1 : 2,
          reviewerAccountCommitment: account,
          reviewerWallet: wallet,
          reviewerAuthorizationId: bytes32(reviewer.authorizationId),
          reviewerIdentityEpoch: uint(reviewer.identityEpoch),
          reviewerGroupId: bytes32(reviewer.groupId),
          reviewerGroupEpoch: uint(reviewer.groupEpoch),
          expectedOwnerEpoch: uint(reviewer.ownerEpoch),
          expectedReviewerRoleEpoch: uint(reviewer.roleEpoch),
          expectedMediaEpoch: 1n,
          intentAcceptedAtMs: uint(p.intentAcceptedAtMs),
          expectedConfigurationRevision: uint(
            reviewer.expectedConfigurationRevision,
          ),
          expectedRulesEpoch: 0n,
          reviewerConsentHash: danceReviewerConsent(
            domain,
            account,
            wallet,
            source.pin.publicityPolicyHash,
            uint(p.intentAcceptedAtMs),
          ),
        },
      },
    ),
  };
}

export function bindCanonicalDanceVerdict(
  source: DanceCanonicalSource,
  intent: DanceDecisionIntent,
  verdict: VerifiedDanceVerdict,
): DanceCanonicalEvidence {
  const expected = canonicalDanceDecision(source, intent);
  const p = verdict.provenance;
  const local = intent.preimage;
  insist(
    same(verdict.sourceHash, source.sourceHash) &&
      same(verdict.commandId, expected.command.id) &&
      same(p.commandHash, expected.command.hash) &&
      same(verdict.submission.submissionId, expected.submissionId) &&
      same(verdict.submission.captureHash, local.capture.captureHash) &&
      same(verdict.submission.mediaBindingHash, local.mediaBindingHash) &&
      verdict.submission.mediaGeneration === uint(local.mediaGeneration) &&
      verdict.submission.trustedSubmittedAtMs ===
        uint(local.trustedSubmittedAtMs) &&
      verdict.submission.reviewDeadlineMs === uint(local.reviewDeadlineMs) &&
      verdict.verdict === local.verdict,
    "dance_canonical_evidence_changed",
    503,
  );
  return {
    version: "pirate.dance-verdict/1",
    verification: "coordinator-validated/1",
    commandId: intent.commandId,
    submissionId: local.submissionId,
    intentIntegrityHash: intent.localIntegrityHash,
    commandHash: p.commandHash,
    submissionHash: p.submissionHash,
    source: local.capture.source,
    verdict: verdict.verdict,
    committedAtSeconds: p.committedAtSeconds.toString(),
    transactionHash: p.transactionHash,
    transactionIndex: Number(p.transactionIndex),
    logIndex: Number(p.logIndex),
    blockNumber: p.blockNumber.toString(),
    blockHash: p.blockHash,
    removed: false,
    finality: "safe",
    canonical: true,
    evidenceHash: verdict.evidenceHash,
  };
}

/** Internal reconciliation: verify canonical raw evidence before binding it
 * back to the original local intent. It never submits or retries a command. */
export async function reconcileCanonicalDanceVerdict(
  rpc: DanceReadPort,
  source: DanceCanonicalSource,
  intent: DanceDecisionIntent,
  log: DanceLog,
) {
  return bindCanonicalDanceVerdict(
    source,
    intent,
    await verifyDanceVerdict(rpc, source, log),
  );
}
