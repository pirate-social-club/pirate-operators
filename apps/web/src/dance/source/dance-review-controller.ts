// c7 review controller's original outstanding-command/observe/act separation.
// Commands are delegated to the already admitted durable Dance client journal;
// visibility/publication is deliberately absent while owner policy is held.
import type { DanceReceipt } from "../../../../../packages/dance/contracts.ts";
import { DanceClientError } from "../client.ts";
import { verdictDigest } from "./digests.ts";
import { assertCurrent, type DanceSourcePorts } from "./ports.ts";
import { danceSession } from "./dance-preparation-api.ts";
import { validateDanceMedia } from "./dance-upload-controller.ts";
import {
  assertDanceReview,
  danceReviewEditable,
  type DanceResult,
} from "./dance-review-api.ts";

export interface DanceReviewView {
  readonly result: DanceResult;
  readonly receipt: DanceReceipt | null;
}
export type DanceReviewIntent = { readonly operation: "submit" | "withdraw" };
export function createDanceReviewController(
  options: DanceSourcePorts & { readonly reviewId?: string },
) {
  let disposed = false;
  const guardFor = (signal: AbortSignal) => () => {
    assertCurrent(options, signal);
    if (disposed) throw Error("dance_review_scope_changed");
  };
  const peek = async (guard: () => void) => {
    if (!options.client.retained || !options.client.observe)
      throw Error("dance_source_client_port_unavailable");
    const value = await options.client.retained();
    guard();
    return value;
  };
  const read = async (signal: AbortSignal): Promise<DanceReviewView> => {
    const guard = guardFor(signal);
    guard();
    const entry = await options.journal.read(options.scope, guard);
    guard();
    const capture = entry.capture;
    if (!capture) {
      if (!options.reviewId || !options.client.observe)
        throw Error("dance_original_command_missing");
      const review = await options.client.observe(options.reviewId, signal);
      guard();
      assertDanceReview(review, options.scope);
      if (review.reviewId !== options.reviewId)
        throw Error("dance_result_target_mismatch");
      return {
        result: { kind: "review", state: review.state, review },
        receipt: null,
      };
    }
    if (entry.submission === "none") {
      if (!entry.upload?.mediaId) throw Error("dance_original_command_missing");
      await options.captureAccess(capture, signal);
      guard();
      const status = await options.media.status(
        capture,
        entry.upload.mediaId,
        signal,
      );
      guard();
      validateDanceMedia(
        status,
        danceSession(capture, options.media.maximumBytes),
        entry.upload.recordingSha256,
        entry.upload.mediaId,
      );
      if (!status.ready || status.state !== "ready")
        throw Error("dance_recording_not_ready");
      return {
        result: {
          kind: "local_recording",
          state: "uploaded",
          capture,
          media: status.ready,
        },
        receipt: null,
      };
    }
    if (!options.client.observe)
      throw Error("dance_source_client_port_unavailable");
    const review = await options.client.observe(capture.captureId, signal);
    guard();
    assertDanceReview(review, options.scope, capture);
    return {
      result: { kind: "review", state: review.state, review },
      receipt: null,
    };
  };
  const recover = async (signal: AbortSignal): Promise<DanceReviewView> => {
    const guard = guardFor(signal);
    guard();
    const recovered = await options.client.recover(signal);
    guard();
    if (recovered?.subject.startsWith("withdraw:") && recovered.receiptJson) {
      const receipt = JSON.parse(recovered.receiptJson) as DanceReceipt;
      return {
        result: { kind: "receipt", state: receipt.state, receipt },
        receipt,
      };
    }
    const view = await read(signal);
    guard();
    if (view.result.kind === "review")
      await options.journal.exclusive(options.scope, guard, async (h) => {
        if (h.read().submission === "unknown")
          await h.save({ submission: "accepted" });
      });
    guard();
    return view;
  };
  return {
    hasOutstanding: async (signal: AbortSignal) => {
      const guard = guardFor(signal);
      guard();
      const p = await peek(guard);
      const entry = await options.journal.read(options.scope, guard);
      guard();
      return !!(p && !p.receiptJson) || entry.submission === "unknown";
    },
    observe: read,
    load: recover,
    async act(
      expected: DanceResult,
      intent: DanceReviewIntent,
      signal: AbortSignal,
    ): Promise<DanceReviewView> {
      const guard = guardFor(signal);
      guard();
      // Original intent recovery always precedes a different/opposite action.
      const outstanding = await peek(guard);
      if (outstanding && !outstanding.receiptJson) return recover(signal);
      return options.journal.exclusive(options.scope, guard, async (handle) => {
        const entry = handle.read();
        if (entry.submission === "unknown")
          throw Error("dance_response_unknown");
        const view = await read(signal);
        guard();
        if (
          !danceReviewEditable(view.result) ||
          JSON.stringify(view.result) !== JSON.stringify(expected)
        )
          throw Error("dance_review_changed");
        if (intent.operation === "submit") {
          if (
            view.result.kind !== "local_recording" ||
            !entry.upload ||
            !entry.capture
          )
            throw Error("dance_review_closed");
          await handle.save({ submission: "unknown" });
          guard();
          let receipt: DanceReceipt;
          try {
            receipt = await options.client.submit(
              entry.capture.captureId,
              view.result.media.id,
              verdictDigest(entry.upload.recordingSha256),
              signal,
            );
            guard();
          } catch (error) {
            guard();
            if (
              error instanceof DanceClientError &&
              error.status === 410 &&
              error.code === "dance_capture_expired"
            ) {
              await handle.save({ submission: "none", terminal: "expired" });
              guard();
            }
            throw error;
          }
          const current = await read(signal);
          guard();
          if (
            current.result.kind !== "review" ||
            receipt.reviewId !== current.result.review.reviewId
          )
            throw Error("dance_response_unknown");
          await handle.save({ submission: "accepted" });
          guard();
          await options.client.acknowledgeRecovery();
          guard();
          return { ...current, receipt };
        }
        if (view.result.kind !== "review") throw Error("dance_review_closed");
        const receipt = await options.client.withdraw(
          view.result.review.reviewId,
          view.result.review.revision,
          signal,
        );
        guard();
        // A real immutable receipt is retained separately from canonical truth.
        // No follow-up private read is required after the local access denial.
        return {
          result: { kind: "receipt", state: receipt.state, receipt },
          receipt,
        };
      });
    },
    dispose: () => {
      disposed = true;
    },
  };
}
