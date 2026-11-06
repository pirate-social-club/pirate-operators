import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureManifest } from "../harness/karaoke-fixture.ts";
import { digest } from "../packages/protocol/index.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import {
  resultManifestUri,
  resultManifestBytes,
} from "../packages/records/result-manifest.ts";

test("a public content hash independently locates the whole canonical timed manifest", async () => {
  const manifest = fixtureManifest({
    communityId: digest("community"),
    audio: "0x01",
    lyrics: "lyric",
    title: "title",
    artwork: "artwork",
    original: true,
  });
  const bytes = resultManifestBytes(manifest),
    pin = await preparePin(bytes, "application/json");
  assert.equal(resultManifestUri(digest(manifest)), pin.uri);
  assert.equal(pin.sha256, digest(manifest));
  assert.throws(
    () =>
      resultManifestBytes({
        ...manifest,
        lines: [{ ...manifest.lines[0], text: "x".repeat(262144) }],
      }),
    /manifest_too_large/,
  );
});
