import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { communityRuntime } from "./community-runtime.ts";
import { canonical } from "../packages/community/common.ts";
import {
  publicationStep,
  type PublicationDriver,
  type OperationResult,
  type Reconciliation,
} from "../packages/community/publication.ts";
import {
  loadJob,
  publicationSteps,
  resumeUncertainJob,
  type ExternalOperation,
} from "../packages/community/publication-store.ts";

async function fixture() {
  const f = await communityRuntime();
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO community_accounts VALUES('private-account','public-author',0)",
    ),
    f.db
      .prepare(`INSERT INTO media_submissions(submission_id,account_id,author_id,post_id,idempotency_key,request_hash,metadata_json,captured_wallet,creator_json,audio_sha256,audio_bytes,object_key,upload_state,created_at,sealed_at)
      VALUES('submission','private-account','public-author','post','once','hash','{}','moss','{}','hash',1,'object','sealed',0,0)`),
    f.db.prepare(
      "INSERT INTO publication_jobs(job_id,submission_id,input_hash,authority_json,phase,due_at,created_at,updated_at) VALUES('job','submission','hash','{}','admission',0,0,0)",
    ),
  ]);
  let time = 1000;
  const calls: string[] = [],
    prepared = new Map<string, string>(),
    receipts = new Map<string, OperationResult>();
  let loseResponse = false,
    reconcileUnknown = false,
    outcome: "confirmed" | "held" | "rejected" = "confirmed";
  const driver: PublicationDriver = {
    async request(job, step) {
      return {
        input: job.input_hash,
        step,
        previous:
          JSON.parse(job.progress_json)[
            publicationSteps[publicationSteps.indexOf(step) - 1]!
          ] ?? null,
      };
    },
    async prepare(op) {
      const raw = `stable-signed-${op.operation_id}`;
      prepared.set(op.operation_id, raw);
      return { signedBytes: raw, nonce: 1 };
    },
    async execute(op) {
      assert.equal(
        JSON.parse(op.prepared_json!).signedBytes,
        prepared.get(op.operation_id),
      );
      calls.push(op.step);
      const value = { receipt: `fixture-${op.operation_id}` };
      const result: OperationResult =
        outcome === "confirmed"
          ? { kind: "confirmed", providerId: op.operation_id, value }
          : {
              kind: outcome,
              providerId: op.operation_id,
              code: "fixture_policy_result",
              value,
            };
      receipts.set(op.operation_id, result);
      if (loseResponse)
        throw new Error("fixture response lost after the provider committed");
      return result;
    },
    async reconcile(op): Promise<Reconciliation> {
      if (reconcileUnknown) return { kind: "unknown" };
      return (
        receipts.get(op.operation_id) ?? {
          kind: "absent",
          proof: "fixture ledger proves no operation",
        }
      );
    },
    async validate(op, result) {
      assert.equal(result.providerId, op.operation_id);
      assert.equal(result.value.receipt, `fixture-${op.operation_id}`);
    },
  };
  const clock = { now: () => time };
  return {
    ...f,
    calls,
    receipts,
    driver,
    clock,
    tick: () => {
      time += 180_001;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    unknown: () => {
      reconcileUnknown = true;
    },
    outcome: (value: typeof outcome) => {
      outcome = value;
    },
    run: () => Effect.runPromise(publicationStep(f.db, "job", driver, clock)),
  };
}

test("duplicate wakeups run every publication operation once and retain all external IDs", async () => {
  const f = await fixture();
  try {
    for (const _step of publicationSteps)
      await Promise.all([f.run(), f.run(), f.run()]);
    assert.equal((await loadJob(f.db, "job")).phase, "published");
    await f.run();
    assert.deepEqual(f.calls, [...publicationSteps]);
    const ops = await f.db
      .prepare("SELECT * FROM external_operations")
      .all<ExternalOperation>();
    assert.equal(ops.results.length, 6);
    assert.ok(
      ops.results.every(
        (op) =>
          op.status === "confirmed" &&
          op.provider_id &&
          op.prepared_json &&
          op.result_json,
      ),
    );
    const frozen = canonical(ops.results);
    await f.run();
    assert.equal(
      canonical(
        (await f.db.prepare("SELECT * FROM external_operations").all()).results,
      ),
      frozen,
    );
  } finally {
    await f.dispose();
  }
});

test("a lost paid-operation response reconciles its receipt without another charge", async () => {
  const f = await fixture();
  try {
    f.loseResponse();
    assert.equal(await f.run(), "uncertain");
    await assert.rejects(
      resumeUncertainJob(f.db, "job", "different-account", f.clock.now()),
      /job_not_reconcilable/,
    );
    await resumeUncertainJob(f.db, "job", "private-account", f.clock.now());
    assert.equal(await f.run(), "pin_audio");
    assert.deepEqual(f.calls, ["admission"]);
  } finally {
    await f.dispose();
  }
});

test("an unreconcilable provider never executes again merely because the creator retries", async () => {
  const f = await fixture();
  try {
    f.loseResponse();
    f.unknown();
    await f.run();
    for (let i = 0; i < 3; i++) {
      await resumeUncertainJob(f.db, "job", "private-account", f.clock.now());
      assert.equal(await f.run(), "uncertain");
    }
    assert.deepEqual(f.calls, ["admission"]);
  } finally {
    await f.dispose();
  }
});

for (const boundary of ["prepared", "started", "confirmed"] as const)
  test(`interruption after ${boundary} resumes the captured operation without duplication`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        Effect.runPromise(
          publicationStep(f.db, "job", f.driver, f.clock, {
            async boundary(value) {
              if (value === boundary) throw new Error("fixture termination");
            },
          }),
        ),
        /fixture termination/,
      );
      f.tick();
      assert.equal(await f.run(), "pin_audio");
      assert.deepEqual(f.calls, ["admission"]);
    } finally {
      await f.dispose();
    }
  });

for (const outcome of ["held", "rejected"] as const)
  test(`${outcome} admission never pins or publishes the upload`, async () => {
    const f = await fixture();
    try {
      f.outcome(outcome);
      assert.equal(await f.run(), outcome === "held" ? "held" : "failed");
      await f.run();
      await assert.rejects(
        resumeUncertainJob(f.db, "job", "private-account", f.clock.now()),
        /job_not_reconcilable/,
      );
      assert.deepEqual(f.calls, ["admission"]);
    } finally {
      await f.dispose();
    }
  });

test("a stale preparer cannot broadcast after a second worker acquires the lease", async () => {
  const f = await fixture();
  try {
    const original = f.driver.prepare;
    // The recursive worker must not prepare forever; it uses the original function.
    f.driver.prepare = async (op) => {
      f.driver.prepare = original;
      const result = await original(op);
      f.tick();
      await f.run();
      return result;
    };
    await assert.rejects(f.run(), /publication_lease_lost/);
    assert.deepEqual(f.calls, ["admission"]);
    assert.equal((await loadJob(f.db, "job")).phase, "pin_audio");
  } finally {
    await f.dispose();
  }
});
