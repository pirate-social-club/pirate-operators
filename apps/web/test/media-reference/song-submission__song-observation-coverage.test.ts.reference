import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createActor, SimulatedClock } from "xstate";
import { expect, test, vi } from "vitest";
import type { MediaSubmissionSnapshot } from "../media-submission/contracts";
import type { SongSubmissionView } from "../media-submission/projection";
import { createSongObservationMachine, type SongObservationSource } from "./song-observation-machine";

type StoryName = keyof typeof import("../../communities/community-page/community-page-posting.stories");
const coverage = {
  starting: { internal: "Eventless initial routing selects held observation without replacing a terminal outcome." },
  routing: { internal: "Eventless routing projects each server outcome into a wait, author action or settlement." },
  waiting: { story: "SongMovesThroughItsStages" },
  reading: { story: "SongStatusUnanswered" },
  waitingForAuthor: { story: "SongNeedsOriginal" },
  bindingOriginal: { story: "SongOriginalUnanswered" },
  rerunning: { story: "SongProcessingFailedThenRerun" },
  held: { internal: "Session suspension preserves the known song outcome; account clearing belongs to the store tests." },
  settled: { story: "SongMovesThroughItsStages" },
} as const satisfies Record<string, { story: StoryName } | { internal: string }>;
type CoveredState = keyof typeof coverage;

const processing: SongSubmissionView = { status: "processing", submissionId: "song-one", phase: "analysis" };
const actionRequired: SongSubmissionView = {
  status: "action_required", submissionId: "song-one", referenceRequestRef: "reference-one", expiresAt: "2099-01-01T00:00:00Z",
};
const failure: SongSubmissionView = { status: "processing_failed", submissionId: "song-one", reasonCode: "transform_failed", retryable: true };
const published: SongSubmissionView = { status: "published", submissionId: "song-one", postId: "post-one", postHref: "/posts/post-one" };

function snapshot(patch: Partial<MediaSubmissionSnapshot>): MediaSubmissionSnapshot {
  // SAFETY: This actor invokes only the existing song projection, and each fixture
  // supplies the fields that projection reads for its status. No wire decoding
  // or transport uses these partial fixtures; wire conformance is not claimed.
  return { submission_id: "song-one", track: "song", status: "processing", phase: "analysis", ...patch } as MediaSubmissionSnapshot;
}
const processingAnswer = snapshot({ status: "processing", phase: "analysis" });
const publishedAnswer = snapshot({ status: "published", published_resource: { post_id: "post-one", href: "/posts/post-one" } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); };

function fixture(view: SongSubmissionView = processing, held = false) {
  const read = deferred<MediaSubmissionSnapshot | null>();
  const command = deferred<MediaSubmissionSnapshot>();
  const signals = new Set<AbortSignal>();
  const receivedSignals: (AbortSignal | undefined)[] = [];
  const own = <T>(work: Promise<T>, signal?: AbortSignal) => {
    receivedSignals.push(signal);
    if (signal) {
      signals.add(signal);
      void work.then(() => signals.delete(signal), () => signals.delete(signal));
    }
    return work;
  };
  const source = {
    refresh: vi.fn((signal?: AbortSignal) => own(read.promise, signal)),
    retry: vi.fn((signal?: AbortSignal) => own(command.promise, signal)),
    bindOriginal: vi.fn((_link: string, signal?: AbortSignal) => own(command.promise, signal)),
    hasPendingOriginal: () => false,
  } satisfies SongObservationSource;
  const machine = createSongObservationMachine(source, 100, 1_000);
  const clock = new SimulatedClock();
  const actor = createActor(machine, { clock, input: { view, held } });
  return { actor, machine, clock, source, read, command, signals, receivedSignals };
}

test("every song observer state has a story or a documented internal projection", () => {
  const flow = fixture();
  expect(Object.keys(coverage).sort()).toEqual(Object.keys(flow.machine.states).sort());
  const stories = readFileSync(resolve(import.meta.dirname, "../../communities/community-page/community-page-posting.stories.tsx"), "utf8");
  for (const row of Object.values(coverage)) {
    if ("story" in row) expect(stories).toMatch(new RegExp(`export const ${row.story}\\b`));
    else expect(row.internal.trim().length).toBeGreaterThan(0);
  }
});

