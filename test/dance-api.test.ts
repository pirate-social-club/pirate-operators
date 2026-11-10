import test from "node:test";
import assert from "node:assert/strict";
import { decodeDanceDecision } from "../packages/dance/commands.ts";
test("pure request boundary normalizes exact categorical vocabulary and refuses body authority/time/score", () => {
  assert.equal(
    decodeDanceDecision({
      commandId: "c",
      revision: 1,
      verdict: "pass",
      consentVersion: "reviewer-policy-v5",
    }).verdict,
    "pass",
  );
  for (const body of [
    { commandId: "c", revision: 1, verdict: "passed" },
    { commandId: "c", revision: 1, verdict: "pass", actorId: "owner" },
    { commandId: "c", revision: 1, verdict: "pass", committedAtMs: 1 },
    { commandId: "c", revision: 1, verdict: "pass", score: 100 },
  ])
    assert.throws(() => decodeDanceDecision(body));
});
