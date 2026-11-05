import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("the bundled alignment adapter in workerd retains redirects without forwarding its key", async () => {
  const output = await build({
    stdin: {
      contents: `
    import {sendAlignment} from './packages/alignment/elevenlabs.ts';
    import {createLyrics} from './packages/community/lyric-manifest.ts';
    import {providerFetch,providerJson} from './packages/moderation/provider-http.ts';
    import {readMp3Probe} from './packages/moderation/mp3-windows.ts';
    import {sha256} from 'viem';
    export default {async fetch(){
      const vocal=new Uint8Array(417*22);for(let n=0;n<22;n++)vocal.set([255,251,144,0],n*417);
      const probe=await readMp3Probe(new Blob([vocal]).stream(),3600000,AbortSignal.timeout(30000));
      const lyrics=createLyrics({chainId:31337,postsContract:'0x'+'11'.repeat(20),communityId:'0x'+'22'.repeat(32),postId:'0x'+'33'.repeat(32)},'Baby blues','en');
      let receipts=0,outcome;try{const raw=await sendAlignment({vocal,vocalSha256:sha256(vocal),durationMs:probe.durationMs,lyrics,apiKey:'fixture-alignment-key',deadline:Date.now()+30000,authorize:async()=>{},received:async()=>{receipts++},transport:providerFetch});providerJson(raw);outcome='unexpected_success'}catch(e){outcome=e.code??'unexpected_runtime_error'}
      return Response.json({outcome,receipts});
    }};`,
      resolveDir: process.cwd(),
      sourcefile: "explicit-alignment-worker-fixture.ts",
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
  const urls: string[] = [],
    runtime = new Miniflare({
      modules: true,
      script: output.outputFiles[0]!.text,
      compatibilityDate: "2026-08-06",
      compatibilityFlags: ["nodejs_compat"],
      outboundService: async (request: { url: string }) => {
        urls.push(request.url);
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
    const result = await runtime.dispatchFetch("https://fixture.example/");
    assert.deepEqual(await result.json(), {
      outcome: "provider_unavailable",
      receipts: 1,
    });
    assert.deepEqual(urls, ["https://api.elevenlabs.io/v1/forced-alignment"]);
  } finally {
    await runtime.dispose();
  }
});
