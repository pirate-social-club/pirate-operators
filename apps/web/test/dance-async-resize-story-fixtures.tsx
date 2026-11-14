/** UNRUN engineering cases: actual pages, original machine/controllers/client
 * and production journal operations; SIMULATED owner/HTTP/storage/guide/camera.
 * The explicit browse-only scenario transition is simulated, not native resize
 * proof. Root's actual viewport gate is separately queued. No device is used. */
import { createSignal, onCleanup } from "solid-js";
import { DanceReviewPage } from "../src/dance/source/dance-review-page.tsx";
import { DanceRecorderPanel } from "../src/dance/source/dance-recorder-panel.tsx";
import { createDanceRecorder } from "../src/dance/source/dance-recorder.ts";
import { createDanceClient } from "../src/dance/client.ts";
import { simulatedCommandStorage } from "./dance-command-storage.ts";
import { simulatedSource, simulatedRecordingStorage, captureFixture, mediaFixture, reviewFixture, sha, scope } from "./dance-source-fixtures.ts";

export function DanceAsyncResizeStory(props: { scenario: "submission" | "activation" }) {
  const f = simulatedSource(), recordings = simulatedRecordingStorage();
  Object.assign(f.c, captureFixture(Date.now()));
  f.setStatus(mediaFixture(f.c));
  f.setReview(reviewFixture(f.c));
  const [eligible, setEligible] = createSignal(true);
  const [held, setHeld] = createSignal(false), [rejected, setRejected] = createSignal(false);
  const [commands, setCommands] = createSignal(0), [posts, setPosts] = createSignal(0);
  const [nativeStarts, setNativeStarts] = createSignal(0), [snapshot, setSnapshot] = createSignal("");
  let armed = false, release: (() => void) | undefined;
  const pause = async () => {
    setHeld(true);
    await new Promise<void>(resolve => { release = resolve; });
    setHeld(false);
  };
  const assertFreshPosting = () => {
    if (!eligible()) { setRejected(true); throw Error("dance_posting_unavailable"); }
  };
  const client = createDanceClient({
    communityId: scope.communityId, accountId: scope.accountId,
    csrf: "SIMULATED", isCurrent: () => true,
    journal: simulatedCommandStorage().journal(),
    fetcher: (async (_url, init) => {
      if (init?.method) { setPosts(n => n + 1); throw Error("unexpected_fresh_post"); }
      return Response.json(reviewFixture(f.c));
    }) as typeof fetch,
  });
  const retained = client.retained!;
  client.retained = async () => {
    const shouldPause = armed; armed = false;
    const original = await retained();
    if (shouldPause) await pause();
    return original;
  };
  const prepareSubmission = client.prepareSubmission!;
  client.prepareSubmission = (...args) => { setCommands(n => n + 1); return prepareSubmission(...args); };
  onCleanup(() => { release?.(); client.dispose(); });
  const setup = props.scenario === "submission" ? f.seed({ upload: {
    requestId: "SIMULATED_original_media", recordingSha256: sha(16), bytes: 4,
    mediaId: "media", put: "acknowledged", status: null,
  } }) : Promise.resolve();
  const source = {
    ...f.ports, client: props.scenario === "submission" ? client : f.client,
    nowMs: Date.now,
    journal: {
      read: async (...args: Parameters<typeof f.ports.journal.read>) => { await setup; return f.ports.journal.read(...args); },
      exclusive: f.ports.journal.exclusive.bind(f.ports.journal),
    },
  };
  const recorder: typeof createDanceRecorder = options => createDanceRecorder({
    ...options, storage: recordings.storage,
    claimCapture: async () => ({ assertCurrent: () => {}, release: async () => {} }),
    // Empty synthetic stream only: no getUserMedia, camera permission or frames.
    openCamera: async () => new MediaStream(),
    prepareGuide: async ({ context }) => ({
      sessionId: context.session.session_id, termsHash: context.session.terms_hash,
      activate: pause, start: () => {}, dispose: () => {},
    }),
    capture: () => { setNativeStarts(n => n + 1); throw Error("unexpected_native_capture"); },
  });
  const inspect = async () => {
    const entry = await source.journal.read(scope, () => {});
    const original = await source.client.retained!();
    setSnapshot(JSON.stringify({ captureId: entry.capture?.captureId ?? null,
      captureUnknown: entry.captureUnknown, submission: entry.submission,
      uploadRequest: entry.upload?.requestId ?? null, outstanding: !!original && !original.receiptJson }));
  };
  return <>
    {props.scenario === "submission" ?
      <DanceReviewPage source={source} songLabel="Fixture song" assertFreshPosting={assertFreshPosting} onBack={() => {}} onAccessLost={() => {}} /> :
      <DanceRecorderPanel source={source} songLabel="Fixture song" recorder={recorder} assertFreshPosting={assertFreshPosting} onBack={() => {}} onAccessLost={() => {}} />}
    <aside hidden aria-hidden="true" aria-label="SIMULATED engineering boundary ports">
      <button type="button" data-async-arm onClick={() => { armed = true; }}>Defer retained read</button>
      <button type="button" data-async-deny onClick={() => setEligible(false)}>Switch to browse-only scenario</button>
      <button type="button" data-async-release onClick={() => release?.()}>Release original pending boundary</button>
      <button type="button" data-async-inspect onClick={() => void inspect()}>Inspect retained identity</button>
      <output data-async-held>{String(held())}</output><output data-async-rejected>{String(rejected())}</output>
      <output data-async-commands>{commands()}</output><output data-async-posts>{posts()}</output>
      <output data-async-native>{nativeStarts()}</output><output data-async-snapshot>{snapshot()}</output>
    </aside>
  </>;
}
