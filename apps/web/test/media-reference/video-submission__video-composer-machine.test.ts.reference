import { createActor, SimulatedClock } from "xstate";
import { createRoot } from "solid-js";
import { describe, expect, test, vi } from "vitest";
import type { SoundtrackSelection } from "../post-composer/song-excerpt-composer";
import type { VideoCaptureSession } from "./capture";
import type { GuideAudio } from "./video-composer-runtime";
import { createVideoComposerMachine, type ComposerOperations } from "./video-composer-machine";
import { useOwnedActor } from "./solid-actor";
import type { SongPlanState } from "./song-reference";

// SAFETY: The machine reads these exact soundtrack fields in this fixture.
const selection = {
  songPostId: "song", title: "Song", audioUrl: "https://example.test/song",
  bounds: { startMs: 0, endMs: 10_000 },
} as SoundtrackSelection;
// SAFETY: Media playback is injected; this test only passes the guide through transitions.
const guide = { pause() {}, play: async () => {}, currentTime: 0, addEventListener() {}, removeEventListener() {} } as GuideAudio;
const take = new File(["take"], "take.mp4", { type: "video/mp4" });
// SAFETY: The statechart stores the session but never invokes stream methods.
// Media-handle behavior belongs to the adapter tests.
const stream = Object.create(null) as MediaStream;
const session = { stream, captureOriginMs: 0,
  stop: async () => take, cancel: async () => {} } satisfies VideoCaptureSession;
const approvedPlan: SongPlanState = { kind: "ready", selection: {
  songPostId: "song", audioRevision: 1, clipStartSamples: 0, clipDurationSamples: 480_000,
  selectedFrom: { kind: "library" },
} };
const negativePlans = [
  { kind: "refused", reason: "interval_too_long" },
  { kind: "failed", retryable: true },
  { kind: "ineligible", reasonCode: "song_not_found" },
  { kind: "not_available" },
  { kind: "timing_unavailable" },
] satisfies readonly SongPlanState[];

function fixture(overrides: Partial<ComposerOperations> = {}, clock?: SimulatedClock) {
  const publish = vi.fn(async () => ({ posted: false }));
  const cancelCapture = vi.fn(async () => {});
  const operations: ComposerOperations = {
    restore: async () => ({ record: null, released: false, resume: false }),
    checkPlayback: async () => {},
    inspectFile: async file => ({ file, durationMs: 10_000, alignment: "none" }),
    prepareGuide: async chosen => ({ guide: chosen, audio: guide }),
    startCapture: async prepared => ({ session, prepared }),
    startGuide: async () => ({ started: true, delayMs: 100 }),
    finishCapture: async () => ({ file: take, durationMs: 10_000, alignment: "aligned" }),
    cancelCapture,
    publish,
    startOver: async () => {},
    refresh: async () => false,
    canCapture: context => context.selection !== null,
    canPublish: context => context.file !== null,
    shouldRefresh: () => false,
    onPosted() {}, onExit() {}, onReset() {},
    syncPreview() {}, closePreview() {}, discardPrepared() {},
    ...overrides,
  };
  const actor = createActor(createVideoComposerMachine(operations, true), clock ? { clock } : undefined).start();
  const inState = (state: string) => {
    const [parent, child] = state.split(".");
    const value = actor.getSnapshot().value;
    return child ? parent === "capture" && typeof value === "object" && value !== null && value.capture === child : value === parent;
  };
  const wait = async (state: string) => vi.waitFor(() => expect(inState(state)).toBe(true));
  return { actor, wait, inState, publish, cancelCapture };
}

