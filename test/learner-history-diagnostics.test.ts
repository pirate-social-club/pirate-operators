import { test } from "node:test";
import assert from "node:assert/strict";
import { learnerHistoryDiagnostics } from "../services/learner-history.ts";

test("private capture diagnostics distinguish no frames from provider failure without exporting the relay", () => {
  const relay = {
    words: [{ text: "private recognized text" }],
    lastSequence: 94,
    lastAudioEndMs: 9400,
    resolvedThroughMs: 8000,
    sttSequence: 3,
    terminal: "stt_auth_error",
    failedLineIds: ["line-1", "line-2"],
    unrelatedSecret: "must remain private",
  };
  const snapshot = structuredClone(relay);
  const store = {
    get: <T>(key: string) =>
      (key === "audioRelay:known" ? relay : undefined) as T | undefined,
  };
  const diagnostic = learnerHistoryDiagnostics(store, "known");
  assert.equal(diagnostic.lastAudioSequence, 94);
  assert.equal(diagnostic.providerMessageSequence, 3);
  assert.equal(diagnostic.providerTerminal, "stt_auth_error");
  assert.equal(diagnostic.failedLineCount, 2);
  assert.equal(diagnostic.resolvedThroughMs, 8000);
  assert.equal(
    JSON.stringify(diagnostic).includes("private recognized text"),
    false,
  );
  assert.equal(
    JSON.stringify(diagnostic).includes("must remain private"),
    false,
  );
  assert.deepEqual(relay, snapshot);
  const absent = learnerHistoryDiagnostics(store, "missing");
  assert.equal(absent.lastAudioSequence, null);
  assert.equal(absent.providerMessageSequence, 0);
  assert.equal(absent.providerTerminal, null);
  assert.equal(absent.resolvedThroughMs, null);
  assert.equal(absent.feedbackThroughMs, null);
  assert.equal(absent.feedbackLineCount, 0);
  assert.equal(absent.feedbackLatestLineIndex, null);
  assert.equal(absent.attempt, null);
});

test("private diagnostics expose only playback and feedback boundaries from retained state", () => {
  const entries = new Map<string, unknown>([
    ["feedbackWatermark:known", 7200],
    [
      "feedback:known",
      { lineScores: [{ scoredLineIndex: 0, score: 1 }], secret: "hidden" },
    ],
    [
      "attempt:known",
      {
        startedAt: 100,
        connected: true,
        disconnectedAt: null,
        lastAudioAt: 107,
        ended: {
          endedAt: 275,
          performanceEndedAt: 275,
          status: "completed",
          paymentDeadline: 285,
        },
        secret: "hidden",
      },
    ],
  ]);
  const original = structuredClone(entries);
  const diagnostic = learnerHistoryDiagnostics(
    { get: <T>(key: string) => entries.get(key) as T | undefined },
    "known",
  );
  assert.equal(diagnostic.feedbackThroughMs, 7200);
  assert.equal(diagnostic.feedbackLineCount, 1);
  assert.equal(diagnostic.feedbackLatestLineIndex, 0);
  assert.deepEqual(diagnostic.attempt, {
    startedAt: 100,
    connected: true,
    disconnectedAt: null,
    lastAudioAt: 107,
    endedAt: 275,
    performanceEndedAt: 275,
    endStatus: "completed",
  });
  assert.ok(!JSON.stringify(diagnostic).includes("hidden"));
  assert.ok(!JSON.stringify(diagnostic).includes("paymentDeadline"));
  assert.deepEqual(entries, original);
});
