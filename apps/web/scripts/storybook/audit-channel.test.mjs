import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installAuditChannel } from "./audit-channel.mjs";
import { classify } from "./audit-results.mjs";

function setup() {
  const sandbox = {
    URL, Date, structuredClone, location: { href: "http://127.0.0.1:6176/iframe.html?id=a--b" },
    innerWidth: 390, innerHeight: 844,
  };
  vm.runInNewContext("(" + installAuditChannel.toString() + ")()", sandbox);
  const listeners = new Map();
  const channel = {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    },
  };
  sandbox.__STORYBOOK_ADDONS_CHANNEL__ = channel;
  return { sandbox, channel };
}

test("captures immediate completion after channel assignment exactly once", () => {
  const { sandbox, channel } = setup();
  channel.emit("storyFinished", { storyId: "a--b", status: "success" });
  assert.equal(sandbox.__PIRATE_STORY_AUDIT__.channelReady, true);
  assert.equal(sandbox.__PIRATE_STORY_AUDIT__.events.length, 1);
});
test("captures actual dimensions at each emitted phase", () => {
  const { sandbox, channel } = setup();
  channel.emit("storyRenderPhaseChanged", { storyId: "a--b", newPhase: "rendering" });
  sandbox.innerHeight = 600;
  channel.emit("storyRenderPhaseChanged", { storyId: "a--b", newPhase: "completed" });
  const phases = sandbox.__PIRATE_STORY_AUDIT__.phases;
  assert.equal(phases.length, 2);
  assert.equal(phases[0].height, 844);
  assert.equal(phases[1].height, 600);
});
test("preserves explicit foreign story attribution for result filtering", () => {
  const { sandbox, channel } = setup();
  channel.emit("storyFinished", { storyId: "other--story", status: "success" });
  assert.equal(sandbox.__PIRATE_STORY_AUDIT__.events[0].storyId, "other--story");
});
test("preserves render and play failure events without a finished payload", () => {
  const { sandbox, channel } = setup();
  channel.emit("playFunctionThrewException", { message: "assertion" });
  channel.emit("storyErrored", { storyId: "a--b", message: "render" });
  assert.equal(sandbox.__PIRATE_STORY_AUDIT__.events.length, 2);
  assert.equal(sandbox.__PIRATE_STORY_AUDIT__.events[0].storyId, "a--b");
});

function successfulPayload() {
  return {
    storyId: "a--b", status: "success",
    reporters: [{
      type: "a11y", status: "passed",
      result: { violations: [], passes: [{ id: "label" }], incomplete: [] },
    }],
  };
}
function completedPhases(channel) {
  for (const newPhase of ["rendering", "playing", "played", "completed"]) {
    channel.emit("storyRenderPhaseChanged", { storyId: "a--b", newPhase });
  }
}
test("distinct emits sharing one completion object remain duplicate completions", () => {
  const { sandbox, channel } = setup();
  completedPhases(channel);
  const payload = successfulPayload();
  channel.emit("storyFinished", payload);
  channel.emit("storyFinished", payload);
  const state = sandbox.__PIRATE_STORY_AUDIT__.seal();
  assert.equal(state.events.length, 2);
  assert.notEqual(state.events[0].dispatchId, state.events[1].dispatchId);
  const result = classify("a--b", state, { width: 390, height: 844 });
  assert.ok(result.failures.includes("missing_or_duplicate_completion"));
});
test("completion then failure reusing its mutated object retains both observations", () => {
  const { sandbox, channel } = setup();
  completedPhases(channel);
  const payload = successfulPayload();
  channel.emit("storyFinished", payload);
  payload.status = "error";
  channel.emit("storyErrored", payload);
  const state = sandbox.__PIRATE_STORY_AUDIT__.seal();
  assert.equal(state.events.length, 2);
  assert.equal(state.events[0].payload.status, "success");
  assert.equal(state.events[1].name, "storyErrored");
  assert.equal(classify("a--b", state, { width: 390, height: 844 }).passed, false);
});
test("nested dispatch sharing a payload suppresses each local echo only", () => {
  const { sandbox, channel } = setup();
  completedPhases(channel);
  let nested = false;
  channel.on("storyFinished", (payload) => {
    if (!nested) {
      nested = true;
      channel.emit("storyFinished", payload);
    }
  });
  channel.emit("storyFinished", successfulPayload());
  const state = sandbox.__PIRATE_STORY_AUDIT__.seal();
  assert.equal(state.events.length, 2);
  assert.equal(classify("a--b", state, { width: 390, height: 844 }).passed, false);
});
test("closed browser evidence is detached from later dispatches and payload mutations", () => {
  const { sandbox, channel } = setup();
  const payload = successfulPayload();
  channel.emit("storyFinished", payload);
  const final = sandbox.__PIRATE_STORY_AUDIT__.seal();
  payload.status = "error";
  channel.emit("storyErrored", payload);
  assert.equal(final.closed, true);
  assert.equal(final.events.length, 1);
  assert.equal(final.events[0].payload.status, "success");
});
