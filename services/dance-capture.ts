import { bytes32, insist, token } from "../packages/community/common.ts";
import type {
  DanceCapture,
  DanceConsentAcceptance,
  DancePorts,
  DanceSelection,
} from "../packages/dance/contracts.ts";
import type { DanceRepository } from "../packages/dance/repository.ts";
import { DanceStore } from "../packages/dance/store.ts";
import {
  danceId,
  mediaBinding,
  sameCapturedPrincipal,
  validateCapture,
  validateConsent,
  validateMedia,
} from "../packages/dance/validation.ts";
import { DancePermissions } from "./dance-authority.ts";
export class DanceCaptureService {
  readonly permissions: DancePermissions;
  readonly store: DanceRepository;
  readonly ports: DancePorts;
  readonly communityId: string;
  constructor(store: DanceRepository, ports: DancePorts, communityId: string) {
    this.store = store;
    this.ports = ports;
    this.communityId = communityId;
    bytes32(communityId);
    this.permissions = new DancePermissions(store, ports, communityId);
  }
  async capture(
    actor: string,
    commandId: string,
    selection: DanceSelection,
    acceptance: DanceConsentAcceptance,
  ): Promise<DanceCapture> {
    danceId(actor);
    danceId(commandId);
    bytes32(selection.songKey);
    const f = await this.permissions.facts(actor, actor),
      hash = DanceStore.request("capture", { selection, acceptance });
    const prior = await this.store.findCapture(
      this.communityId,
      actor,
      commandId,
      hash,
    );
    if (prior?.consent) {
      sameCapturedPrincipal(f.actor, prior.learner);
      validateConsent(acceptance, prior.consent);
      await this.store.assert([f.fence, await this.ports.authorization(prior)]);
      return prior;
    }
    const admitted = await this.ports.admitCapture(
      this.communityId,
      actor,
      selection,
    );
    insist(
      admitted.consentPolicy.admission === "admitted",
      "dance_terms_admission_held",
      409,
    );
    validateConsent(acceptance, admitted.consentPolicy);
    const complete = async (c: DanceCapture) => {
      insist(
        acceptance.termsHash === c.termsHash &&
          admitted.capture.source.policyHash === c.source.policyHash,
        "dance_consent_binding_mismatch",
        409,
      );
      const current = await this.permissions.facts(actor, actor);
      sameCapturedPrincipal(current.actor, c.learner);
      const accepted = await this.store.acceptConsent(
        c,
        acceptance,
        commandId,
        [current.fence, admitted.fence, await this.ports.authorization(c)],
      );
      validateCapture(accepted);
      return accepted;
    };
    if (prior) return complete(prior);
    const reserved = {
      ...admitted.capture,
      captureId: token(),
      reservedAtMs: await this.store.now(),
    };
    if (reserved.offer)
      insist(
        reserved.offer.offerIdCommitment ===
          (await this.ports.offerIdCommitment(
            reserved.offer.offerId,
            reserved.source,
          )),
        "dance_offer_id_commitment_mismatch",
        409,
      );
    sameCapturedPrincipal(f.actor, reserved.learner);
    insist(
      reserved.communityId === this.communityId &&
        reserved.songKey === selection.songKey &&
        (reserved.offer?.offerId ?? null) === selection.offerId &&
        (reserved.reference?.id ?? null) === selection.referenceId &&
        reserved.expected.ownerEpoch === f.owner.epoch &&
        reserved.expected.configurationRevision ===
          f.epochs.configurationRevision,
      "dance_capture_binding_mismatch",
      409,
    );
    const c: DanceCapture = {
      ...reserved,
      captureHash: bytes32(await this.ports.captureCommitment(reserved)),
      consent: null,
    };
    validateCapture(c, false);
    try {
      // Freeze IDs/context/reservedAt FIRST, then accept exact versioned consent.
      await this.store.reserveCapture(c, actor, commandId, hash, [
        f.fence,
        admitted.fence,
      ]);
      return await complete(c);
    } catch (e) {
      const recovered = await this.store.findCapture(
        this.communityId,
        actor,
        commandId,
        hash,
      );
      if (recovered) return complete(recovered);
      throw e;
    }
  }
  protected async recovery(
    actor: string,
    command: string,
    hash: string,
    reviewId: string,
  ) {
    const r = await this.store.review(reviewId),
      access = await this.permissions.read(actor, r);
    await this.store.assert(access.fences);
    return this.store.receipt(this.communityId, actor, command, hash);
  }
  async submit(
    actor: string,
    commandId: string,
    captureId: string,
    mediaId: string,
    recordingSha256: string,
  ) {
    [actor, commandId, captureId, mediaId].forEach(danceId);
    bytes32(recordingSha256);
    const c = await this.store.capture(captureId);
    insist(
      c.communityId === this.communityId && c.learner.accountId === actor,
      "dance_not_found",
      404,
    );
    const hash = DanceStore.request("submit", {
      captureId,
      mediaId,
      recordingSha256,
    });
    const prior = await this.store.receipt(
      this.communityId,
      actor,
      commandId,
      hash,
    );
    const complete = async () => {
      const result = await this.recovery(actor, commandId, hash, captureId);
      insist(result, "dance_outcome_unknown", 503);
      const review = await this.store.review(captureId);
      await this.store.ensureSubmissionOutbox(review, commandId);
      return result;
    };
    if (prior) return complete();
    const f = await this.permissions.facts(actor, actor);
    sameCapturedPrincipal(f.actor, c.learner);
    validateCapture(c);
    insist(
      (await this.store.now()) < c.expiresAtMs,
      "dance_capture_expired",
      410,
    );
    const binding = mediaBinding(c, recordingSha256);
    const ready = await this.ports.media.readyForSubmission(mediaId, binding, {
      accountId: actor,
    });
    validateMedia(binding, ready.media);
    insist(ready.media.id === mediaId, "dance_media_binding_mismatch", 409);
    this.ports.media.projectDanceMedia(ready.media, ready.witness);
    const rules = await this.ports.rules(c),
      commitment = bytes32(
        await this.ports.mediaBindingHash({
          source: c.source,
          captureHash: c.captureHash,
          mediaId,
          expectedPostRetentionGeneration: ready.witness.revision + 1,
          recordingSha256,
        }),
      );
    try {
      await this.store.acceptSubmission({
        capture: c,
        media: binding,
        witness: ready.witness,
        commandId,
        requestHash: hash,
        bindingCommitment: commitment,
        fences: [
          f.fence,
          rules,
          await this.ports.authorization(c),
          this.ports.media.commitFence(ready.witness),
        ],
        mediaPort: this.ports.media,
      });
      const result = await complete(),
        fresh = await this.ports.media.readyForSubmission(mediaId, binding, {
          accountId: actor,
        });
      this.ports.media.projectDanceSubmission(
        this.ports.media.projectDanceMedia(fresh.media, fresh.witness),
        (await this.store.review(captureId)).receipt,
      );
      return result;
    } catch (e) {
      const recovered = await this.store.receipt(
        this.communityId,
        actor,
        commandId,
        hash,
      );
      if (recovered) return complete();
      throw e;
    }
  }
}
