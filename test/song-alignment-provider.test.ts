import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { sendAlignment } from "../packages/alignment/elevenlabs.ts";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import { readMp3Probe } from "../packages/moderation/mp3-windows.ts";

const lyrics = () =>
  createLyrics(
    {
      chainId: 31337,
      postsContract: "0x1111111111111111111111111111111111111111",
      communityId: `0x${"22".repeat(32)}`,
      postId: `0x${"33".repeat(32)}`,
    },
    "Baby blues",
    "en",
  );
async function input() {
  const vocal = new Uint8Array(417 * 22);
  for (let n = 0; n < 22; n++) vocal.set([0xff, 0xfb, 0x90, 0], n * 417);
  const probe = await readMp3Probe(
    new Blob([vocal]).stream(),
    3600000,
    AbortSignal.timeout(30000),
  );
  return {
    vocal,
    vocalSha256: sha256(vocal),
    durationMs: probe.durationMs,
    lyrics: lyrics(),
    apiKey: "fixture-alignment-key",
    deadline: Date.now() + 30000,
  };
}
test("alignment sends actual vocal MP3 and exact accepted lyrics, retaining the raw receipt", async () => {
  const selected = await input(),
    events: string[] = [];
  const raw = await sendAlignment({
    ...selected,
    authorize: async () => {
      events.push("authorized");
    },
    received: async (receipt) => {
      assert.equal(receipt.requestId, "fixture-alignment");
      assert.equal(receipt.body, '{"raw":"retained"}');
      events.push("retained");
    },
    transport: {
      async request(request) {
        events.push("sent");
        assert.equal(
          request.url,
          "https://api.elevenlabs.io/v1/forced-alignment",
        );
        assert.equal(request.redirect, "manual");
        assert.equal(
          request.headers.get("xi-api-key"),
          "fixture-alignment-key",
        );
        const form = await request.formData(),
          file = form.get("file");
        assert(file instanceof File);
        assert.equal(file.type, "audio/mpeg");
        assert.equal(
          sha256(new Uint8Array(await file.arrayBuffer())),
          selected.vocalSha256,
        );
        assert.equal(form.get("text"), selected.lyrics.sourceText);
        return new Response('{"raw":"retained"}', {
          headers: {
            "content-type": "application/json",
            "x-request-id": "fixture-alignment",
          },
        });
      },
    },
  });
  assert.equal(raw.status, 200);
  assert.deepEqual(events, ["authorized", "sent", "retained"]);
});
test("alignment refuses changed audio, expired windows and revoked authority before sending", async () => {
  let sends = 0;
  const selected = await input(),
    ports = {
      authorize: async () => {},
      received: async () => {},
      transport: {
        async request() {
          sends++;
          return new Response();
        },
      },
    };
  await assert.rejects(
    sendAlignment({
      ...selected,
      ...ports,
      vocalSha256: `0x${"00".repeat(32)}`,
    }),
    /alignment_vocal_mismatch/,
  );
  await assert.rejects(
    sendAlignment({ ...selected, ...ports, deadline: Date.now() - 1 }),
    /alignment_window_expired/,
  );
  await assert.rejects(
    sendAlignment({
      ...selected,
      ...ports,
      authorize: async () => {
        throw Error("revoked");
      },
    }),
    /revoked/,
  );
  assert.equal(sends, 0);
});
