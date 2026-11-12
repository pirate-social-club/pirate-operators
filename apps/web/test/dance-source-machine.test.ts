/** UNRUN. Original c7 statechart assertions on the actual copied XState actor. */
import test from "node:test";
import assert from "node:assert/strict";
import { createActor, waitFor } from "xstate";
import { createDanceRecorderMachine } from "../src/dance/source/dance-recorder-machine.ts";
import type {
  createDanceRecorder,
  DanceRecorderView,
} from "../src/dance/source/dance-recorder.ts";
import { simulatedSource, consent } from "./dance-source-fixtures.ts";

function harness() {
  const f = simulatedSource(),
    calls: string[] = [];
  const camera: DanceRecorderView = {
    kind: "camera",
    ready: f.ready,
    stream: {} as MediaStream,
  };
  const processing: DanceRecorderView = {
    kind: "upload",
    upload: { kind: "processing", session: f.session },
  };
  const review: DanceRecorderView = {
    kind: "upload",
    upload: { kind: "review", session: f.session },
  };
  const recorder: ReturnType<typeof createDanceRecorder> = {
    prepare: async () => {
      calls.push("prepare");
      return { kind: "objectives", session: null, context: { consent } };
    },
    enter: async () => {
      calls.push("enter");
      return camera;
    },
    record: async () => {
      calls.push("record");
      return processing;
    },
    observe: async () => {
      calls.push("observe");
      return review;
    },
    recover: async () => {
      calls.push("recover");
      return processing;
    },
    resume: async () => {
      calls.push("resume");
      return processing;
    },
    newAttempt: async () => {
      calls.push("newAttempt");
      return camera;
    },
    localPreview: async () => null,
    pause: () => {
      calls.push("pause");
    },
    dispose: () => {},
    cancelBeforeTake: async () => {},
  };
  const actor = createActor(
    createDanceRecorderMachine({
      recorder,
      termsHash: consent.termsHash,
      pause: recorder.pause,
    }),
  );
  return { ...f, actor, recorder, calls, camera, processing, review };
}
test("one explicit acceptance precedes camera; duplicate Record/Resume cannot overlap capture", async () => {
  const h = harness();
  h.actor.start();
  try {
    await waitFor(h.actor, (s) => s.matches("objectives"));
    assert.equal(h.calls.includes("enter"), false);
    h.actor.send({ type: "RECORD" });
    assert.equal(h.calls.includes("record"), false);
    h.actor.send({ type: "ACCEPT" });
    h.actor.send({ type: "ACCEPT" });
    await waitFor(h.actor, (s) => s.matches("camera"));
    let done!: (v: DanceRecorderView) => void;
    h.recorder.record = async () => {
      h.calls.push("record");
      return new Promise((r) => {
        done = r;
      });
    };
    h.actor.send({ type: "RECORD" });
    h.actor.send({ type: "RECORD" });
    h.actor.send({ type: "RESUME" });
    assert.equal(h.calls.filter((c) => c === "record").length, 1);
    assert.equal(h.calls.includes("resume"), false);
    done(h.processing);
    await waitFor(h.actor, (s) => s.matches("review"));
    assert.equal(h.calls.filter((c) => c === "observe").length, 1);
    assert.equal(h.calls.includes("recover"), false);
    assert.equal(h.ports.client.submit === undefined, false);
    assert.equal(h.calls.includes("submit"), false);
  } finally {
    h.actor.stop();
  }
});
test("background aborts the actual invocation, ignores late output, foreground only observes", async () => {
  const h = harness();
  let finish!: (v: DanceRecorderView) => void, signal!: AbortSignal;
  h.recorder.observe = async (_session, pending) => {
    h.calls.push("observe");
    signal = pending;
    return new Promise((r) => {
      finish = r;
    });
  };
  h.actor.start();
  try {
    await waitFor(h.actor, (s) => s.matches("objectives"));
    h.actor.send({ type: "ACCEPT" });
    await waitFor(h.actor, (s) => s.matches("camera"));
    h.actor.send({ type: "RECORD" });
    await waitFor(h.actor, (s) => s.matches({ processing: "reading" }));
    h.actor.send({ type: "BACKGROUND" });
    assert.equal(signal.aborted, true);
    finish(h.review);
    await Promise.resolve();
    assert.equal(h.actor.getSnapshot().matches("paused"), true);
    h.recorder.observe = async () => {
      h.calls.push("observe");
      return h.review;
    };
    h.actor.send({ type: "FOREGROUND" });
    await waitFor(h.actor, (s) => s.matches("review"));
    assert.equal(h.calls.filter((c) => c === "observe").length, 2);
    assert.equal(h.calls.includes("resume"), false);
    assert.equal(h.calls.includes("recover"), false);
  } finally {
    h.actor.stop();
  }
});
test("access loss clears actual actor view/review and stops private playback ownership", async () => {
  const h = harness();
  h.actor.start();
  try {
    await waitFor(h.actor, (s) => s.matches("objectives"));
    h.actor.send({ type: "ACCEPT" });
    await waitFor(h.actor, (s) => s.matches("camera"));
    h.actor.send({ type: "ACCESS_LOST" });
    const s = h.actor.getSnapshot();
    assert.equal(s.context.view, null);
    assert.equal(s.context.review, null);
    assert.equal(h.calls.includes("pause"), true);
    h.actor.send({ type: "RECORD" });
    assert.equal(h.calls.includes("record"), false);
  } finally {
    h.actor.stop();
  }
});
