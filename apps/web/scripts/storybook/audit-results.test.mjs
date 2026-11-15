import vm from "node:vm";
import { installAuditChannel } from "./audit-channel.mjs";
import { captureAndClassify, createHostEvidence } from "./audit-observation.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { classify, parseIndex, sizesFor, summarize } from "./audit-results.mjs";

const size = { width: 390, height: 844 };
const phase = (name, width = 390, height = 844) => ({
  storyId: "screen--ready", phase: name, width, height,
});
function evidence() {
  return {
    phases: [phase("rendering"), phase("playing"), phase("played"), phase("completed")],
    events: [{
      name: "storyFinished", storyId: "screen--ready",
      payload: {
        storyId: "screen--ready", status: "success",
        reporters: [{
          type: "a11y", status: "passed",
          result: { violations: [], passes: [{ id: "label" }], incomplete: [{ id: "contrast" }] },
        }],
      },
    }],
  };
}
const check = (state, errors) => classify("screen--ready", state, size, errors);
test("completed execution retains incomplete axe checks separately", () => {
  const result = check(evidence());
  assert.equal(result.passed, true);
  assert.equal(result.axe.incomplete, 1);
});
test("missing, duplicate and stale-story completion fail", () => {
  for (const events of [[], [...evidence().events, ...evidence().events],
    [{ ...evidence().events[0], storyId: "other", payload: { storyId: "other" } }]]) {
    assert.equal(check({ ...evidence(), events }).passed, false);
  }
});
test("render, play and unhandled failures cannot hide behind successful finish", () => {
  for (const name of ["storyErrored", "storyThrewException",
    "playFunctionThrewException", "unhandledErrorsWhilePlaying"]) {
    const state = evidence();
    state.events.push({ name, storyId: "screen--ready", payload: { message: "failed" } });
    assert.equal(check(state).passed, false);
  }
  assert.equal(check(evidence(), ["uncaught page failure"]).passed, false);
});
test("missing reporter, disabled scan and malformed axe evidence fail", () => {
  for (const reporters of [[], [{ type: "a11y", status: "passed" }],
    [{ type: "a11y", status: "passed", result: { violations: [] } }],
    [{ type: "a11y", status: "passed", result: { violations: [], passes: [], incomplete: [] } }]]) {
    const state = evidence();
    state.events[0].payload.reporters = reporters;
    assert.equal(check(state).passed, false);
  }
});
test("axe violations and non-a11y reporter failure fail", () => {
  const state = evidence();
  state.events[0].payload.reporters[0].result.violations.push({ id: "label" });
  assert.equal(check(state).passed, false);
  const other = evidence();
  other.events[0].payload.reporters.push({ type: "interaction", status: "failed" });
  assert.equal(check(other).passed, false);
});
test("wrong initial size, wrong height and a second run all fail", () => {
  for (const phases of [
    [phase("rendering", 1440, 1000), phase("playing"), phase("completed")],
    [phase("rendering"), phase("playing"), phase("completed", 390, 600)],
    [...evidence().phases, ...evidence().phases],
    [],
  ]) assert.equal(check({ ...evidence(), phases }).passed, false);
});
test("stories without play still require render and completion evidence", () => {
  assert.equal(check({ ...evidence(), phases: [phase("rendering"), phase("completed")] }).passed, true);
});
test("index rejects empty, malformed, non-app and duplicate selections", () => {
  const entry = { type: "story", id: "a--b", importPath: "./src/a.stories.tsx" };
  assert.equal(parseIndex({ entries: { a: entry } }).length, 1);
  for (const index of [{}, { entries: {} }, { entries: { a: { ...entry, id: undefined } } },
    { entries: { a: { ...entry, importPath: "./test/reference.txt" } } },
    { entries: { a: entry, b: entry } }]) {
    assert.throws(() => parseIndex(index));
  }
});
test("default matrix and declared viewport dimensions are explicit", () => {
  assert.deepEqual(sizesFor({}, {}).map(({ width, height }) => [width, height]),
    [[390, 844], [1440, 1000]]);
  const metadata = {
    globalsViewport: { value: "phone", isRotated: true },
    parameterViewport: { options: { phone: { styles: { width: "390px", height: "844px" } } } },
  };
  assert.deepEqual(sizesFor(metadata, {})[0], {
    name: "phone", width: 844, height: 390, global: metadata.globalsViewport,
  });
  assert.throws(() => sizesFor(null, {}));
  assert.throws(() => sizesFor({ globalsViewport: { value: "unknown" } }, {}));
  assert.throws(() => sizesFor({ parameterViewport: { defaultViewport: "phone" } }, {}));
});
test("empty, partial, duplicate and extra result ledgers cannot pass", () => {
  const result = { key: "a@phone", ...check(evidence()) };
  assert.equal(summarize({ expected: [result.key], results: [result] }).passed, true);
  for (const run of [
    {}, { expected: ["a@phone", "b@phone"], results: [result] },
    { expected: ["a@phone", "b@phone"], results: [result, result] },
    { expected: [result.key], results: [result, { ...result, key: "extra" }] },
    { expected: [result.key], results: [result], startupError: "failed" },
  ]) assert.equal(summarize(run).passed, false);
});

