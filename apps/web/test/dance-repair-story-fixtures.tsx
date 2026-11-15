/** UNRUN page fixtures. Real source pages/controllers/client; simulated HTTP,
 * authenticated owner, authority and durable storage only. No device access. */
import { DanceReviewPage } from "../src/dance/source/dance-review-page.tsx";
import { DanceResultPage } from "../src/dance/source/dance-result-page.tsx";
import { createSignal, onCleanup, Show } from "solid-js";
import { createDanceClient, DanceClientError } from "../src/dance/client.ts";
import { danceSession } from "../src/dance/source/dance-preparation-api.ts";
import { createDanceRecordingController } from "../src/dance/source/dance-recording.ts";
import { simulatedCommandStorage } from "./dance-command-storage.ts";
import {
  simulatedSource,
  simulatedRecordingStorage,
  captureFixture,
  reviewFixture,
  mediaFixture,
  scope,
  hash,
} from "./dance-source-fixtures.ts";
export type RepairStoryMode =
  | "explicit_A_local_B"
  | "explicit_A_submitted_B"
  | "local_original"
  | "local_permission_refused"
  | "local_missing_original"
  | "review_stalled_401"
  | "result_stalled_403";
const originalFixtureUrl = new URL(
  "./dance-fixtures/paper-neutral-avc-aac.mp4",
  import.meta.url,
).href;
export function DanceRepairStory(props: { mode: RepairStoryMode }) {
  const f = simulatedSource(),
    storage = simulatedRecordingStorage();
  Object.assign(f.c, captureFixture(Date.now()));
  const a = structuredClone(f.c);
  a.captureId = "explicit_A";
  a.captureHash = hash(70);
  a.consent = {
    ...a.consent!,
    captureId: a.captureId,
    captureHash: a.captureHash,
  };
  let refuse = false,
    delayNext = false,
    lateReply: (() => void) | undefined;
  const [closed, setClosed] = createSignal(false);
  const [lateWaiting, setLateWaiting] = createSignal(false);
  const [lastPath, setLastPath] = createSignal(""),
    [lost, setLost] = createSignal(0);
  const client = createDanceClient({
    communityId: scope.communityId,
    accountId: scope.accountId,
    csrf: "SIMULATED",
    journal: simulatedCommandStorage().journal(),
    isCurrent: () => true,
    fetcher: (async (url, init) => {
      setLastPath(String(url));
      if (refuse)
        return {
          status: props.mode === "result_stalled_403" ? 403 : 401,
          ok: false,
          json: () => new Promise(() => {}),
        } as Response;
      if (delayNext) {
        delayNext = false;
        setLateWaiting(true);
        return {
          status: 200,
          ok: true,
          json: () =>
            new Promise((resolve) => {
              lateReply = () => resolve(reviewFixture(a));
            }),
        } as Response;
      }
      if (init?.method)
        return Response.json({
          version: "pirate.dance/1",
          commandId: JSON.parse(String(init.body)).commandId,
          reviewId: a.captureId,
          revision: 1,
          state: "withdrawal_pending",
          intentId: null,
        });
      return Response.json(reviewFixture(a));
    }) as typeof fetch,
  });
  onCleanup(() => client.dispose());
  const setup = (async () => {
    await f.seed();
    const response = await fetch(originalFixtureUrl, { credentials: "omit" });
    if (!response.ok) throw new Error("story_fixture_missing");
    const file = new File([await response.blob()], "take.mp4", {
      type: "video/mp4",
    });
    const session = danceSession(f.c, f.ports.media.maximumBytes);
    const ready = {
      ...f.ready,
      session,
      context: { ...f.ready.context, session },
    };
    const original = await createDanceRecordingController({
      ...f.ports,
      storage: storage.storage,
      nowMs: Date.now,
    }).retain(
      ready,
      {
        sessionId: f.c.captureId,
        termsHash: f.c.termsHash,
        durationMs: session.body_end_ms,
        file,
      },
      new AbortController().signal,
    );
    if (props.mode === "local_missing_original") storage.records.clear();
    const status = mediaFixture(f.c, original.metadata.sha256);
    f.setStatus(status);
    await f.seed({
      upload: {
        requestId: "original_story_request",
        recordingSha256: original.metadata.sha256,
        bytes: file.size,
        mediaId: "media",
        put: "acknowledged",
        status,
      },
      submission: props.mode === "explicit_A_submitted_B" ? "accepted" : "none",
    });
  })();
  const source = {
    ...f.ports,
    client,
    recordingStorage: storage.storage,
    nowMs: Date.now,
    journal: {
      read: async (...args: Parameters<typeof f.ports.journal.read>) => {
        await setup;
        return f.ports.journal.read(...args);
      },
      exclusive: f.ports.journal.exclusive.bind(f.ports.journal),
    },
    captureAccess: async () => {
      if (props.mode === "local_permission_refused")
        throw new DanceClientError("simulated_permission_refused", false, 403);
    },
  };
  const explicit =
    props.mode.startsWith("explicit_") || props.mode.includes("stalled");
  return (
    <>
      <Show when={!closed()}>
      {props.mode === "result_stalled_403" ? (
        <DanceResultPage
          source={source}
          reviewId={a.captureId}
          onBack={() => setClosed(true)}
          onManage={() => {}}
          onSignIn={() => {}}
          onAccessLost={() => {
            setLost(lost() + 1);
          }}
        />
      ) : (
        <DanceReviewPage
          source={source}
          songLabel="Fixture song"
          reviewId={explicit ? a.captureId : undefined}
          onBack={() => setClosed(true)}
          onAccessLost={() => {
            setLost(lost() + 1);
          }}
        />
      )}
      </Show>
      <aside
        hidden
        aria-hidden="true"
        aria-label="Simulated fixture controls"
        data-last-path={lastPath()}
      >
        <button
          data-fixture-refusal
          onClick={() => {
            refuse = true;
            void client.observe!(a.captureId).catch(() => {});
          }}
        >
          Simulate header refusal with stalled body
        </button>
        <button
          data-fixture-late-read
          onClick={() => {
            delayNext = true;
            window.dispatchEvent(new Event("online"));
          }}
        >
          Simulate delayed observation
        </button>
        <button data-fixture-late-reply onClick={() => lateReply?.()}>
          Deliver old private response
        </button>
        <output data-fixture-late-waiting>{String(lateWaiting())}</output>
        <output data-fixture-path>{lastPath()}</output>
        <output data-fixture-exited>{String(closed())}</output>
        <output data-fixture-lost>{lost()}</output>
      </aside>
    </>
  );
}
