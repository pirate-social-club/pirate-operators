import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { Effect } from "effect";
import { communityRuntime } from "./community-runtime.ts";
import { releaseFixture } from "./fixtures/release-service.ts";
import { publisher, configuration } from "./fixtures/release-admission.ts";
import { releasePostsFixture } from "./fixtures/release-posts.ts";
import { hashText, publicId } from "../packages/community/common.ts";
import {
  reserveSubmission,
  sealSubmission,
} from "../packages/community/submissions.ts";
import { uploadAudio } from "../packages/community/uploads.ts";
import { serveInputCapability } from "../packages/community/input-capabilities.ts";
import { publicationStep } from "../packages/community/publication.ts";
import type { ExternalOperation } from "../packages/community/publication-store.ts";
import {
  loadJob,
  resumeUncertainJob,
} from "../packages/community/publication-store.ts";
import {
  syncPublicPosts,
  indexedPublicPosts,
} from "../packages/community/post-index.ts";
import { firstSongDriver } from "../services/first-song-driver.ts";
import type { AccountSession } from "../packages/community/accounts.ts";

test("sealed upload resumes across managed admission, pinning, ROOT mint and pending post; public chain reconstruction preserves private separation", async () => {
  const community = await communityRuntime(),
    managed = await releaseFixture(1001, false, 3600, false);
  try {
    // Explicit completed authentication/native-binding fixture. Their real
    // cryptography/device acceptance is owned by their separate tests and pilot.
    const session: AccountSession = {
      session_hash: hashText("fixture-session"),
      account_id: crypto.randomUUID(),
      author_id: publicId(),
      binding_id: "fixture-moss",
      wallet: publisher.address.toLowerCase() as `0x${string}`,
      csrf_token: "fixture-csrf",
      expires_at: Date.now() + 900000,
    };
    await community.db.batch([
      community.db
        .prepare("INSERT INTO community_accounts VALUES(?,?,?)")
        .bind(session.account_id, session.author_id, Date.now()),
      community.db
        .prepare(
          "INSERT INTO creator_bindings VALUES(?,'https://wallet.example','fixture-credential','fixture-sui','fixture-dwallet','fixture-cap','fixture-share',?,'{}',?)",
        )
        .bind(session.account_id, managed.context.recipient, Date.now()),
    ]);
    const profile = {
      chainId: 6343,
      communityId: configuration.communityId,
      postsContract: configuration.postsContract,
      configurationRevision: 1,
      publisher: configuration.publisher,
      moderationSigner: configuration.policies.moderationSigner,
    };
    const row = await reserveSubmission(
      community.db,
      session,
      profile,
      {
        title: managed.title,
        language: "en",
        lyrics: managed.lyrics,
        original: true,
        acceptedPolicy: "pirate-release/2026-08-29",
        audioSha256: sha256(managed.audio),
        audioBytes: managed.audio.length,
      },
      "fixture-durable-first-song-key",
    );
    await uploadAudio(
      community.db,
      community.media,
      session.account_id,
      row.submission_id,
      new Request(configuration.app.origin + "/api/uploads/audio", {
        method: "PUT",
        headers: { "content-type": "audio/mpeg" },
        body: managed.audio,
      }),
    );
    const sealed = await sealSubmission(
      community.db,
      community.media,
      session,
      profile,
      row.submission_id,
    );
    managed.config.inputTransport = (request) =>
      serveInputCapability(
        request,
        community.db,
        community.media,
        configuration.app.origin,
      );
    const posts = releasePostsFixture(publisher, configuration),
      client = {
        origin: managed.service.origin,
        publisher,
        configuration,
        transport: managed.transport,
      };
    const originalPinTransport = managed.service.pinTransport;
    let lostPinResponse = false;
    managed.service.pinTransport = async (request) => {
      const response = await originalPinTransport(request);
      if (!lostPinResponse && new URL(request.url).pathname === "/api/v0/add") {
        lostPinResponse = true;
        throw new Error("fixture response lost after retained pin");
      }
      return response;
    };
    const ports = {
      db: community.db,
      media: community.media,
      managed: client,
      release: {
        client,
        grantHash: managed.grant.sha256,
        registrationOperator: managed.grant.registration.operator,
        story: managed.story.client,
        ipfs: managed.service.pinTransport,
      },
      posting: {
        db: community.db,
        client: posts.client,
        publisher,
        profile: posts.profile,
        config: configuration,
        currentConfiguration: async () => configuration,
        bounds: {
          period: "fixture-first-song",
          maximumGas: "1000000",
          maximumGasPrice: "30000000",
          maximumTotalFee: "30000000000000",
          expiresAt: managed.grant.expiresAt,
        },
      },
      acrEndpoint: managed.service.acrEndpoint,
      checkServices: async () => {},
    };
    let driver = firstSongDriver(ports),
      restarts = 0,
      clockOffset = 0;
    const faults = new Set<string>();
    let checkedChangedGrant = false;
    for (let i = 0; i < 20; i++) {
      const job = await loadJob(community.db, sealed.jobId);
      if (job.phase === "published") break;
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
            /publication_operation_input_changed/,
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
    assert.equal(lostPinResponse, true);
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
    await community.dispose();
    await managed.dispose();
  }
});
