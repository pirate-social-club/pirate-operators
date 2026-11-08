// Release 1 acceptance: owner-only unregistered publication through the actual
// community and managed handlers with registration services unreachable.
import test from "node:test";
import assert from "node:assert/strict";
import {
  syncPublicPosts,
  indexedPublicPosts,
} from "../packages/community/post-index.ts";
import { ownerBudgetKey } from "../packages/release/owner-grant.ts";
import { ownerSongFixture } from "./fixtures/owner-song-job.ts";

test("one owner song publishes as pirate.community-post/3 with no registration service", async () => {
  const f = await ownerSongFixture();
  try {
    const { sealed } = await f.addSong(
      "Owner song one",
      "owner-song-one-key-1",
    );
    const job = await f.drive(sealed.jobId);
    assert.equal(
      job.phase,
      "published",
      `${(job as { error_code?: string }).error_code} ${f.history().join(" > ")}`,
    );
    assert.equal(f.registrationRequests(), 0);
    const steps = await f.community.db
      .prepare(
        "SELECT step FROM external_operations WHERE job_id=? ORDER BY rowid",
      )
      .bind(sealed.jobId)
      .all<{ step: string }>();
    assert.equal(
      steps.results.some((r) => r.step === "registration"),
      false,
    );
    const scan = await syncPublicPosts(
      f.community.db,
      f.posts.client,
      f.posts.profile,
      [f.configuration],
      f.configuration,
      f.managed.service.pinTransport,
    );
    assert.equal(scan.caughtUp, true);
    const feed = await indexedPublicPosts(
      f.community.db,
      f.posts.client,
      f.posts.profile,
      [f.configuration],
      f.configuration,
      scan.head,
    );
    assert.equal(feed.length, 1);
    assert.equal(feed[0]!.post.schema, "pirate.community-post/3");
    assert.deepEqual(feed[0]!.post.registration, {
      status: "absent",
      reason: "deferred_for_launch",
    });
    assert.equal(feed[0]!.post.title, "Owner song one");
    const spent = async (db: D1Database, asset: string) =>
      (await db
        .prepare(
          "SELECT reserved,spent FROM spending_budgets WHERE scope=? AND asset=?",
        )
        .bind(ownerBudgetKey(f.grant, "songs").scope, asset)
        .first<{ reserved: string; spent: string }>()) ?? null;
    assert.deepEqual(
      { ...(await spent(f.managed.db, "songs")) },
      {
        reserved: "1",
        spent: "0",
      },
    );
    assert.equal((await spent(f.managed.db, "pin_adds"))!.spent, "3");
    assert.equal((await spent(f.managed.db, "pin_adds"))!.reserved, "0");
    assert.ok(Number((await spent(f.managed.db, "pin_bytes"))!.spent) > 0);
    const fee = await spent(f.community.db, "post_fee_wei");
    assert.equal(fee!.reserved, "0");
    assert.ok(BigInt(fee!.spent) > 0n);
  } finally {
    await f.dispose();
  }
});
