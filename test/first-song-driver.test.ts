import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { preparePin } from "../packages/community/ipfs.ts";
import { publicationInput } from "../packages/community/publication-input.ts";
import { validateReleaseResult } from "../packages/community/publication-release.ts";
import { publicId } from "../packages/community/common.ts";
import { publicationStep } from "../packages/community/publication.ts";
import {
  loadJob,
  resumeUncertainJob,
  type ExternalOperation,
} from "../packages/community/publication-store.ts";
import {
  syncPublicPosts,
  indexedPublicPosts,
} from "../packages/community/post-index.ts";
import {
  firstSongDriver,
  resumeFirstSongAdmission,
} from "../services/first-song-driver.ts";
import { configuration } from "./fixtures/release-admission.ts";
import { firstSongJobFixture } from "./fixtures/first-song-job.ts";
import { firstSongPublicReady } from "../services/community-public.ts";

test("sealed upload resumes across managed admission, pinning, ROOT mint and pending post; public chain reconstruction preserves private separation", async () => {
  const fixture = await firstSongJobFixture({ loseFirstPinResponse: true }),
    { community, managed, session, row, sealed, posts, ports } = fixture;
  try {
    let driver = firstSongDriver(ports),
      restarts = 0,
      clockOffset = 0;
    const faults = new Set<string>();
    let checkedChangedGrant = false,
      checkedBetweenStages = false,
      checkedStoryRevalidation = false;
    for (let i = 0; i < 20; i++) {
      const job = await loadJob(community.db, sealed.jobId);
      if (job.phase === "published") break;
      if (job.phase === "pin_audio" && !checkedBetweenStages) {
        const before = fixture.remoteRequests();
        const variants = [
          { ...ports, release: { ...ports.release, grantHash: publicId() } },
          {
            ...ports,
            posting: {
              ...ports.posting,
              bounds: { ...ports.posting.bounds, period: "changed-period" },
            },
          },
          {
            ...ports,
            posting: {
              ...ports.posting,
              bounds: {
                ...ports.posting.bounds,
                maximumTotalFee: "60000000000000",
              },
            },
          },
        ];
        for (const changed of variants)
          await assert.rejects(
            firstSongDriver(changed).request(job, "pin_audio"),
            /publication_execution_profile_changed/,
          );
        assert.equal(fixture.remoteRequests(), before);
        assert.equal(managed.adds(), 0);
        assert.equal(
          (await community.db
            .prepare(
              "SELECT COUNT(*) AS n FROM external_operations WHERE job_id=? AND step='pin_audio'",
            )
            .bind(sealed.jobId)
            .first())!.n,
          0,
        );
        checkedBetweenStages = true;
      }

      if (job.phase === "publication" && !checkedStoryRevalidation) {
        const saved = JSON.parse(job.progress_json).registration.receipt
          .transactionHash;
        managed.story.orphan(true);
        await assert.rejects(
          Effect.runPromise(
            publicationStep(community.db, sealed.jobId, driver, {
              now: () => Date.now() + clockOffset,
            }),
          ),
          /registration_result_mismatch/,
        );
        assert.equal(posts.broadcasts(), 0);
        assert.equal(managed.story.mints(), 1);
        assert.equal(
          JSON.parse((await loadJob(community.db, sealed.jobId)).progress_json)
            .registration.receipt.transactionHash,
          saved,
        );
        managed.story.orphan(false);
        clockOffset += 180001;
        driver = firstSongDriver(ports);
        checkedStoryRevalidation = true;
      }
      if (job.phase === "uncertain") {
        if (
          !checkedChangedGrant &&
          JSON.parse(job.progress_json).resumePhase === "admission"
        ) {
          const operation = await community.db
            .prepare(
              "SELECT * FROM external_operations WHERE job_id=? AND step='admission'",
            )
            .bind(sealed.jobId)
            .first<ExternalOperation>();
          const changed = firstSongDriver({
            ...ports,
            release: { ...ports.release, grantHash: publicId() },
          });
          await assert.rejects(
            changed.reconcile(operation!),
            /publication_execution_profile_changed/,
          );
          assert.equal(managed.sends(), 0);
          checkedChangedGrant = true;
        }
        await managed.runQueued();
        if (JSON.parse(job.progress_json).resumePhase === "publication")
          posts.mine();
        await resumeUncertainJob(
          community.db,
          sealed.jobId,
          session.account_id,
        );
        driver = firstSongDriver(ports);
        restarts++;
      }
      try {
        await Effect.runPromise(
          publicationStep(
            community.db,
            sealed.jobId,
            driver,
            { now: () => Date.now() + clockOffset },
            {
              boundary: async (boundary, operation) => {
                if (
                  operation.step === "registration" &&
                  (boundary === "started" || boundary === "confirmed") &&
                  !faults.has(boundary)
                ) {
                  faults.add(boundary);
                  throw new Error("fixture terminated at " + boundary);
                }
              },
            },
          ),
        );
      } catch (error) {
        assert.match(String(error), /fixture terminated/);
        clockOffset += 180001;
        driver = firstSongDriver(ports);
        restarts++;
      }
    }
    const job = await loadJob(community.db, sealed.jobId);
    assert.equal(job.phase, "published", job.progress_json);
    assert.ok(restarts >= 4);
    assert.equal(checkedChangedGrant, true);
    assert.equal(checkedBetweenStages, true);
    assert.equal(checkedStoryRevalidation, true);
    assert.equal(fixture.lostPinResponse(), true);
    assert.deepEqual([...faults], ["started", "confirmed"]);
    assert.equal(managed.sends(), 3);
    assert.equal(managed.adds(), 5);
    assert.equal(managed.story.mints(), 1);
    assert.equal(posts.broadcasts(), 1);
    for (let i = 0; i < 3; i++)
      assert.equal(
        await Effect.runPromise(
          publicationStep(community.db, sealed.jobId, firstSongDriver(ports)),
        ),
        "published",
      );
    const scan = await syncPublicPosts(
      community.db,
      posts.client,
      posts.profile,
      [configuration],
      configuration,
      managed.service.pinTransport,
    );
    assert.equal(scan.caughtUp, true);
    const feed = await indexedPublicPosts(
      community.db,
      posts.client,
      posts.profile,
      [configuration],
      configuration,
      scan.head,
    );
    assert.equal(feed.length, 1);
    assert.equal(feed[0]!.post.postId, row.post_id);
    assert.equal(
      feed[0]!.post.registration.recipient,
      managed.context.recipient,
    );
    assert.equal(JSON.stringify(feed).includes(session.account_id), false);
    const getHead = posts.client.getBlockNumber;
    let heads = 0;
    posts.client.getBlockNumber = async (...args) => {
      heads++;
      return getHead(...args);
    };
    const reads = {
      client: posts.client,
      profile: posts.profile,
      transport: managed.service.pinTransport,
    };
    try {
      assert.equal(
        await firstSongPublicReady(community.db, configuration, reads),
        true,
      );
      assert.equal(heads, 1, "readiness must authenticate the post only once");
      const audio = feed[0]!.post.media.find((m) => m.role === "audio")!;
      assert.equal(
        await firstSongPublicReady(community.db, configuration, {
          ...reads,
          transport: async (request) =>
            new URL(request.url).pathname.endsWith(audio.uri.slice(7))
              ? new Response("changed audio")
              : reads.transport(request),
        }),
        false,
        "missing or changed playback bytes cannot report ready",
      );
    } finally {
      posts.client.getBlockNumber = getHead;
    }
    const pretty = new TextEncoder().encode(
        JSON.stringify(feed[0]!.post, null, 2),
      ),
      prettyIntent = await preparePin(pretty, "application/json");
    managed.retained.set(prettyIntent.uri.slice(7), pretty);
    const input = await publicationInput(
      community.db,
      community.media,
      sealed.jobId,
      configuration,
    );
    await assert.rejects(
      validateReleaseResult(input, ports.release, "pin_manifest", {
        kind: "confirmed",
        providerId: prettyIntent.uri,
        value: {
          pin: {
            ...prettyIntent,
            retained: true,
            gateway: "https://gateway.pinata.cloud",
            verifiedAt: Math.floor(Date.now() / 1000),
          },
        },
      }),
      /post_manifest_not_canonical/,
    );
    assert.deepEqual(
      await indexedPublicPosts(
        community.db,
        posts.client,
        posts.profile,
        [configuration],
        configuration,
        99n,
      ),
      [],
    );
    await community.db
      .prepare(
        "INSERT INTO public_post_revisions SELECT community_id,post_id,revision+1,author_id,configuration_revision,manifest_uri,manifest_sha256,manifest_json,'101',block_hash,transaction_hash,log_index,quarantined FROM public_post_revisions WHERE revision=1",
      )
      .run();
    assert.equal(
      (
        await indexedPublicPosts(
          community.db,
          posts.client,
          posts.profile,
          [configuration],
          configuration,
          100n,
        )
      ).length,
      1,
    );
    await community.db
      .prepare(
        "UPDATE public_post_revisions SET transaction_hash=? WHERE revision=1",
      )
      .bind(publicId())
      .run();
    await assert.rejects(
      indexedPublicPosts(
        community.db,
        posts.client,
        posts.profile,
        [configuration],
        configuration,
        scan.head,
      ),
      /public_post_provenance_(unavailable|changed)/,
    );
    await community.db
      .prepare(
        "UPDATE public_post_revisions SET transaction_hash=? WHERE revision=1",
      )
      .bind(feed[0]!.transactionHash)
      .run();
    await community.db
      .prepare("UPDATE public_post_revisions SET manifest_sha256=?")
      .bind(publicId())
      .run();
    await assert.rejects(
      indexedPublicPosts(
        community.db,
        posts.client,
        posts.profile,
        [configuration],
        configuration,
        scan.head,
      ),
      /public_post_state_changed/,
    );
    await community.db
      .prepare("UPDATE chain_scan_state SET checkpoint_hash=?")
      .bind(publicId())
      .run();
    await assert.rejects(
      syncPublicPosts(
        community.db,
        posts.client,
        posts.profile,
        [configuration],
        configuration,
        managed.service.pinTransport,
      ),
      /public_index_checkpoint_changed/,
    );
    assert.equal(posts.broadcasts(), 1);
    assert.equal(managed.story.mints(), 1);
    assert.equal(managed.adds(), 5);
  } finally {
    await fixture.dispose();
  }
});

