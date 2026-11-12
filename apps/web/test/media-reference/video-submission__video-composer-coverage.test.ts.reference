import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createActor } from "xstate";
import { expect, test, vi } from "vitest";
import type { SoundtrackSelection } from "../post-composer/song-excerpt-composer";
import { ORIGINAL_VIDEO_PENDING, type PendingVideo } from "./coordinator";
import type { VideoCaptureSession } from "./capture";
import { createVideoComposerMachine, type ComposerOperations } from "./video-composer-machine";

type StoryName = keyof typeof import("./video-authoring.stories");
// Story names are inventory links. Each row also executes the real chart below.
// Runtime/media suites retain the deeper adapter and device-lifetime assertions.
const coverage = {
  restoring: { story: "SubmittedUploadResumes" },
  choosingSong: { story: "ExcerptSelection" },
  checkingPlayback: { internal: "Playback confirmation has no separate stable screen." },
  capture: { story: "RecordingReady" },
  "capture.idle": { story: "RecordingReady" },
  "capture.inspecting": { internal: "Inspection precedes review; rejection must release the selected file." },
  "capture.preparingGuide": { internal: "Guide preparation uses the capture screen's loading notice." },
  "capture.startingCapture": { internal: "Pending camera permission uses the existing capture screen." },
  "capture.startingGuide": { internal: "Guide startup has not yet established a recording." },
  "capture.recording": { story: "GuidedRecording" },
  "capture.interrupting": { story: "GuideInterrupted" },
  "capture.finalizing": { story: "RecordingStopped" },
  review: { story: "ReviewPlayback" },
  submitting: { story: "UploadProgress" },
  retained: { story: "SubmittedUploadNeedsAnotherTry" },
  refreshing: { story: "SubmittedUploadResumes" },
  startingOver: { story: "SubmittedUploadExpired" },
} as const satisfies Record<string, { story: StoryName } | { internal: string }>;
type CoveredState = keyof typeof coverage;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const take = new File(["take"], "take.mp4", { type: "video/mp4" });
  const record: PendingVideo = {
    version: ORIGINAL_VIDEO_PENDING, principalId: "account-one", communityId: "community-one",
    personaId: "persona-one", file: take, caption: "", rating: "general",
    reservation: null, snapshot: null, receipts: [], pending: null,
  };
  // SAFETY: The chart only retains this stream; controlled operations never
  // call device methods. Real stream behavior is covered by the media suites.
  const session: VideoCaptureSession = {
    stream: Object.create(null) as MediaStream, captureOriginMs: 0,
    stop: async () => take, cancel: async () => {},
  };
  const selection: SoundtrackSelection = {
    songPostId: "song", title: "Song", audioUrl: "https://example.test/song",
    bounds: { startMs: 0, endMs: 10_000 },
  };
  // SAFETY: The chart retains this opaque audio handle without calling it;
  // controlled capture operations supply results and media tests exercise audio.
  const prepared = { guide: selection, audio: Object.create(null) as Parameters<ComposerOperations["startCapture"]>[0]["audio"] };
  const restore = deferred<Awaited<ReturnType<ComposerOperations["restore"]>>>();
  const playback = deferred<void>();
  const inspection = deferred<Awaited<ReturnType<ComposerOperations["inspectFile"]>>>();
  const guide = deferred<typeof prepared>();
  const camera = deferred<Awaited<ReturnType<ComposerOperations["startCapture"]>>>();
  const startGuide = deferred<Awaited<ReturnType<ComposerOperations["startGuide"]>>>();
  const finish = deferred<Awaited<ReturnType<ComposerOperations["finishCapture"]>>>();
  const cancel = deferred<void>();
  const publish = deferred<{ posted: boolean }>();
  const refresh = deferred<boolean>();
  const reset = deferred<void>();
  const signals = new Set<AbortSignal>();
  const own = <T>(work: Promise<T>, signal: AbortSignal) => {
    signals.add(signal);
    void work.then(() => signals.delete(signal), () => signals.delete(signal));
    return work;
  };
  const operations: ComposerOperations = {
    restore: signal => own(restore.promise, signal),
    checkPlayback: vi.fn((_selection, signal) => own(playback.promise, signal)),
    inspectFile: vi.fn((_file, signal) => own(inspection.promise, signal)),
    prepareGuide: vi.fn((_selection, signal) => own(guide.promise, signal)),
    startCapture: vi.fn((_prepared, signal) => own(camera.promise, signal)),
    startGuide: vi.fn((_session, signal) => own(startGuide.promise, signal)),
    finishCapture: vi.fn((_context, signal) => own(finish.promise, signal)),
    cancelCapture: vi.fn((_context, signal) => own(cancel.promise, signal)),
    publish: vi.fn((_context, signal) => own(publish.promise, signal)),
    refresh: vi.fn((_context, signal) => own(refresh.promise, signal)),
    startOver: vi.fn((_context, signal) => own(reset.promise, signal)),
    canCapture: context => context.selection !== null,
    canPublish: context => context.file !== null,
    shouldRefresh: context => context.record !== null,
    onPosted: vi.fn(), onExit: vi.fn(), onReset: vi.fn(),
    syncPreview: vi.fn(), closePreview: vi.fn(), discardPrepared: vi.fn(),
  };
  const machine = createVideoComposerMachine(operations, true);
  const actor = createActor(machine).start();
  const inState = (path: CoveredState) => {
    const value = actor.getSnapshot().value;
    return typeof value === "string" ? value === path : path === "capture" || path === `capture.${value.capture}`;
  };
  const wait = (path: CoveredState) => vi.waitFor(() => expect(inState(path)).toBe(true));
  const reach = async (path: CoveredState) => {
    if (path === "restoring") return;
    if (path === "retained" || path === "refreshing" || path === "startingOver") {
      restore.resolve({ record, released: false, resume: false }); await wait("retained");
      if (path === "refreshing") actor.send({ type: "TICK" });
      if (path === "startingOver") actor.send({ type: "START_OVER" });
      await wait(path); return;
    }
    restore.resolve({ record: null, released: false, resume: false }); await wait("choosingSong");
    if (path === "choosingSong") return;
    actor.send({ type: "SELECTION", selection }); actor.send({ type: "CONTINUE" }); await wait("checkingPlayback");
    if (path === "checkingPlayback") return;
    playback.resolve(); await wait("capture.idle");
    if (path === "capture" || path === "capture.idle") return;
    if (path === "capture.inspecting" || path === "review" || path === "submitting") {
      actor.send({ type: "FILE", file: take }); await wait("capture.inspecting");
      if (path === "capture.inspecting") return;
      inspection.resolve({ file: take, durationMs: 10_000, alignment: "none" }); await wait("review");
      if (path === "submitting") { actor.send({ type: "PUBLISH" }); await wait(path); }
      return;
    }
    actor.send({ type: "RECORD" }); await wait("capture.preparingGuide");
    if (path === "capture.preparingGuide") return;
    guide.resolve(prepared); await wait("capture.startingCapture");
    if (path === "capture.startingCapture") return;
    camera.resolve({ session, prepared }); await wait("capture.startingGuide");
    if (path === "capture.startingGuide") return;
    startGuide.resolve({ started: true, delayMs: 100 }); await wait("capture.recording");
    if (path === "capture.recording") return;
    actor.send({ type: path === "capture.interrupting" ? "INTERRUPT" : "STOP" }); await wait(path);
  };
  return { actor, machine, operations, signals, record, take, selection, restore, inspection, finish, cancel, publish, refresh, reset, inState, wait, reach };
}

