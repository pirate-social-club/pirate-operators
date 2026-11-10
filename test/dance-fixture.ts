/** Pure modeled authority/media/canonical ports. No process, D1 or provider. */
import { hashJson, insist } from "../packages/community/common.ts";
import {
  DANCE_VERSION,
  DANCE_PRIVATE_MEDIA_POLICY,
  type DanceAuthority,
  type DanceCapture,
  type DancePrincipal,
  type DancePorts,
  type DanceReadyMedia,
  type DanceCanonicalEvidence,
  type DanceDecisionIntent,
  type DanceFence,
} from "../packages/dance/contracts.ts";
import { DanceReviewService } from "../services/dance-review.ts";
import { MemoryDanceStore } from "./dance-memory-store.ts";
export const dh = (n: number) => "0x" + n.toString(16).padStart(64, "0");
export const dw = (n: number) => "0x" + n.toString(16).padStart(40, "0");
export function danceFixture() {
  const store = new MemoryDanceStore(),
    principals: Record<string, DancePrincipal> = {};
  for (const [n, id] of [
    "owner",
    "learner",
    "moderator",
    "stranger",
    "learner2",
    "learner3",
    "alternate",
  ].entries())
    principals[id] = {
      accountId: id,
      wallet: dw(n + 1),
      active: true,
      identityEpoch: 1,
      groupId: "group_" + id,
      groupEpoch: 1,
      knownAliases: [id],
      authorizationId: dh(n + 50),
      accountCommitment: dh(n + 60),
    };
  const validAuthorizations = new Set(
    Object.values(principals).map((p) => p.authorizationId),
  );
  let ownerEpoch = 1,
    rulesRevision = 1,
    sequence = 0,
    termsAdmitted = true;
  const delegates = new Set<string>(),
    media = new Map<string, DanceReadyMedia>(),
    deadMedia = new Set<string>(),
    evidence = new Map<string, DanceCanonicalEvidence>();
  const pin = {
    chainId: 6343,
    address: dw(20),
    runtimeCodeHash: dh(21),
    fromBlock: "1",
    communityId: dh(1),
    publisher: dw(22),
    policyHash: dh(23),
    sourceHash: dh(24),
  };
  const consent = {
    accepted: true as const,
    version: "dance-consent-proposed-v4",
    termsHash: dh(5),
    publicityPolicyHash: dh(25),
  };
  function fence(use: () => boolean): DanceFence {
    const key = "modeled-fence-" + ++sequence;
    store.checks.set(key, use);
    return { sql: key, values: [] };
  }
  const currentMedia = (id: string) => {
    const m = media.get(id);
    insist(m && !deadMedia.has(id), "media_unavailable", 410);
    const accepted = [...store.records.values()].find(
      (r) => r.receipt.mediaId === id,
    );
    return accepted
      ? {
          ...m,
          revision: accepted.receipt.mediaRevision,
          expiresAt: accepted.receipt.reviewDeadlineMs,
        }
      : m;
  };
  const ready = async (id: string) => {
    const m = currentMedia(id);
    return {
      media: structuredClone(m),
      witness: {
        id,
        communityId: m.communityId,
        accountId: m.accountId,
        revision: m.revision,
        recordingSha256: m.recordingSha256,
        expiresAt: m.expiresAt,
      },
    };
  };
  const ports: DancePorts = {
    async authority(c, a, l) {
      insist(c === dh(1), "dance_not_found", 404);
      const ae = principals[a],
        le = principals[l];
      insist(ae && le, "dance_not_found", 404);
      const actor = structuredClone(ae),
        learner = structuredClone(le),
        observed = ownerEpoch;
      const f: DanceAuthority = {
        actor,
        learner,
        owner: {
          accountId: "owner",
          wallet: principals.owner.wallet,
          assignmentId: "assignment_" + ownerEpoch,
          epoch: ownerEpoch,
          expiresAtMs: store.time + 864000000,
          canonicalAccepted: true,
        },
        epochs: {
          configurationRevision: ownerEpoch,
          rulesEpoch: 0,
          mediaEpoch: 1,
        },
        reviewer: delegates.has(a)
          ? {
              delegationId: "grant_" + a,
              ownerEpoch,
              roleEpoch: 1,
              expiresAtMs: store.time + 864000000,
              canonicalAccepted: true,
            }
          : null,
        fence: fence(
          () =>
            ownerEpoch === observed &&
            hashJson(principals[a]) === hashJson(actor) &&
            hashJson(principals[l]) === hashJson(learner),
        ),
      };
      return f;
    },
    async admitCapture(c, a, s) {
      const capturedRule = rulesRevision;
      return {
        capture: {
          version: DANCE_VERSION,
          communityId: c,
          learner: structuredClone(principals[a]),
          songKey: s.songKey,
          songRevision: 1,
          songDurationSamples: 4800000,
          manifestSha256: dh(2),
          audioSha256: dh(3),
          mediaPolicyVersion: DANCE_PRIVATE_MEDIA_POLICY.version,
          mediaPolicyHash: dh(4),
          reference: s.referenceId
            ? {
                id: s.referenceId,
                revision: 1,
                epoch: 1,
                segmentId: "segment_1",
                segmentLayoutSha256: dh(7),
              }
            : null,
          startSample: 0,
          durationSamples: 480000,
          policy: "moderator-review-policy-v2",
          rulesHash: dh(6),
          termsHash: dh(5),
          rubricHash: dh(8),
          rubricText: "Perform the selected whole dance.",
          offer: s.offerId
            ? {
                offerId: s.offerId,
                offerIdCommitment: dh(90),
                inputHash: dh(9),
                sourceHash: pin.sourceHash,
                opensAtMs: store.time - 10000,
                cutoffAtMs: store.time + 2 * 86400000,
              }
            : null,
          expected: {
            ownerEpoch,
            configurationRevision: ownerEpoch,
            rulesEpoch: 0,
            mediaEpoch: 0,
          },
          source: pin,
          expiresAtMs: store.time + 2 * 86400000,
        },
        consentPolicy: {
          ...consent,
          text: "Proposed review consent, fixture only.",
          admission: termsAdmitted ? "admitted" : "review_pending",
        },
        fence: fence(() => rulesRevision === capturedRule),
      };
    },
    media: {
      version: "pirate.dance-media-port/1",
      readyForSubmission: async (id, _b, a) => {
        const r = await ready(id);
        insist(a.accountId === r.media.accountId, "media_not_found", 404);
        return r;
      },
      readyForReview: async (id, _b, a) => {
        const r = await ready(id);
        insist(a.accountId !== r.media.accountId, "dance_self_review", 403);
        return r;
      },
      prepareMediaSubmission: (_w, _id, _binding, accepted) => {
        insist(accepted.sql.length > 0, "actual_acceptance_fence_required");
        return { beforeAcceptance: [], afterAcceptance: [] };
      },
      commitFence: (w) =>
        fence(() => {
          const m = currentMedia(w.id);
          return (
            m.revision === w.revision &&
            m.recordingSha256 === w.recordingSha256 &&
            store.time < m.expiresAt
          );
        }),
      projectDanceMedia: (m, w) => {
        insist(m.revision === w.revision, "media_witness_mismatch");
        return {
          ...m,
          version: "pirate.community-media-dance/1",
          purpose: "private-review",
          readyAtMs: m.readyAt,
          expiresAtMs: m.expiresAt,
        };
      },
      projectDanceSubmission: (m, r) => {
        insist(
          m.revision === r.mediaRevision &&
            m.expiresAtMs === r.reviewDeadlineMs &&
            r.reviewDeadlineMs === r.trustedSubmittedAtMs + 604800000,
          "media_dance_submission_mismatch",
        );
        return {
          submissionId: r.submissionId,
          bindingCommitment: r.bindingCommitment,
          trustedSubmittedAtMs: r.trustedSubmittedAtMs,
          reviewDeadlineMs: r.reviewDeadlineMs,
        };
      },
    },
    async rules() {
      const revision = rulesRevision;
      return fence(() => rulesRevision === revision);
    },
    async captureCommitment(c) {
      return hashJson({ fixture: "ABI-not-implemented", c });
    },
    async mediaBindingHash(p) {
      return hashJson({ fixture: "acyclic-ABI-preimage-only", p });
    },
    async reviewerRoleEpoch() {
      return 0;
    },
    async offerIdCommitment() {
      return dh(90);
    },
    async reviewerAuthorization(r) {
      return fence(() => validAuthorizations.has(r.authorizationId));
    },
    reviewerConsent: {
      version: "dance-reviewer-proposed-v5",
      publicityPolicyHash: dh(25),
      admission: "admitted",
    },
    async authorization(c) {
      insist(
        validAuthorizations.has(c.learner.authorizationId),
        "dance_capture_authorization_changed",
        403,
      );
      return fence(() => validAuthorizations.has(c.learner.authorizationId));
    },
    async canonicalEvidence(i) {
      return evidence.get(i.commandId) ?? null;
    },
  };
  const service = new DanceReviewService(store, ports, dh(1));
  async function prepare(
    options: {
      actor?: string;
      offer?: boolean;
      reference?: boolean;
      delayMs?: number;
      digest?: string;
    } = {},
  ) {
    const actor = options.actor ?? "learner",
      n = ++sequence;
    const capture = await service.capture(
      actor,
      "capture_" + n,
      {
        songKey: dh(10),
        offerId: options.offer === false ? null : "offer_01",
        referenceId: options.reference ? "reference_1" : null,
      },
      consent,
    );
    const id = "media_" + n,
      recordingSha256 = options.digest ?? dh(n + 100);
    media.set(id, {
      version: "pirate.community-media/1",
      id,
      revision: 1,
      purpose: "private-review",
      rendition: {
        sha256: dh(99),
        bytes: 1,
        durationMs: 10000,
        width: 1,
        height: 1,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      communityId: dh(1),
      accountId: actor,
      songKey: capture.songKey,
      songRevision: 1,
      audioSha256: dh(3),
      mediaPolicyVersion: DANCE_PRIVATE_MEDIA_POLICY.version,
      recordingSha256,
      startSample: 0,
      durationSamples: 480000,
      readyAt: store.time,
      expiresAt: store.time + 2 * 86400000,
    });
    store.time += options.delayMs ?? 0;
    const receipt = await service.submit(
      actor,
      "submit_" + n,
      capture.captureId,
      id,
      recordingSha256,
    );
    return {
      capture,
      mediaId: id,
      recordingSha256,
      receipt,
      reviewId: capture.captureId,
    };
  }
  function canonical(
    i: DanceDecisionIntent,
    seconds = String(Math.floor(store.time / 1000)),
  ): DanceCanonicalEvidence {
    return {
      version: "pirate.dance-verdict/1",
      verification: "coordinator-validated/1",
      commandId: i.commandId,
      submissionId: i.preimage.submissionId,
      intentIntegrityHash: i.localIntegrityHash,
      commandHash: dh(70),
      submissionHash: dh(71),
      source: pin,
      verdict: i.preimage.verdict,
      committedAtSeconds: seconds,
      transactionHash: dh(72),
      transactionIndex: 0,
      logIndex: 1,
      blockNumber: "100",
      blockHash: dh(73),
      removed: false,
      finality: "safe",
      canonical: true,
      evidenceHash: dh(74),
    };
  }
  return {
    store,
    ports,
    service,
    principals,
    validAuthorizations,
    media,
    deadMedia,
    delegates,
    evidence,
    prepare,
    canonical,
    consent,
    pin,
    setOwner: () => {
      ownerEpoch++;
    },
    setRules: () => {
      rulesRevision++;
    },
    holdTerms: () => {
      termsAdmitted = false;
    },
  };
}
