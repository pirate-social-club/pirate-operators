// c7 review controller's original outstanding-command/observe/act separation.
// Commands are delegated to the already admitted durable Dance client journal;
// visibility/publication is deliberately absent while owner policy is held.
import type { DanceReceipt } from "../../../../../packages/dance/contracts.ts";
import { DanceClientError } from "../client.ts";
import { sameOriginalCommand, type DanceJournalEntry } from "../journal.ts";
import { verdictDigest } from "./digests.ts";
import {
  assertCurrent,
  danceTargetKey,
  type DanceSourcePorts,
} from "./ports.ts";
import {
  assertCommandTarget,
  assertRequestedReview,
  commandReviewId,
  requireCommandPorts,
  resultReviewId,
  DanceOriginalHeldError,
  reconcileSubmissionExpiry,
} from "./command-ordering.ts";
import { createDanceRecordingController } from "./dance-recording.ts";
import { createBrowserDanceRecordingStorage } from "./dance-recording-storage.ts";
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
  let localCaptureId: string | undefined;
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
    if (options.reviewId) {
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
    if (!capture) throw Error("dance_original_command_missing");
    if (localCaptureId && localCaptureId !== capture.captureId)
      throw Error("dance_local_attempt_changed");
    localCaptureId = capture.captureId;
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
    if (review.reviewId !== capture.captureId)
      throw Error("dance_review_route_mismatch");
    return {
      result: { kind: "review", state: review.state, review },
      receipt: null,
    };
  };
  const recover = async (signal: AbortSignal): Promise<DanceReviewView> => {
    const guard = guardFor(signal);
    guard();
    const client = requireCommandPorts(options),
      entry = await options.journal.read(options.scope, guard);
    guard();
    const global = await peek(guard),
      desired = options.reviewId ?? localCaptureId ?? entry.capture?.captureId;
    if (!desired) throw Error("dance_original_command_missing");
    if (global && !global.receiptJson && commandReviewId(global) !== desired)
      throw new DanceOriginalHeldError(global);
    let recovered: DanceJournalEntry | null = null;
    const saved =
      entry.capture?.captureId === desired ? entry.commands?.submit : undefined;
    const recorded = saved ? await client.command(saved.commandId) : null;
    guard();
    if (saved && (!recorded || !sameOriginalCommand(recorded, saved)))
      throw Error("dance_original_command_changed");
    const command =
      global && commandReviewId(global) === desired && global.path !== "reviews"
        ? global
        : (recorded ?? global);
    if (
      entry.capture?.captureId === desired &&
      entry.submission === "unknown" &&
      (!command ||
        command.path !== "reviews" ||
        commandReviewId(command) !== desired)
    )
      throw Error("dance_legacy_original_missing");
    if (command && commandReviewId(command) === desired) {
      if (command.targetKey) assertCommandTarget(command, options);
      if (
        command.path === "reviews" &&
        (await reconcileSubmissionExpiry(options, command, guard))
      )
        throw new DanceClientError("dance_capture_expired", false, 410);
      if (
        command.path === "reviews" &&
        entry.capture?.captureId === desired &&
        entry.upload
      ) {
        const b = JSON.parse(command.bodyJson);
        if (
          b.captureId !== desired ||
          b.mediaId !== entry.upload.mediaId ||
          b.recordingSha256 !== verdictDigest(entry.upload.recordingSha256)
        )
          throw Error("dance_original_command_changed");
        if (command.targetKey)
          await options.journal.exclusive(options.scope, guard, async (h) => {
            await h.save({
              submission: "unknown",
              commands: { ...h.read().commands, submit: command! },
            });
          });
      }
      guard();
      try {
        if (command.targetKey) {
          await client.dispatchPrepared(command, signal);
          guard();
          recovered = await client.command(command.commandId);
          guard();
        } else {
          recovered = await options.client.recover(signal);
          guard();
        }
      } catch (error) {
        guard();
        if (
          error instanceof DanceClientError &&
          error.status === 410 &&
          error.code === "dance_capture_expired" &&
          command.path === "reviews"
        )
          await reconcileSubmissionExpiry(options, command, guard);
        throw error;
      }
    }
    if (recovered?.subject.startsWith("withdraw:") && recovered.receiptJson) {
      const receipt = JSON.parse(recovered.receiptJson) as DanceReceipt;
      if (
        receipt.reviewId !== desired ||
        receipt.commandId !== recovered.commandId
      )
        throw Error("dance_review_route_mismatch");
      return {
        result: { kind: "receipt", state: receipt.state, receipt },
        receipt,
      };
    }
    const view = await read(signal);
    guard();
    assertRequestedReview(view.result, desired);
    if (recovered?.path === "reviews") {
      const receipt = recovered.receiptJson
        ? (JSON.parse(recovered.receiptJson) as DanceReceipt)
        : null;
      if (
        !receipt ||
        receipt.commandId !== recovered.commandId ||
        receipt.reviewId !== desired ||
        view.result.kind !== "review" ||
        view.result.review.receipt.mediaId !==
          JSON.parse(recovered.bodyJson).mediaId ||
        view.result.review.media.recordingSha256 !==
          JSON.parse(recovered.bodyJson).recordingSha256
      )
        throw Error("dance_response_unknown");
    }
    if (view.result.kind === "review")
      await options.journal.exclusive(options.scope, guard, async (h) => {
        if (
          h.read().capture?.captureId === desired &&
          h.read().submission === "unknown"
        )
          await h.save({ submission: "accepted" });
      });
    guard();
    if (recovered?.path === "reviews") {
      await options.client.acknowledgeRecovery(recovered.commandId);
      guard();
    }
    return view;
  };
  return {
    async localPreview(signal: AbortSignal) {
      const guard = guardFor(signal),
        view = await read(signal);
      guard();
      if (view.result.kind !== "local_recording")
        throw Error("dance_local_preview_unavailable");
      const capture = view.result.capture;
      const recordings = createDanceRecordingController({
        ...options,
        storage:
          options.recordingStorage ??
          createBrowserDanceRecordingStorage(options.scope.accountId),
      });
      const original = await recordings.restore(capture.captureId, signal);
      guard();
      if (
        !original ||
        original.metadata.sha256 !== view.result.media.recordingSha256 ||
        original.metadata.captureHash !== capture.captureHash
      )
        throw Error("dance_local_preview_unavailable");
      await options.captureAccess(capture, signal);
      guard();
      const expiresAtMs = Math.min(
        original.metadata.expiresAtMs,
        capture.expiresAtMs,
      );
      if ((options.nowMs ?? Date.now)() >= expiresAtMs)
        throw Error("dance_local_preview_unavailable");
      return { blob: original.blob, expiresAtMs };
    },
    hasOutstanding: async (signal: AbortSignal) => {
      const guard = guardFor(signal);
      guard();
      const p = await peek(guard);
      if (
        p &&
        !p.receiptJson &&
        commandReviewId(p) !== (options.reviewId ?? localCaptureId)
      )
        throw new DanceOriginalHeldError(p);
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
      assertRequestedReview(expected, options.reviewId ?? localCaptureId);
      // Original intent recovery always precedes a different/opposite action.
      const outstanding = await peek(guard);
      if (outstanding && !outstanding.receiptJson) {
        if (commandReviewId(outstanding) !== resultReviewId(expected))
          throw new DanceOriginalHeldError(outstanding);
        return recover(signal);
      }
      return options.journal.exclusive(options.scope, guard, async (handle) => {
        const entry = handle.read();
        if (entry.submission === "unknown")
          throw Error("dance_response_unknown");
        const view = await read(signal);
        guard();
        assertRequestedReview(view.result, options.reviewId ?? localCaptureId);
        if (
          !danceReviewEditable(view.result) ||
          JSON.stringify(view.result) !== JSON.stringify(expected)
        )
          throw Error("dance_review_changed");
        if (intent.operation === "submit") {
          if (options.reviewId) throw Error("dance_review_route_mismatch");
          if (
            view.result.kind !== "local_recording" ||
            !entry.upload ||
            !entry.capture
          )
            throw Error("dance_review_closed");
          const client = requireCommandPorts(options);
          const command = await client.prepareSubmission(
            danceTargetKey(options.scope),
            entry.capture.captureId,
            view.result.media.id,
            verdictDigest(entry.upload.recordingSha256),
          );
          guard();
          assertCommandTarget(command, options);
          await handle.save({
            submission: "unknown",
            commands: { ...entry.commands, submit: command },
          });
          guard();
          let receipt: DanceReceipt;
          try {
            receipt = (await client.dispatchPrepared(
              command,
              signal,
            )) as DanceReceipt;
            guard();
          } catch (error) {
            guard();
            if (
              error instanceof DanceClientError &&
              error.status === 410 &&
              error.code === "dance_capture_expired"
            ) {
              await reconcileSubmissionExpiry(options, command, guard, handle);
              guard();
            }
            throw error;
          }
          const current = await read(signal);
          guard();
          if (
            current.result.kind !== "review" ||
            receipt.commandId !== command.commandId ||
            receipt.reviewId !== entry.capture.captureId ||
            receipt.reviewId !== current.result.review.reviewId ||
            current.result.review.receipt.mediaId !== entry.upload.mediaId ||
            current.result.review.media.recordingSha256 !==
              verdictDigest(entry.upload.recordingSha256)
          )
            throw Error("dance_response_unknown");
          await handle.save({ submission: "accepted" });
          guard();
          await options.client.acknowledgeRecovery(command.commandId);
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
        if (receipt.reviewId !== view.result.review.reviewId)
          throw Error("dance_review_route_mismatch");
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
