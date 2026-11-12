import {
  assertCapture,
  assertCurrent,
  danceTargetKey,
  type DanceSourcePorts,
} from "./ports.ts";
import { danceSession } from "./dance-preparation-api.ts";
import { openCameraPreview } from "./platform/capture.ts";
import {
  startDanceCapture,
  type DanceCaptureHandle,
  type DanceRecordedTake,
} from "./dance-capture.ts";
import {
  prepareDanceCaptureGuide,
  type DanceCaptureGuide,
} from "./dance-capture-guide.ts";
import {
  createDancePreparationController,
  type DancePreparationView,
} from "./dance-preparation-controller.ts";

import {
  createDanceRecordingController,
  danceRecordingDigest,
} from "./dance-recording.ts";
import { createBrowserDanceRecordingStorage } from "./dance-recording-storage.ts";
import {
  createDanceUploadController,
  type DanceUploadView,
} from "./dance-upload-controller.ts";

import type { DanceSession } from "./dance-preparation-api.ts";
import { producerDigest } from "./digests.ts";
import {
  claimBrowserDanceCapture,
  type DanceCaptureLease,
} from "./capture-lease.ts";

type Ready = Extract<DancePreparationView, { kind: "capture_ready" }>;
export type DanceRecorderView =
  | Exclude<DancePreparationView, Ready>
  | {
      readonly kind: "camera";
      readonly ready: Ready;
      readonly stream: MediaStream;
    }
  | { readonly kind: "recovery"; readonly session: Ready["session"] }
  | { readonly kind: "upload"; readonly upload: DanceUploadView };
export type DanceRecorderStage =
  | "preparing_audio"
  | "recording"
  | "saving"
  | "uploading";

/** Composition of consent, camera, guide, original storage and upload. A
 * gesture opens guide audio before its first await. Lost writes retain the
 * same original in memory or durable storage; recovery never auto-recaptures. */
