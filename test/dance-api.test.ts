import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CommunityError, hashText } from "../packages/community/common.ts";
import { danceCommunityApi } from "../services/dance-community-api.ts";
import { danceFixture, dh } from "./dance-fixture.ts";

test("actual session, CSRF and Origin gates protect private Dance routes and reject body roles", async () => {
  const f = await danceFixture();
  try {
    const setup = await readFile(
      new URL(
        "../apps/community-wizard/infra/migrations/0001_setup.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await f.db.batch(
      setup
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim())
        .map((s) => f.db.prepare(s)),
    );
    const sql = await readFile(
      new URL(
        "../apps/community-wizard/infra/migrations/0002_first_song.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await f.db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim())
        .map((s) => f.db.prepare(s)),
    );
    const context = {
      communityId: dh(1) as `0x${string}`,
      origin: "https://community.example",
    };
    const tokens = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    for (const [i, id] of ["learner", "owner", "stranger"].entries()) {
      await f.db.batch([
        f.db
          .prepare("INSERT INTO community_accounts VALUES(?,?,0)")
          .bind(id, dh(i + 100)),
        f.db
          .prepare(
            "INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,0)",
          )
          .bind(`binding_${i}`, id, f.principals[id].wallet),
        f.db
          .prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)")
          .bind(
            hashText(tokens[i]),
            context.communityId,
            context.origin,
            id,
            `binding_${i}`,
            `csrf_${i}`,
            Date.now() + 1000000,
          ),
      ]);
    }
    const r = await f.prepare();
    async function call(
      who: number | undefined,
      path: string,
      options: {
        body?: unknown;
        origin?: string;
        csrf?: boolean;
        expected?: string;
      } = {},
    ) {
      const headers = new Headers();
      if (who !== undefined)
        headers.set("cookie", `__Host-community_session=${tokens[who]}`);
      if (options.expected) headers.set("x-dance-account", options.expected);
      if (options.body) {
        headers.set("content-type", "application/json");
        headers.set("origin", options.origin ?? context.origin);
        if (options.csrf !== false) headers.set("x-csrf-token", `csrf_${who}`);
      }
      try {
        return (await danceCommunityApi(
          new Request(context.origin + path, {
            method: options.body ? "POST" : "GET",
            headers,
            ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          }),
          { db: f.db, dance: f.ports },
          context,
          new Headers(),
        ))!;
      } catch (error) {
        if (error instanceof CommunityError)
          return Response.json({ error: error.code }, { status: error.status });
        throw error;
      }
    }
    const verdictPath = `/api/dance/reviews/${r.reviewId}/verdict`;
    const body = { commandId: "decision", revision: 1, verdict: "passed" };
    assert.equal(
      (await call(undefined, `/api/dance/reviews/${r.reviewId}`)).status,
      401,
    );
    assert.equal(
      (await call(2, `/api/dance/reviews/${r.reviewId}`)).status,
      403,
    );
    assert.equal(
      (await call(1, verdictPath, { body, csrf: false })).status,
      403,
    );
    assert.equal(
      (await call(1, verdictPath, { body, origin: "https://other.example" }))
        .status,
      403,
    );
    assert.equal(
      (
        await call(1, verdictPath, {
          body: { ...body, actorId: "learner", role: "owner" },
        })
      ).status,
      400,
    );
    assert.equal(
      (await call(1, verdictPath, { body, expected: "learner" })).status,
      409,
    );
    const accepted = await call(1, verdictPath, { body });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store, private");
    assert.equal(
      ((await accepted.json()) as { verdict: { verdict: string } }).verdict
        .verdict,
      "passed",
    );
  } finally {
    await f.dispose();
  }
});
