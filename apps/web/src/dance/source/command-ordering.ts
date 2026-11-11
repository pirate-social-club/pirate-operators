import type { DanceCapture } from "../../../../../packages/dance/contracts.ts";
import type { DanceJournalEntry } from "../journal.ts";
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
