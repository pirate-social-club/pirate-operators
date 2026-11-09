// Release 1 acceptance through the community application itself: real SIWE
// sign-in, host cookie, CSRF and Origin checks, the upload, stem and seal
// routes, and the community queue handler running the publication job. The
// managed side is the managed admission and owner release handlers. ACRCloud,
// IPFS and the MegaETH chain are explicit simulations. There is no creator
// service, registration signer, registration client or Aeneid client; any
// registration route request or creator health check fails the test.
import test from "node:test";
import assert from "node:assert/strict";
import { sha256, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  communityFetch,
  communityQueue,
  type CommunityDependencies,
  type CommunityEnv,
} from "../services/community-application.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { loadJob } from "../packages/community/publication-store.ts";
import {
  OWNER_POLICY_HASH,
  OWNER_POLICY_VERSION,
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../packages/community/owner-policy.ts";
import { hashJson } from "../packages/community/common.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { publicationExecutionProfile } from "../packages/community/publication-profile.ts";
import {
  ownerGrantDigest,
  validateOwnerGrant,
} from "../packages/release/owner-grant.ts";
import { firstSongRuntime } from "../services/first-song-runtime.ts";
import { configuration as baselineConfiguration } from "./fixtures/release-admission.ts";
import {
  ownerController,
  ownerSongFixture,
} from "./fixtures/owner-song-job.ts";

// Public local fixture keys. Never fund or deploy them.
const owner = privateKeyToAccount(`0x${"51".repeat(32)}`),
  learner = privateKeyToAccount(`0x${"52".repeat(32)}`);

async function application() {
  const f = await ownerSongFixture(
    {},
    {
      community: {
        communityId: firstSong.directoryProfile.communityId,
        registry: firstSong.directoryProfile.registry,
        directory: firstSong.directoryProfile.directory,
        origin: firstSong.origin,
      },
      ownerWallet: owner.address,
    },
  );
  const wakes: string[] = [];
  let creatorChecks = 0;
  const env = {
    DB: f.community.db,
    MEDIA: f.community.media,
    JOBS: {
      send: async (message: { jobId: string }) => {
        wakes.push(message.jobId);
      },
    },
    ASSETS: {
      fetch: async () =>
        new Response("<main>Community</main>", {
          headers: { "content-type": "text/html" },
        }),
    },
    COMMUNITY_NAME: firstSong.name,
    PLAN_ID: firstSong.planId,
    APPLICATION_PROFILE_HASH: `0x${"a".repeat(64)}`,
    COMMUNITY_PUBLISHER_PRIVATE_KEY: `0x${"12".repeat(32)}`,
    // Present as in an owner deployment; the release ports are injected.
    OWNER_GRANT_JSON: JSON.stringify(f.grant),
  } as unknown as CommunityEnv;
  const ports: CommunityDependencies = {
    configuration: async () => f.configuration,
    verifyLogin: (address, message, signature) =>
      verifyMessage({ address, message, signature }),
    creatorHealth: async () => {
      creatorChecks++;
      throw new Error("creator service must not be contacted");
    },
    releaseRuntime: () => f.ports,
    publicReads: {
      client: f.posts.client,
      profile: f.posts.profile,
      transport: f.managed.service.pinTransport,
    },
  };
  const call = (path: string, options: RequestInit = {}) =>
    communityFetch(new Request(firstSong.origin + path, options), env, ports);
  const signIn = async (account: typeof owner) => {
    const challenge = (await (
      await call("/api/auth/challenge", {
        method: "POST",
        headers: {
          origin: firstSong.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ address: account.address }),
      })
    ).json()) as { id: string; message: string };
    const verified = await call("/api/auth/verify", {
      method: "POST",
      headers: {
        origin: firstSong.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: challenge.id,
        signature: await account.signMessage({ message: challenge.message }),
      }),
    });
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!,
      session = (await (
        await call("/api/session", { headers: { cookie } })
      ).json()) as { csrf: string; publisher: boolean };
    const write = (
      path: string,
      method: string,
      body: BodyInit,
      extra: Record<string, string> = {},
    ) =>
      call(path, {
        method,
        headers: {
          cookie,
          origin: firstSong.origin,
          "x-csrf-token": session.csrf,
          ...extra,
        },
        body,
      });
    return { cookie, csrf: session.csrf, publisher: session.publisher, write };
  };
  /** Delivers queued wakeups to the community queue handler until settled. */
  const runQueue = async (jobId: string, rounds = 40) => {
    for (let i = 0; i < rounds; i++) {
      const job = await loadJob(f.community.db, jobId);
      if (["published", "blocked", "held", "failed"].includes(job.phase))
        return job;
      await f.managed.runQueued();
      f.posts.mine();
      const acked: boolean[] = [];
      await communityQueue(
        {
          messages: [
            {
              body: { jobId },
              ack: () => acked.push(true),
              retry: () => acked.push(false),
            } as unknown as Message<{ jobId: string }>,
          ],
        },
        env,
        ports,
      );
    }
    return loadJob(f.community.db, jobId);
  };
  return {
    f,
    env,
    ports,
    call,
    signIn,
    runQueue,
    wakes,
    creatorChecks: () => creatorChecks,
  };
}

