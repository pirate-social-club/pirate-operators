import { keccak256, stringToHex } from "viem";
import { canonical, check } from "../packages/protocol/index.ts";
import { publicationConsentAbi } from "../packages/protocol/generated/publication-consent-v1.ts";
import type { PublicationPurpose } from "../packages/protocol/publication-consent.ts";
import type {
  CanonicalObservationV1,
  ConsentSourceV1,
  CurrentGrantStateV1,
} from "../packages/protocol/publication-runtime-v1.ts";
import { parseCommand } from "./publication-command-contract.ts";
import { ownedCommand, type CommandRow } from "./publication-command-store.ts";
import {
  publicationOriginal,
  PublicationRequestSession,
} from "./publication-app-request.ts";
import { publicationObservation } from "./publication-app-journal.ts";
import { parsePublicationReceipt } from "./publication-app-transport.ts";
import { reconcilePublicationOriginal } from "./publication-app-outbox.ts";
import { publicationPolicyRead } from "./publication-app-policy.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";
import {
  completeRecordedPublicationHead,
  publicationActivationHead,
  publicationOriginalFingerprint,
} from "./publication-app-activation.ts";

type DeniedReason = Extract<CurrentGrantStateV1, { state: "denied" }>["reason"];
/** Closed read projection. It has neither an action binding nor a boundAtS. */
export type PublicationCurrentObservationV1 =
  | {
      state: "allowed";
      grantId: `0x${string}`;
      purpose: PublicationPurpose;
      source: ConsentSourceV1;
      observed: CanonicalObservationV1;
      use: "observation-only";
    }
  | { state: "denied"; reason: DeniedReason; observed?: CanonicalObservationV1 }
  | {
      state: "unavailable";
      reason:
        | "publication_original_not_recorded"
        | "publication_current_state_unavailable";
    };
// ICommunityPublicationConsentV1.Denial, exact declared uint8 ordinal order.
const CONTRACT_DENIALS: readonly (DeniedReason | null)[] = [
  null,
  "unknown_grant",
  "wrong_scope",
  "inactive_registry",
  "superseded_descriptor",
  "changed_target_code",
  "withdrawn",
  "not_effective",
  "expired",
];
function contractDenial(allowed: boolean, reason: number): DeniedReason | null {
  check(
    Number.isInteger(reason) &&
      reason >= 0 &&
      reason < CONTRACT_DENIALS.length &&
      allowed === (reason === 0),
    "publication_denial_invalid",
  );
  const value = CONTRACT_DENIALS[reason];
  check(value !== undefined, "publication_denial_invalid");
  return value;
}

/** Current observation and exact-generation local completion of an already
 * recorded consent, never an action binding or admission capability. Effects
 * must retain and recheck their own actual original accepting rows. */
