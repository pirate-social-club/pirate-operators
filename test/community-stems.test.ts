import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { firstSongJobFixture } from "./fixtures/first-song-job.ts";
import {
  reserveStem,
  uploadStem,
  submissionStems,
  requireStems,
} from "../packages/community/stems.ts";
import { ownedSubmission } from "../packages/community/submissions.ts";
import { firstSongDriver } from "../services/first-song-driver.ts";
import { loadJob } from "../packages/community/publication-store.ts";

test("fixed stem seals preserve the existing master, lyrics and job; other accounts and replacement bytes cannot attach", async () => {
  const f = await firstSongJobFixture();
  try {
    const before = await ownedSubmission(
        f.community.db,
        f.row.submission_id,
        f.session.account_id,
      ),
      job = await loadJob(f.community.db, f.sealed.jobId);
    const rows = await requireStems(
      f.community.db,
      f.community.media,
      f.row.submission_id,
    );
    assert.equal(rows.length, 2);
    await assert.rejects(
      reserveStem(
        f.community.db,
        "other-account",
        f.row.submission_id,
        "vocals",
        { sha256: rows[0]!.sha256, byteLength: rows[0]!.byte_length },
      ),
      /submission_not_found/,
    );
    await assert.rejects(
      reserveStem(
        f.community.db,
        f.session.account_id,
        f.row.submission_id,
        "vocals",
        { sha256: sha256(new Uint8Array([1])), byteLength: 1 },
      ),
      /stem_slot_conflict/,
    );
    const stems = await submissionStems(f.community.db, f.row.submission_id);
    await uploadStem(
      f.community.db,
      f.community.media,
      f.session.account_id,
      f.row.submission_id,
      "vocals",
      new Request("https://fixture.example", {
        method: "PUT",
        body: "replacement",
      }),
    );
    assert.deepEqual(
      await submissionStems(f.community.db, f.row.submission_id),
      stems,
    );
    assert.deepEqual(
      await ownedSubmission(
        f.community.db,
        f.row.submission_id,
        f.session.account_id,
      ),
      before,
    );
    assert.deepEqual(await loadJob(f.community.db, f.sealed.jobId), job);
    await f.community.media.delete(rows[0]!.object_key!);
    await assert.rejects(
      firstSongDriver(f.ports).request(job, "pin_audio"),
      /sealed_stem_unavailable/,
    );
  } finally {
    await f.dispose();
  }
});

test("a lost stem put response reconciles the checksum-valid object and never rewrites the sealed slot", async () => {
  const f = await firstSongJobFixture();
  try {
    const [stem] = await requireStems(
      f.community.db,
      f.community.media,
      f.row.submission_id,
      ["vocals"],
    );
    // Explicit interruption after the real R2 put and before the D1 final seal.
    await f.community.db
      .prepare(
        "UPDATE media_stems SET state='uploading',object_etag=NULL,duration_ms=NULL,lease_token='lost-response',lease_until=? WHERE submission_id=? AND slot='vocals'",
      )
      .bind(Date.now() + 180000, f.row.submission_id)
      .run();
    let writes = 0;
    const media = new Proxy(f.community.media, {
      get(target, key) {
        if (key === "put")
          return () => {
            writes++;
            throw new Error("must reconcile, not upload");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await uploadStem(
      f.community.db,
      media,
      f.session.account_id,
      f.row.submission_id,
      "vocals",
      new Request("https://fixture.example", { method: "PUT", body: "unused" }),
    );
    assert.equal(writes, 0);
    const [saved] = await requireStems(
      f.community.db,
      media,
      f.row.submission_id,
      ["vocals"],
    );
    assert.equal(saved!.sha256, stem!.sha256);
    assert.equal(saved!.object_key, stem!.object_key);
    assert.equal(saved!.object_etag, stem!.object_etag);
  } finally {
    await f.dispose();
  }
});
