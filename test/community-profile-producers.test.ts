// UNRUN: actual local D1/HTTP/auth tests; no deployed data or provider action.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { communityRuntime } from "./community-runtime.ts";
import { communityProfilesApi } from "../services/community-profiles.ts";
import { ensureCommunityIdentity } from "../packages/community/accounts.ts";
import { hashText } from "../packages/community/common.ts";
import type { PublicSongView } from "../packages/community/application-api.ts";

const origin = "https://community.example",
  communityId = `0x${"1".repeat(64)}` as const;
const authorA = `0x${"2".repeat(64)}`,
  authorB = `0x${"3".repeat(64)}`;
const command = {
  mutationId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 0,
  displayName: "Fixture profile",
  bio: null,
  avatarRef: null,
  coverRef: null,
};
async function fixture() {
  const runtime = await communityRuntime(),
    db = runtime.db as unknown as D1Database;
  await ensureCommunityIdentity(db, { communityId, origin });
  const ddl = await readFile(
    new URL("../packages/community-profile/schema.sql", import.meta.url),
    "utf8",
  );
  await db.batch(
    ddl
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  let now = Date.now();
  for (const [id, author, token] of [
    ["a", authorA, "a"],
    ["b", authorB, "b"],
  ]) {
    await db.batch([
      db
        .prepare("INSERT INTO community_accounts VALUES(?,?,?)")
        .bind(`private-account-${id}`, author, now),
      db
        .prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)")
        .bind(
          `binding-${id}`,
          `private-account-${id}`,
          `0x${id.repeat(40)}`,
          now,
        ),
      db
        .prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)")
        .bind(
          hashText(token!.repeat(64)),
          communityId,
          origin,
          `private-account-${id}`,
          `binding-${id}`,
          token!.repeat(64),
          now + 86400000,
        ),
    ]);
  }
  let posts: PublicSongView[] = [];
  const call = async (
    path: string,
    options: {
      as?: "a" | "b";
      method?: string;
      body?: unknown;
      csrf?: string;
      requestOrigin?: string;
    } = {},
  ) => {
    const response = await communityProfilesApi(
      new Request(origin + path, {
        method: options.method ?? "GET",
        headers: {
          ...(options.as
            ? { cookie: `__Host-community_session=${options.as.repeat(64)}` }
            : {}),
          ...(options.body
            ? {
                "content-type": "application/json",
                origin: options.requestOrigin ?? origin,
                "x-csrf-token": options.csrf ?? options.as?.repeat(64) ?? "",
              }
            : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      }),
      {
        db: db as unknown as D1Database,
        context: { communityId, origin },
        publicPosts: async () => ({ communityId, posts }),
        now: () => now,
      },
    );
    assert.ok(response);
    return { response, body: (await response.json()) as any };
  };
  return {
    ...runtime,
    db,
    call,
    setPosts: (value: PublicSongView[]) => {
      posts = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("owner is resolved by real session; empty reads publish no metadata or credential mapping", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("/api/profile/owner")).response.status, 401);
    const owner = await f.call("/api/profile/owner", { as: "a" });
    assert.equal(owner.body.accountId, "private-account-a");
    assert.equal(owner.body.profile.displayName, null);
    assert.equal(owner.body.profile.revision, 0);
    assert.equal(owner.response.headers.get("cache-control"), "no-store");
    const publicView = await f.call(`/api/public/authors/${authorA}`);
    assert.equal(publicView.body.displayName, null);
    assert.doesNotMatch(
      JSON.stringify(publicView.body),
      /private-account|binding-|wallet|csrf|session/,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM community_profiles")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});
test("Origin/CSRF/forged ownership and unsafe media cannot publish fields", async () => {
  const f = await fixture();
  try {
    for (const options of [
      { csrf: "wrong" },
      { requestOrigin: "https://other.example" },
      { body: { ...command, accountId: "private-account-b" } },
      { body: { ...command, avatarRef: "https://other.example/image" } },
      { body: { ...command, avatarRef: "/api/public/unproven" } },
    ])
      assert.ok(
        (
          await f.call("/api/profile/owner", {
            as: "a",
            method: "PUT",
            body: command,
            ...options,
          })
        ).response.status >= 400,
      );
    assert.equal(
      (await f.call(`/api/public/authors/${authorB}`)).body.displayName,
      null,
    );
  } finally {
    await f.dispose();
  }
});
test("real atomic revision/CAS and retained receipts settle lost responses without overwriting", async () => {
  const f = await fixture();
  try {
    const other = {
      ...command,
      mutationId: "22222222-2222-4222-8222-222222222222",
      displayName: "Other fixture profile",
    };
    const results = await Promise.all(
      [command, other].map((body) =>
        f.call("/api/profile/owner", { as: "a", method: "PUT", body }),
      ),
    );
    assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 409]);
    const winner = results[0]!.response.status === 200 ? command : other;
    const replay = await f.call("/api/profile/owner", {
      as: "a",
      method: "PUT",
      body: winner,
    });
    assert.equal(replay.body.profile.revision, 1);
    assert.equal(
      (
        await f.call(`/api/profile/owner/mutations/${winner.mutationId}`, {
          as: "a",
        })
      ).body.receipt.profile.revision,
      1,
    );
    assert.equal(
      (
        await f.call(`/api/profile/owner/mutations/${winner.mutationId}`, {
          as: "b",
        })
      ).body.receipt,
      null,
    );
    assert.equal(
      (
        await f.call("/api/profile/owner", {
          as: "a",
          method: "PUT",
          body: { ...winner, bio: "different bytes" },
        })
      ).response.status,
      409,
    );
  } finally {
    await f.dispose();
  }
});
test("activity uses genuinely public records, allowlists fields and rejects forged/scoped/stale cursors", async () => {
  const f = await fixture();
  try {
    const posts = Array.from({ length: 3 }, (_, index) => {
      const id = `0x${String(index + 4).repeat(64)}`;
      return {
        manifest: {
          schema: "pirate.community-post/3",
          postId: id,
          authorId: authorA,
          title: "Fixture song",
          language: "en",
          rating: "general",
        },
        audioUrl: `/api/public/posts/${id}/audio`,
        postUrl: `/#song-${id}`,
        transactionHash: "fixture-receipt",
        privateHistory: "must not escape",
      } as PublicSongView;
    });
    f.setPosts(posts);
    const first = await f.call(
      `/api/public/authors/${authorA}/activity?limit=1`,
    );
    assert.equal(first.body.items.length, 1);
    assert.doesNotMatch(
      JSON.stringify(first.body),
      /privateHistory|must not escape/,
    );
    const cursor = first.body.nextCursor;
    assert.equal(
      (
        await f.call(
          `/api/public/authors/${authorB}/activity?limit=1&cursor=${cursor}`,
        )
      ).response.status,
      400,
    );
    assert.equal(
      (
        await f.call(
          `/api/public/authors/${authorA}/activity?cursor=${"0".repeat(64)}`,
        )
      ).response.status,
      400,
    );
    const next = await f.call(
      `/api/public/authors/${authorA}/activity?limit=1&cursor=${cursor}`,
    );
    assert.notEqual(
      next.body.items[0].manifest.postId,
      first.body.items[0].manifest.postId,
    );
    f.setPosts(posts.slice(1));
    assert.equal(
      (
        await f.call(
          `/api/public/authors/${authorA}/activity?limit=1&cursor=${cursor}`,
        )
      ).response.status,
      409,
    );
    f.setPosts(posts);
    f.advance(600001);
    assert.equal(
      (
        await f.call(
          `/api/public/authors/${authorA}/activity?limit=1&cursor=${cursor}`,
        )
      ).response.status,
      410,
    );
  } finally {
    await f.dispose();
  }
});

test("expired or mismatched session bindings cannot read/write an owner profile; catalogue scope is checked", async () => {
  const f = await fixture();
  try {
    await f.db
      .prepare(
        "UPDATE community_sessions SET binding_id='binding-b' WHERE account_id='private-account-a'",
      )
      .run();
    assert.equal(
      (await f.call("/api/profile/owner", { as: "a" })).response.status,
      401,
    );
    assert.equal(
      (
        await f.call("/api/profile/owner", {
          as: "a",
          method: "PUT",
          body: command,
        })
      ).response.status,
      401,
    );
    const wrongCatalogue = await communityProfilesApi(
      new Request(`${origin}/api/public/authors/${authorB}/activity`),
      {
        db: f.db,
        context: { origin, communityId },
        publicPosts: async () => ({
          communityId: `0x${"f".repeat(64)}`,
          posts: [],
        }),
      },
    );
    assert.equal(wrongCatalogue?.status, 503);
    f.advance(86400001);
    assert.equal(
      (await f.call("/api/profile/owner", { as: "b" })).response.status,
      401,
    );
  } finally {
    await f.dispose();
  }
});