for (const scenario of ["retained_receipt", "expired_inputs"] as const) {
  test(`explicit same-admission resume recovers ${scenario} without another paid check`, async () => {
    const f = await firstSongJobFixture(),
      realNow = Date.now;
    try {
      if (scenario === "retained_receipt")
        await f.managed.db.exec(
          "CREATE TRIGGER fixture_retained_interruption BEFORE UPDATE OF state ON moderation_provider_calls WHEN NEW.state='validated' BEGIN SELECT RAISE(ABORT,'fixture_interrupted_after_receipt'); END;",
        );
      const driver = firstSongDriver(f.ports);
      assert.equal(
        await Effect.runPromise(
          publicationStep(f.community.db, f.sealed.jobId, driver),
        ),
        "uncertain",
      );
      if (scenario === "expired_inputs") Date.now = () => realNow() + 901000;
      await f.managed.runQueued();
      const before = await f.managed.db
        .prepare(
          "SELECT admission_id,request_hash,state FROM managed_admissions",
        )
        .first();
      assert.equal(before!.state, "held");
      assert.equal(f.managed.sends(), scenario === "retained_receipt" ? 1 : 0);
      if (scenario === "retained_receipt")
        await f.managed.db.exec("DROP TRIGGER fixture_retained_interruption;");
      assert.equal(
        await resumeFirstSongAdmission(f.ports, f.sealed.jobId),
        true,
      );
      await f.managed.runQueued();
      await resumeUncertainJob(
        f.community.db,
        f.sealed.jobId,
        f.session.account_id,
      );
      assert.equal(
        await Effect.runPromise(
          publicationStep(
            f.community.db,
            f.sealed.jobId,
            firstSongDriver(f.ports),
          ),
        ),
        "pin_audio",
      );
      const after = await f.managed.db
        .prepare(
          "SELECT admission_id,request_hash,state FROM managed_admissions",
        )
        .first();
      assert.equal(after!.admission_id, before!.admission_id);
      assert.equal(after!.request_hash, before!.request_hash);
      assert.equal(after!.state, "complete");
      assert.equal(f.managed.sends(), 3);
      assert.equal(
        (await f.managed.db
          .prepare("SELECT COUNT(*) AS n FROM moderation_provider_calls")
          .first())!.n,
        3,
      );
    } finally {
      Date.now = realNow;
      await f.dispose();
    }
  });
}
test("an unknown provider send cannot be resubmitted by the admission resume path", async () => {
  const f = await firstSongJobFixture({ responseLost: true });
  try {
    assert.equal(
      await Effect.runPromise(
        publicationStep(
          f.community.db,
          f.sealed.jobId,
          firstSongDriver(f.ports),
        ),
      ),
      "uncertain",
    );
    await f.managed.runQueued();
    assert.equal(f.managed.sends(), 1);
    assert.equal(
      await resumeFirstSongAdmission(f.ports, f.sealed.jobId),
      false,
    );
    assert.equal(f.managed.sends(), 1);
    assert.equal(
      (await f.managed.db
        .prepare("SELECT state FROM managed_admissions")
        .first())!.state,
      "uncertain",
    );
  } finally {
    await f.dispose();
  }
});
