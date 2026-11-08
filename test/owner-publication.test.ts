// Release 1 acceptance: owner-only unregistered publication through the
// publication driver and the managed service handlers, with registration
// services unreachable. Submissions are created by calling the community
// reservation, upload and sealing functions directly, not through the
// authenticated community routes or the queue handler; that runtime acceptance
// is still to come with the runtime wiring.
import test from "node:test";
import assert from "node:assert/strict";
import {
  syncPublicPosts,
  indexedPublicPosts,
} from "../packages/community/post-index.ts";
import { Effect } from "effect";
import { keccak256 } from "viem";
import { hashJson } from "../packages/community/common.ts";
import { reserveBudget } from "../packages/community/budgets.ts";
import { publicationStep } from "../packages/community/publication.ts";
import { loadJob } from "../packages/community/publication-store.ts";
import {
  claimOwnerWindow,
  ownerBudgetKey,
} from "../packages/release/owner-grant.ts";
import { firstSongDriver } from "../services/first-song-driver.ts";
import { getAdmission } from "../packages/moderation/admission-store.ts";
import { runAdmission } from "../packages/moderation/service.ts";
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

test("recognition is not purchased once the grant expires after its window was claimed", async () => {
  const f = await ownerSongFixture({}, { grantSeconds: 20 });
  const realNow = Date.now;
  try {
    const transport = f.managed.config.transport as {
      request(request: Request): Promise<Response>;
    };
    const original = transport.request.bind(transport);
    let acr = 0;
    transport.request = async (request) => {
      if (new URL(request.url).host.includes("acrcloud")) acr++;
      return original(request);
    };
    // The window is claimed while the grant is valid, as an earlier song would.
    await claimOwnerWindow(f.managed.db, f.grant);
    // The clock passes expiry once the admission is prepared, before the
    // provider call is authorized.
    const current = f.managed.config.currentConfiguration;
    f.managed.config.currentConfiguration = async () => {
      if (
        await f.managed.db
          .prepare(
            "SELECT 1 FROM managed_admissions WHERE prepared_json IS NOT NULL",
          )
          .first()
      ) {
        const shift = (f.grant.expiresAt + 1) * 1000 - realNow();
        Date.now = () => realNow() + shift;
      }
      return current();
    };
    const { sealed } = await f.addSong("Expired song", "owner-expired-0001");
    const job = await f.drive(sealed.jobId, 12);
    assert.equal(job.phase, "held", f.history().join(" > "));
    assert.equal(
      (job as { error_code?: string }).error_code,
      "owner_grant_outside_window",
    );
    assert.equal(acr, 0);
    const recognition = await f.managed.db
      .prepare(
        "SELECT COUNT(*) AS n FROM spending_reservations WHERE asset='recognition_requests'",
      )
      .first<{ n: number }>();
    assert.equal(recognition!.n, 0);
    assert.equal(f.registrationRequests(), 0);
  } finally {
    Date.now = realNow;
    await f.dispose();
  }
});

test("post-fee exhaustion before broadcast holds the job instead of looping", async () => {
  const f = await ownerSongFixture({ postFeeWei: "1" });
  try {
    const { sealed } = await f.addSong("Fee-capped song", "owner-fee-cap-0001");
    const job = await f.drive(sealed.jobId, 20);
    assert.equal(job.phase, "held", f.history().join(" > "));
    assert.equal(
      (job as { error_code?: string }).error_code,
      "funding_cap_exhausted",
    );
    // Once at publication it parked; it never alternated with uncertain.
    const reached = f.history().indexOf("publication");
    assert.ok(reached > 0);
    assert.equal(f.history().slice(reached).includes("uncertain"), false);
    assert.equal(f.posts.broadcasts(), 0);
    const operation = await f.community.db
      .prepare(
        "SELECT status,operation_id FROM external_operations WHERE job_id=? AND step='publication'",
      )
      .bind(sealed.jobId)
      .first<{ status: string; operation_id: string }>();
    assert.equal(operation!.status, "failed");
    const fee = await f.community.db
      .prepare("SELECT 1 FROM spending_reservations WHERE reservation_id=?")
      .bind(operation!.operation_id + ":fee")
      .first();
    assert.equal(fee, null);
    // The three pins were bought and kept; only the post was refused.
    const pins = await f.community.db
      .prepare(
        "SELECT COUNT(*) AS n FROM external_operations WHERE job_id=? AND step LIKE 'pin_%' AND status='confirmed'",
      )
      .bind(sealed.jobId)
      .first<{ n: number }>();
    assert.equal(pins!.n, 3);
    // A later wakeup replays the held receipt rather than retrying the post.
    await Effect.runPromise(
      publicationStep(f.community.db, sealed.jobId, firstSongDriver(f.ports)),
    );
    assert.equal((await loadJob(f.community.db, sealed.jobId)).phase, "held");
    assert.equal(f.posts.broadcasts(), 0);
  } finally {
    await f.dispose();
  }
});

