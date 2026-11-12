// Original c7 explicit resume/observation split and retain-before-reservation
// ordering, on the one admitted private media producer rather than central PUTs.
import type { MediaStatus } from "../../../../../packages/community-media/contracts.ts";
import type { DanceSession } from "./dance-preparation-api.ts";
import {
  assertCapture,
  assertCurrent,
  type DanceSourcePorts,
} from "./ports.ts";
import type { createDanceRecordingController } from "./dance-recording.ts";
import { producerDigest } from "./digests.ts";

export type DanceUploadView = {
  readonly kind:
    | "missing_recording"
    | "original_command_missing"
    | "processing"
    | "reconciling"
    | "unavailable"
    | "review"
    | "terminal"
    | "expired";
  readonly session: DanceSession;
};
export function validateDanceMedia(
  status: MediaStatus,
  session: DanceSession,
  sha256: string,
  id?: string,
) {
  const c = session.capture,
    r = status.ready;
  if (
    !status.id ||
    (id && status.id !== id) ||
    status.purpose !== "private-review" ||
    !Number.isSafeInteger(status.expiresAt) ||
    (status.state === "ready") !== !!r ||
    (r &&
      (r.id !== status.id ||
        r.purpose !== "private-review" ||
        r.accountId !== c.learner.accountId ||
        r.communityId !== c.communityId ||
        r.songKey !== c.songKey ||
        r.songRevision !== c.songRevision ||
        r.audioSha256 !== producerDigest(c.audioSha256) ||
        r.recordingSha256 !== sha256 ||
        r.mediaPolicyVersion !== c.mediaPolicyVersion ||
        r.startSample !== c.startSample ||
        r.durationSamples !== c.durationSamples ||
        r.rendition.durationMs !== c.durationSamples / 48))
  )
    throw Error("dance_upload_target_changed");
}
function observation(
  status: MediaStatus,
  session: DanceSession,
  time: number,
): DanceUploadView {
  if (!Number.isSafeInteger(time) || time < 0)
    throw Error("dance_upload_clock_unavailable");
  // A ready/submitted server result is never reinterpreted using upload time.
  if (status.state === "ready") return { kind: "review", session };
  if (status.state === "withdrawn" || status.state === "revoked")
    return { kind: "terminal", session };
  if (status.state === "expired" || time >= session.expires_at_ms)
    return { kind: "expired", session };
  if (["queued", "receiving", "processing"].includes(status.state))
    return { kind: "processing", session };
  if (status.state === "failed") return { kind: "unavailable", session };
  return { kind: "reconciling", session };
}
export function createDanceUploadController(
  options: DanceSourcePorts & {
    readonly recordings: Pick<
      ReturnType<typeof createDanceRecordingController>,
      "restore" | "cleanupExpired"
    >;
    readonly commandKey?: () => string;
  },
) {
  const now = options.nowMs ?? Date.now,
    commandKey = options.commandKey ?? (() => crypto.randomUUID());
  let generation = 0;
  const context = (signal: AbortSignal) => {
    const selected = ++generation;
    return () => {
      assertCurrent(options, signal);
      if (generation !== selected) throw Error("dance_upload_scope_changed");
    };
  };
  return {
    async resume(
      session: DanceSession,
      signal: AbortSignal,
    ): Promise<DanceUploadView> {
      const guard = context(signal);
      guard();
      assertCapture(session.capture, options.scope);
      await options.recordings.cleanupExpired(signal);
      guard();
      return options.journal.exclusive(options.scope, guard, async (handle) => {
        let entry = handle.read(),
          upload = entry.upload;
        if (
          !entry.capture ||
          entry.capture.captureHash !== session.capture.captureHash ||
          entry.captureUnknown
        )
          throw Error("dance_upload_preparation_changed");
        if (entry.submission !== "none") return { kind: "review", session };
        let recording: Awaited<ReturnType<typeof options.recordings.restore>> =
          null;
        if (!upload) {
          if (now() >= session.expires_at_ms)
            return { kind: "expired", session };
          recording = await options.recordings.restore(
            session.session_id,
            signal,
          );
          guard();
          if (!recording) return { kind: "missing_recording", session };
          upload = {
            requestId: commandKey(),
            recordingSha256: recording.metadata.sha256,
            bytes: recording.blob.size,
            mediaId: null,
            put: "not_started",
            status: null,
          };
          entry = await handle.save({ upload });
          guard();
        }
        const persist = async (s: MediaStatus) => {
          guard();
          validateDanceMedia(
            s,
            session,
            upload!.recordingSha256,
            upload!.mediaId ?? undefined,
          );
          const { playbackUrl: _privateUrl, ...facts } = s;
          upload = { ...upload!, mediaId: s.id, status: facts };
          entry = await handle.save({ upload });
          guard();
          return s;
        };
        let status: MediaStatus;
        if (!upload.mediaId)
          status = await persist(
            await options.media.reserve(
              session.capture,
              {
                requestId: upload.requestId,
                songKey: session.capture.songKey,
                songRevision: session.capture.songRevision,
                recordingSha256: upload.recordingSha256,
                bytes: upload.bytes,
                startSample: session.capture.startSample,
                durationSamples: session.capture.durationSamples,
                purpose: "private-review",
                publicConsent: false,
              },
              signal,
            ),
          );
        else
          status = await persist(
            await options.media.status(session.capture, upload.mediaId, signal),
          );
        guard();
        if (status.state === "failed" && status.canRetry) {
          status = await persist(
            await options.media.retry(session.capture, status.id, signal),
          );
          guard();
        }
        if (status.state !== "uploading")
          return observation(status, session, now());
        if (upload.put === "acknowledged")
          return { kind: "reconciling", session };
        if (now() >= session.expires_at_ms) return { kind: "expired", session };
        recording ??= await options.recordings.restore(
          session.session_id,
          signal,
        );
        guard();
        if (!recording) return { kind: "missing_recording", session };
        if (
          recording.metadata.sha256 !== upload.recordingSha256 ||
          recording.blob.size !== upload.bytes
        )
          throw Error("dance_upload_original_required");
        upload = { ...upload, put: "unknown" };
        await handle.save({ upload });
        guard();
        const file = new File([recording.blob], "dance-recording.mp4", {
          type: "video/mp4",
        });
        status = await persist(
          await options.media.upload(session.capture, status.id, file, signal),
        );
        guard();
        upload = { ...upload!, put: "acknowledged" };
        await handle.save({ upload });
        guard();
        return observation(status, session, now());
      });
    },
    /** Timer/foreground observation is GET-only: never reserve, PUT, retry or
     * submit, even if an upload acknowledgement was lost. */
    async observe(
      session: DanceSession,
      signal: AbortSignal,
    ): Promise<DanceUploadView> {
      const guard = () => assertCurrent(options, signal);
      guard();
      const entry = await options.journal.read(options.scope, guard);
      guard();
      if (!entry.upload?.mediaId)
        return { kind: "original_command_missing", session };
      const status = await options.media.status(
        session.capture,
        entry.upload.mediaId,
        signal,
      );
      guard();
      validateDanceMedia(
        status,
        session,
        entry.upload.recordingSha256,
        entry.upload.mediaId,
      );
      return observation(status, session, now());
    },
  };
}
