import test from "node:test";
import assert from "node:assert/strict";
import { web2FirstSongFixture } from "./fixtures/web2-first-song.ts";

test(
  "Web2 first song uses plain SIWE and actual owner publication, catalog, feed and media",
  { timeout: 120000 },
  async (t) => {
    const f = await web2FirstSongFixture();
    t.after(f.close);
    const account = await f.login();
    assert.equal(account.challenge.kind, undefined);
    assert.equal(await f.learningAuthorizations(), 0);
    const song = await f.publish(account);
    assert.equal(song.job.phase, "published");
    assert.equal(f.effects.broadcasts, 1);
    assert.equal(f.effects.catalogUploads, 1);
    await f.assertPublicSong(song);
    await f.writeArtifact("ordinary", song);
    await f.assertManagedAuthorityRefusal();
  },
);

test(
  "unlisted and expired discovery proofs do not remove direct access or owner publication authority",
  { timeout: 120000 },
  async (t) => {
    const f = await web2FirstSongFixture();
    t.after(f.close);
    await f.setDiscovery("expired");
    const account = await f.login(),
      song = await f.publish(account);
    assert.equal(song.job.phase, "published");
    await f.assertPublicSong(song);
    assert.equal((await f.discovery()).discoverable, false);
  },
);

test(
  "Web2 refuses wrong owner and stale or unavailable authority before new effects",
  { timeout: 120000 },
  async (t) => {
    const f = await web2FirstSongFixture();
    t.after(f.close);
    const wrong = await f.login("other");
    assert.equal((await f.reserve(wrong)).status, 403);
    const owner = await f.login(),
      before = { ...f.effects };
    await f.setAuthority("unavailable");
    assert.equal((await f.reserve(owner)).status, 503);
    assert.deepEqual(f.effects, before);
    await f.setAuthority("stale");
    assert.equal((await f.reserve(owner)).status, 503);
    assert.deepEqual(f.effects, before);
  },
);

test(
  "Web2 server boundaries refuse learning names and Dance even with old bindings and V4 challenges",
  { timeout: 120000 },
  async (t) => {
    const f = await web2FirstSongFixture();
    t.after(f.close);
    await f.assertExcludedFeatures();
  },
);

test(
  "lost acknowledgement and runtime restart retain one original publication and every effect identity",
  { timeout: 120000 },
  async (t) => {
    const f = await web2FirstSongFixture();
    t.after(f.close);
    const owner = await f.login();
    f.loseNextPinAcknowledgement();
    const song = await f.publish(owner, { restart: true });
    assert.equal(song.job.phase, "published");
    assert.equal(f.effects.broadcasts, 1);
    assert.equal(f.effects.catalogUploads, 1);
    await f.assertOriginalsRetained(song);
    await f.assertPublicSong(song);
    await f.writeArtifact("recovery", song);
  },
);

test(
  "authenticated Web2 history keeps earlier songs readable after configuration changes",
  { timeout: 120000 },
  async (t) => {
    const f = await web2FirstSongFixture();
    t.after(f.close);
    const song = await f.publish(await f.login());
    await f.configureNextRevision();
    await f.assertPublicSong(song);
    assert.deepEqual(
      (await f.configurationHistory()).map((c) => c.configurationRevision),
      [1, 2],
    );
  },
);
