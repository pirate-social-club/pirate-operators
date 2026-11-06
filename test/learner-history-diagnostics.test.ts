import { test } from "node:test";
import assert from "node:assert/strict";
import { learnerHistoryDiagnostics } from "../services/learner-history.ts";

test("private capture diagnostics distinguish no frames from provider failure without exporting the relay", () => {
  const relay = {
    words: [{ text: "private recognized text" }],
    lastSequence: 94,
    lastAudioEndMs: 9400,
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
});
