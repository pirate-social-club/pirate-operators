import assert from "node:assert/strict";
import test from "node:test";
import { leaseJob, loadJob, type PublicationJob } from "../packages/community/publication-store.ts";

const job: PublicationJob = {
  job_id: "job-1",
  submission_id: "submission-1",
  input_hash: "input",
  authority_json: JSON.stringify({ policy: { version: "fixture", sha256: "fixture" } }),
  phase: "publication",
  progress_json: "{}",
  revision: 1,
  lease_token: null,
  lease_until: 0,
};

function staleDefaultDatabase() {
  const sessions: string[] = [];
  const statement = (value: PublicationJob | null) => ({
    bind() { return this; },
    async first() { return value; },
  });
  const database = {
    prepare() { return statement(job); },
    withSession(session: string) {
      sessions.push(session);
      return { prepare() { return statement(job); } };
    },
  };
  return { database: database as unknown as D1Database, sessions };
}

test("publication job reads require the primary session instead of a stale replica", async () => {
  const { database, sessions } = staleDefaultDatabase();
  assert.deepEqual(await loadJob(database, job.job_id), job);
  assert.deepEqual(sessions, ["first-primary"]);
});

test("publication job leasing validates the primary phase before its conditional update", async () => {
  const { database, sessions } = staleDefaultDatabase();
  const leased = await leaseJob(database, job.job_id, 1_000);
  assert.equal(leased?.job_id, job.job_id);
  assert.deepEqual(sessions, ["first-primary"]);
});