const metadata = (audio: Uint8Array, lyrics: string, title: string) =>
  JSON.stringify({
    title,
    language: "en",
    lyrics,
    original: true,
    acceptedPolicy: UNREGISTERED_OWNER_POLICY_VERSION,
    rating: "general",
    audioSha256: sha256(audio),
    audioBytes: audio.length,
  });

test("the owner signs in, uploads and seals through the community routes, and the queue handler publishes /3 with no creator or registration service", async () => {
  const a = await application();
  const { f } = a;
  try {
    const capabilities = (await (
      await a.call("/api/capabilities")
    ).json()) as Record<string, unknown>;
    assert.equal(capabilities.upload, true);
    assert.equal(capabilities.publication, true);
    assert.equal(capabilities.creatorConnection, false);
    assert.equal(capabilities.policyVersion, UNREGISTERED_OWNER_POLICY_VERSION);
    const session = await a.signIn(owner);
    // Display only; the release routes check the same authorization.
    assert.equal(session.publisher, true);
    const audio = f.managed.audio;
    const reserved = await session.write(
      "/api/uploads",
      "POST",
      metadata(audio, f.managed.lyrics, "Owner route song"),
      {
        "content-type": "application/json",
        "idempotency-key": "owner-route-song-0001",
      },
    );
    assert.equal(reserved.status, 201, await reserved.clone().text());
    const { submissionId } = (await reserved.json()) as {
      submissionId: string;
    };
    const uploaded = await session.write(
      `/api/uploads/${submissionId}/audio`,
      "PUT",
      audio,
      { "content-type": "audio/mpeg" },
    );
    assert.equal(uploaded.status, 200, await uploaded.clone().text());
    for (const slot of ["instrumental", "vocals"]) {
      const stem = await session.write(
        `/api/uploads/${submissionId}/stems/${slot}`,
        "POST",
        JSON.stringify({ sha256: sha256(audio), byteLength: audio.length }),
        { "content-type": "application/json" },
      );
      assert.equal(stem.status, 201, await stem.clone().text());
      const put = await session.write(
        `/api/uploads/${submissionId}/stems/${slot}`,
        "PUT",
        audio,
        { "content-type": "audio/mpeg" },
      );
      assert.equal(put.status, 200, await put.clone().text());
    }
    const sealed = await session.write(
      `/api/uploads/${submissionId}/seal`,
      "POST",
      "{}",
      { "content-type": "application/json" },
    );
    assert.equal(sealed.status, 202, await sealed.clone().text());
    const { jobId } = (await sealed.json()) as { jobId: string };
    assert.deepEqual(a.wakes, [jobId]);
    const job = await a.runQueue(jobId);
    assert.equal(
      job.phase,
      "published",
      `${(job as { error_code?: string }).error_code}`,
    );
    const view = (await (
      await a.call(`/api/jobs/${encodeURIComponent(jobId)}`, {
        headers: { cookie: session.cookie },
      })
    ).json()) as { phase: string };
    assert.equal(view.phase, "published");
    const steps = await f.community.db
      .prepare(
        "SELECT step FROM external_operations WHERE job_id=? ORDER BY rowid",
      )
      .bind(jobId)
      .all<{ step: string }>();
    assert.equal(
      steps.results.some((r) => r.step === "registration"),
      false,
    );
    assert.equal(f.registrationRequests(), 0);
    assert.equal(a.creatorChecks(), 0);
    assert.equal(
      (await f.community.db
        .prepare("SELECT COUNT(*) AS n FROM creator_bindings")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("a signed-in learner, a missing CSRF token and a foreign Origin are refused at the community routes before any row exists", async () => {
  const a = await application();
  const { f } = a;
  try {
    const body = metadata(f.managed.audio, f.managed.lyrics, "Not yours");
    const json = { "content-type": "application/json" };
    const other = await a.signIn(learner);
    // The learner is shown no release controls, and the route refuses anyway.
    assert.equal(other.publisher, false);
    const refused = await other.write("/api/uploads", "POST", body, {
      ...json,
      "idempotency-key": "learner-upload-key-0001",
    });
    assert.equal(refused.status, 403);
    assert.equal(
      ((await refused.json()) as { error: string }).error,
      "owner_publication_only",
    );
    const own = await a.signIn(owner);
    const noCsrf = await a.call("/api/uploads", {
      method: "POST",
      headers: {
        cookie: own.cookie,
        origin: firstSong.origin,
        ...json,
        "idempotency-key": "owner-no-csrf-key-0001",
      },
      body,
    });
    assert.equal(noCsrf.status, 403);
    const foreign = await own.write("/api/uploads", "POST", body, {
      ...json,
      origin: "https://attacker.example",
      "idempotency-key": "owner-foreign-key-0001",
    });
    assert.equal(foreign.status, 403);
    assert.equal(
      (await f.community.db
        .prepare("SELECT COUNT(*) AS n FROM media_submissions")
        .first<{ n: number }>())!.n,
      0,
    );
    assert.equal(a.creatorChecks(), 0);
    // Status during a configuration-read failure still never contacts the
    // creator service in an owner deployment.
    const configuration = a.ports.configuration;
    a.ports.configuration = async () => {
      throw new Error("fixture directory outage");
    };
    const status = (await (await a.call("/health")).json()) as {
      creatorConnection: string;
    };
    a.ports.configuration = configuration;
    assert.equal(status.creatorConnection, "unavailable");
    assert.equal(a.creatorChecks(), 0);
    // Before activation the configuration still names the November 5 policy;
    // an owner deployment still never contacts the creator service.
    a.ports.configuration = async () => ({
      ...f.configuration,
      policies: {
        ...f.configuration.policies,
        admission: { version: OWNER_POLICY_VERSION, sha256: OWNER_POLICY_HASH },
      },
    });
    const before = (await (await a.call("/health")).json()) as {
      creatorConnection: string;
    };
    const beforeCapabilities = (await (
      await a.call("/api/capabilities")
    ).json()) as { creatorConnection: boolean };
    a.ports.configuration = configuration;
    assert.equal(before.creatorConnection, "unavailable");
    assert.equal(beforeCapabilities.creatorConnection, false);
    // The preserved connection routes refuse before any creator contact.
    for (const route of ["/api/creator/connect", "/api/creator/complete"]) {
      const refused = await own.write(route, "POST", "{}", json);
      assert.equal(refused.status, 503);
      assert.equal(
        ((await refused.json()) as { error: string }).error,
        "creator_connection_unavailable",
      );
    }
    assert.equal(a.creatorChecks(), 0);
  } finally {
    await f.dispose();
  }
});

test("the production runtime selects owner mode from the configuration policy and checks only the managed owner release", async () => {
  const configuration = validateConfig({
    ...baselineConfiguration,
    communityId: firstSong.directoryProfile.communityId,
    registry: firstSong.directoryProfile.registry,
    directory: firstSong.directoryProfile.directory,
    postsContract: firstSong.posts.address,
    controller: ownerController.address.toLowerCase(),
    app: { ...baselineConfiguration.app, origin: firstSong.origin },
    feed: {
      ...baselineConfiguration.feed,
      endpoint: firstSong.origin + "/api/feed",
    },
    policies: {
      ...baselineConfiguration.policies,
      admission: {
        version: UNREGISTERED_OWNER_POLICY_VERSION,
        sha256: UNREGISTERED_OWNER_POLICY_HASH,
      },
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const draft = {
    schema: "pirate.owner-publishing-grant/1" as const,
    sha256: "0x" + "00".repeat(32),
    communityId: configuration.communityId,
    communityOrigin: configuration.app.origin,
    ownerWallet: owner.address.toLowerCase(),
    policy: configuration.policies.admission,
    destination: {
      chainId: configuration.chainId,
      postsContract: configuration.postsContract,
      publisher: configuration.publisher,
    },
    validFrom: now - 60,
    expiresAt: now + 3600,
    limits: {
      songs: 3,
      pinAdds: 15,
      pinBytes: "67108864",
      recognitionRequests: 12,
      postFeeWei: "90000000000000",
    },
  };
  const grant = validateOwnerGrant({
    ...draft,
    sha256: ownerGrantDigest(draft),
  });
  const body = {
    schema: "pirate.owner-publishing-authorization/1",
    communityId: configuration.communityId,
    ownerWallet: owner.address.toLowerCase(),
    policy: configuration.policies.admission,
    validFrom: now - 60,
    expiresAt: now + 3600,
  };
  const authorization = {
    authorization: body,
    signature: await ownerController.signMessage({
      message: { raw: hashJson(body) as `0x${string}` },
    }),
  };
  const managedProfileHash = `0x${"c".repeat(64)}`;
  const env = {
    DB: {} as D1Database,
    MEDIA: {} as R2Bucket,
    COMMUNITY_PUBLISHER_PRIVATE_KEY: `0x${"12".repeat(32)}`,
    MANAGED_PROFILE_HASH: managedProfileHash,
    OWNER_GRANT_JSON: JSON.stringify(grant),
    OWNER_AUTHORIZATION_JSON: JSON.stringify(authorization),
  };
  const current = async () => configuration;
  const contacted: string[] = [];
  let reported = grant.sha256;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    contacted.push(url);
    if (url === firstSong.managedOrigin + "/health")
      return Response.json({
        profileHash: managedProfileHash,
        release: { configured: false },
        ownerRelease: { configured: true, grantSha256: reported },
      });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const ports = firstSongRuntime(env, configuration, current);
    const release = ports.release as unknown as Record<string, unknown>;
    assert.equal(release.story, undefined);
    assert.equal(release.registrationOperator, undefined);
    assert.equal(
      (release.ownerGrant as { sha256: string }).sha256,
      grant.sha256,
    );
    assert.equal(ports.posting.ownerGrant?.sha256, grant.sha256);
    assert.deepEqual(ports.ownerAuthorization, authorization);
    const profile = publicationExecutionProfile(ports);
    assert.equal(profile.schema, "pirate.publication-execution-profile/2");
    assert.equal(profile.serviceOrigin, firstSong.managedOrigin);
    assert.equal(profile.posting.expiresAt, grant.expiresAt);
    assert.equal("registrationOperator" in profile, false);
    await ports.checkServices();
    assert.deepEqual(contacted, [firstSong.managedOrigin + "/health"]);
    // A managed service holding another grant is not ready.
    reported = "0x" + "99".repeat(32);
    await assert.rejects(ports.checkServices(), /release_service_unavailable/);
    // Owner mode needs both reviewed values; the registered path is not a fallback.
    for (const missing of ["OWNER_GRANT_JSON", "OWNER_AUTHORIZATION_JSON"])
      assert.throws(
        () =>
          firstSongRuntime(
            { ...env, [missing]: undefined },
            configuration,
            current,
          ),
        /owner_runtime_unconfigured/,
      );
    // A grant for another destination is refused.
    const other = {
      ...draft,
      destination: { ...draft.destination, publisher: "0x" + "77".repeat(20) },
    };
    assert.throws(
      () =>
        firstSongRuntime(
          {
            ...env,
            OWNER_GRANT_JSON: JSON.stringify({
              ...other,
              sha256: ownerGrantDigest(other),
            }),
          },
          configuration,
          current,
        ),
      /owner_grant_scope_mismatch/,
    );
    // Owner values never turn a registered-policy configuration into owner mode.
    const registered = validateConfig({
      ...configuration,
      policies: baselineConfiguration.policies,
    });
    assert.throws(
      () => firstSongRuntime(env, registered, async () => registered),
      /release_runtime_unconfigured/,
    );
    assert.equal(
      contacted.some((url) => !url.startsWith(firstSong.managedOrigin)),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
