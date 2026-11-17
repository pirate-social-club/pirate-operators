import type { Hex } from "viem";
import { bytes32, insist } from "../packages/community/common.ts";
import {
  hashPrivateDanceCaptureV2,
  parseCaptureRequestV2,
  parseDanceCaptureV2,
  type CaptureRequestV2,
  type DanceCaptureV2,
  type PrivateCaptureV2,
  type StoredDanceCapture,
} from "../packages/dance/capture-v2.ts";
import type {
  DanceConsentPolicy,
  DanceFence,
} from "../packages/dance/contracts.ts";
import {
  sameDanceTarget,
  type DanceProductionTarget,
} from "../packages/dance/production.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import {
  validateConsent,
  validateFence,
} from "../packages/dance/validation.ts";
import {
  DancePrivateRequestSession,
  type DancePrivateActor,
} from "./dance-private-session.ts";

export interface DancePrivateCaptureCatalogue {
  select(
    actor: DancePrivateActor,
    target: DanceProductionTarget,
  ): Promise<{
    capture: Omit<
      PrivateCaptureV2,
      "captureId" | "captureHash" | "consent" | "reservedAtMs"
    >;
    consentPolicy: DanceConsentPolicy;
    fences: readonly DanceFence[];
  }>;
  /** Authenticate the EXACT retained resource/epoch snapshot; never substitute
   * a newly selected song/reference/offer or a public grant. */
  current(
    actor: DancePrivateActor,
    capture: PrivateCaptureV2,
  ): Promise<readonly DanceFence[]>;
}
type Resource = Pick<
  PrivateCaptureV2,
  | "communityId"
  | "songKey"
  | "songRevision"
  | "audioSha256"
  | "reference"
  | "offer"
