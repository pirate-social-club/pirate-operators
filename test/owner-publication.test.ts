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

test("several owner songs share one grant, the next song is refused once songs are exhausted, and nothing registers", async () => {
  const f = await ownerSongFixture({ songs: 2 });
  try {
    const first = await f.addSong("Owner song A", "owner-song-a-key-0001"),
      second = await f.addSong("Owner song B", "owner-song-b-key-0002"),
      third = await f.addSong("Owner song C", "owner-song-c-key-0003");
    for (const { sealed } of [first, second])
      assert.equal(
        (await f.drive(sealed.jobId)).phase,
        "published",
        f.history().slice(-12).join(" > "),
      );
    // The third song cannot reserve a song unit; it never pins or posts.
    const exhausted = await f.drive(third.sealed.jobId, 12);
    assert.equal(exhausted.phase, "held", f.history().slice(-8).join(" > "));
    assert.equal(
      (exhausted as { error_code?: string }).error_code,
      "funding_cap_exhausted",
    );
    const pins = await f.community.db
      .prepare(
        "SELECT COUNT(*) AS n FROM external_operations WHERE job_id=? AND step IN ('pin_audio','pin_lyrics','pin_manifest','publication') AND status='confirmed'",
      )
      .bind(third.sealed.jobId)
      .first<{ n: number }>();
    assert.equal(pins!.n, 0);
    const songs = await f.managed.db
      .prepare(
        "SELECT reserved FROM spending_budgets WHERE scope=? AND asset='songs'",
      )
      .bind(ownerBudgetKey(f.grant, "songs").scope)
      .first<{ reserved: string }>();
    assert.equal(songs!.reserved, "2");
    assert.equal(f.registrationRequests(), 0);
    // Both published songs are in the reconstructed public feed as /3.
    const scan = await syncPublicPosts(
      f.community.db,
      f.posts.client,
      f.posts.profile,
      [f.configuration],
      f.configuration,
      f.managed.service.pinTransport,
    );
    const feed = await indexedPublicPosts(
      f.community.db,
      f.posts.client,
      f.posts.profile,
      [f.configuration],
      f.configuration,
      scan.head,
    );
    assert.deepEqual(feed.map((p) => [p.post.schema, p.post.title]).sort(), [
      ["pirate.community-post/3", "Owner song A"],
      ["pirate.community-post/3", "Owner song B"],
    ]);
  } finally {
    await f.dispose();
  }
});

test("restarts and a lost pin response retry without double charging the owner grant", async () => {
  const f = await ownerSongFixture();
  try {
    const original = f.managed.service.pinTransport;
    let lost = false;
    // Lose the first add response after the provider retained the pin.
    f.managed.service.pinTransport = async (request: Request) => {
      const response = await original(request);
      if (!lost && new URL(request.url).pathname === "/api/v0/add") {
        lost = true;
        throw new Error("fixture response lost after retained pin");
      }
      return response;
    };
    (f.ports.release as { ipfs: unknown }).ipfs =
      f.managed.service.pinTransport;
    const { sealed } = await f.addSong(
      "Owner retry song",
      "owner-retry-key-0001",
    );
    const job = await f.drive(sealed.jobId, 60);
    assert.equal(job.phase, "published", f.history().join(" > "));
    assert.equal(lost, true);
    const budget = async (asset: string) =>
      (await f.managed.db
        .prepare(
          "SELECT reserved,spent FROM spending_budgets WHERE scope=? AND asset=?",
        )
        .bind(ownerBudgetKey(f.grant, "songs").scope, asset)
        .first<{ reserved: string; spent: string }>())!;
    // One song, three pins: retries replayed reservations instead of new ones.
    assert.equal((await budget("songs")).reserved, "1");
    const adds = await budget("pin_adds");
    assert.equal(BigInt(adds.reserved) + BigInt(adds.spent), 3n);
    assert.equal(f.registrationRequests(), 0);
  } finally {
    await f.dispose();
  }
});

test("owner ports carry no registration signer, client, operator or creator service", async () => {
  const f = await ownerSongFixture();
  try {
    const release = f.ports.release as Record<string, unknown>;
    assert.equal(release.story, undefined);
    assert.equal(release.registrationOperator, undefined);
    assert.equal(
      (f.profile.execution as { schema: string }).schema,
      "pirate.publication-execution-profile/2",
    );
    assert.equal("registrationOperator" in f.profile.execution, false);
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