// SAFETY: Object.keys reads only this local literal, whose own keys define CoveredState.
test.each(Object.keys(coverage) as CoveredState[])("song coverage executes %s", async state => {
  const view = state === "waitingForAuthor" || state === "bindingOriginal" ? actionRequired
    : state === "rerunning" ? failure : state === "settled" ? published : processing;
  const flow = fixture(view, state === "held");
  try {
    if (state === "starting") {
      expect(flow.machine.config.initial).toBe("starting");
      for (const [initial, held, expected] of [[processing, false, "waiting"], [processing, true, "held"], [published, true, "settled"]] as const) {
        const branch = fixture(initial, held);
        try {
          branch.actor.start();
          expect(branch.actor.getSnapshot().value).toBe(expected);
          expect(branch.actor.getSnapshot().context.view).toBe(initial);
          expect(branch.source.refresh).not.toHaveBeenCalled();
        } finally { branch.actor.stop(); }
      }
      return;
    }
    if (state === "routing") {
      // Eventless nodes are not stable snapshots. Verify their incoming and
      // outgoing edges as well as the actual projected destinations below.
      expect(flow.machine.config.states?.starting?.always).toEqual(expect.arrayContaining([expect.objectContaining({ target: "routing" })]));
      expect(flow.machine.config.states?.routing?.always).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: "settled" }),
        expect.objectContaining({ target: "waitingForAuthor" }),
        expect.objectContaining({ target: "waiting" }),
      ]));
      expect(flow.machine.config.states?.reading?.invoke).toEqual(expect.objectContaining({
        onDone: expect.arrayContaining([expect.objectContaining({ target: "routing" })]),
      }));
      const outcomes = [
        [processingAnswer, "waiting"],
        [snapshot({ status: "manual_review", reason_code: "review_required", review_ref: "review-one" }), "waiting"],
        [snapshot({ status: "action_required", action: { kind: "reference_required", reference_request_ref: "reference-one", expires_at: actionRequired.expiresAt } }), "waitingForAuthor"],
        [snapshot({ status: "processing_failed", reason_code: "transform_failed", retryable: true }), "waitingForAuthor"],
        [publishedAnswer, "settled"],
        [snapshot({ status: "blocked", reason_code: "policy_violation" }), "settled"],
        [snapshot({ status: "abandoned", reason_code: "author_cancelled_before_finalize" }), "settled"],
      ] as const;
      for (const [answer, expected] of outcomes) {
        const branch = fixture();
        try {
          branch.actor.start(); branch.actor.send({ type: "CHECK" });
          expect(branch.actor.getSnapshot().value).toBe("reading");
          branch.read.resolve(answer); await settle();
          expect(branch.actor.getSnapshot().value).toBe(expected);
          expect(branch.actor.getSnapshot().context.view.status).toBe(answer.status);
          expect(branch.actor.getSnapshot().context.failures).toBe(0);
          expect(branch.source.retry).not.toHaveBeenCalled();
        } finally { branch.actor.stop(); }
      }
      return;
    }
    flow.actor.start();
    if (state === "reading") flow.actor.send({ type: "CHECK" });
    if (state === "bindingOriginal") flow.actor.send({ type: "BIND_ORIGINAL", link: "/posts/original" });
    if (state === "rerunning") flow.actor.send({ type: "RETRY" });
    expect(flow.actor.getSnapshot().value).toBe(state);
    expect(flow.actor.getSnapshot().context.view).toBe(view);
    if (state === "waiting") {
      flow.clock.increment(100);
      expect(flow.actor.getSnapshot().value).toBe("reading");
      expect(flow.source.refresh).toHaveBeenCalledTimes(1);
    } else if (state === "reading") {
      expect(flow.source.refresh).toHaveBeenCalledTimes(1);
      flow.clock.increment(1_000);
      expect(flow.actor.getSnapshot().value).toBe("waiting");
      expect(flow.actor.getSnapshot().context.view).toBe(processing);
      expect(flow.actor.getSnapshot().context.failures).toBe(1);
      expect([...flow.signals].every(signal => signal.aborted)).toBe(true);
      flow.read.resolve(publishedAnswer); await settle();
      expect(flow.actor.getSnapshot().context.view).toBe(processing);
    } else if (state === "waitingForAuthor") {
      flow.clock.increment(999); expect(flow.source.refresh).not.toHaveBeenCalled();
      flow.clock.increment(1); expect(flow.actor.getSnapshot().value).toBe("reading");
      expect(flow.source.bindOriginal).not.toHaveBeenCalled();
    } else if (state === "bindingOriginal") {
      flow.actor.send({ type: "BIND_ORIGINAL", link: "/posts/replacement" });
      expect(flow.source.bindOriginal).toHaveBeenCalledTimes(1);
      expect(flow.actor.getSnapshot().context.originalLink).toBe("/posts/original");
      flow.clock.increment(1_000);
      expect(flow.actor.getSnapshot().value).toBe("reading");
      expect(flow.actor.getSnapshot().context.originalError).toContain("unanswered");
      flow.command.resolve(processingAnswer); await settle();
      expect(flow.actor.getSnapshot().value).toBe("reading");
      expect(flow.source.bindOriginal).toHaveBeenCalledTimes(1);
    } else if (state === "rerunning") {
      flow.actor.send({ type: "RETRY" }); expect(flow.source.retry).toHaveBeenCalledTimes(1);
      flow.clock.increment(1_000);
      expect(flow.actor.getSnapshot().value).toBe("reading");
      expect(flow.source.retry).toHaveBeenCalledTimes(1);
      flow.read.resolve(processingAnswer); await settle();
      expect(flow.actor.getSnapshot().value).toBe("waiting");
      expect(flow.actor.getSnapshot().context.view.status).toBe("processing");
    } else if (state === "held") {
      flow.clock.increment(60_000); expect(flow.source.refresh).not.toHaveBeenCalled();
      flow.actor.send({ type: "RESUME" }); expect(flow.actor.getSnapshot().value).toBe("reading");
      flow.actor.send({ type: "PAUSE" }); expect(flow.actor.getSnapshot().value).toBe("held");
      expect([...flow.signals].every(signal => signal.aborted)).toBe(true);
      flow.read.resolve(publishedAnswer); await settle();
      expect(flow.actor.getSnapshot().context.view).toBe(processing);
    } else if (state === "settled") {
      expect(flow.actor.getSnapshot().status).toBe("done");
      flow.clock.increment(60_000); flow.actor.send({ type: "CHECK" });
      expect(flow.source.refresh).not.toHaveBeenCalled();
    }
  } finally {
    flow.actor.stop();
    // Assert outside invoked callbacks so actor error handling cannot swallow it.
    for (const signal of flow.receivedSignals) expect(signal).toBeInstanceOf(AbortSignal);
    expect([...flow.signals].every(signal => signal.aborted)).toBe(true);
  }
});