test("an ambiguous broadcast keeps its reconciliation path after the post-fee budget is exhausted", async () => {
  const f = await ownerSongFixture();
  try {
    const client = f.posts.client as unknown as {
      sendRawTransaction(input: {
        serializedTransaction: string;
      }): Promise<string>;
    };
    const send = client.sendRawTransaction.bind(client);
    let lost = false;
    client.sendRawTransaction = async (input) => {
      await send(input);
      if (!lost) {
        lost = true;
        // The rest of the post-fee budget is consumed while this response is
        // lost, so no new post spending could be reserved now.
        const key = ownerBudgetKey(f.grant, "post_fee_wei");
        const row = (await f.community.db
          .prepare(
            "SELECT ceiling,reserved,spent FROM spending_budgets WHERE scope=? AND period=? AND asset=?",
          )
          .bind(key.scope, key.period, key.asset)
          .first<{ ceiling: string; reserved: string; spent: string }>())!;
        const rest =
          BigInt(row.ceiling) - BigInt(row.reserved) - BigInt(row.spent);
        await reserveBudget(
          f.community.db,
          "fixture:other-post:fee",
          hashJson({ other: true }),
          [key],
          rest.toString(),
        );
        throw new Error("fixture broadcast response lost");
      }
      return keccak256(input.serializedTransaction as `0x${string}`);
    };
    const { sealed } = await f.addSong("Ambiguous post", "owner-ambiguous-01");
    const job = await f.drive(sealed.jobId, 40);
    assert.equal(job.phase, "published", f.history().join(" > "));
    assert.equal(lost, true);
    assert.equal(f.history().includes("uncertain"), true);
    const operation = await f.community.db
      .prepare(
        "SELECT operation_id FROM external_operations WHERE job_id=? AND step='publication'",
      )
      .bind(sealed.jobId)
      .first<{ operation_id: string }>();
    const fee = await f.community.db
      .prepare(
        "SELECT status FROM spending_reservations WHERE reservation_id=?",
      )
      .bind(operation!.operation_id + ":fee")
      .first<{ status: string }>();
    assert.equal(fee!.status, "settled");
  } finally {
    await f.dispose();
  }
});

/**
 * Interrupts each owner admission after its ACR receipt was retained and
 * validated, ages that receipt, and resumes the admission through the managed
 * handler before the job reads the result.
 */
async function resumeAgedOwnerAdmission(ageMs: number) {
  const f = await ownerSongFixture();
  const resumed: { id: string; state: string; old: number }[] = [];
  const run = f.managed.runQueued;
  f.managed.runQueued = async () => {
    const ids = [...f.managed.queued];
    await run();
    for (const id of ids) {
      const db = f.managed.db;
      const calls = await db
        .prepare(
          "SELECT kind,state FROM moderation_provider_calls WHERE admission_id=?",
        )
        .bind(id)
        .all<{ kind: string; state: string }>();
      // Recognition only: one validated ACR receipt, no text calls.
      assert.deepEqual(
        calls.results.map((c) => [c.kind, c.state]),
        [["acr_primary", "validated"]],
      );
      const old = Date.now() - ageMs;
      await db
        .prepare(
          "UPDATE moderation_provider_calls SET started_at=? WHERE admission_id=?",
        )
        .bind(old, id)
        .run();
      // The worker stopped after the retained result, before job advancement.
      await db
        .prepare(
          "UPDATE managed_admissions SET state='queued',result_json=NULL,error_code=NULL WHERE admission_id=?",
        )
        .bind(id)
        .run();
      resumed.push({
        id,
        old,
        state: await runAdmission(db, f.managed.media, id, f.managed.config),
      });
    }
  };
  return { f, resumed };
}

test("a two-hour-old owner recognition receipt completes admission without another provider request", async () => {
  const { f, resumed } = await resumeAgedOwnerAdmission(2 * 3600 * 1000);
  try {
    const { sealed } = await f.addSong(
      "Aged receipt song",
      "owner-aged-receipt-0001",
    );
    const job = await f.drive(sealed.jobId);
    assert.equal(job.phase, "published", f.history().join(" > "));
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]!.state, "complete");
    assert.equal(f.managed.sends(), 1);
    const admission = await getAdmission(f.managed.db, resumed[0]!.id);
    const evidence = JSON.parse(admission.result_json!).evidence as {
      envelope: { issuedAt: number; expiresAt: number; policy: string };
    }[];
    // The original acquisition time is kept; the retry did not renew it.
    const acquired = Math.floor(resumed[0]!.old / 1000);
    assert.ok(evidence.length > 0);
    for (const e of evidence) {
      assert.equal(e.envelope.issuedAt, acquired);
      assert.equal(e.envelope.expiresAt, acquired + 86400);
      assert.equal(e.envelope.policy, "pirate-owner-curated/2026-11-08/1");
    }
    const started = await f.managed.db
      .prepare(
        "SELECT MIN(started_at) AS first FROM moderation_provider_calls WHERE admission_id=?",
      )
      .bind(resumed[0]!.id)
      .first<{ first: number }>();
    assert.equal(started!.first, resumed[0]!.old);
    assert.equal(f.registrationRequests(), 0);
  } finally {
    await f.dispose();
  }
});

test("an owner recognition receipt past 24 hours stays refused on resume and buys nothing", async () => {
  const { f, resumed } = await resumeAgedOwnerAdmission(25 * 3600 * 1000);
  try {
    const { sealed } = await f.addSong(
      "Stale receipt song",
      "owner-stale-receipt-0001",
    );
    const job = await f.drive(sealed.jobId, 12);
    assert.notEqual(job.phase, "published", f.history().join(" > "));
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]!.state, "held");
    const admission = await getAdmission(f.managed.db, resumed[0]!.id);
    assert.equal(admission.error_code, "moderation_evidence_stale");
    assert.equal(f.managed.sends(), 1);
    const pins = await f.community.db
      .prepare(
        "SELECT COUNT(*) AS n FROM external_operations WHERE job_id=? AND step LIKE 'pin_%'",
      )
      .bind(sealed.jobId)
      .first<{ n: number }>();
    assert.equal(pins!.n, 0);
  } finally {
    await f.dispose();
  }
});
