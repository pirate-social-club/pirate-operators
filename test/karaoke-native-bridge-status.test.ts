import type { Hex } from "viem";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localKaraokeTranscriber } from "../harness/karaoke-local-bridge.ts";

test("native bridge distinguishes no speech from binding, timing and child failure without exposing stderr", { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "karaoke-native-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vectors = [
    { code: 0, status: 200, category: null, words: [] },
    { code: 65, status: 409, category: "model_changed" },
    { code: 67, status: 503, category: "native_decode" },
    { code: 69, status: 503, category: "token_timing" },
    { code: 99, status: 503, category: "child_exit" },
  ] as const;
  const observed = [];
  for (const v of vectors) {
    const script = join(directory, "case-" + v.code + ".mjs");
    await writeFile(script, "for await (const _ of process.stdin) {};" +
      "process.stderr.write('fixture untrusted stderr');" +
      (v.code ? "process.exit(" + v.code + ");" : "process.stdout.write('{\"words\":[]}');"));
    const bridge = localKaraokeTranscriber({
      python: process.execPath, script, model: join(directory, "unused"),
      modelSha256: ("0x" + "1".repeat(64)) as Hex,
    });
    try {
      const response = await bridge.fetch(new Request("http://local-karaoke/recognize", {
        method: "POST", headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0, 0]),
      }));
      assert.equal(response.status, v.status);
      assert.equal(response.headers.get("x-pirate-karaoke-native-failure"), v.category);
      if (v.code) assert.equal(await response.text(), "");
      else assert.deepEqual(await response.json(), { words: [] });
      observed.push({ status: response.status, category: v.category });
    } finally {
      await bridge.close();
    }
  }
  t.diagnostic(JSON.stringify({ observed }));
});
