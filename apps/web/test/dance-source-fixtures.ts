/** Named SIMULATED API/authority/media/storage ports. Never a production import.
 * Adapted c7 camera/preparation/recording fixture and original recovery cases. */
import type {
  DanceCapture,
  DanceConsentPolicy,
  DanceReceipt,
  DanceReview,
  DanceVerdict,
} from "../../../packages/dance/contracts.ts";
import type {
  MediaStatus,
  ReadyMedia,
} from "../../../packages/community-media/contracts.ts";
import type { DanceClient } from "../src/dance/client.ts";
import type { DanceJournalEntry } from "../src/dance/journal.ts";
import {
  decodeJourney,
  emptyJourney,
  type DanceJourneyEntry,
  type DanceJourneyStore,
} from "../src/dance/source/journey-store.ts";
import { danceSession } from "../src/dance/source/dance-preparation-api.ts";
import {
  danceTargetKey,
  type DanceScope,
  type DanceSourcePorts,
} from "../src/dance/source/ports.ts";
import type {
  DanceRecordingStorage,
  StoredDanceRecording,
} from "../src/dance/source/dance-recording.ts";

export const sha = (n: number) => n.toString(16).padStart(64, "0");
export const hash = (n: number) => "0x" + sha(n);
export const scope: DanceScope = {
  accountId: "private_account",
  sessionKey: "session_1",
  profileLabel: "Community profile",
  communityId: hash(1),
  songKey: hash(2),
  songRevision: 4,
  audioSha256: hash(3),
  reference: { id: "reference", revision: 2 },
  offerId: null,
};
export const consent: DanceConsentPolicy = {
  version: "fixture-consent-v5",
  termsHash: hash(5),
  publicityPolicyHash: hash(6),
  text: "Perform the selected dance. An authorized reviewer inspects the whole performance. This take remains private.",
  admission: "admitted",
};
export function captureFixture(now = 10000): DanceCapture {
  const c: DanceCapture = {
    version: "pirate.dance/1",
    captureId: "capture",
    communityId: scope.communityId,
    learner: {
      accountId: scope.accountId,
      wallet: "0x" + "01".repeat(20),
      active: true,
      identityEpoch: 1,
      groupId: "fixture_group",
      groupEpoch: 1,
      knownAliases: [scope.accountId],
      authorizationId: hash(7),
      accountCommitment: hash(8),
    },
    songKey: scope.songKey,
    songRevision: scope.songRevision,
    songDurationSamples: 4800000,
    manifestSha256: hash(2),
    audioSha256: scope.audioSha256,
    mediaPolicyVersion: "pirate.dance-private/1",
    mediaPolicyHash: hash(4),
    reference: {
      id: "reference",
      revision: 2,
      epoch: 1,
      segmentId: "segment",
      segmentLayoutSha256: hash(9),
    },
    startSample: 480000,
    durationSamples: 384624,
    policy: "moderator-review-policy-v2",
    rulesHash: hash(10),
    termsHash: consent.termsHash,
    rubricHash: hash(11),
    rubricText:
      "Perform the whole selected dance, keeping your full body visible.",
    offer: null,
    source: {
      chainId: 6343,
      address: "0x" + "02".repeat(20),
      runtimeCodeHash: hash(12),
      fromBlock: "1",
      communityId: scope.communityId,
      publisher: "0x" + "03".repeat(20),
      policyHash: hash(13),
      sourceHash: hash(14),
    },
    reservedAtMs: now,
    expiresAtMs: now + 600000,
    captureHash: hash(15),
    consent: null,
    expected: {
      ownerEpoch: 1,
      configurationRevision: 1,
      rulesEpoch: 1,
      mediaEpoch: 1,
    },
  };
  c.consent = {
    accepted: true,
    version: consent.version,
    termsHash: consent.termsHash,
    publicityPolicyHash: consent.publicityPolicyHash,
    receiptId: "capture_command",
    accountId: scope.accountId,
    captureId: c.captureId,
    captureHash: c.captureHash,
    acceptedAtMs: now,
  };
  return c;
}
export function simulatedJourneyStore() {
  const data = new Map<string, DanceJourneyEntry>(),
    archives = new Map<string, DanceJourneyEntry>();
  let tail = Promise.resolve();
  const store: DanceJourneyStore = {
    read: async (s, guard) => {
      guard();
      return structuredClone(decodeJourney(data.get(danceTargetKey(s)), s));
    },
    async exclusive(s, guard, use) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((r) => {
        release = r;
      });
      await previous;
      try {
        guard();
        let value = structuredClone(
          data.get(danceTargetKey(s)) ?? emptyJourney(s),
        );
        let active = true;
        try {
          return await use({
            read: () => {
              guard();
              if (!active) throw Error("closed");
              return structuredClone(value);
            },
            save: async (patch) => {
              guard();
              if (!active) throw Error("closed");
              value = decodeJourney(
                { ...value, ...patch, revision: value.revision + 1 },
                s,
              );
              data.set(danceTargetKey(s), structuredClone(value));
              return structuredClone(value);
            },
            archive: async () => {
              guard();
              archives.set(value.capture!.captureId, structuredClone(value));
            },
          });
        } finally {
          active = false;
        }
      } finally {
        release();
      }
    },
  };
  return { store, data, archives };
}
export function simulatedRecordingStorage() {
  const records = new Map<string, StoredDanceRecording>();
  const storage: DanceRecordingStorage = {
    exclusive: async (_id, use) => use(),
    load: async (id, guard) => {
      guard();
      return records.get(id) ?? null;
    },
    add: async (r, guard) => {
      guard();
      const m = JSON.parse(r.metadataJson) as { sessionId: string };
      if (records.has(m.sessionId)) throw Error("duplicate");
      records.set(m.sessionId, r);
    },
    remove: async (id, guard) => {
      guard();
      records.delete(id);
    },
    pruneExpired: async (now, guard) => {
      guard();
      for (const [id, r] of records)
        if (
          (JSON.parse(r.metadataJson) as { expiresAtMs: number }).expiresAtMs <=
          now
        )
          records.delete(id);
    },
  };
  return { storage, records };
}
export function mediaFixture(c: DanceCapture, digest = sha(16)): MediaStatus {
  const ready: ReadyMedia = {
    version: "pirate.community-media/1",
    id: "media",
    revision: 1,
    communityId: c.communityId,
    accountId: c.learner.accountId,
    songKey: c.songKey,
    songRevision: c.songRevision,
    audioSha256: c.audioSha256.slice(2),
    recordingSha256: digest,
    mediaPolicyVersion: c.mediaPolicyVersion,
    startSample: c.startSample,
    durationSamples: c.durationSamples,
    purpose: "private-review",
    readyAt: c.reservedAtMs + 1,
    expiresAt: c.expiresAtMs,
    rendition: {
      sha256: sha(17),
      bytes: 1000,
      durationMs: c.durationSamples / 48,
      width: 720,
      height: 1280,
      videoCodec: "h264",
      audioCodec: "aac",
    },
  };
  return {
    id: "media",
    purpose: "private-review",
    state: "ready",
    canRetry: false,
    expiresAt: c.expiresAtMs,
    ready,
  };
}
export function reviewFixture(c: DanceCapture): DanceReview {
  const ready = mediaFixture(c).ready!;
  return {
    version: "pirate.dance/1",
    reviewId: c.captureId,
    revision: 1,
    capture: c,
    media: {
      communityId: c.communityId,
      accountId: c.learner.accountId,
      songKey: c.songKey,
      songRevision: c.songRevision,
      audioSha256: c.audioSha256,
      recordingSha256: "0x" + ready.recordingSha256,
      mediaPolicyVersion: c.mediaPolicyVersion,
      startSample: c.startSample,
      durationSamples: c.durationSamples,
    },
    receipt: {
      submissionId: c.captureId,
      communityId: c.communityId,
      accountId: c.learner.accountId,
      mediaId: ready.id,
      bindingCommitment: hash(18),
      trustedSubmittedAtMs: c.reservedAtMs + 100,
      reviewDeadlineMs: c.reservedAtMs + 100 + 604800000,
      mediaRevision: 1,
    },
    state: "awaiting_review",
    localDenied: false,
    decision: null,
    canonical: null,
  };
}
export function simulatedCanonicalReview(
  c: DanceCapture,
  verdict: DanceVerdict,
): DanceReview {
  const review = reviewFixture(c);
  review.state = "canonical";
  review.decision = {
    intentId: "simulated_intent",
    commandId: "simulated_verdict_command",
    localIntegrityHash: hash(19),
    preimage: {
      version: "pirate.dance-verdict/1",
      operation: "CommitVerdict",
      commandId: "simulated_verdict_command",
      submissionId: c.captureId,
      capture: c,
      media: review.media,
      mediaId: review.receipt.mediaId,
      mediaGeneration: review.receipt.mediaRevision,
      mediaBindingHash: hash(18),
      trustedSubmittedAtMs: review.receipt.trustedSubmittedAtMs,
      reviewDeadlineMs: review.receipt.reviewDeadlineMs,
      reviewer: {
        accountId: "reviewer_account",
        wallet: "0x" + "04".repeat(20),
        identityEpoch: 1,
        groupId: "reviewer_group",
        groupEpoch: 1,
        authorizationId: hash(20),
        knownAliases: ["reviewer_account"],
        authority: "owner:fixture",
        ownerEpoch: 1,
        roleEpoch: 0,
        accountCommitment: hash(21),
        expectedConfigurationRevision: 1,
        expectedRulesEpoch: 1,
        expectedMediaEpoch: 1,
        consentVersion: consent.version,
        publicityPolicyHash: consent.publicityPolicyHash,
        consentAccepted: true,
      },
      verdict,
      intentAcceptedAtMs: c.reservedAtMs + 200,
    },
  };
  review.canonical = {
    version: "pirate.dance-verdict/1",
    verification: "coordinator-validated/1",
    commandId: review.decision.commandId,
    submissionId: c.captureId,
    intentIntegrityHash: review.decision.localIntegrityHash,
    commandHash: hash(22),
    submissionHash: hash(23),
    source: c.source,
    verdict,
    committedAtSeconds: String(Math.ceil((c.reservedAtMs + 1000) / 1000)),
    transactionHash: hash(24),
    transactionIndex: 0,
    logIndex: 0,
    blockNumber: "100",
    blockHash: hash(25),
    removed: false,
    finality: "safe",
    canonical: true,
    evidenceHash: hash(26),
  };
  return review;
}
export function simulatedSource() {
  const journey = simulatedJourneyStore(),
    c = captureFixture(),
    calls: string[] = [];
  let current: DanceScope | null = structuredClone(scope),
    retained: DanceJournalEntry | null = null;
  let status = mediaFixture(c),
    review = reviewFixture(c);
  const receipt = (): DanceReceipt => ({
    version: "pirate.dance/1",
    commandId: "submission_command",
    reviewId: c.captureId,
    revision: review.revision,
    state: review.state,
    intentId: null,
  });
  const client: DanceClient = {
    capture: async () => {
      calls.push("capture");
      return c;
    },
    submit: async () => {
      calls.push("submit");
      return receipt();
    },
    get: async () => {
      calls.push("get_recovering");
      return review;
    },
    observe: async () => {
      calls.push("observe");
      return review;
    },
    queue: async () => {
      throw Error("operator_not_in_fixture");
    },
    decide: async () => {
      throw Error("operator_not_in_fixture");
    },
    withdraw: async () => {
      calls.push("withdraw");
      return { ...receipt(), state: "withdrawal_pending" };
    },
    recover: async () => {
      calls.push("recover");
      return retained;
    },
    retained: async () => retained,
    acknowledgeRecovery: async () => {},
    resetDefiniteCapture: async () => {
      calls.push("reset");
    },
    dispose: () => {},
  };
  const ports: DanceSourcePorts = {
    scope,
    currentScope: () => current,
    client,
    consent,
    journal: journey.store,
    nowMs: () => 11000,
    captureAccess: async () => {
      calls.push("capture_access");
    },
    media: {
      version: "pirate.dance-private-media-ui/1",
      maximumBytes: 32 * 1024 * 1024,
      reserve: async () => {
        calls.push("reserve");
        return status;
      },
      upload: async () => {
        calls.push("put");
        return status;
      },
      status: async () => {
        calls.push("status");
        return status;
      },
      retry: async () => {
        calls.push("retry");
        return status;
      },
      playback: async () => ({
        url: "/api/media/media/playback",
        expiresAtMs: c.expiresAtMs,
      }),
    },
    playback: {
      guide: async () => {
        throw Error("native_guide_not_in_fixture");
      },
      reference: async () => {
        throw Error("reference_provider_not_in_fixture");
      },
    },
  };
  const session = danceSession(c, ports.media.maximumBytes);
  const ready = {
    kind: "capture_ready" as const,
    session,
    context: {
      session,
      reference: {
        canonical_song_start_ms: c.startSample / 48,
        canonical_song_end_ms: (c.startSample + c.durationSamples) / 48,
      },
    },
    assertCurrent: () => {},
  };
  async function seed(patch: Partial<DanceJourneyEntry> = {}) {
    await journey.store.exclusive(
      scope,
      () => {},
      async (h) => {
        await h.save({ capture: c, ...patch });
      },
    );
  }
  return {
    ports,
    journey,
    c,
    calls,
    client,
    ready,
    session,
    seed,
    setScope: (s: DanceScope | null) => {
      current = s;
    },
    setStatus: (s: MediaStatus) => {
      status = s;
    },
    setReview: (r: DanceReview) => {
      review = r;
    },
    setRetained: (r: DanceJournalEntry | null) => {
      retained = r;
    },
  };
}
