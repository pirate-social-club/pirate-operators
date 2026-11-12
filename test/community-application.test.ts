import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyLoginOffline } from "../harness/login-verifier.ts";
import { privateKeyToAccount } from "viem/accounts";
import { communityRuntime } from "./community-runtime.ts";
import {
  communityFetch,
  communityQueue,
  communityScheduled,
  type CommunityEnv,
  type CommunityDependencies,
} from "../services/community-application.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { authorizeCreatorRequest } from "../packages/community/creator-service.ts";
import { creatorServiceOrigin } from "../packages/community/creator-receipt.ts";
import { hashJson } from "../packages/community/common.ts";
import {
  CommunityPrivateDance,
  type CommunityQueueJob,
  type PrivateMediaJob,
} from "../services/community-private-dance.ts";
import { sha256 } from "../packages/community-media/validation.ts";
import { danceFixture } from "./dance-fixture.ts";
import { releasePostsFixture } from "./fixtures/release-posts.ts";

// Public local fixture keys. Never fund or deploy them.
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`),
  publisher = privateKeyToAccount(`0x${"12".repeat(32)}`),
  deployment = JSON.parse(
    await readFile(
      new URL(
        "../docs/deployments/first-song-managed-20261105.configuration.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
  config = validateConfig({
    ...deployment.configuration,
    publisher: publisher.address.toLowerCase(),
  });

async function fixture() {
  const runtime = await communityRuntime();
  const env = {
    DB: runtime.db,
    MEDIA: runtime.media,
    JOBS: { send: async () => {} },
    ASSETS: {
      fetch: async () =>
        new Response("<main>Community</main>", {
          headers: { "content-type": "text/html" },
        }),
    },
    COMMUNITY_NAME: firstSong.name,
    PLAN_ID: firstSong.planId,
    APPLICATION_PROFILE_HASH: `0x${"a".repeat(64)}`,
    CREATOR_PROFILE_HASH: `0x${"b".repeat(64)}`,
    COMMUNITY_PUBLISHER_PRIVATE_KEY: `0x${"12".repeat(32)}`,
  } as unknown as CommunityEnv;
  const launches = new Set<string>();
  const posts = releasePostsFixture(publisher, config);
  let loseLaunch = true;
  const ports: CommunityDependencies = {
    publicReads: { client: posts.client, profile: posts.profile },
    configuration: async () => config,
    verifyLogin: verifyLoginOffline,
    creatorHealth: async () => true,
    creatorTransport: async (request: Request) => {
      const verified = await authorizeCreatorRequest(
          await request.json(),
          "creator_launch",
          creatorServiceOrigin,
          async () => config,
        ),
        id = hashJson({
          communityId: config.communityId,
          connectionId: verified.body.connectionId,
        }).slice(2);
      launches.add(id);
      if (loseLaunch) {
        loseLaunch = false;
        throw new Error("fixture lost response");
      }
      return Response.json({
        requestId: id,
        url: `${creatorServiceOrigin}/wallet?request=${id}`,
      });
    },
  };
  const call = (path: string, options: RequestInit = {}) =>
    communityFetch(new Request(firstSong.origin + path, options), env, ports);
  const post = (
    path: string,
    body: unknown,
    more: Record<string, string> = {},
  ) =>
    call(path, {
      method: "POST",
      headers: {
        origin: firstSong.origin,
        "content-type": "application/json",
        ...more,
      },
      body: JSON.stringify(body),
    });
  return { ...runtime, env, ports, call, post, launches };
}

test("application signs in with real SIWE verification, host cookie and CSRF; public endpoints expose no private identity", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("/api/session")).status, 401);
    const challenge = (await (
      await f.post("/api/auth/challenge", { address: signer.address })
    ).json()) as { id: string; message: string };
    assert.ok(challenge.message.includes(firstSong.origin));
    assert.ok(challenge.message.includes("Chain ID: 6343"));
    const signature = await signer.signMessage({ message: challenge.message }),
      verified = await f.post("/api/auth/verify", {
        id: challenge.id,
        signature,
      }),
      cookie = verified.headers.get("set-cookie")!;
    assert.equal(verified.status, 200);
    assert.match(cookie, /^__Host-community_session=/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
      assert.ok(cookie.includes(flag));
    assert.ok(!cookie.includes("Domain="));
    const auth = { cookie: cookie.split(";")[0]! },
      session = (await (
        await f.call("/api/session", { headers: auth })
      ).json()) as Record<string, unknown>;
    assert.match(String(session.authorId), /^0x[0-9a-f]{64}$/);
    assert.equal(session.mossAddress, signer.address.toLowerCase());
    assert.ok(!("accountId" in session));
    assert.equal(
      (await f.post("/api/auth/verify", { id: challenge.id, signature }))
        .status,
      401,
    );
    assert.equal((await f.post("/api/logout", {}, auth)).status, 403);
    const wrongOrigin = await f.post(
      "/api/logout",
      {},
      {
        ...auth,
        "x-csrf-token": String(session.csrf),
        origin: "https://attacker.example",
      },
    );
    assert.equal(wrongOrigin.status, 403);
    for (const path of [
      "/api/feed",
      "/api/public/community",
      "/.well-known/pirate-client.json",
      "/.well-known/pirate-community.json",
    ]) {
      const response = await f.call(path),
        data = await response.text();
      assert.equal(response.status, 200);
      assert.ok(!data.includes(String(session.authorId)));
      assert.ok(!data.includes(String(session.csrf)));
      assert.ok(!data.includes(signer.address.toLowerCase()));
    }
    f.ports.configuration = async () => {
      throw new Error("fixture directory outage");
    };
    assert.equal((await f.call("/api/session", { headers: auth })).status, 200);
    const signedOut = await f.post(
      "/api/logout",
      {},
      { ...auth, "x-csrf-token": String(session.csrf) },
    );
    assert.equal(signedOut.status, 200);
    assert.match(signedOut.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await f.call("/api/session", { headers: auth })).status, 401);
  } finally {
    await f.dispose();
  }
});

test("application recovers a lost native launch with one private connection after reload", async () => {
  const f = await fixture();
  try {
    const c = (await (
        await f.post("/api/auth/challenge", { address: signer.address })
      ).json()) as { id: string; message: string },
      login = await f.post("/api/auth/verify", {
        id: c.id,
        signature: await signer.signMessage({ message: c.message }),
      }),
      auth = {
        cookie: login.headers.get("set-cookie")!.split(";")[0]!,
        "x-csrf-token": String(((await login.json()) as { csrf: string }).csrf),
      };
    assert.equal((await f.post("/api/creator/connect", {}, auth)).status, 503);
    const reopened = (await (
        await f.call("/api/session", { headers: auth })
      ).json()) as {
        pendingConnection: {
          connectionId: string;
          state: string;
          requestId: null;
        };
      },
      resumed = await f.post("/api/creator/connect", {}, auth),
      connection = (await resumed.json()) as {
        connectionId: string;
        state: string;
        url: string;
      };
    assert.equal(resumed.status, 200);
    assert.equal(
      connection.connectionId,
      reopened.pendingConnection.connectionId,
    );
    assert.equal(connection.state, reopened.pendingConnection.state);
    assert.equal(f.launches.size, 1);
    assert.equal(new URL(connection.url).origin, creatorServiceOrigin);
    const publicText = await (await f.call("/api/feed")).text();
    assert.ok(!publicText.includes(connection.connectionId));
    assert.ok(!publicText.includes(connection.state));
  } finally {
    await f.dispose();
  }
});

test("application separates bootstrap from directory manifest, serves assets without RPC and refuses changed authority", async () => {
  const f = await fixture();
  try {
    const client = (await (
        await f.call("/.well-known/pirate-client.json")
      ).json()) as { schema: string },
      manifest = (await (
        await f.call("/.well-known/pirate-community.json")
      ).json()) as { schema: string };
    assert.equal(client.schema, "pirate.community-client-config/1");
    assert.equal(manifest.schema, "pirate.community-config/1");
    f.ports.configuration = async () => {
      throw new Error("fixture unavailable RPC");
    };
    const page = await f.call("/");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "strict-origin");
    assert.match(
      page.headers.get("content-security-policy")!,
      /frame-src https:\/\/\*\.megaeth.com/,
    );
    assert.equal((await f.call("/api/feed")).status, 503);
    assert.equal(
      (
        await communityFetch(
          new Request("https://other.example/api/feed"),
          f.env,
          f.ports,
        )
      ).status,
      403,
    );
    f.ports.configuration = async () => ({
      ...config,
      app: { ...config.app, origin: "https://other.example" },
    });
    assert.equal((await f.call("/api/feed")).status, 503);
  } finally {
    await f.dispose();
  }
});

test("admitted private Dance runtime uses real HTTP session, queue isolation and durable maintenance", async () => {
  const f = await fixture();
  try {
    const migration = await readFile(
      new URL(
        "../apps/community-wizard/infra/migrations/0015_community_media.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await f.db.batch(
      migration
        .replace(/^--[^\n]*\n/gm, "")
        .trim()
        .split(/;\n+/)
        .map((sql) => f.db.prepare(sql)),
    );
    await f.db
      .prepare(
        "CREATE TABLE capture_gate(account_id TEXT PRIMARY KEY, active INTEGER NOT NULL)",
      )
      .run();
    const bytes = new TextEncoder().encode(
      "sealed local bound renderer fixture",
    );
    const recording = await sha256(bytes);
    const jobs: PrivateMediaJob[] = [];
    let renders = 0;
    const dance = danceFixture().ports;
    const song = {
      communityId: config.communityId,
      songKey: "published_private_fixture",
      songRevision: 1,
      audioSha256: "a".repeat(64),
      durationSamples: 48_000 * 15,
      title: "Fixture song",
    };
    const runtime = new CommunityPrivateDance({
      db: f.db,
      bucket: f.media,
      communityId: config.communityId,
      renderer: {
        async fetch(url, init) {
          assert.equal(url, "https://community-media.internal/render");
          assert.equal(init?.method, "POST");
          renders++;
          return new Response(bytes, {
            headers: {
              "x-media-facts": JSON.stringify({
                sha256: recording,
                bytes: bytes.byteLength,
                durationMs: 6000,
                width: 320,
                height: 240,
                videoCodec: "h264",
                audioCodec: "aac",
              }),
            },
          });
        },
      },
      dance,
      active: async () => true,
      song: async () => song,
      reservation: async (actor) => ({
        sql: "EXISTS(SELECT 1 FROM capture_gate WHERE account_id=? AND active=1)",
        values: [actor.accountId],
      }),
      preview: async () => false,
      enqueue: async (job) => {
        jobs.push(job);
      },
    });
    f.ports.privateDance = () => runtime;
    const intent = {
      requestId: "private_mount_001",
      songKey: song.songKey,
      songRevision: song.songRevision,
      recordingSha256: recording,
      bytes: bytes.byteLength,
      startSample: 0,
      durationSamples: 6 * 48_000,
      purpose: "private-review",
      publicConsent: false,
    };
    assert.equal((await f.post("/api/media", intent)).status, 401);
    const challenge = (await (
      await f.post("/api/auth/challenge", { address: signer.address })
    ).json()) as { id: string; message: string };
    const verified = await f.post("/api/auth/verify", {
      id: challenge.id,
      signature: await signer.signMessage({ message: challenge.message }),
    });
    const cookie = verified.headers.get("set-cookie")!.split(";")[0];
    const session = (await (
      await f.call("/api/session", { headers: { cookie } })
    ).json()) as { csrf: string };
    const auth = { cookie, "x-csrf-token": session.csrf };
    assert.equal((await f.post("/api/media", intent, { cookie })).status, 403);
    assert.equal((await f.post("/api/media", intent, auth)).status, 403);
    const account = await f.db
      .prepare("SELECT account_id FROM credential_bindings WHERE subject=?")
      .bind(signer.address.toLowerCase())
      .first<{ account_id: string }>();
    assert.ok(account);
    await f.db
      .prepare("INSERT INTO capture_gate VALUES(?,1)")
      .bind(account.account_id)
      .run();
    const reserve = await f.post("/api/media", intent, auth);
    assert.equal(reserve.status, 201);
    const { id } = (await reserve.json()) as { id: string };
    const blocked = await f.post(
      "/api/media",
      {
        ...intent,
        requestId: "public_mount_001",
        durationSamples: 3 * 48_000,
        purpose: "public-feed",
        publicConsent: true,
      },
      auth,
    );
    assert.equal(blocked.status, 403);
    await f.db.prepare("UPDATE capture_gate SET active=0").run();
    assert.equal((await f.post("/api/media", intent, auth)).status, 403);
    await f.db.prepare("UPDATE capture_gate SET active=1").run();
    assert.equal(
      (
        await f.call(`/api/media/${id}/upload`, {
          method: "PUT",
          headers: { ...auth, origin: firstSong.origin },
          body: bytes,
        })
      ).status,
      200,
    );
    assert.deepEqual(jobs, [
      {
        kind: "community-media/1",
        communityId: config.communityId,
        mediaId: id,
      },
    ]);
    const acks: string[] = [],
      retries: string[] = [];
    function message(label: string, body: CommunityQueueJob) {
      return {
        body,
        ack: () => acks.push(label),
        retry: () => retries.push(label),
      } as unknown as Message<CommunityQueueJob>;
    }
    await communityQueue(
      {
        messages: [
          message("foreign", {
            ...jobs[0],
            communityId: "different-community",
          }),
          message("media", jobs[0]),
        ],
      },
      f.env,
      f.ports,
    );
    assert.deepEqual(retries, ["foreign"]);
    assert.deepEqual(acks, ["media"]);
    assert.equal(renders, 1);
    assert.equal((await runtime.media.ports.repository.get(id)).state, "ready");
    assert.equal(
      (await f.call(`/api/media/${id}/playback`, { headers: auth })).status,
      404,
    );
    await communityScheduled(f.env, f.ports);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT after_id,revision FROM community_media_recovery WHERE community_id=?",
        )
        .bind(config.communityId)
        .first(),
      { after_id: "", revision: 0 },
    );
  } finally {
    await f.dispose();
  }
});

test("application serializes rejected input capabilities before reading private media", async () => {
  const f = await fixture();
  let mediaReads = 0;
  try {
    const env = {
      ...f.env,
      MEDIA: {
        get: async (key: string, options?: R2GetOptions) => {
          mediaReads++;
          return f.media.get(key, options);
        },
      } as unknown as R2Bucket,
    };
    const path = `/api/moderation/inputs/${crypto.randomUUID()}/audio`;
    for (const [query, code] of [
      [`?cap=${"f".repeat(64)}`, "input_capability_expired_or_invalid"],
      ["?cap=malformed", "input_capability_required"],
    ]) {
      const response = await communityFetch(
        new Request(firstSong.origin + path + query),
        env,
        f.ports,
      );
      assert.equal(response.status, 403);
      assert.match(
        response.headers.get("content-type") ?? "",
        /^application\/json/,
      );
      assert.deepEqual(await response.json(), { error: code });
      assert.equal(mediaReads, 0);
    }
  } finally {
    await f.dispose();
  }
});