export function createDanceRecorder(
  options: DanceSourcePorts & {
    readonly storage?: Parameters<
      typeof createDanceRecordingController
    >[0]["storage"];
    readonly openCamera?: typeof openCameraPreview;
    readonly prepareGuide?: typeof prepareDanceCaptureGuide;
    readonly capture?: typeof startDanceCapture;
    readonly claimCapture?: typeof claimBrowserDanceCapture;
  },
) {
  const scope = Object.freeze({ ...options.scope });
  const preparation = createDancePreparationController(options);
  const recordings = createDanceRecordingController({
    ...options,
    storage:
      options.storage ?? createBrowserDanceRecordingStorage(scope.accountId),
  });
  const upload = createDanceUploadController({ ...options, recordings });
  let disposed = false,
    stream: MediaStream | null = null,
    guide: DanceCaptureGuide | null = null,
    capture: DanceCaptureHandle | null = null;
  let ready: Ready | null = null,
    original: {
      readonly ready: Ready;
      readonly take: DanceRecordedTake;
    } | null = null;
  let uploadSession: string | null = null,
    busy = false;
  let lease: DanceCaptureLease | null = null;
  let leaseReleased: Promise<void> = Promise.resolve();
  const releaseLease = () => {
    if (lease) leaseReleased = lease.release();
    lease = null;
    // Cleanup may be synchronous, but a later claim must observe real release.
    void leaseReleased.catch(() => {});
    return leaseReleased;
  };
  const current = (signal: AbortSignal) => {
    assertCurrent(options, signal);
    if (disposed) throw new Error("dance_recorder_scope_changed");
  };
  const ensureLease = async (signal: AbortSignal) => {
    try {
      await leaseReleased;
      current(signal);
      if (!lease)
        lease = await (options.claimCapture ?? claimBrowserDanceCapture)(
          scope,
          () => !disposed && !!options.currentScope(),
        );
      current(signal);
      lease.assertCurrent();
    } catch (error) {
      releaseLease();
      throw error;
    }
  };
  const release = () => {
    capture?.cancel();
    capture = null;
    guide?.dispose();
    guide = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };
  const exclusive = async <T>(
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> => {
    current(signal);
    if (busy) throw new Error("dance_recorder_busy");
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  };
  const supported = (view: DancePreparationView) => {
    if (view.session) assertCapture(view.session.capture, scope);
  };
  const recoverUpload = async (
    signal: AbortSignal,
  ): Promise<DanceRecorderView> => {
    if (!uploadSession) throw new Error("dance_recorder_original_required");
    const entry = await options.journal.read(scope, () => current(signal));
    current(signal);
    if (!entry.capture || entry.capture.captureId !== uploadSession)
      throw new Error("dance_upload_preparation_changed");
    const view = await upload.resume(
      danceSession(entry.capture, options.media.maximumBytes),
      signal,
    );
    current(signal);
    return { kind: "upload", upload: view };
  };
  const saveAndUpload = async (
    signal: AbortSignal,
    stage: (value: DanceRecorderStage) => void,
  ): Promise<DanceRecorderView> => {
    current(signal);
    if (!original) return recoverUpload(signal);
    await ensureLease(signal);
    current(signal);
    stage("saving");
    await recordings.retain(original.ready, original.take, signal);
    current(signal);
    await releaseLease();
    current(signal);
    uploadSession = original.take.sessionId;
    original = null;
    ready = null;
    stage("uploading");
    return recoverUpload(signal);
  };
  const prepare = async (
    policyHash: string,
    signal: AbortSignal,
  ): Promise<DanceRecorderView> => {
    current(signal);
    await recordings.cleanupExpired(signal);
    current(signal);
    const view = await preparation.prepare(policyHash, signal);
    current(signal);
    supported(view);
    if (view.kind === "terminal" || view.kind === "expired") return view;
    const entry = await options.journal.read(scope, () => current(signal));
    current(signal);
    if (entry.capture) {
      const saved = await recordings.restore(entry.capture.captureId, signal);
      current(signal);
      if (saved) {
        uploadSession = entry.capture.captureId;
        return {
          kind: "recovery",
          session: danceSession(entry.capture, options.media.maximumBytes),
        };
      }
    }
    if (view.kind === "capture_ready")
      throw new Error("dance_recorder_state_inconsistent");
    return view;
  };
  return {
    observe: (
      expected: DanceSession,
      signal: AbortSignal,
    ): Promise<DanceRecorderView> =>
      exclusive(signal, async () => {
        const observed = await upload.observe(expected, signal);
        current(signal);
        return { kind: "upload", upload: observed };
      }),
    localPreview: (sessionId: string, signal: AbortSignal) =>
      exclusive(signal, async () => {
        const saved = await recordings.restore(sessionId, signal);
        current(signal);
        return (
          saved && { blob: saved.blob, expiresAtMs: saved.metadata.expiresAtMs }
        );
      }),
    prepare: (policyHash: string, signal: AbortSignal) =>
      exclusive(signal, () => prepare(policyHash, signal)),
    enter(
      acceptedTermsHash: string,
      signal: AbortSignal,
    ): Promise<DanceRecorderView> {
      return exclusive(signal, async () => {
        if (original || uploadSession)
          throw new Error("dance_recorder_original_required");
        const view = await preparation.start(acceptedTermsHash, signal);
        current(signal);
        supported(view);
        if (view.kind !== "capture_ready") return view;
        await options.captureAccess(view.session.capture, signal);
        current(signal);
        view.assertCurrent();
        const saved = await recordings.restore(view.session.session_id, signal);
        current(signal);
        if (saved) {
          uploadSession = view.session.session_id;
          return { kind: "recovery", session: view.session };
        }
        release();
        releaseLease();
        await ensureLease(signal);
        current(signal);
        const racedOriginal = await recordings
          .restore(view.session.session_id, signal)
          .catch((error) => {
            releaseLease();
            throw error;
          });
        current(signal);
        if (racedOriginal) {
          releaseLease();
          uploadSession = view.session.session_id;
          return { kind: "recovery", session: view.session };
        }
        const ownedView: Ready = {
          ...view,
          assertCurrent: () => {
            view.assertCurrent();
            lease?.assertCurrent();
            if (!lease) throw new Error("dance_preparation_capture_superseded");
          },
        };
        ready = ownedView;
        const opened = await (options.openCamera ?? openCameraPreview)().catch(
          (error) => {
            releaseLease();
            ready = null;
            throw error;
          },
        );
        try {
          current(signal);
          view.assertCurrent();
          stream = opened;
          guide = await (options.prepareGuide ?? prepareDanceCaptureGuide)(
            {
              context: view.context,
              signal,
              assertCurrent: () => {
                current(signal);
                view.assertCurrent();
              },
              deferActivation: true,
            },
            {
              prepareSource: async (_song, pending) => {
                const source = await options.playback.guide(
                  view.session.capture,
                  pending,
                );
                try {
                  current(signal);
                  view.assertCurrent();
                  const digest = await danceRecordingDigest(source.blob);
                  current(signal);
                  view.assertCurrent();
                  if (
                    digest !== producerDigest(view.session.capture.audioSha256)
                  )
                    throw new Error("dance_guide_target_changed");
                  return source;
                } catch (error) {
                  source.release();
                  throw error;
                }
              },
            },
          );
          await options.captureAccess(view.session.capture, signal);
          current(signal);
          view.assertCurrent();
          ownedView.assertCurrent();
          return { kind: "camera", ready: ownedView, stream: opened };
        } catch (error) {
          release();
          releaseLease();
          for (const track of opened.getTracks()) track.stop();
          ready = null;
          throw error;
        }
      });
    },
    /** Called directly from the Record gesture so resume() can unlock audio. */
    record(
      signal: AbortSignal,
      stage: (value: DanceRecorderStage) => void,
      progress: (elapsedMs: number) => void,
      preview?: (take: DanceRecordedTake, expiresAtMs: number) => void,
    ): Promise<DanceRecorderView> {
      return exclusive(signal, async () => {
        if (!ready || !stream || !guide || original || uploadSession)
          throw new Error("dance_recorder_original_required");
        const selected = ready,
          camera = stream;
        const guard = () => {
          current(signal);
          selected.assertCurrent();
        };
        guard();
        // Invoke before notifying a renderer or awaiting any network work.
        try {
          await guide.activate();
          guard();
          stage("recording");
          capture = (options.capture ?? startDanceCapture)({
            ready: selected,
            stream: camera,
            guide,
            signal,
            onProgress: (elapsedMs) => {
              guard();
              progress(elapsedMs);
            },
          });
          const take = await capture.result;
          guard();
          original = { ready: selected, take };
          preview?.(take, selected.session.expires_at_ms);
          guard();
          release();
          return await saveAndUpload(signal, stage);
        } finally {
          release();
        }
      });
    },
    recover(
      policyHash: string,
      signal: AbortSignal,
      stage: (value: DanceRecorderStage) => void,
    ): Promise<DanceRecorderView> {
      return exclusive(signal, async () => {
        current(signal);
        release();
        if (original) return saveAndUpload(signal, stage);
        if (uploadSession) {
          stage("uploading");
          return recoverUpload(signal);
        }
        const recovered = await preparation.recover(policyHash, signal);
        current(signal);
        supported(recovered);
        // Recovery cannot silently enter the camera/guide path. The separate
        // deliberate Accept operation owns conversion of capture readiness.
        if (recovered.kind === "capture_ready")
          throw new Error("dance_recorder_state_inconsistent");
        return recovered;
      });
    },
    resume(sessionId: string, signal: AbortSignal): Promise<DanceRecorderView> {
      return exclusive(signal, async () => {
        release();
        uploadSession = sessionId;
        return recoverUpload(signal);
      });
    },
    newAttempt(
      policyHash: string,
      signal: AbortSignal,
    ): Promise<DanceRecorderView> {
      return exclusive(signal, async () => {
        release();
        releaseLease();
        await preparation.closeTerminal(signal);
        current(signal);
        original = null;
        uploadSession = null;
        ready = null;
        return prepare(policyHash, signal);
      });
    },
    async cancelBeforeTake(signal: AbortSignal) {
      if (busy || original || uploadSession) return;
      release();
      releaseLease();
      ready = null;
      await preparation.cancelBeforeTake(signal);
    },
    pause() {
      release();
      releaseLease();
      ready = null;
    },
    dispose() {
      disposed = true;
      release();
      releaseLease();
      ready = null;
      original = null;
    },
  };
}