>;
function target(c: Resource): DanceProductionTarget {
  return {
    communityId: c.communityId,
    songKey: c.songKey,
    songRevision: c.songRevision,
    audioSha256: c.audioSha256,
    reference: c.reference
      ? { id: c.reference.id, revision: c.reference.revision }
      : null,
    offerId: c.offer?.offerId ?? null,
  };
}
function resourceFences(fences: readonly DanceFence[]) {
  insist(
    Array.isArray(fences) && fences.length > 0,
    "dance_capture_resource_fences_missing",
    503,
  );
  // Preserve the producer's actual fence objects/composition metadata.
  return fences.map(validateFence);
}
function privateCapture(c: DanceCaptureV2): c is PrivateCaptureV2 {
  return c.publication.kind === "private" && c.canonical === null;
}
function freshCaptureId(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytes32(
    "0x" +
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

/** Plain private practice only. Durable command replay precedes selection and
 * allocation. Reservation and trusted media consent are separate real Store
 * transactions; a lost acknowledgement never creates a replacement intent. */
export class DancePrivateCaptureService {
  private readonly store: DanceStore;
  private readonly session: DancePrivateRequestSession;
  private readonly catalogue: DancePrivateCaptureCatalogue;
  private readonly communityId: Hex;

  constructor(input: {
    db: D1Database;
    session: DancePrivateRequestSession;
    catalogue: DancePrivateCaptureCatalogue;
    communityId: string;
  }) {
    insist(
      input.session instanceof DancePrivateRequestSession,
      "dance_private_session_required",
      409,
    );
    this.store = new DanceStore(input.db);
    this.session = input.session;
    this.catalogue = input.catalogue;
    this.communityId = bytes32(input.communityId);
  }
  private async observed<T>(operation: Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await operation;
    } catch (error) {
      await this.session.check();
      throw error;
    }
    await this.session.check();
    return result;
  }
  private owned(
    value: StoredDanceCapture,
    requireConsent = false,
  ): PrivateCaptureV2 {
    const actor = this.session.actor;
    insist(
      value.version === "pirate.dance/2",
      "dance_private_capture_version_unavailable",
      409,
    );
    const capture = parseDanceCaptureV2(value, requireConsent);
    insist(
      capture.communityId === this.communityId &&
        capture.learner.accountId === actor.accountId &&
        capture.learner.wallet === actor.wallet,
      "dance_not_found",
      404,
    );
    insist(
      privateCapture(capture),
      "dance_publication_capture_unavailable",
      503,
    );
    return capture;
  }
  private async complete(
    value: StoredDanceCapture,
    request: CaptureRequestV2,
    selectedFences: readonly DanceFence[] = [],
  ): Promise<PrivateCaptureV2> {
    const capture = this.owned(value);
    insist(
      sameDanceTarget(target(capture), request.target),
      "dance_capture_binding_mismatch",
      409,
    );
    if (capture.consent) validateConsent(request.consent, capture.consent);
    insist(
      request.consent.termsHash === capture.termsHash,
      "dance_consent_binding_mismatch",
      409,
    );
    const current = resourceFences(
      await this.observed(this.catalogue.current(this.session.actor, capture)),
    );
    const accepted = await this.observed(
      this.store.acceptConsentV2(capture, request.consent, request.commandId, [
        ...this.session.fences,
        ...selectedFences,
        ...current,
      ]),
    );
    // Final private access rechecks the committed original and current resource;
    // an unknown consent acknowledgement is recovered on the next exact replay.
    return this.access(accepted.captureId);
  }

  async capture(value: CaptureRequestV2): Promise<PrivateCaptureV2> {
    const request = parseCaptureRequestV2(value);
    await this.session.check();
    insist(
      request.publication.kind === "private",
      "dance_publication_capture_unavailable",
      503,
    );
    insist(
      request.target.communityId === this.communityId,
      "dance_not_found",
      404,
    );
    const actor = this.session.actor,
      hash = DanceStore.request("capture-v2", request);
    const prior = await this.observed(
      this.store.findStoredCapture(
        this.communityId,
        actor.accountId,
        request.commandId,
        hash,
      ),
    );
    if (prior) return this.complete(prior, request);
    const admitted = await this.observed(
      this.catalogue.select(actor, request.target),
    );
    const selected = structuredClone(admitted.capture),
      policy = structuredClone(admitted.consentPolicy);
    const fences = resourceFences(admitted.fences);
    insist(policy.admission === "admitted", "dance_terms_admission_held", 409);
    validateConsent(request.consent, policy);
    insist(
      selected.communityId === this.communityId &&
        selected.learner.accountId === actor.accountId &&
        selected.learner.wallet === actor.wallet &&
        sameDanceTarget(target(selected), request.target),
      "dance_capture_binding_mismatch",
      409,
    );
    for (const key of ["captureId", "captureHash", "consent", "reservedAtMs"])
      insist(
        !Object.hasOwn(selected, key),
        "dance_capture_binding_mismatch",
        409,
      );
    const reservedAtMs = await this.observed(this.store.now());
    const snapshot = { ...selected, captureId: freshCaptureId(), reservedAtMs };
    const candidate = parseDanceCaptureV2(
      {
        ...snapshot,
        captureHash: hashPrivateDanceCaptureV2(snapshot),
        consent: null,
      },
      false,
    );
    insist(
      privateCapture(candidate),
      "dance_publication_capture_unavailable",
      503,
    );
    try {
      await this.observed(
        this.store.reserveCaptureV2(
          candidate,
          actor.accountId,
          request.commandId,
          hash,
          [...this.session.fences, ...fences],
          { kind: "private" },
        ),
      );
    } catch (error) {
      // Only reconcile this original reservation. A unique-key race or lost
      // response cannot fall through to another select, ID or reservation.
      await this.session.check();
      const saved = await this.observed(
        this.store.findStoredCapture(
          this.communityId,
          actor.accountId,
          request.commandId,
          hash,
        ),
      );
      if (saved) return this.complete(saved, request);
      throw error;
    }
    return this.complete(candidate, request, fences);
  }

  async access(captureId: string): Promise<PrivateCaptureV2> {
    bytes32(captureId);
    await this.session.check();
    const capture = this.owned(
      await this.observed(this.store.storedCapture(captureId)),
      true,
    );
    const now = await this.observed(this.store.now());
    insist(now < capture.expiresAtMs, "dance_capture_expired", 410);
    const current = resourceFences(
      await this.observed(this.catalogue.current(this.session.actor, capture)),
    );
    await this.observed(
      this.store.assert([
        ...this.session.fences,
        ...current,
        {
          sql: `EXISTS(SELECT 1 FROM dance_captures c JOIN dance_consents s ON s.capture_id=c.capture_id
        WHERE c.capture_id=? AND c.community_id=? AND c.account_id=? AND c.capture_json=? AND s.consent_json=?
          AND json_extract(c.capture_json,'$.expiresAtMs')>${DANCE_DB_NOW})`,
          values: [
            capture.captureId,
            this.communityId,
            this.session.actor.accountId,
            JSON.stringify({ ...capture, consent: null }),
            JSON.stringify(capture.consent),
          ],
        },
      ]),
    );
    return capture;
  }
}
