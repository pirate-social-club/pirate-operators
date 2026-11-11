// Full communityFetch/D1/session routes. Local SIWE keys and chain catalogue
// are explicit fixtures; no provider, real MOSS or deployed data is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import {
  communityFetch,
  type CommunityDependencies,
  type CommunityEnv,
} from "../services/community-application.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { verifyLoginOffline } from "../packages/community/accounts.ts";
import type { OwnerProfile } from "../packages/community-profile/contracts.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { releasePostsFixture } from "./fixtures/release-posts.ts";
import { communityRuntime } from "./community-runtime.ts";

const learner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const publisher = privateKeyToAccount(`0x${"12".repeat(32)}`);
async function fixture() {
  const runtime = await communityRuntime();
  try {
    // The numbered prefix is independently qualified by the actual Alchemy
    // tests. This legacy route fixture installs only profile19's simple DDL.
    const sql = await readFile(
      new URL(
        "../apps/community-wizard/infra/migrations/0019_community_profiles.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await runtime.db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => runtime.db.prepare(s)),
    );
    const deployment = JSON.parse(
      await readFile(
        new URL(
          "../docs/deployments/first-song-managed-20261105.configuration.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const config = validateConfig({
      ...deployment.configuration,
      publisher: publisher.address.toLowerCase(),
    });
    const posts = releasePostsFixture(publisher, config);
    const env = {
      DB: runtime.db,
      MEDIA: runtime.media,
      JOBS: {
        send: async () => {
          throw Error("unexpected local publication dispatch");
        },
      },
      ASSETS: { fetch: async () => new Response("profile fixture asset") },
      COMMUNITY_NAME: firstSong.name,
      PLAN_ID: firstSong.planId,
      APPLICATION_PROFILE_HASH: `0x${"a".repeat(64)}`,
      CREATOR_PROFILE_HASH: `0x${"b".repeat(64)}`,
    } as unknown as CommunityEnv;
    const ports: CommunityDependencies = {
      configuration: async () => config,
      publicReads: { client: posts.client, profile: posts.profile },
      verifyLogin: verifyLoginOffline,
      creatorHealth: async () => false,
    };
    const call = (path: string, init: RequestInit = {}) =>
      communityFetch(new Request(firstSong.origin + path, init), env, ports);
    const post = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      call(path, {
        method: "POST",
        headers: {
          origin: firstSong.origin,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const challenge = (await (
      await post("/api/auth/challenge", { address: learner.address })
    ).json()) as { id: string; message: string };
    const verified = await post("/api/auth/verify", {
      id: challenge.id,
      signature: await learner.signMessage({ message: challenge.message }),
    });
    assert.equal(verified.status, 200);
    const session = (await verified.json()) as { csrf: string };
    const auth = {
      cookie: verified.headers.get("set-cookie")!.split(";")[0]!,
      "x-csrf-token": session.csrf,
    };
    return { ...runtime, call, post, auth };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

test("mounted owner/public routes separate the authenticated account and retain response security", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("/api/profile/owner")).status, 401);
    const response = await f.call("/api/profile/owner", { headers: f.auth });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const owner = (await response.json()) as OwnerProfile;
    assert.equal(owner.schema, "pirate.community-profile-owner/1");
    assert.ok(owner.accountId);
    assert.equal(owner.profile.displayName, null);
    const publicResponse = await f.call(
      "/api/public/authors/" + owner.profile.authorId,
    );
    assert.equal(publicResponse.status, 200);
    const publicText = await publicResponse.text();
    assert.equal(publicText.includes(owner.accountId), false);
    assert.equal(publicText.includes(learner.address.toLowerCase()), false);
    assert.equal(publicText.includes("csrf"), false);
    assert.equal(JSON.parse(publicText).displayName, null);
    assert.equal(
      await (await f.call("/ordinary-route")).text(),
      "profile fixture asset",
    );
  } finally {
    await f.dispose();
  }
});

test("mounted metadata writes require Origin and CSRF and expose only their public allowlist", async () => {
  const f = await fixture();
  try {
    const body = {
      mutationId: "22222222-2222-4222-8222-222222222222",
      expectedRevision: 0,
      displayName: "Mounted fixture",
      bio: null,
      avatarRef: null,
      coverRef: null,
    };
    const put = (headers: Record<string, string>) =>
      f.call("/api/profile/owner", {
        method: "PUT",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await put({ cookie: f.auth.cookie, origin: firstSong.origin })).status,
      403,
    );
    assert.equal(
      (await put({ ...f.auth, origin: "https://other.example" })).status,
      403,
    );
    const accepted = await put({ ...f.auth, origin: firstSong.origin });
    assert.equal(accepted.status, 200);
    const owner = (await (
      await f.call("/api/profile/owner", { headers: f.auth })
    ).json()) as OwnerProfile;
    assert.equal(owner.profile.displayName, "Mounted fixture");
    assert.equal(owner.profile.revision, 1);
    const publicResponse = await f.call(
      "/api/public/authors/" + owner.profile.authorId,
    );
    const published = await publicResponse.text();
    assert.equal(JSON.parse(published).displayName, "Mounted fixture");
    assert.equal(published.includes(owner.accountId), false);
    assert.equal(published.includes(learner.address.toLowerCase()), false);
    const receipt = await f.call(
      "/api/profile/owner/mutations/" + body.mutationId,
      { headers: f.auth },
    );
    assert.equal(receipt.status, 200);
    assert.ok(((await receipt.json()) as { receipt: unknown }).receipt);
  } finally {
    await f.dispose();
  }
});

test("mounted profile access stops after real logout and public activity stays a real empty catalogue", async () => {
  const f = await fixture();
  try {
    const owner = (await (
      await f.call("/api/profile/owner", { headers: f.auth })
    ).json()) as OwnerProfile;
    const activity = await f.call(
      "/api/public/authors/" + owner.profile.authorId + "/activity",
    );
    assert.equal(activity.status, 200);
    const page = (await activity.json()) as {
      items: unknown[];
      nextCursor: string | null;
    };
    assert.deepEqual(page.items, []);
    assert.equal(page.nextCursor, null);
    assert.equal((await f.post("/api/logout", {}, f.auth)).status, 200);
    assert.equal(
      (await f.call("/api/profile/owner", { headers: f.auth })).status,
      401,
    );
  } finally {
    await f.dispose();
  }
});
