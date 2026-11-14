/** Story-only simulated ports, adapted from c7 dance-camera.fixtures/stories.
 * Uses a canvas camera and immutable encoded local fixture, never a provider.
 * Production services do not import this module. */
import { DanceSongPage } from "../src/dance/source/dance-song-page.tsx";
import type {
  createDanceRecorder,
  DanceRecorderView,
} from "../src/dance/source/dance-recorder.ts";
import { danceSession } from "../src/dance/source/dance-preparation-api.ts";
import { VideoCaptureError } from "../src/dance/source/platform/capture-failure.ts";
import { DanceClientError } from "../src/dance/client.ts";
import {
  captureFixture,
  consent,
  hash,
  sha,
  mediaFixture,
  reviewFixture,
  simulatedSource,
  scope,
} from "./dance-source-fixtures.ts";
export type DanceStoryMode =
  | "desktop"
  | "camera"
  | "saved"
  | "pending"
  | "owner"
  | "permission"
  | "slow"
  | "offline"
  | "unknown"
  | "denied_after_load"
  | "loading"
  | "anonymous"
  | "error"
  | "held";
const fixtureUrl = new URL(
  "./dance-fixtures/paper-neutral-avc-aac.mp4",
  import.meta.url,
).href;
export function DanceStory(props: { mode: DanceStoryMode }) {
  const f = simulatedSource();
  Object.assign(f.c, captureFixture(Date.now()));
  f.setStatus(mediaFixture(f.c));
  f.setReview(reviewFixture(f.c));
  let account = props.mode === "anonymous" ? null : scope,
    refused = false,
    observations = 0,
    submitted = false;
  const listeners = new Set<() => void>();
  const recorder: typeof createDanceRecorder = (options) => {
    const session = danceSession(f.c, options.media.maximumBytes),
      ready = {
        kind: "capture_ready" as const,
        session,
        context: {
          session,
          reference: {
            canonical_song_start_ms: f.c.startSample / 48,
            canonical_song_end_ms: (f.c.startSample + f.c.durationSamples) / 48,
          },
        },
        assertCurrent: () => {},
      };
    let stream: MediaStream | undefined;
    const camera = (): DanceRecorderView => {
      if (!stream) {
        const canvas = document.createElement("canvas");
        canvas.width = 720;
        canvas.height = 1280;
        const brush = canvas.getContext("2d")!;
        brush.fillStyle = "#263b49";
        brush.fillRect(0, 0, 720, 1280);
        stream = canvas.captureStream(30);
      }
      return { kind: "camera", ready, stream };
    };
    const view = (kind: "processing" | "review"): DanceRecorderView => ({
      kind: "upload",
      upload: { kind, session },
    });
    const stop = () => {
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = undefined;
    };
    const original = async () => {
      const response = await fetch(fixtureUrl, { credentials: "omit" });
      if (!response.ok) throw Error("story_fixture_missing");
      return new File([await response.blob()], "dance.mp4", {
        type: "video/mp4",
      });
    };
    return {
      prepare: async () => {
        if (props.mode === "saved") {
          await f.seed();
          return { kind: "recovery", session };
        }
        return {
          kind: "objectives",
          session: null,
          context: { consent: options.consent },
        };
      },
      enter: async () => {
        if (props.mode === "permission" && !refused) {
          refused = true;
          throw new VideoCaptureError(
            "camera_denied",
            "Simulated permission refusal",
          );
        }
        await f.seed();
        return camera();
      },
      record: async (_signal, stage, progress, preview) => {
        stage("recording");
        progress(0);
        const file = await original();
        await f.seed({
          upload: {
            requestId: "story_original_request",
            recordingSha256: sha(16),
            bytes: file.size,
            mediaId: "media",
            put: "acknowledged",
            status: mediaFixture(f.c),
          },
        });
        preview?.(
          {
            sessionId: f.c.captureId,
            termsHash: f.c.termsHash,
            durationMs: session.body_end_ms,
            file,
          },
          f.c.expiresAtMs,
        );
        stop();
        return view("processing");
      },
      observe: async () => {
        observations++;
        if (props.mode === "offline" && observations === 1)
          throw TypeError("Simulated offline observation");
        return view(
          props.mode === "slow" && observations < 3 ? "processing" : "review",
        );
      },
      localPreview: async () => ({
        blob: await original(),
        expiresAtMs: f.c.expiresAtMs,
      }),
      recover: async () => ({
        kind: "objectives",
        session: null,
        context: { consent: options.consent },
        consentRequested: true,
      }),
      resume: async () => {
        const file = await original();
        await f.seed({
          upload: {
            requestId: "story_saved_request",
            recordingSha256: sha(16),
            bytes: file.size,
            mediaId: "media",
            put: "acknowledged",
            status: mediaFixture(f.c),
          },
        });
        return view("review");
      },
      newAttempt: async () => camera(),
      pause: stop,
      dispose: stop,
      cancelBeforeTake: async () => {},
    };
  };
  if (props.mode === "unknown") {
    f.client.submit = async () => {
      if (!submitted) {
        submitted = true;
        throw new TypeError("Simulated lost accepted acknowledgement");
      }
      return {
        version: "pirate.dance/1",
        commandId: "fixture_dispatch_rebinds_original",
        reviewId: f.c.captureId,
        revision: 1,
        state: "awaiting_review",
        intentId: null,
      };
    };
  }
  if (props.mode === "denied_after_load") {
    const status = f.ports.media.status;
    f.ports.media.status = async (...args) => {
      if (submitted)
        throw new DanceClientError("dance_request_denied", false, 401);
      submitted = true;
      return status(...args);
    };
  }
  const playback = {
    ...f.ports.playback,
    reference: async () => ({
      url: fixtureUrl,
      expiresAt: Date.now() + 60000,
      renewAt: Date.now() + 30000,
    }),
  };
  return (
    <DanceSongPage
      browseOnly={props.mode === "desktop"}
      communityId={scope.communityId}
      songKey={scope.songKey}
      recorder={recorder}
      playback={playback}
      account={{
        current: () => account,
        load: async () =>
          props.mode === "loading" ? new Promise(() => {}) : account,
        subscribe: (callback) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      }}
      catalogue={{
        options: async () => {
          if (props.mode === "error")
            throw Error("Simulated catalogue failure");
          return {
            choices: [
              {
                ...scope,
                title: "Fixture song",
                durationMs: f.c.durationSamples / 48,
                playback: "ready",
                recordingAllowed: props.mode !== "held",
              },
            ],
            consent:
              props.mode === "held"
                ? { ...consent, admission: "review_pending" }
                : consent,
            owner: props.mode === "owner",
            cursor: null,
          };
        },
        latest: async () =>
          props.mode === "pending" ? reviewFixture(f.c) : null,
      }}
      source={(selected, terms, current) => ({
        ...f.ports,
        scope: selected,
        consent: terms,
        currentScope: current,
        playback,
        nowMs: Date.now,
      })}
      onBack={() => {}}
      onSignIn={() => {}}
    />
  );
}