export async function publicationCurrentState(
  p: PublicationApplicationPorts,
  input: CommandRow,
  session: PublicationRequestSession,
): Promise<PublicationCurrentObservationV1> {
  try {
    check(
      session instanceof PublicationRequestSession && session.db === p.db,
      "publication_request_session_required",
    );
    const owner = {
      communityId: session.context.communityId,
      accountId: session.original.account_id,
    };
    const clock = { ...p.clock };
    let row = await ownedCommand(p.db, input.command_id, owner);
    await session.check();
    const original = publicationOriginal(row, p.catalog);
    if (row.action !== "grant" || !row.typed_json || row.phase !== "accepted")
      return {
        state: "unavailable",
        reason: "publication_original_not_recorded",
      };
    // Canonical ORIGINAL receipt is resolved before current usability; a
    // changed active profile cannot redirect or manufacture its success.
    row = await reconcilePublicationOriginal(p, row);
    await session.check();
    const command = parseCommand(JSON.parse(row.typed_json!));
    const observed = await publicationObservation(p.db, row);
    await session.check();
    const receipt = observed
      ? parsePublicationReceipt(observed, command)
      : null;
    // Same-account historical receipt access survives wallet/binding changes.
    // Current usability belongs to the actual current learner AND binding.
    const current = session.original,
      capture = original.capture;
    if (
      current.account_id !== capture.accountId ||
      current.binding_id !== capture.bindingId ||
      current.author_id !== capture.authorId ||
      current.wallet.toLowerCase() !== capture.learner
    )
      return { state: "denied", reason: "wrong_scope" };
    if (receipt?.state !== "recorded")
      return {
        state: "unavailable",
        reason: "publication_original_not_recorded",
      };
    const head = await publicationActivationHead(p.db, row);
    await session.check();
    if (
      head.pending ||
      String(head.generation) !== command.localFenceGeneration
    )
      return { state: "denied", reason: "local_withdrawal" };
    if (p.catalog.active !== original.source.releaseSelectionSha256)
      return { state: "denied", reason: "inactive_registry" };
    check(
      command.action === "grant" &&
        command.commandId === row.command_id &&
        command.message.learner === capture.learner &&
        command.message.purpose === row.purpose &&
        command.message.nonce === row.nonce_hex,
      "publication_original_changed",
    );
    const fingerprint = publicationOriginalFingerprint(row);
    const local = async (stopped = head.stopped) => {
      await session.check();
      session.assertOriginal(capture);
      check(
        p.catalog.active === original.source.releaseSelectionSha256 &&
          original.release.configuration.app.origin ===
            session.context.origin &&
          p.clock.now === clock.now &&
          p.clock.maxSafeBlockAgeSeconds === clock.maxSafeBlockAgeSeconds,
        "publication_active_release_changed",
      );
      const latest = await ownedCommand(p.db, row.command_id, owner);
      await session.check();
      check(
        publicationOriginalFingerprint(latest) === fingerprint,
        "publication_recorded_original_changed",
      );
      row = latest;
      const h = await publicationActivationHead(p.db, row);
      await session.check();
      check(
        h.generation === head.generation &&
          h.stopped === stopped &&
          !h.pending &&
          h.stop_command_id === head.stop_command_id,
        "publication_local_changed",
      );
    };
    await local();
    const proof = await publicationPolicyRead({
      client: p.client,
      release: original.release,
      learner: capture.learner,
      purpose: command.message.purpose,
      mode: "grant",
      clock,
      session,
    });
    await local();
    const r = {
      address: original.source.registry,
      abi: publicationConsentAbi,
      ...proof.at,
    } as const;
    const [[grant, recordedAt], [allowed, reason]] = await Promise.all([
      p.client.readContract({
        ...r,
        functionName: "grantOf",
        args: [command.digest],
      }),
      p.client.readContract({
        ...r,
        functionName: "checkGrant",
        args: [
          command.digest,
          original.capture.learner,
          keccak256(stringToHex(command.message.purpose)),
          command.message.publicationTarget,
          command.message.policyHash,
          proof.anchor.timestamp,
        ],
      }),
    ]);
    await local();
    check(
      proof.anchor.number >= BigInt(receipt.observed.blockNumber) &&
        proof.anchor.timestamp >= BigInt(receipt.observed.timestampS),
      "publication_observation_pending",
    );
    const observedAt: CanonicalObservationV1 = {
      blockNumber: String(proof.anchor.number),
      blockHash: proof.anchor.hash,
      timestampS: String(proof.anchor.timestamp),
    };
    const finish = async (stopped = head.stopped) => {
      // The earlier original reconciliation and today's safe anchor must not
      // disagree about the original receipt's canonical branch after a reorg.
      const [block] = await Promise.all([
        p.client.getBlock({
          blockNumber: BigInt(receipt.observed.blockNumber),
          includeTransactions: false,
        }),
        proof.finish(),
      ]);
      await local(stopped);
      check(
        block.number === BigInt(receipt.observed.blockNumber) &&
          block.hash === receipt.observed.blockHash &&
          block.timestamp === BigInt(receipt.observed.timestampS) &&
          (block.number !== proof.anchor.number ||
            block.hash === proof.anchor.hash),
        "publication_original_receipt_reorg",
      );
    };
    const denied = async (
      reason: DeniedReason,
    ): Promise<PublicationCurrentObservationV1> => {
      await finish();
      return { state: "denied", reason, observed: observedAt };
    };
    const denial = contractDenial(allowed, reason);
    if (denial !== null) return await denied(denial);
    const wire = {
      ...grant,
      learner: grant.learner.toLowerCase(),
      publicationTarget: grant.publicationTarget.toLowerCase(),
      permissionRevision: String(grant.permissionRevision),
      withdrawalEpoch: String(grant.withdrawalEpoch),
      issuedAt: String(grant.issuedAt),
      validAfter: String(grant.validAfter),
      expiresAt: String(grant.expiresAt),
      submitBefore: String(grant.submitBefore),
    };
    check(
      canonical(wire) === canonical(command.message) &&
        recordedAt === BigInt(receipt.observed.timestampS),
      "publication_original_changed",
    );
    const descriptor = proof.descriptor;
    check(descriptor, "publication_descriptor_changed");
    if (
      grant.permissionRevision !== BigInt(descriptor.permissionRevision) ||
      grant.publicationTarget.toLowerCase() !== descriptor.target ||
      grant.publicationTargetRuntimeHash !== descriptor.runtimeHash ||
      grant.policyHash !== descriptor.policyHash
    )
      return await denied("superseded_descriptor");
    if (grant.withdrawalEpoch !== proof.epoch) return await denied("withdrawn");
    if (clock.now() >= grant.expiresAt) return await denied("expired");
    await finish();
    const validFromS =
      grant.validAfter > proof.anchor.timestamp
        ? grant.validAfter
        : proof.anchor.timestamp;
    const safeUntil =
      proof.anchor.timestamp + clock.maxSafeBlockAgeSeconds + 1n;
    const validUntilS =
      grant.expiresAt < safeUntil ? grant.expiresAt : safeUntil;
    await completeRecordedPublicationHead(
      p,
      { row, command, receipt, head, validFromS, validUntilS },
      session,
    );
    await finish(0);
    return {
      state: "allowed",
      grantId: command.digest,
      purpose: command.message.purpose,
      source: original.source,
      observed: observedAt,
      use: "observation-only",
    };
  } catch {
    // No unavailable observation can silently become fresh signing or private
    // practice admission. The owned original remains independently readable.
    return {
      state: "unavailable",
      reason: "publication_current_state_unavailable",
    };
  }
}
