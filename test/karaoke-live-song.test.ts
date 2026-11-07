// The published first song through the community application: its pinned
// lyric manifest, one controller-signed forced alignment against simulated
// ElevenLabs, and the timed Karaoke manifest that keeps every published line ID.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { songKeyOf } from "../packages/protocol/records.ts";
import type { KaraokeManifest } from "../packages/protocol/payments.ts";
import { isSectionCue } from "../packages/alignment/elevenlabs-response.ts";
import { firstSongFixture, karaokeLive } from "../harness/karaoke-live.ts";
import { accounts } from "../harness/runtime.ts";
import { startChain, stopChain, type Chain } from "./payments-fixture.ts";

let evm: Chain;
before(async () => {
  evm = await startChain(19245);
});
after(async () => {
  await stopChain(evm);
});

const sha = (bytes: Uint8Array) =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;
const sung = firstSongFixture.lyrics.lines.filter(
  (l: { text: string }) => !isSectionCue(l.text),
) as { lineId: string; text: string }[];

test("authenticated instrumental playback serves exact byte ranges and rejects invalid ranges", async () => {
  const live = await karaokeLive({ evm, now: 1800000000, streams: [] });
  try {
    const {
      instrumental: { bytes: instrumental },
    } = await live.publish();
    const path = `/api/karaoke/posts/${firstSongFixture.postId}/instrumental`;
    assert.equal(
      (await live.app(path, { headers: { range: "bytes=0-9" } })).status,
      401,
    );
    const session = await live.signIn(accounts[5]!);
    const get = (range?: string) =>
      live.app(path, {
        headers: {
          cookie: session.cookie,
          ...(range === undefined ? {} : { range }),
        },
      });
    const full = await get();
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), instrumental);
    for (const [header, start, end] of [
      ["bytes=10-19", 10, 20],
      [
        `bytes=${instrumental.length - 10}-`,
        instrumental.length - 10,
        instrumental.length,
      ],
      ["bytes=-5", instrumental.length - 5, instrumental.length],
      [`bytes=10-${instrumental.length + 100}`, 10, instrumental.length],
    ] as const) {
      const response = await get(header);
      assert.equal(response.status, 206, header);
      assert.equal(
        response.headers.get("content-range"),
        `bytes ${start}-${end - 1}/${instrumental.length}`,
      );
      assert.equal(response.headers.get("content-length"), String(end - start));
      assert.deepEqual(
        new Uint8Array(await response.arrayBuffer()),
        instrumental.slice(start, end),
      );
    }
    for (const header of [
      "bytes=",
      "bytes=0-1,3-4",
      "bytes=9-1",
      "bytes=-0",
      `bytes=${instrumental.length}-`,
      "bytes=99999999999999999999-",
    ]) {
      const response = await get(header);
      assert.equal(response.status, 416, header);
      assert.equal(
        response.headers.get("content-range"),
        `bytes */${instrumental.length}`,
      );
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
    await live.db
      .prepare(
        "UPDATE media_stems SET object_etag='changed' WHERE slot='instrumental'",
      )
      .run();
    assert.equal(
      (await get("bytes=0-9")).status,
      503,
      "ranges preserve sealed object identity checks",
    );
  } finally {
    await live.dispose();
  }
});

test("the fixtures are the published bytes, with 23 sung lines and six section cues", () => {
  assert.equal(sha(firstSongFixture.lyricBytes), firstSongFixture.lyricsSha256);
  assert.equal(sha(firstSongFixture.postBytes), firstSongFixture.postSha256);
  assert.equal(firstSongFixture.lyrics.lines.length, 29);
  assert.equal(sung.length, 23);
});

