import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { communityRuntime } from "./community-runtime.ts";
import {
  communityFetch,
  type CommunityEnv,
  type CommunityDependencies,
} from "../services/community-application.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { authorizeCreatorRequest } from "../packages/community/creator-service.ts";
import { creatorServiceOrigin } from "../packages/community/creator-receipt.ts";
import { hashJson } from "../packages/community/common.ts";

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
  let loseLaunch = true;
  const ports: CommunityDependencies = {
    configuration: async () => config,
    verifyLogin: (address, message, signature) =>
      verifyMessage({ address, message, signature }),
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
    assert.equal(
      (
        await f.post(
          "/api/logout",
          {},
          { ...auth, "x-csrf-token": String(session.csrf) },
        )
      ).status,
      200,
    );
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
