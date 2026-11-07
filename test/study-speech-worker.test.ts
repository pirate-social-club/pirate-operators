import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { STUDY_SPEECH_ENDPOINT } from "../packages/study/speech-transcriber.ts";

test("Study uses actual Worker fetch and refuses redirects without forwarding its credential", async () => {
  const output = await build({
    stdin: {
      contents: `import {makeStudyTranscriber} from './packages/study/speech-transcriber.ts';
        export default {async fetch(){try {
          const transcript = await makeStudyTranscriber('local-fixture-key').transcribe(new Uint8Array([1,2,3]),'audio/webm','en');
          return Response.json({transcript});
        } catch(error) {
          return Response.json({error:error.code,outcome:error.outcome},{status:503});
        }}};`,
      resolveDir: process.cwd(),
      sourcefile: "study-speech-worker-fixture.ts",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2024",
    logLevel: "silent",
  });
  let redirect = false;
  const calls: string[] = [];
  const runtime = new Miniflare({
    modules: true,
    script: output.outputFiles[0]!.text,
    // The pinned local binary's latest supported date, not the deployed date.
    compatibilityDate: "2026-08-06",
    outboundService: async (request: {
      url: string;
      headers: { get(name: string): string | null };
    }) => {
      calls.push(request.url);
      assert.equal(request.url, STUDY_SPEECH_ENDPOINT);
      assert.equal(request.headers.get("xi-api-key"), "local-fixture-key");
      return redirect
        ? new Response(null, {
            status: 302,
            headers: { location: "https://different-provider.invalid/" },
          })
        : Response.json({ text: "Hold me close", language_code: "en" });
    },
  });
  try {
    const response = await runtime.dispatchFetch("https://fixture.example/");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(result, {
      transcript: { text: "Hold me close", language: "en" },
    });
    assert.deepEqual(calls, [STUDY_SPEECH_ENDPOINT]);
    redirect = true;
    const refused = await runtime.dispatchFetch("https://fixture.example/");
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), {
      error: "speech_unavailable",
      outcome: "unknown",
    });
    assert.deepEqual(calls, [STUDY_SPEECH_ENDPOINT, STUDY_SPEECH_ENDPOINT]);
  } finally {
    await runtime.dispose();
  }
});