for (const mode of ["words", "characters", "unbound"] as const) {
  test(`one signed alignment times every published line (${mode} provider response)`, async () => {
    const live = await karaokeLive({
      evm,
      now: 1800000000,
      streams: [],
      alignment: {
        mode,
        startMs: 2000,
        charMs: 55,
        spaceMs: 45,
        lineGapMs: 700,
      },
    });
    try {
      await live.publish();
      const feed = await live.get<{
        posts: { manifest: { postId: string } }[];
      }>(null, "/api/feed");
      assert.equal(feed.status, 200, JSON.stringify(feed.value));
      assert.deepEqual(
        feed.value.posts.map((p) => p.manifest.postId),
        [firstSongFixture.postId],
      );
      const before = await live.get<{ error: string }>(
        null,
        `/api/public/posts/${firstSongFixture.postId}/karaoke`,
      );
      assert.deepEqual(
        [before.status, before.value.error],
        [404, "karaoke_timing_unavailable"],
      );

      const aligned = await live.align();
      assert.equal(aligned.status, 200, JSON.stringify(aligned.value));
      assert.equal(aligned.value.state, "complete");
      assert.equal(
        (aligned.value.result as { mode: string }).mode,
        mode === "words" ? "word" : "character",
      );
      // A repeated or newly signed request never buys a second alignment.
      await live.align();
      const log = await live.simulatorLog();
      assert.equal(log.alignment.requests, 1);
      assert.equal(
        `0x${log.alignment.textSha256[0]}`,
        firstSongFixture.lyrics.sourceSha256,
      );

      const timed = await live.get<KaraokeManifest>(
        null,
        `/api/public/posts/${firstSongFixture.postId}/karaoke`,
      );
      assert.equal(timed.status, 200, JSON.stringify(timed.value));
      const manifest = timed.value;
      assert.deepEqual(
        manifest.lines.map((l) => l.lineId),
        sung.map((l) => l.lineId),
      );
      assert.deepEqual(
        manifest.lines.map((l) => l.text),
        sung.map((l) => l.text),
      );
      assert.deepEqual(manifest.song, {
        chainId: 6343,
        posts: "0xa5c155058dd8c6befae7dcb6562277dad77f6045",
        communityId: firstSongFixture.communityId,
        postId: firstSongFixture.postId,
      });
      assert.equal(manifest.songHash, songKeyOf(manifest.song!));
      for (const line of manifest.lines) {
        assert.equal(line.startMs, line.words[0]!.startMs);
        assert.equal(line.endMs, line.words.at(-1)!.endMs);
        assert.equal(
          line.words.map((w) => w.text).join(" "),
          line.text.split(/\s+/).join(" "),
        );
      }
      assert.equal(manifest.segments.length, 23);
    } finally {
      await live.dispose();
    }
  });
}

test("only the controller's unexpired request for the current lyrics and vocal buys alignment", async () => {
  const live = await karaokeLive({ evm, now: 1800000000, streams: [] });
  try {
    await live.publish();
    const stranger = privateKeyToAccount(`0x${"14".repeat(32)}`);
    assert.deepEqual(
      [
        (await live.align(stranger)).status,
        (await live.align(stranger)).value.error,
      ],
      [403, "untrusted_alignment_controller"],
    );
    assert.equal(
      (await live.align(undefined, { lyricsSha256: `0x${"1".repeat(64)}` }))
        .value.error,
      "alignment_lyrics_changed",
    );
    assert.equal(
      (await live.align(undefined, { vocalSha256: `0x${"1".repeat(64)}` }))
        .value.error,
      "alignment_vocal_changed",
    );
    assert.equal(
      (await live.align(undefined, { expiresAt: live.now() + 3600 })).value
        .error,
      "invalid_alignment_request",
    );
    assert.equal((await live.simulatorLog()).alignment.requests, 0);
  } finally {
    await live.dispose();
  }
});

test("without Pirate's provider key alignment is unavailable and nothing is sent", async () => {
  const live = await karaokeLive({
    evm,
    now: 1800000000,
    streams: [],
    providerKey: null,
  });
  try {
    await live.publish();
    const aligned = await live.align();
    assert.deepEqual(
      [aligned.status, aligned.value.error],
      [503, "alignment_key_unavailable"],
    );
    assert.equal((await live.simulatorLog()).alignment.requests, 0);
  } finally {
    await live.dispose();
  }
});

test("configuring a records successor keeps songs from earlier public configurations readable", async () => {
  const live = await karaokeLive({ evm, now: 1800000000, streams: [] });
  try {
    await live.publish();
    const previous = structuredClone(live.config);
    live.config.configurationRevision++;
    live.ports.publicReads!.configurationHistory = async () => [
      previous,
      live.config,
    ];
    const feed = await live.get<{ posts: { manifest: { postId: string } }[] }>(
      null,
      "/api/feed",
    );
    assert.equal(feed.status, 200, JSON.stringify(feed.value));
    assert.deepEqual(
      feed.value.posts.map((p) => p.manifest.postId),
      [firstSongFixture.postId],
    );
    const aligned = await live.align();
    assert.equal(aligned.status, 200, JSON.stringify(aligned.value));
    assert.equal(aligned.value.state, "complete");
  } finally {
    await live.dispose();
  }
});
