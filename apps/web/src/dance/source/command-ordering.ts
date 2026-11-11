import type { DanceCapture } from "../../../../../packages/dance/contracts.ts";
import {
  hasDanceExpiredOutcome,
  sameOriginalCommand,
  type DanceJournalEntry,
} from "../journal.ts";
import type { DanceJourneyHandle } from "./journey-store.ts";
import { verdictDigest } from "./digests.ts";
import {
  assertCapture,
  danceTargetKey,
  type DanceSourcePorts,
} from "./ports.ts";
import type { DanceResult } from "./dance-review-api.ts";

export class DanceOriginalHeldError extends Error {
  readonly original: DanceJournalEntry;
  constructor(original: DanceJournalEntry, cause?: unknown) {
    super("dance_other_original_pending", { cause });
    this.original = structuredClone(original);
  }
}
export function originalHoldCopy(error: unknown): string | null {
  if (
    error instanceof Error &&
    error.message.startsWith("dance_legacy_original_missing")
  )
    return "This saved request is missing its original command details. It remains held; no replacement recording was started.";
  if (!(error instanceof DanceOriginalHeldError)) return null;
  const e = error.original;
  let id = e.commandId;
  try {
    id =
      commandReviewId(e) ??
      (e.receiptJson
        ? (JSON.parse(e.receiptJson) as { captureId?: string }).captureId
        : undefined) ??
      id;
  } catch {
    /* Malformed legacy metadata remains held under its known UUID. */
  }
  return `Original recording request ${id} still needs confirmation. Return to its song and revision to resume it before starting another recording.`;
}

export function resultReviewId(result: DanceResult): string {
  return result.kind === "review"
    ? result.review.reviewId
    : result.kind === "local_recording"
      ? result.capture.captureId
      : result.receipt.reviewId;
}
export function assertRequestedReview(result: DanceResult, reviewId?: string) {
  if (reviewId && resultReviewId(result) !== reviewId)
    throw Error("dance_review_route_mismatch");
}
export function commandReviewId(e: DanceJournalEntry): string | null {
  if (e.path === "reviews")
    return (JSON.parse(e.bodyJson) as { captureId?: string }).captureId ?? null;
  const match = /^reviews\/([^/]+)\/(withdraw|verdict)$/.exec(e.path);
  return match ? decodeURIComponent(match[1]!) : null;
}
export function assertCommandTarget(
  e: DanceJournalEntry,
  options: DanceSourcePorts,
) {
  if (
    e.scope.accountId !== options.scope.accountId ||
    e.scope.communityId !== options.scope.communityId
  )
    throw Error("dance_account_changed");
  if (e.targetKey !== danceTargetKey(options.scope) || !e.requestJson)
    throw new DanceOriginalHeldError(e);
}
export function assertCaptureCommand(
  e: DanceJournalEntry,
  options: DanceSourcePorts,
) {
  assertCommandTarget(e, options);
  const b = JSON.parse(e.bodyJson),
    p = options.consent;
  if (
    e.path !== "captures" ||
    e.subject !== "capture" ||
    b.songKey !== options.scope.songKey ||
    b.offerId !== options.scope.offerId ||
    b.referenceId !== (options.scope.reference?.id ?? null) ||
    b.consent?.accepted !== true ||
    b.consent.version !== p.version ||
    b.consent.termsHash !== p.termsHash ||
    b.consent.publicityPolicyHash !== p.publicityPolicyHash
  )
    throw Error("dance_original_command_changed");
}
export function requireCommandPorts(options: DanceSourcePorts) {
  const c = options.client;
  if (
    !c.prepareCapture ||
    !c.prepareSubmission ||
    !c.dispatchPrepared ||
    !c.command ||
    !c.acceptedCapture ||
    !c.releaseCompletedCapture
  )
    throw Error("dance_preparation_port_unavailable");
  return c as typeof c &
    Required<
      Pick<
        typeof c,
        | "prepareCapture"
        | "prepareSubmission"
        | "dispatchPrepared"
        | "command"
        | "acceptedCapture"
        | "releaseCompletedCapture"
      >
    >;
}
export function acceptedCaptureMatches(
  e: DanceJournalEntry,
  options: DanceSourcePorts,
): DanceCapture | null {
  if (!e.receiptJson || e.path !== "captures") return null;
  const c = JSON.parse(e.receiptJson) as DanceCapture;
  try {
    assertCapture(c, options.scope);
    return c;
  } catch {
    return null;
  }
}

