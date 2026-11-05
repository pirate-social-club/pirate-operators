// Actual cookie/CSRF handlers and D1/R2 with explicitly simulated provider and
// chain transports. This is local composition evidence, not live acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { verifyMessage, sha256 } from "viem";
import { loginChallenge, loginVerify } from "../packages/community/accounts.ts";
import { privateKeyToAccount } from "viem/accounts";
import { CommunityError } from "../packages/community/common.ts";
import { communityReleaseApi } from "../services/community-release-api.ts";
import {
  runCommunityJob,
  recoverCommunityJobs,
} from "../services/community-jobs.ts";
import {
  publicSongViews,
  publicSongResource,
  firstSongPublicReady,
} from "../services/community-public.ts";
import { firstSongJobFixture } from "./fixtures/first-song-job.ts";
import { configuration, publisher } from "./fixtures/release-admission.ts";
import { loadJob } from "../packages/community/publication-store.ts";

test("authenticated release HTTP retains one upload/job through reload and queue restarts; anonymous public audio is byte-verified", async () => {
  const f = await firstSongJobFixture(),
    context = {
      communityId: configuration.communityId,
      origin: configuration.app.origin,
    };
  try {
    // Bind the fixture account to a real SIWE credential and perform actual
    // signature verification; no test-only auth bypass enters the handler.
    await f.community.db
      .prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)")
      .bind(
        "fixture-binding",
        f.session.account_id,
        publisher.address.toLowerCase(),
        Date.now(),
      )
      .run();
    const challenge = await loginChallenge(
        f.community.db,
        context,
        publisher.address,
      ),
      login = await loginVerify(
        f.community.db,
        context,
        challenge.id,
        await publisher.signMessage({ message: challenge.message }),
        (address, message, signature) =>
          verifyMessage({ address, message, signature }),
      ),
      auth = {
        cookie: login.cookie.split(";")[0]!,
        "x-csrf-token": login.csrf,
        origin: context.origin,
      },
      wakeups: string[] = [],
      jobs = {
        send: async ({ jobId }: { jobId: string }) => {
          wakeups.push(jobId);
        },
      } satisfies import("../services/community-jobs.ts").PublicationWakeQueue,
      env = { DB: f.community.db, MEDIA: f.community.media, JOBS: jobs },
      ready = async () => ({ config: configuration, ports: f.ports });
    const call = async (
      path: string,
      method = "GET",
      body?: BodyInit,
      headers: Record<string, string> = auth,
    ) => {
      try {
        return await communityReleaseApi(
          new Request(context.origin + path, { method, headers, body }),
          env,
          context,
          ready,
          (value, status = 200) => Response.json(value, { status }),
        );
      } catch (error) {
        if (error instanceof CommunityError)
          return Response.json({ error: error.code }, { status: error.status });
        throw error;
      }
    };
    assert.equal(
      (await call("/api/uploads", "GET", undefined, {}))!.status,
      401,
    );
    const metadata = JSON.stringify({
        title: f.managed.title,
        language: "en",
        lyrics: f.managed.lyrics,
        original: true,
        acceptedPolicy: "pirate-release/2026-08-29",
        audioSha256: sha256(f.managed.audio),
        audioBytes: f.managed.audio.length,
      }),
      headers = {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "fixture-http-resumable-release",
      };
    assert.equal(
      (await call("/api/uploads", "POST", metadata, {
        ...headers,
        "x-csrf-token": "wrong",
      }))!.status,
      403,
    );
    assert.equal(
      (await call("/api/uploads", "POST", metadata, {
        ...headers,
        origin: "https://attacker.example",
      }))!.status,
      403,
    );
    const first = await call("/api/uploads", "POST", metadata, headers),
      row = (await first!.json()) as { submissionId: string; postId: string };
    assert.equal(first!.status, 201);
    assert.deepEqual(
      await (await call("/api/uploads", "POST", metadata, headers))!.json(),
      { ...row, state: "reserved" },
    );
    assert.equal(
      (await call(
        "/api/uploads",
        "POST",
        metadata.replace(f.managed.title, "Changed title"),
        headers,
      ))!.status,
      409,
    );
    assert.equal(
      (await call(
        `/api/uploads/${row.submissionId}/audio`,
        "PUT",
        f.managed.audio,
        { ...auth, "content-type": "audio/mpeg" },
      ))!.status,
      200,
    );
    const sealed = (await (await call(
      `/api/uploads/${row.submissionId}/seal`,
      "POST",
      "{}",
      headers,
    ))!.json()) as { jobId: string };
    assert.deepEqual(
      await (await call(
        `/api/uploads/${row.submissionId}/seal`,
        "POST",
        "{}",
        headers,
      ))!.json(),
      sealed,
    );
    const privateRead = await (await call(
      `/api/jobs/${encodeURIComponent(sealed.jobId)}`,
    ))!.text();
    assert.ok(!privateRead.includes(f.session.account_id));
    assert.equal(
      (await call(
        `/api/jobs/${encodeURIComponent(f.sealed.jobId)}/resume`,
        "POST",
        "{}",
        headers,
      ))!.status,
      409,
    );
    // Another valid account cannot see or resume this job.
    const other = privateKeyToAccount(`0x${"44".repeat(32)}`),
      otherChallenge = await loginChallenge(
        f.community.db,
        context,
        other.address,
      ),
      otherLogin = await loginVerify(
        f.community.db,
        context,
        otherChallenge.id,
        await other.signMessage({ message: otherChallenge.message }),
        (address, message, signature) =>
          verifyMessage({ address, message, signature }),
      ),
      otherAuth = {
        cookie: otherLogin.cookie.split(";")[0]!,
        "x-csrf-token": otherLogin.csrf,
        origin: context.origin,
        "content-type": "application/json",
      };
    assert.equal(
      (await call(
        `/api/jobs/${encodeURIComponent(sealed.jobId)}`,
        "GET",
        undefined,
        otherAuth,
      ))!.status,
      404,
    );
    assert.equal(
      (await call(
        `/api/jobs/${encodeURIComponent(sealed.jobId)}/resume`,
        "POST",
        "{}",
        otherAuth,
      ))!.status,
      404,
    );
    assert.equal(
      (await call(
        `/api/uploads/${row.submissionId}/audio`,
        "PUT",
        f.managed.audio,
        { ...otherAuth, "content-type": "audio/mpeg" },
      ))!.status,
      404,
    );
    assert.deepEqual(
      await (await call("/api/uploads", "GET", undefined, otherAuth))!.json(),
      { uploads: [] },
    );
    const empty = await call("/api/uploads");
    assert.ok((await empty!.text()).includes(row.submissionId));
    for (let i = 0; i < 20; i++) {
      const job = await loadJob(f.community.db, sealed.jobId);
      if (job.phase === "published") break;
      if (job.phase === "uncertain") {
        await f.managed.runQueued();
        f.posts.mine();
      }
      await runCommunityJob(f.ports, jobs, sealed.jobId);
    }
    assert.equal(
      (await loadJob(f.community.db, sealed.jobId)).phase,
      "published",
    );
    assert.equal(f.managed.sends(), 3);
    assert.equal(f.managed.adds(), 5);
    assert.equal(f.managed.story.mints(), 1);
    assert.equal(f.posts.broadcasts(), 1);
    const publicPorts = {
        client: f.posts.client,
        profile: f.posts.profile,
        transport: f.managed.service.pinTransport,
      },
      feed = await publicSongViews(f.community.db, configuration, publicPorts);
    assert.equal(feed.length, 1);
    assert.equal(feed[0]!.manifest.postId, row.postId);
    assert.ok(!JSON.stringify(feed).includes(f.session.account_id));
    assert.equal(
      await firstSongPublicReady(f.community.db, configuration, publicPorts),
      true,
    );
    const lyricsUri = JSON.parse(
      (await loadJob(f.community.db, sealed.jobId)).progress_json,
    ).pin_lyrics.uri as string;
    const unavailableLyrics = {
      ...publicPorts,
      transport: async (request: Request) =>
        new URL(request.url).pathname.includes(lyricsUri.slice(7))
          ? new Response("fixture missing lyrics", { status: 404 })
          : f.managed.service.pinTransport(request),
    };
    await assert.rejects(
      publicSongViews(f.community.db, configuration, unavailableLyrics),
      /public_ipfs_unavailable/,
    );
    assert.equal(
      await firstSongPublicReady(
        f.community.db,
        configuration,
        unavailableLyrics,
      ),
      false,
    );
    const audioPath = context.origin + feed[0]!.audioUrl,
      audio = await publicSongResource(
        new Request(audioPath),
        f.community.db,
        configuration,
        publicPorts,
      );
    assert.equal(audio!.status, 200);
    assert.equal(
      sha256(new Uint8Array(await audio!.arrayBuffer())),
      sha256(f.managed.audio),
    );
    const range = await publicSongResource(
      new Request(audioPath, { headers: { range: "bytes=0-9" } }),
      f.community.db,
      configuration,
      publicPorts,
    );
    assert.equal(range!.status, 206);
    assert.equal((await range!.arrayBuffer()).byteLength, 10);
    await recoverCommunityJobs(f.community.db, jobs);
    await runCommunityJob(f.ports, jobs, sealed.jobId);
    assert.equal(f.posts.broadcasts(), 1);
    assert.equal(f.managed.story.mints(), 1);
  } finally {
    await f.dispose();
  }
});
