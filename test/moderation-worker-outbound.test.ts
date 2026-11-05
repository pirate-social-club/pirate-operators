import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("production ACR and OpenAI adapters in workerd retain redirect responses and never forward credentials", async () => {
  const source = `
    import {identifyMp3} from './packages/moderation/acrcloud.ts';
    import {moderateText,classifyLyrics} from './packages/moderation/openai.ts';
    export default {async fetch(){
      let receipts=0; const received=async()=>{receipts++}, outcomes=[];
      for(const run of [
        ()=>identifyMp3(new Uint8Array([1,2,3]),{host:'identify-eu-west-1.acrcloud.com',accessKey:'fixture-key',accessSecret:'fixture-secret'},received),
        ()=>moderateText('Fixture title','Fixture lyrics','fixture-key',received),
        ()=>classifyLyrics('Fixture title','Fixture lyrics','fixture-key',received),
      ]){try{await run();outcomes.push('unexpected_success')}catch(e){outcomes.push(e.code??'unexpected_runtime_error')}}
      return Response.json({outcomes,receipts});
    }};
  `;
  const output = await build({
    stdin: {
      contents: source,
      resolveDir: process.cwd(),
      sourcefile: "explicit-worker-provider-fixture.ts",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2024",
    external: ["node:*"],
    minify: true,
    logLevel: "silent",
  });
  const urls: string[] = [];
  const mf = new Miniflare({
    modules: true,
    script: output.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: async (request: { url: string }) => {
      urls.push(request.url);
      assert.ok(
        [
          "https://identify-eu-west-1.acrcloud.com/v1/identify",
          "https://api.openai.com/v1/moderations",
          "https://api.openai.com/v1/responses",
        ].includes(request.url),
      );
      return new Response("{}", {
        status: 302,
        headers: {
          location: "https://attacker.invalid/",
          "content-type": "application/json",
        },
      });
    },
  });
  try {
    const response = await mf.dispatchFetch("https://fixture.example/");
    assert.deepEqual(await response.json(), {
      outcomes: [
        "provider_unavailable",
        "provider_unavailable",
        "provider_unavailable",
      ],
      receipts: 3,
    });
    assert.equal(urls.length, 3);
    assert.ok(urls.every((url) => !url.includes("attacker.invalid")));
  } finally {
    await mf.dispose();
  }
});
