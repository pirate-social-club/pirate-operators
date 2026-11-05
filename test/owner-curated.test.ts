import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import {
  curatedSongFixture,
  curatedController,
} from "./fixtures/curated-song.ts";
import { hashJson, canonical, publicId } from "../packages/community/common.ts";
import { adoptCuratedPublication } from "../packages/community/adopt-curated.ts";
import { adoptCuratedAdmission } from "../packages/moderation/adopt-curated.ts";
import { getAdmission } from "../packages/moderation/admission-store.ts";
import {
  originalProviderCalls,
  selectedAdmission,
} from "../packages/moderation/curated-admission.ts";
import { firstSongDriver } from "../services/first-song-driver.ts";
import { publicationStep } from "../packages/community/publication.ts";
import {
  loadJob,
  resumeUncertainJob,
} from "../packages/community/publication-store.ts";
import { requireCuratedOwner } from "../packages/community/curated-amendment.ts";
import {
  indexedPublicPosts,
  syncPublicPosts,
} from "../packages/community/post-index.ts";

test("owner-curated successor preserves the held operation and provider charges through pins, mint, publication and reconstruction", async () => {
  const f = await curatedSongFixture();
  try {
    assert.equal(f.originalJob.phase, "held");
    assert.equal(f.originalAdmission.state, "held");
    await adoptCuratedAdmission(
      f.managed.db,
      f.signed,
      f.result,
      f.config,
      f.grant,
    );
    await adoptCuratedPublication(
      f.community.db,
      f.community.media,
      f.signed,
      f.config,
    );
    await adoptCuratedPublication(
      f.community.db,
      f.community.media,
      f.signed,
      f.config,
    );
    await adoptCuratedAdmission(
      f.managed.db,
      f.signed,
      f.result,
      f.config,
      f.grant,
    );
    await requireCuratedOwner(f.community.db, f.config, f.row.captured_wallet);
    await assert.rejects(
      requireCuratedOwner(f.community.db, f.config, "0x" + "9".repeat(40)),
      /owner_publication_only/,
    );
    for (let i = 0; i < 20; i++) {
      const job = await loadJob(f.community.db, f.sealed.jobId);
      if (job.phase === "published") break;
      if (job.phase === "uncertain") {
        if (JSON.parse(job.progress_json).resumePhase === "publication")
          f.posts.mine();
        await resumeUncertainJob(
          f.community.db,
          f.sealed.jobId,
          f.session.account_id,
        );
      }
      await Effect.runPromise(
        publicationStep(
          f.community.db,
          f.sealed.jobId,
          firstSongDriver(f.ports),
        ),
      );
    }
    const job = await loadJob(f.community.db, f.sealed.jobId);
    assert.equal(job.phase, "published");
    assert.equal(job.input_hash, f.originalJob.input_hash);
    assert.equal(job.authority_json, f.originalJob.authority_json);
    assert.deepEqual(
      await getAdmission(f.managed.db, f.originalId),
      f.originalAdmission,
    );
    assert.deepEqual(
      await originalProviderCalls(f.managed.db, f.originalId),
      f.originalCalls,
    );
    assert.deepEqual(
      await f.community.db
        .prepare("SELECT * FROM external_operations WHERE operation_id=?")
        .bind(f.originalOperation.operation_id)
        .first(),
      f.originalOperation,
    );
    assert.equal(f.managed.adds(), 5);
    assert.equal(f.managed.story.mints(), 1);
    assert.equal(f.posts.broadcasts(), 1);
    const calls = await f.managed.db
      .prepare("SELECT COUNT(*) AS n FROM moderation_provider_calls")
      .first<{ n: number }>();
    assert.equal(calls!.n, 3);
    await syncPublicPosts(
      f.community.db,
      f.posts.client,
      f.posts.profile,
      [f.config],
      f.config,
      f.managed.service.pinTransport,
    );
    const posts = await indexedPublicPosts(
      f.community.db,
      f.posts.client,
      f.posts.profile,
      [f.config],
      f.config,
      100n,
    );
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.post.schema, "pirate.community-post/2");
    assert.equal(posts[0]!.post.postId, f.row.post_id);
    assert.equal(posts[0]!.post.admission.automatedContent, "deferred");
    assert.equal(
      posts[0]!.post.admission.declarationSource,
      "operator_declared",
    );
    assert.equal(
      (await selectedAdmission(f.managed.db, f.id, f.config)).admission.state,
      "complete",
    );
    assert.equal(
      (await f.community.db
        .prepare(
          "SELECT COUNT(*) AS n FROM external_operations WHERE step LIKE 'admission%'",
        )
        .first())!.n,
      2,
    );
  } finally {
    await f.dispose();
  }
});

test("curation refuses changed declarations, unknown provider results and a predecessor with public work", async () => {
  const f = await curatedSongFixture();
  try {
    await assert.rejects(
      adoptCuratedAdmission(
        f.managed.db,
        {
          ...f.signed,
          amendment: { ...f.signed.amendment, rating: "adult_18" },
        },
        f.result,
        f.config,
        f.grant,
      ),
      /untrusted_curated_controller/,
    );
    await assert.rejects(
      adoptCuratedAdmission(
        f.managed.db,
        f.signed,
        {
          ...f.result,
          declarations: { ...f.result.declarations, language: "fr" },
        },
        f.config,
        f.grant,
      ),
      /curated_declaration_changed/,
    );
    for (const mutation of [
      { windows: [] },
      { probe: { ...f.result.probe, durationMs: 1 } },
    ])
      await assert.rejects(
        adoptCuratedAdmission(
          f.managed.db,
          f.signed,
          { ...f.result, ...mutation },
          f.config,
          f.grant,
        ),
        /curated_prepared_projection_changed/,
      );
    assert.equal(
      (await f.managed.db
        .prepare("SELECT COUNT(*) AS n FROM curated_admissions")
        .first())!.n,
      0,
    );
    const changed = { ...f.signed.amendment, originalCallsHash: publicId() },
      signed = {
        amendment: changed,
        signature: await curatedController.signMessage({
          message: { raw: hashJson(changed) },
        }),
      };
    await assert.rejects(
      adoptCuratedAdmission(
        f.managed.db,
        signed,
        { ...f.result, amendmentSha256: hashJson(signed) },
        f.config,
        f.grant,
      ),
      /curated_original_admission_changed/,
    );
    await f.community.db
      .prepare(
        "INSERT INTO external_operations(operation_id,job_id,step,request_hash,request_json,status) VALUES(?,?,'pin_audio',?,'{}','uncertain')",
      )
      .bind(publicId(), f.sealed.jobId, publicId())
      .run();
    await assert.rejects(
      adoptCuratedPublication(
        f.community.db,
        f.community.media,
        f.signed,
        f.config,
      ),
      /CHECK constraint failed/,
    );
    assert.equal(
      (await f.community.db
        .prepare("SELECT COUNT(*) AS n FROM publication_amendments")
        .first())!.n,
      0,
    );
    assert.equal((await loadJob(f.community.db, f.sealed.jobId)).phase, "held");
  } finally {
    await f.dispose();
  }
});