test("every video state has a story or a documented internal projection", () => {
  const flow = fixture();
  try {
    const collect = (nodes: typeof flow.machine.states, prefix = ""): string[] =>
      Object.entries(nodes).flatMap(([name, node]) => {
        const path = prefix ? `${prefix}.${name}` : name;
        return [path, ...collect(node.states, path)];
      });
    const paths = collect(flow.machine.states);
    expect(Object.keys(coverage).sort()).toEqual(paths.sort());
    const stories = readFileSync(resolve(import.meta.dirname, "video-authoring.stories.tsx"), "utf8");
    for (const row of Object.values(coverage)) {
      if ("story" in row) expect(stories).toMatch(new RegExp(`export const ${row.story}\\b`));
      else expect(row.internal.trim().length).toBeGreaterThan(0);
    }
  } finally { flow.actor.stop(); }
});

// SAFETY: Object.keys reads only this local literal, whose own keys define CoveredState.
test.each(Object.keys(coverage) as CoveredState[])("video coverage executes %s", async path => {
  const flow = fixture();
  try {
    await flow.reach(path);
    expect(flow.inState(path)).toBe(true);
    if (path === "restoring") {
      expect(flow.operations.publish).not.toHaveBeenCalled();
      flow.restore.resolve({ record: flow.record, released: false, resume: true }); await flow.wait("submitting");
      expect(flow.actor.getSnapshot().context.record).toBe(flow.record);
      expect(flow.actor.getSnapshot().context.file).toBe(flow.record.file);
      expect(flow.operations.publish).toHaveBeenCalledTimes(1);
    } else if (path === "capture" || path === "capture.idle") {
      expect(flow.actor.getSnapshot().context.enteredCapture).toBe(true);
      expect(flow.operations.startCapture).not.toHaveBeenCalled();
      flow.actor.send({ type: "PREVIEW_CHECK" }); expect(flow.operations.syncPreview).toHaveBeenCalled();
    } else if (path === "capture.inspecting") {
      expect(flow.operations.inspectFile).toHaveBeenCalledWith(flow.take, expect.any(AbortSignal));
      flow.inspection.reject(new Error("Invalid video")); await flow.wait("capture.idle");
      expect(flow.actor.getSnapshot().context.file).toBeNull();
      expect(flow.actor.getSnapshot().context.error).toBe("Invalid video");
    } else if (path === "capture.recording") {
      expect(flow.actor.getSnapshot().context.guideStarted).toBe(true);
      expect(flow.actor.getSnapshot().context.takeSoundtrack?.songPostId).toBe(flow.selection.songPostId);
    } else if (path === "capture.interrupting") {
      expect(flow.operations.cancelCapture).toHaveBeenCalledTimes(1);
      flow.cancel.resolve(); await flow.wait("capture.idle");
      expect(flow.actor.getSnapshot().context.session).toBeNull();
      expect(flow.actor.getSnapshot().context.issue).toBe("guide_interrupted");
    } else if (path === "capture.finalizing") {
      expect(flow.operations.finishCapture).toHaveBeenCalledTimes(1);
      flow.finish.resolve({ file: flow.take, durationMs: 10_000, alignment: "aligned" }); await flow.wait("review");
      expect(flow.actor.getSnapshot().context.file).toBe(flow.take);
      expect(flow.actor.getSnapshot().context.takeAlignment).toBe("aligned");
    } else if (path === "review") {
      expect(flow.actor.getSnapshot().context.file).toBe(flow.take);
      flow.actor.send({ type: "BACK_FROM_REVIEW" }); await flow.wait("capture.idle");
      expect(flow.actor.getSnapshot().context.file).toBeNull();
    } else if (path === "submitting") {
      flow.actor.send({ type: "PUBLISH" }); flow.actor.send({ type: "PUBLISH" });
      expect(flow.operations.publish).toHaveBeenCalledTimes(1);
      flow.publish.resolve({ posted: false }); await flow.wait("retained");
      expect(flow.operations.onPosted).not.toHaveBeenCalled();
    } else if (path === "retained") {
      expect(flow.actor.getSnapshot().context.record).toBe(flow.record);
      expect(flow.operations.publish).not.toHaveBeenCalled();
    } else if (path === "refreshing") {
      expect(flow.operations.refresh).toHaveBeenCalledTimes(1);
      flow.refresh.resolve(false); await flow.wait("retained");
      expect(flow.actor.getSnapshot().context.record).toBe(flow.record);
      expect(flow.operations.publish).not.toHaveBeenCalled();
    } else if (path === "startingOver") {
      expect(flow.operations.startOver).toHaveBeenCalledTimes(1);
      flow.reset.resolve(); await flow.wait("choosingSong");
      expect(flow.actor.getSnapshot().context.record).toBeNull();
      expect(flow.operations.onReset).toHaveBeenCalledTimes(1);
    }
  } finally {
    flow.actor.stop();
    expect([...flow.signals].every(signal => signal.aborted)).toBe(true);
  }
});
