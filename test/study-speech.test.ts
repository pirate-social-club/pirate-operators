import test from "node:test";
import assert from "node:assert/strict";
import {
  makeStudyTranscriber,
  StudySpeechError,
  STUDY_SPEECH_ENDPOINT,
} from "../packages/study/speech-transcriber.ts";

const audio = new Uint8Array([1, 2, 3]);
test("Scribe transport pins model, retention, server credential and language without disclosing the reference", async () => {
  const transcriber = makeStudyTranscriber(
    "local-fixture-key",
    async (input, init) => {
      assert.equal(input, STUDY_SPEECH_ENDPOINT);
      assert.equal(init?.redirect, "manual");
      assert.equal(
        new Headers(init?.headers).get("xi-api-key"),
        "local-fixture-key",
      );
      const form = init?.body as FormData;
      assert.equal(form.get("model_id"), "scribe_v2");
      assert.equal(form.get("language_code"), "en");
      assert.equal(form.get("timestamps_granularity"), "none");
      assert.equal(form.get("reference"), null);
      return Response.json({
        text: "Hold me close",
        language_code: "en",
        language_probability: 0.99,
      });
    },
  );
  assert.equal(transcriber.providerRetention, "stored");
  assert.deepEqual(await transcriber.transcribe(audio, "audio/webm", "en-US"), {
    text: "Hold me close",
    language: "en",
    languageConfidence: 0.99,
  });
});
test("provider refusals and uncertain outcomes remain distinct, including malformed successful responses", async () => {
  for (const [status, outcome] of [
    [429, "known_failed"],
    [401, "known_failed"],
    [503, "unknown"],
    [408, "unknown"],
  ] as const) {
    await assert.rejects(
      makeStudyTranscriber(
        "fixture",
        async () => new Response("not retained", { status }),
      ).transcribe(audio, "audio/webm", "und"),
      (e: unknown) => e instanceof StudySpeechError && e.outcome === outcome,
    );
  }
  for (const body of [
    "not json",
    JSON.stringify({ text: "x".repeat(4097) }),
    JSON.stringify({ text: "x", language_probability: 2 }),
    "null",
  ]) {
    await assert.rejects(
      makeStudyTranscriber(
        "fixture",
        async () => new Response(body),
      ).transcribe(audio, "audio/webm", "und"),
      StudySpeechError,
    );
  }
});
test("body deadline cancels stalled streams and byte limits stop oversized provider output", async () => {
  let cancelled = false;
  await assert.rejects(
    makeStudyTranscriber(
      "fixture",
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      20,
    ).transcribe(audio, "audio/webm", "en"),
    /speech_timeout/,
  );
  assert.equal(cancelled, true);
  cancelled = false;
  await assert.rejects(
    makeStudyTranscriber(
      "fixture",
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(65537));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    ).transcribe(audio, "audio/webm", "en"),
    /speech_invalid_response/,
  );
  assert.equal(cancelled, true);
});
