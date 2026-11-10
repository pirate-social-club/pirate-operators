// Actual cookie/CSRF handlers and D1/R2 with explicitly simulated provider and
// chain transports. This is local composition evidence, not live acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { verifyLoginOffline } from "../harness/login-verifier.ts";
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
        verifyLoginOffline,
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
    assert.equal(
      (await call(
        `/api/uploads/${row.submissionId}/seal`,
        "POST",
        "{}",
        headers,
      ))!.status,
      409,
    );
    for (const slot of ["instrumental", "vocals"]) {
      const path = `/api/uploads/${row.submissionId}/stems/${slot}`;
      assert.equal(
        (await call(
          path,
          "POST",
          JSON.stringify({
            sha256: sha256(f.managed.audio),
            byteLength: f.managed.audio.length,
          }),
          headers,
        ))!.status,
        201,
      );
      assert.equal(
        (await call(path, "PUT", f.managed.audio, {
          ...auth,
          "content-type": "audio/mpeg",
        }))!.status,
        200,
      );
    }
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
        verifyLoginOffline,
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
    assert.equal(
      (await call(
        `/api/uploads/${row.submissionId}/stems`,
        "GET",
        undefined,
        otherAuth,
      ))!.status,
      404,
    );
    assert.equal(
      (await call(
        `/api/uploads/${row.submissionId}/stems/vocals`,
        "PUT",
        f.managed.audio,
        { ...otherAuth, "content-type": "audio/mpeg" },
      ))!.status,
      404,
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
    ).pin_lyrics.pin.uri as string;
    assert.match(lyricsUri, /^ipfs:\/\//);
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
    const availableAudio = await publicSongResource(
      new Request(context.origin + feed[0]!.audioUrl),
      f.community.db,
      configuration,
      unavailableLyrics,
    );
    assert.equal(availableAudio!.status, 200);
    assert.equal(
      sha256(new Uint8Array(await availableAudio!.arrayBuffer())),
      sha256(f.managed.audio),
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

test("under the unregistered owner policy only the controller-authorized owner can reserve, before any row exists", async () => {
  const { validateConfig } = await import(
    "../packages/community/config-manifest.ts"
  );
  const { UNREGISTERED_OWNER_POLICY_VERSION, UNREGISTERED_OWNER_POLICY_HASH } =
    await import("../packages/community/owner-policy.ts");
  const { hashJson } = await import("../packages/community/common.ts");
  const controller = privateKeyToAccount(`0x${"31".repeat(32)}`),
    stranger = privateKeyToAccount(`0x${"32".repeat(32)}`),
    learner = privateKeyToAccount(`0x${"33".repeat(32)}`);
  const f = await firstSongJobFixture(),
    context = {
      communityId: configuration.communityId,
      origin: configuration.app.origin,
    },
    policy = {
      version: UNREGISTERED_OWNER_POLICY_VERSION,
      sha256: UNREGISTERED_OWNER_POLICY_HASH,
    },
    unregistered = validateConfig({
      ...configuration,
      controller: controller.address.toLowerCase(),
      policies: { ...configuration.policies, admission: policy },
    });
  const now = Math.floor(Date.now() / 1000);
  const authorize = async (
    ownerWallet: string,
    signer: typeof controller = controller,
  ) => {
    const authorization = {
      schema: "pirate.owner-publishing-authorization/1",
      communityId: unregistered.communityId,
      ownerWallet: ownerWallet.toLowerCase(),
      policy,
      validFrom: now - 60,
      expiresAt: now + 3600,
    };
    return {
      authorization,
      signature: await signer.signMessage({
        message: { raw: hashJson(authorization) as `0x${string}` },
      }),
    };
  };
  try {
    await f.community.db
      .prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)")
      .bind(
        "fixture-binding",
        f.session.account_id,
        publisher.address.toLowerCase(),
        Date.now(),
      )
      .run();
    const signIn = async (account: typeof publisher) => {
      const challenge = await loginChallenge(
          f.community.db,
          context,
          account.address,
        ),
        login = await loginVerify(
          f.community.db,
          context,
          challenge.id,
          await account.signMessage({ message: challenge.message }),
          verifyLoginOffline,
        );
      return {
        cookie: login.cookie.split(";")[0]!,
        "x-csrf-token": login.csrf,
        origin: context.origin,
        "content-type": "application/json",
      };
    };
    const ownerHeaders = await signIn(publisher),
      learnerHeaders = await signIn(learner);
    const env = {
      DB: f.community.db,
      MEDIA: f.community.media,
      JOBS: { send: async () => assert.fail("no job may be queued") },
    };
    const call = async (
      headers: Record<string, string>,
      ownerAuthorization: unknown,
      key: string,
    ) => {
      try {
        return await communityReleaseApi(
          new Request(context.origin + "/api/uploads", {
            method: "POST",
            headers: { ...headers, "idempotency-key": key },
            body: JSON.stringify({
              title: f.managed.title,
              language: "en",
              lyrics: f.managed.lyrics,
              original: true,
              acceptedPolicy: UNREGISTERED_OWNER_POLICY_VERSION,
              rating: "general",
              audioSha256: sha256(f.managed.audio),
              audioBytes: f.managed.audio.length,
            }),
          }),
          env,
          context,
          async () => ({
            config: unregistered,
            ports: { ...f.ports, ownerAuthorization },
          }),
          (value, status = 200) => Response.json(value, { status }),
        );
      } catch (error) {
        if (error instanceof CommunityError)
          return Response.json({ error: error.code }, { status: error.status });
        throw error;
      }
    };
    const rows = async () =>
      (await f.community.db
        .prepare("SELECT COUNT(*) AS n FROM media_submissions")
        .first<{ n: number }>())!.n;
    const before = await rows();
    const refused = async (
      headers: Record<string, string>,
      authorization: unknown,
      status: number,
      code: string,
    ) => {
      const response = await call(
        headers,
        authorization,
        "fixture-owner-refused",
      );
      assert.equal(response!.status, status, code);
      assert.deepEqual(await response!.json(), { error: code });
      assert.equal(await rows(), before);
    };
    await refused(
      ownerHeaders,
      undefined,
      503,
      "owner_authorization_unavailable",
    );
    await refused(
      ownerHeaders,
      await authorize(learner.address),
      403,
      "owner_publication_only",
    );
    await refused(
      ownerHeaders,
      await authorize(publisher.address, stranger),
      403,
      "untrusted_owner_authorization_signer",
    );
    const valid = await authorize(publisher.address);
    // Another signed-in account is refused even with a valid owner authorization.
    await refused(learnerHeaders, valid, 403, "owner_publication_only");
    // No creator binding exists for anyone: the owner path never needs one.
    await f.community.db.prepare("DELETE FROM creator_bindings").run();
    const reserved = await call(ownerHeaders, valid, "fixture-owner-reserved");
    assert.equal(reserved!.status, 201);
    const row = await f.community.db
      .prepare(
        "SELECT creator_json,metadata_json,captured_wallet FROM media_submissions WHERE idempotency_key='fixture-owner-reserved'",
      )
      .first<{
        creator_json: string;
        metadata_json: string;
        captured_wallet: string;
      }>();
    assert.equal(row!.creator_json, "null");
    assert.equal(row!.captured_wallet, publisher.address.toLowerCase());
    const metadata = JSON.parse(row!.metadata_json);
    assert.equal(metadata.acceptedPolicy, UNREGISTERED_OWNER_POLICY_VERSION);
    assert.equal(metadata.rating, "general");
  } finally {
    await f.dispose();
  }
});