/** An outcome is recovered from the exact durable original, never from a
 * thrown transport error, a local deadline or a new command candidate. */
async function expiredOriginal(
  options: DanceSourcePorts,
  command: DanceJournalEntry,
  guard: () => void,
) {
  const client = requireCommandPorts(options);
  const stored = await client.command(command.commandId);
  guard();
  if (!stored || !sameOriginalCommand(stored, command))
    throw Error("dance_original_command_changed");
  if (!hasDanceExpiredOutcome(stored)) return null;
  if (
    stored.scope.accountId !== options.scope.accountId ||
    stored.scope.communityId !== options.scope.communityId
  )
    throw Error("dance_account_changed");
  if (stored.targetKey) assertCommandTarget(stored, options);
  return stored;
}
export async function reconcileSubmissionExpiry(
  options: DanceSourcePorts,
  command: DanceJournalEntry,
  guard: () => void,
  held?: DanceJourneyHandle,
): Promise<boolean> {
  const stored = await expiredOriginal(options, command, guard);
  if (!stored) return false;
  if (stored.path !== "reviews") throw Error("dance_original_command_changed");
  const use = async (handle: DanceJourneyHandle) => {
    guard();
    const entry = handle.read(),
      body = JSON.parse(stored.bodyJson);
    if (
      !entry.capture ||
      !entry.upload ||
      entry.captureUnknown ||
      entry.submission === "accepted" ||
      entry.terminal === "canceled" ||
      body.captureId !== entry.capture.captureId ||
      body.mediaId !== entry.upload.mediaId ||
      body.recordingSha256 !== verdictDigest(entry.upload.recordingSha256) ||
      (entry.commands?.submit &&
        !sameOriginalCommand(entry.commands.submit, stored))
    )
      throw Error("dance_original_command_changed");
    assertCapture(entry.capture, options.scope);
    if (
      entry.submission === "none" &&
      entry.terminal === "expired" &&
      (!entry.commands?.submit || hasDanceExpiredOutcome(entry.commands.submit))
    )
      return true;
    await handle.save({
      submission: "none",
      terminal: "expired",
      // Historical commands can retain their original pre-metadata shape.
      // Their durable outcome stays in the command journal; never manufacture
      // targetKey/requestJson just to fit the prepared-command copy codec.
      commands:
        stored.targetKey && stored.requestJson
          ? { ...entry.commands, submit: stored }
          : entry.commands,
    });
    guard();
    return true;
  };
  return held
    ? use(held)
    : options.journal.exclusive(options.scope, guard, use);
}
/** Capture refusal has no accepted capture to invent. Keep the original in
 * command history; clear only the matching local pending reservation. */
export async function reconcileCaptureExpiry(
  options: DanceSourcePorts,
  command: DanceJournalEntry,
  guard: () => void,
  handle: DanceJourneyHandle,
): Promise<boolean> {
  const stored = await expiredOriginal(options, command, guard);
  if (!stored) return false;
  assertCaptureCommand(stored, options);
  const entry = handle.read();
  if (
    entry.capture ||
    entry.upload ||
    entry.submission !== "none" ||
    (entry.commands?.capture &&
      !sameOriginalCommand(entry.commands.capture, stored))
  )
    throw Error("dance_original_command_changed");
  if (entry.captureUnknown || entry.commands)
    await handle.save({ captureUnknown: false, commands: undefined });
  guard();
  await options.client.acknowledgeRecovery(stored.commandId);
  guard();
  return true;
}