// Orchestration regressions exercise the same capture/finalize helper used
// by runStory. All ports below are explicit simulations, not a real browser.
function observationScenario() {
  const sandbox = {
    URL, Date, structuredClone,
    location: { href: "http://127.0.0.1:6176/iframe.html?id=screen--ready" },
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
  for (const newPhase of ["rendering", "playing", "played", "completed"]) {
    channel.emit("storyRenderPhaseChanged", { storyId: "screen--ready", newPhase });
  }
  const payload = evidence().events[0].payload;
  channel.emit("storyFinished", payload);
  const host = createHostEvidence();
  return {
    host, channel, payload, sandbox,
    closeWindow: async () => host.close(sandbox.__PIRATE_STORY_AUDIT__.seal(), size),
  };
}
const lateCases = [
  ["page error", (scope) => scope.host.record("errors", "late page error")],
  ["story failure with reused completion object", (scope) =>
    scope.channel.emit("storyErrored", scope.payload)],
  ["blocked HTTP request", (scope) => scope.host.record("blocked", {
    kind: "request", origin: "https://fixture.invalid", pathname: "/late",
  })],
  ["blocked WebSocket", (scope) => scope.host.record("blocked", {
    kind: "websocket", origin: "wss://fixture.invalid", pathname: "/late",
  })],
  ["duplicate completion with reused object", (scope) =>
    scope.channel.emit("storyFinished", scope.payload)],
  ["second render", (scope) => scope.channel.emit("storyRenderPhaseChanged", {
    storyId: "screen--ready", newPhase: "rendering",
  })],
];
for (const [name, inject] of lateCases) {
  test("capture-time " + name + " invalidates an earlier successful finish", async () => {
    const scope = observationScenario();
    assert.equal(classify("screen--ready",
      scope.sandbox.__PIRATE_STORY_AUDIT__, size).passed, true);
    const result = await captureAndClassify({
      id: "screen--ready", size, metadata: { key: "screen--ready@phone" },
      capture: async () => {
        await Promise.resolve();
        inject(scope);
        return { path: "simulated.png", sha256: "simulated-capture" };
      },
      closeWindow: scope.closeWindow,
    });
    assert.equal(result.passed, false);
    assert.equal(result.raw.closed, true);
    assert.equal(result.observationWindow.captureSettledBeforeClose, true);
    assert.ok(result.failures.length > 0);
  });
}
test("successful final record is immutable and not backed by live event buffers", async () => {
  const scope = observationScenario();
  const result = await captureAndClassify({
    id: "screen--ready", size, metadata: { key: "screen--ready@phone", size },
    capture: async () => ({ path: "simulated.png", sha256: "simulated-capture" }),
    closeWindow: scope.closeWindow,
  });
  assert.equal(result.passed, true);
  scope.host.record("errors", "outside explicitly closed window");
  scope.channel.emit("storyErrored", scope.payload);
  scope.payload.status = "error";
  assert.equal(result.errors.length, 0);
  assert.equal(result.raw.events.length, 1);
  assert.equal(result.raw.events[0].payload.status, "success");
  assert.throws(() => result.errors.push("mutation"), TypeError);
  assert.throws(() => { result.raw.events[0].payload.status = "error"; }, TypeError);
});
test("capture rejection still closes evidence and cannot return a passing record", async () => {
  const scope = observationScenario();
  const result = await captureAndClassify({
    id: "screen--ready", size, metadata: {},
    capture: async () => { throw new Error("capture failed"); },
    closeWindow: scope.closeWindow,
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes("screenshot_missing"));
  assert.ok(result.errors.includes("capture failed"));
  assert.equal(result.raw.closed, true);
});
test("an unclosed channel observation cannot qualify", async () => {
  const scope = observationScenario();
  const result = await captureAndClassify({
    id: "screen--ready", size, metadata: {},
    capture: async () => ({ path: "simulated.png", sha256: "simulated-capture" }),
    closeWindow: async () => scope.host.close(evidence(), size),
  });
  assert.equal(result.passed, false);
  assert.ok(result.errors.includes("Observation window did not close"));
});
