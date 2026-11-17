/** Failure-first cases prepared before the independent private writer.
 * UNRUN: Root owns every test/build/runtime slot. */
import assert from "node:assert/strict";
import test from "node:test";
import { canonical, hashText } from "../packages/community/common.ts";
import { createDanceSongResources } from "../services/dance-song-resources.ts";
import { createDancePrivateSongProjections } from "../services/dance-private-song-projections.ts";
import {
  pause,
  privateSongFixture,
  word,
} from "./fixtures/dance-private-song-projections.ts";

test("private song projection requires captured current/configuration/identity facts", async (t) => {
  for (const fault of [
    "missing",
    "generation",
    "configuration",
    "identity",
  ] as const) {
    await t.test(fault, async (t) => {
      const f = await privateSongFixture(t);
      if (fault === "missing") f.state.currentMissing = true;
      if (fault === "generation") f.lose();
      if (fault === "configuration")
        f.db.sqlite.exec(
          "UPDATE public_configurations SET publisher='changed'",
        );
      if (fault === "identity")
        f.db.sqlite.exec(
          "UPDATE application_identity SET community_id='changed'",
        );
      await assert.rejects(
        createDancePrivateSongProjections(f.input).selection(f.selected, null),
        fault === "missing"
          ? /current_missing/
          : fault === "configuration"
            ? /configuration_missing/
            : /fence_changed/,
      );
      assert.deepEqual(f.counts(), [0, 0, 0]);
      assert.equal(f.calls.probe, 0);
    });
  }
});

test("private song projection holds forged/stale Posts and mismatching audio", async (t) => {
  for (const fault of [
    "chain",
    "receipt",
    "event",
    "checkpoint",
    "manifest",
    "quarantine",
    "audio",
  ] as const) {
    await t.test(fault, async (t) => {
      const f = await privateSongFixture(t);
      if (fault === "chain") f.state.chainId = 1;
      if (fault === "receipt") f.state.receiptSuccess = false;
      if (fault === "event") f.log.transactionHash = word(999);
      if (fault === "checkpoint") f.state.checkpoint = word(999);
      if (fault === "manifest")
        f.db.sqlite.exec("UPDATE public_post_revisions SET manifest_json='{}'");
      if (fault === "quarantine")
        f.db.sqlite.exec("UPDATE public_post_revisions SET quarantined=1");
      if (fault === "audio") f.state.corruptAudio = true;
      const expected = {
        chain: /wrong_posts_profile/,
        receipt: /dance_publication_provenance_changed/,
        event: /dance_publication_provenance_changed/,
        checkpoint: /dance_publication_checkpoint_changed/,
        manifest: /invalid_fields|unsupported_post/,
        quarantine: /publication_missing/,
        audio: /public_ipfs_unavailable/,
      };
      await assert.rejects(
        createDancePrivateSongProjections(f.input).selection(f.selected, null),
        expected[fault],
      );
      assert.deepEqual(f.counts(), [0, 0, 0]);
    });
  }
});

test("only the trusted probe supplies measured evidence; invalid intervals never project", async (t) => {
  for (const fault of [
    "rate",
    "samples",
    "receipt",
    "out-of-song",
    "short",
    "injected",
  ] as const) {
    await t.test(fault, async (t) => {
      const f = await privateSongFixture(t);
      if (fault === "rate") f.state.sampleRate = 44100;
      if (fault === "samples") f.state.samples = 0;
      if (fault === "receipt") f.state.receiptBytes = "";
      if (fault === "out-of-song") f.selected.startSample = f.state.samples;
      if (fault === "short") f.selected.durationSamples = 48;
      const selected =
        fault === "injected"
          ? {
              ...f.selected,
              songDurationSamples: 999999,
              probeEvidenceSha256: word(9),
            }
          : f.selected;
      await assert.rejects(
        createDancePrivateSongProjections(f.input).selection(selected, null),
        fault === "injected"
          ? /invalid_fields/
          : ["out-of-song", "short"].includes(fault)
            ? /interval_invalid/
            : /probe_unavailable/,
      );
      assert.deepEqual(f.counts(), [0, 0, 0]);
    });
  }
});

test("generation changes during download/probe or at accepting batch roll back all song projections", async (t) => {
  for (const at of ["download", "probe", "batch"] as const) {
    await t.test(at, async (t) => {
      const f = await privateSongFixture(t);
      if (at === "batch") {
        // The preliminary authority assertion is distinct from accepting writes.
        f.db.beforeBatch = (statements) => {
          if (
            statements.some((s) =>
              s.sql.includes("INSERT INTO dance_host_song_keys"),
            )
          )
            f.lose();
          else f.db.beforeBatch = () => f.lose();
        };
      } else f.hooks[at] = async () => f.lose();
      await assert.rejects(
        createDancePrivateSongProjections(f.input).selection(f.selected, null),
        /fence_changed/,
      );
      assert.deepEqual(f.counts(), [0, 0, 0]);
    });
  }
});