function ownedFixture(overrides: Partial<ComposerOperations> = {}) {
  return createRoot(dispose => {
    const flow = fixture(overrides);
    return { ...flow, ...useOwnedActor(flow.actor), dispose };
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe("composer transitions", () => {
  test.each([...negativePlans, null])("approval lost during playback keeps song choice open after late success: %s", async plan => {
    const pending = deferred<void>();
    let eligible = true;
    const { actor, send, wait, dispose } = ownedFixture({
      canCapture: context => eligible && context.songPlan.kind === "ready",
      checkPlayback: async () => pending.promise,
    });
    try {
      await wait("choosingSong");
      send({ type: "SELECTION", selection }); send({ type: "SONG_PLAN", plan: approvedPlan });
      send({ type: "CONTINUE" }); await wait("checkingPlayback");
      if (plan) {
        send({ type: "SONG_PLAN", plan });
        await vi.waitFor(() => expect(actor.getSnapshot().context.songPlan.kind).toBe(plan.kind));
      } else eligible = false;
      pending.resolve(); await wait("choosingSong");
      expect(actor.getSnapshot().context.enteredCapture).toBe(false);
      expect(actor.getSnapshot().context.confirmRequested).toBe(false);
      expect(actor.getSnapshot().context.selection).toBe(selection);
      if (plan) expect(actor.getSnapshot().context.songPlan).toEqual(plan);
    } finally { pending.resolve(); dispose(); }
  });

  test.each([
    ["preparingGuide", "song"], ["startingCapture", "song"],
    ["preparingGuide", "profile"], ["startingCapture", "profile"],
  ] as const)("losing %s approval through %s cancels pending startup", async (phase, invalidation) => {
    const prepared = { guide: selection, audio: guide };
    const pendingGuide = deferred<typeof prepared>();
    const pendingCapture = deferred<{ session: VideoCaptureSession; prepared: typeof prepared }>();
    let eligible = true;
    let signal: AbortSignal | undefined;
    const startCapture = vi.fn(async (_input, inputSignal: AbortSignal) => {
      signal = inputSignal;
      return pendingCapture.promise;
    });
    const startGuide = vi.fn(async () => ({ started: true, delayMs: 100 }));
    const discardPrepared = vi.fn();
    const { actor, send, wait, dispose } = ownedFixture({
      canCapture: context => eligible && context.songPlan.kind === "ready",
      prepareGuide: async (_chosen, inputSignal) => {
        if (phase === "preparingGuide") { signal = inputSignal; return pendingGuide.promise; }
        return prepared;
      },
      startCapture, startGuide, discardPrepared,
    });
    try {
      await wait("choosingSong");
      send({ type: "SELECTION", selection }); send({ type: "SONG_PLAN", plan: approvedPlan });
      send({ type: "CONTINUE" }); await wait("capture.idle");
      send({ type: "RECORD" }); await wait(`capture.${phase}`);
      if (invalidation === "song") send({ type: "SONG_PLAN", plan: negativePlans[0] });
      else { eligible = false; send({ type: "PREVIEW_CHECK" }); }
      await wait("capture.idle");
      expect(signal?.aborted).toBe(true);
      expect(discardPrepared).toHaveBeenCalledTimes(1);
      pendingGuide.resolve(prepared); pendingCapture.resolve({ session, prepared });
      await Promise.resolve(); await Promise.resolve();
      expect(actor.getSnapshot().matches({ capture: "idle" })).toBe(true);
      expect(actor.getSnapshot().context.session).toBeNull();
      expect(startCapture).toHaveBeenCalledTimes(phase === "startingCapture" ? 1 : 0);
      expect(startGuide).not.toHaveBeenCalled();
    } finally { pendingGuide.resolve(prepared); pendingCapture.resolve({ session, prepared }); dispose(); }
  });

  test("losing song approval during recording still allows Stop but prevents Publish", async () => {
    const finishCapture = vi.fn(async () => ({ file: take, durationMs: 10_000, alignment: "aligned" as const }));
    const { actor, send, wait, publish, dispose } = ownedFixture({
      canCapture: context => context.songPlan.kind === "ready",
      canPublish: context => context.file !== null && context.songPlan.kind === "ready",
      finishCapture,
    });
    try {
      await wait("choosingSong");
      send({ type: "SELECTION", selection }); send({ type: "SONG_PLAN", plan: approvedPlan });
      send({ type: "CONTINUE" }); await wait("capture.idle");
      send({ type: "RECORD" }); await wait("capture.recording");
      send({ type: "SONG_PLAN", plan: negativePlans[0] });
      await vi.waitFor(() => expect(actor.getSnapshot().context.songPlan.kind).toBe("refused"));
      expect(actor.getSnapshot().matches({ capture: "recording" })).toBe(true);
      send({ type: "STOP" }); await wait("review");
      expect(finishCapture).toHaveBeenCalledTimes(1);
      expect(actor.getSnapshot().can({ type: "PUBLISH" })).toBe(false);
      send({ type: "PUBLISH" }); await Promise.resolve();
      expect(publish).not.toHaveBeenCalled();
    } finally { dispose(); }
  });

  test("Stop during guide startup aborts the guide and finalizes with no confirmed alignment", async () => {
    const pending = deferred<{ started: boolean; delayMs: number }>();
    let signal: AbortSignal | undefined;
    const finishCapture = vi.fn(async (_context: Parameters<ComposerOperations["finishCapture"]>[0]) => ({ file: take, durationMs: 10_000, alignment: "unaligned" as const }));
    const { actor, send, wait, dispose } = ownedFixture({
      startGuide: async (_input, inputSignal) => { signal = inputSignal; return pending.promise; },
      finishCapture,
    });
    try {
      await wait("choosingSong"); send({ type: "SELECTION", selection });
      send({ type: "CONTINUE" }); await wait("capture.idle");
      send({ type: "RECORD" }); await wait("capture.startingGuide");
      send({ type: "STOP" }); await wait("review");
      expect(signal?.aborted).toBe(true);
      expect(finishCapture).toHaveBeenCalledTimes(1);
      expect(finishCapture.mock.calls[0]?.[0]).toMatchObject({ guideStarted: false });
      pending.resolve({ started: true, delayMs: 100 });
      await Promise.resolve(); await Promise.resolve();
      expect(actor.getSnapshot().value).toBe("review");
      expect(actor.getSnapshot().context.takeAlignment).toBe("unaligned");
      expect(actor.getSnapshot().context.guideStarted).toBe(false);
    } finally { pending.resolve({ started: false, delayMs: 0 }); dispose(); }
  });

  test.each(["direct", "delayed"] as const)("%s song confirmation from file review keeps Publish usable without checking recording playback", async confirmation => {
    const checkPlayback = vi.fn(async () => {});
    const { actor, send, wait, publish, dispose } = ownedFixture({
      checkPlayback, canCapture: context => context.selection !== null && context.songPlan.kind === "ready",
    });
    try {
      await wait("choosingSong");
      send({ type: "SELECTION", selection }); send({ type: "SONG_PLAN", plan: approvedPlan });
      send({ type: "CONTINUE" }); await wait("capture.idle");
      send({ type: "FILE", file: take }); await wait("review");
      checkPlayback.mockClear();
      send({ type: "OPEN_SONG" }); await wait("choosingSong");
      if (confirmation === "delayed") send({ type: "SONG_PLAN", plan: { kind: "checking" } });
      send({ type: "CONTINUE" });
      if (confirmation === "delayed") {
        await vi.waitFor(() => expect(actor.getSnapshot().context.confirmRequested).toBe(true));
        send({ type: "SONG_PLAN", plan: approvedPlan });
      }
      await wait("review");
      expect(actor.getSnapshot().context.file).toBe(take);
      expect(checkPlayback).not.toHaveBeenCalled();
      send({ type: "PUBLISH" }); await wait("retained");
      expect(publish).toHaveBeenCalledTimes(1);
    } finally { dispose(); }
  });

  test.each(negativePlans)("a terminal $kind verdict cancels pending confirmation before a new selection is approved", async plan => {
    const checkPlayback = vi.fn(async () => {});
    const { actor, send, wait, dispose } = ownedFixture({
      checkPlayback, canCapture: context => context.selection !== null && context.songPlan.kind === "ready",
    });
    try {
      await wait("choosingSong");
      send({ type: "SELECTION", selection }); send({ type: "SONG_PLAN", plan: { kind: "checking" } });
      send({ type: "CONTINUE" });
      await vi.waitFor(() => expect(actor.getSnapshot().context.confirmRequested).toBe(true));
      send({ type: "SONG_PLAN", plan });
      await vi.waitFor(() => expect(actor.getSnapshot().context.confirmRequested).toBe(false));
      send({ type: "SELECTION", selection: { ...selection, bounds: { startMs: 1000, endMs: 11_000 } } });
      send({ type: "SONG_PLAN", plan: approvedPlan });
      await vi.waitFor(() => expect(actor.getSnapshot().context.songPlan.kind).toBe("ready"));
      expect(actor.getSnapshot().value).toBe("choosingSong");
      expect(checkPlayback).not.toHaveBeenCalled();
      send({ type: "CONTINUE" }); await wait("capture.idle");
      expect(checkPlayback).toHaveBeenCalledTimes(1);
    } finally { dispose(); }
  });

  test.each([false, true])("Back during pending playback cancels the check with prior capture entry %s", async entered => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let blocked = !entered;
    let signal: AbortSignal | undefined;
    const onExit = vi.fn();
    const { actor, send, wait, dispose } = ownedFixture({
      onExit, checkPlayback: async (_selection, inputSignal) => {
        if (blocked) { signal = inputSignal; await pending; }
      },
    });
    try {
      await wait("choosingSong"); send({ type: "SELECTION", selection });
      if (entered) {
        send({ type: "CONTINUE" }); await wait("capture.idle");
        send({ type: "OPEN_SONG" }); await wait("choosingSong"); blocked = true;
      }
      send({ type: "CONTINUE" }); await wait("checkingPlayback");
      send({ type: "BACK_FROM_SONG" }); await wait(entered ? "capture.idle" : "choosingSong");
      expect(signal?.aborted).toBe(true);
      expect(onExit).toHaveBeenCalledTimes(entered ? 0 : 1);
      finish(); await Promise.resolve(); await Promise.resolve();
      expect(actor.getSnapshot().matches(entered ? "capture" : "choosingSong")).toBe(true);
    } finally { finish(); dispose(); }
  });

  test("changing the song during playback does not reuse an earlier delayed confirmation", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const { actor, send, wait, dispose } = ownedFixture({
      canCapture: context => context.selection !== null && context.songPlan.kind === "ready",
      checkPlayback: async () => pending,
    });
    try {
      await wait("choosingSong"); send({ type: "SELECTION", selection });
      send({ type: "SONG_PLAN", plan: { kind: "checking" } });
      send({ type: "CONTINUE" });
      await vi.waitFor(() => expect(actor.getSnapshot().context.confirmRequested).toBe(true));
      send({ type: "SONG_PLAN", plan: approvedPlan }); await wait("checkingPlayback");
      send({ type: "SONG_PLAN", plan: { kind: "checking" } });
      send({ type: "SELECTION", selection: { ...selection, songPostId: "another-song" } });
      await wait("choosingSong");
      expect(actor.getSnapshot().context.confirmRequested).toBe(false);
      finish(); send({ type: "SONG_PLAN", plan: approvedPlan });
      await vi.waitFor(() => expect(actor.getSnapshot().context.songPlan.kind).toBe("ready"));
      expect(actor.getSnapshot().value).toBe("choosingSong");
    } finally { finish(); dispose(); }
  });

  test("two Publish events queued by the Solid bridge start only one operation", async () => {
    let complete!: (value: { posted: boolean }) => void;
    const pending = new Promise<{ posted: boolean }>(resolve => { complete = resolve; });
    const publish = vi.fn(() => pending);
    let dispose = () => {};
    const { actor, wait, send } = createRoot(release => {
      dispose = release;
      const fixtureActor = fixture({ publish });
      return { ...fixtureActor, send: useOwnedActor(fixtureActor.actor).send };
    });
    try {
      await wait("choosingSong");
      send({ type: "SELECTION", selection });
      send({ type: "CONTINUE" });
      await wait("capture.idle");
      send({ type: "FILE", file: take });
      await wait("review");
      send({ type: "PUBLISH" });
      send({ type: "PUBLISH" });
      await wait("submitting");
      expect(publish).toHaveBeenCalledTimes(1);
      expect(actor.getSnapshot().can({ type: "PUBLISH" })).toBe(false);
      complete({ posted: false });
      await wait("retained");
      expect(publish).toHaveBeenCalledTimes(1);
    } finally { dispose(); }
  });

  test("song approval, capture, finalization and Publish have one path", async () => {
    const { actor, wait, publish } = fixture();
    await wait("choosingSong");
    actor.send({ type: "SELECTION", selection });
    actor.send({ type: "CONTINUE" });
    await wait("capture.idle");
    actor.send({ type: "RECORD" });
    await wait("capture.recording");
    actor.send({ type: "STOP" });
    await wait("review");
    actor.send({ type: "PUBLISH" });
    actor.send({ type: "PUBLISH" });
    await wait("retained");
    expect(publish).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  test("an interrupted guide cancels the take and returns to retake", async () => {
    const { actor, wait, cancelCapture } = fixture();
    await wait("choosingSong");
    actor.send({ type: "SELECTION", selection });
    actor.send({ type: "CONTINUE" });
    await wait("capture.idle");
    actor.send({ type: "RECORD" });
    await wait("capture.recording");
    actor.send({ type: "INTERRUPT" });
    await wait("capture.idle");
    expect(cancelCapture).toHaveBeenCalledTimes(1);
    expect(actor.getSnapshot().context.issue).toBe("guide_interrupted");
    actor.stop();
  });

  test("a late prepared guide cannot enter capture after selection changes", async () => {
    let finishPrepare!: (value: { guide: SoundtrackSelection; audio: GuideAudio }) => void;
    const startCapture = vi.fn(async prepared => ({ session, prepared }));
    const { actor, wait, inState } = fixture({
      prepareGuide: async () => new Promise(resolve => { finishPrepare = resolve; }),
      startCapture,
    });
    await wait("choosingSong");
    actor.send({ type: "SELECTION", selection });
    actor.send({ type: "CONTINUE" });
    await wait("capture.idle");
    actor.send({ type: "RECORD" });
    await wait("capture.preparingGuide");
    actor.send({ type: "SELECTION", selection: { ...selection, bounds: { startMs: 1000, endMs: 11_000 } } });
    finishPrepare({ guide: selection, audio: guide });
    await Promise.resolve();
    expect(inState("capture.idle")).toBe(true);
    expect(startCapture).not.toHaveBeenCalled();
    actor.stop();
  });

  test("rejected file inspection returns to capture without keeping a bad file", async () => {
    const { actor, wait } = fixture({ inspectFile: async () => { throw new Error("Invalid video"); } });
    await wait("choosingSong");
    actor.send({ type: "SELECTION", selection });
    actor.send({ type: "CONTINUE" });
    await wait("capture.idle");
    actor.send({ type: "FILE", file: take });
    await wait("capture.idle");
    expect(actor.getSnapshot().context.file).toBeNull();
    expect(actor.getSnapshot().context.error).toBe("Invalid video");
    actor.stop();
  });
});


test("finalization deadline aborts the whole invocation and ignores an old take after retaking", async () => {
  const clock = new SimulatedClock();
  const pending = deferred<{ file: File; durationMs: number; alignment: "aligned" }>();
  let signal: AbortSignal | undefined;
  let first = true;
  const flow = fixture({ finishCapture: async (_context, inputSignal) => {
    if (first) { first = false; signal = inputSignal; return pending.promise; }
    return { file: take, durationMs: 10_000, alignment: "aligned" };
  } }, clock);
  try {
    await flow.wait("choosingSong");
    flow.actor.send({ type: "SELECTION", selection });
    flow.actor.send({ type: "CONTINUE" }); await flow.wait("capture.idle");
    flow.actor.send({ type: "RECORD" }); await flow.wait("capture.recording");
    flow.actor.send({ type: "STOP" }); await flow.wait("capture.finalizing");
    clock.increment(29_999); expect(signal?.aborted).toBe(false);
    clock.increment(1);
    expect(flow.actor.getSnapshot().matches({ capture: "idle" })).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(flow.actor.getSnapshot().context.file).toBeNull();
    expect(flow.actor.getSnapshot().context.error).toBe("The recording couldn’t finish. Record again.");
    flow.actor.send({ type: "PUBLISH" }); expect(flow.publish).not.toHaveBeenCalled();
    flow.actor.send({ type: "RECORD" }); await flow.wait("capture.recording");
    flow.actor.send({ type: "STOP" }); await flow.wait("review");
    pending.resolve({ file: new File(["old"], "old.mp4"), durationMs: 1, alignment: "aligned" });
    await Promise.resolve(); await Promise.resolve();
    clock.increment(30_000);
    expect(flow.actor.getSnapshot().context.file).toBe(take);
    expect(flow.actor.getSnapshot().value).toBe("review");
    flow.actor.send({ type: "PUBLISH" }); await flow.wait("retained");
    expect(flow.publish).toHaveBeenCalledTimes(1);
  } finally { flow.actor.stop(); }
});