test("private selection writes exact existing tables and is consumed by the real shared resource reader", async (t) => {
  const f = await privateSongFixture(t),
    writer = createDancePrivateSongProjections(f.input);
  const accepted = await writer.selection(f.selected, null);
  assert.equal(accepted.revision, 1);
  assert.deepEqual(f.counts(), [1, 1, 1]);
  assert.equal(accepted.song.songDurationSamples, f.state.samples);
  assert.equal(accepted.song.startSample, f.selected.startSample);
  assert.equal(accepted.song.durationSamples, f.selected.durationSamples);
  assert.equal(accepted.song.reference, null);
  assert.equal(accepted.song.offer, null);
  const receipt = f.db.sqlite
    .prepare("SELECT receipt_bytes FROM dance_host_audio_probes")
    .get()!;
  assert.equal(
    hashText(String(receipt.receipt_bytes)),
    accepted.song.probeEvidenceSha256,
  );
  assert.deepEqual(JSON.parse(String(receipt.receipt_bytes)), {
    version: "pirate.dance-measured-audio/1",
    audioSha256: f.audio.sha256,
    sampleRate: 48000,
    samples: f.state.samples,
    producerReceipt: f.state.receiptBytes,
  });
  const resources = createDanceSongResources(f.input);
  const selected = await resources.selected(accepted.songKey, null, null);
  assert.equal(canonical(selected.song), canonical(accepted.song));
  assert.equal(
    (await resources.publication(accepted.songKey, selected.song)).title,
    f.post.title,
  );
  assert.deepEqual(
    new Set(f.calls.contracts),
    new Set(["directory", "getPost"]),
  );
  assert.equal((await writer.selection(f.selected, null)).revision, 1);
  assert.deepEqual(f.counts(), [1, 1, 1]);
});

test("selection CAS never adopts a different interval; exact update retains original measured evidence", async (t) => {
  const f = await privateSongFixture(t),
    writer = createDancePrivateSongProjections(f.input);
  const first = await writer.selection(f.selected, null);
  const next = { ...f.selected, startSample: 96000 };
  await assert.rejects(writer.selection(next, null), /cas_changed/);
  const saved = f.db.sqlite
    .prepare("SELECT body_json FROM dance_host_selections")
    .get()!;
  assert.equal(String(saved.body_json), canonical(first.song));
  const second = await writer.selection(next, first.revision);
  assert.equal(second.revision, 2);
  assert.equal(second.song.startSample, 96000);
  assert.deepEqual(f.counts(), [1, 1, 1]);
});

test("caller mutation while current/probe is held cannot retarget selected or configuration bytes", async (t) => {
  for (const at of ["current", "probe"] as const)
    await t.test(at, async (t) => {
      const f = await privateSongFixture(t),
        held = pause();
      f.hooks[at] = held.wait;
      const writer = createDancePrivateSongProjections(f.input),
        original = structuredClone(f.selected);
      const pending = writer.selection(f.selected, null);
      await Promise.race([
        held.started,
        pending.then(() => {
          throw Error("selection completed before held producer entered");
        }),
      ]);
      f.selected.postId = word(999);
      f.selected.startSample = 999999;
      f.input.config.communityId = word(998);
      held.release();
      const accepted = await pending;
      assert.equal(accepted.song.postId, original.postId);
      assert.equal(accepted.song.startSample, original.startSample);
      assert.deepEqual(f.counts(), [1, 1, 1]);
    });
});

test("selection CAS also rejects a real competing row change at the accepting batch", async (t) => {
  const f = await privateSongFixture(t),
    writer = createDancePrivateSongProjections(f.input);
  const first = await writer.selection(f.selected, null);
  const competing = { ...first.song, startSample: 96000 };
  f.hooks.probe = async () => {
    f.db.beforeBatch = () => {
      f.db.sqlite
        .prepare(
          "UPDATE dance_host_selections SET revision=revision+1,body_json=?",
        )
        .run(canonical(competing));
    };
  };
  await assert.rejects(
    writer.selection({ ...f.selected, startSample: 144000 }, first.revision),
    /fence_changed/,
  );
  const row = f.db.sqlite
    .prepare("SELECT revision,body_json FROM dance_host_selections")
    .get()!;
  assert.equal(row.revision, 2);
  assert.equal(row.body_json, canonical(competing));
  assert.deepEqual(f.counts(), [1, 1, 1]);
});

test("lost acknowledgement retains exact projection and only reconciles under captured current fences", async (t) => {
  for (const loseAuthority of [false, true])
    await t.test(String(loseAuthority), async (t) => {
      const f = await privateSongFixture(t),
        writer = createDancePrivateSongProjections(f.input);
      f.hooks.probe = async () => {
        f.db.afterBatch = () => {
          if (loseAuthority) f.lose();
          throw Error("offline lost D1 acknowledgement");
        };
      };
      if (loseAuthority)
        await assert.rejects(
          writer.selection(f.selected, null),
          /fence_changed/,
        );
      else assert.equal((await writer.selection(f.selected, null)).revision, 1);
      assert.deepEqual(
        f.counts(),
        [1, 1, 1],
        "committed evidence is retained, never deleted/reseeded",
      );
      assert.equal(
        f.calls.current,
        1,
        "recovery cannot refresh stale admission into a new generation",
      );
    });
});

test("lost acknowledgement never rewrites a different committed selection into the requested outcome", async (t) => {
  const f = await privateSongFixture(t),
    writer = createDancePrivateSongProjections(f.input);
  f.hooks.probe = async () => {
    f.db.afterBatch = () => {
      const row = f.db.sqlite
        .prepare("SELECT body_json FROM dance_host_selections")
        .get()!;
      const other = {
        ...JSON.parse(String(row.body_json)),
        startSample: 96000,
      };
      f.db.sqlite
        .prepare(
          "UPDATE dance_host_selections SET revision=revision+1,body_json=?",
        )
        .run(canonical(other));
      throw Error("offline lost acknowledgement with different successor");
    };
  };
  await assert.rejects(
    writer.selection(f.selected, null),
    /different successor/,
  );
  const saved = f.db.sqlite
    .prepare("SELECT body_json,revision FROM dance_host_selections")
    .get()!;
  assert.equal(JSON.parse(String(saved.body_json)).startSample, 96000);
  assert.equal(saved.revision, 2);
  assert.deepEqual(f.counts(), [1, 1, 1]);
});
