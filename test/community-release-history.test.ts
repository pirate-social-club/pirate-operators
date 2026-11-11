// Actual cookie/CSRF API and D1/R2 history, with explicit local fixture inputs.
// The production journal records the simulated terminal rejection; no external
// provider outcome, native cold restart or public release acceptance is claimed.
import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { verifyLoginOffline } from "../harness/login-verifier.ts";
import { loginChallenge, loginVerify } from "../packages/community/accounts.ts";
import { CommunityError } from "../packages/community/common.ts";
import { communityReleaseApi } from "../services/community-release-api.ts";
import {
  leaseJob,
  loadJob,
  parkJob,
} from "../packages/community/publication-store.ts";
import { firstSongJobFixture } from "./fixtures/first-song-job.ts";
import { publisher } from "./fixtures/release-admission.ts";

test("authenticated owner history retains the original rejected job after a distinct second release is sealed", async () => {
  const f = await firstSongJobFixture();
  const context = {
    communityId: f.configuration.communityId,
    origin: f.configuration.app.origin,
  };
  try {
    await f.community.db
      .prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)")
      .bind(
        "fixture-history-binding",
        f.session.account_id,
        publisher.address.toLowerCase(),
        Date.now(),
      )
      .run();
    const challenge = await loginChallenge(
      f.community.db,
      context,
      publisher.address,
    );
    const login = await loginVerify(
      f.community.db,
      context,
      challenge.id,
      await publisher.signMessage({ message: challenge.message }),
      verifyLoginOffline,
    );
    const auth = {
      cookie: login.cookie.split(";")[0]!,
      "x-csrf-token": login.csrf,
      origin: context.origin,
    };
    const jobs = { send: async (_message: { jobId: string }) => {} };
    // Every call constructs the real stateless handler/env afresh over the same
    // actual storage, instead of reading a simulated browser uploads endpoint.
    const call = async (
      path: string,
      method = "GET",
      body?: BodyInit,
      headers: Record<string, string> = auth,
    ) => {
      try {
        return await communityReleaseApi(
          new Request(context.origin + path, { method, body, headers }),
          { DB: f.community.db, MEDIA: f.community.media, JOBS: jobs },
          context,
          async () => ({ config: f.configuration, ports: f.ports }),
          (value, status = 200) => Response.json(value, { status }),
        );
      } catch (error) {
        if (error instanceof CommunityError)
          return Response.json({ error: error.code }, { status: error.status });
        throw error;
      }
    };
    const lease = await leaseJob(f.community.db, f.sealed.jobId, Date.now());
    assert.ok(lease);
    await parkJob(
      f.community.db,
      lease,
      "failed",
      "fixture_history_rejected",
      Date.now(),
    );
    const original = await f.community.db
      .prepare("SELECT * FROM media_submissions WHERE submission_id=?")
      .bind(f.row.submission_id)
      .first();
    assert.ok(original);
    const oldJob = await loadJob(f.community.db, f.sealed.jobId);
    assert.equal(oldJob.phase, "failed");
    const metadata = {
      title: "Distinct second history release",
      language: "en",
      lyrics: f.managed.lyrics,
      original: true,
      acceptedPolicy: "pirate-release/2026-08-29",
      audioSha256: sha256(f.managed.audio),
      audioBytes: f.managed.audio.length,
    };
    const headers = {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": "fixture-second-history-release",
    };
    const reservation = await call(
      "/api/uploads",
      "POST",
      JSON.stringify(metadata),
      headers,
    );
    assert.equal(reservation!.status, 201);
    const second = (await reservation!.json()) as {
      submissionId: string;
      postId: string;
    };
    assert.notEqual(second.submissionId, f.row.submission_id);
    assert.notEqual(second.postId, f.row.post_id);
    assert.equal(
      (await call(
        `/api/uploads/${second.submissionId}/audio`,
        "PUT",
        f.managed.audio,
        { ...auth, "content-type": "audio/mpeg" },
      ))!.status,
      200,
    );
    for (const slot of ["instrumental", "vocals"]) {
      const path = `/api/uploads/${second.submissionId}/stems/${slot}`;
      assert.equal(
        (await call(
          path,
          "POST",
          JSON.stringify({
            sha256: sha256(f.managed.audio),
            byteLength: f.managed.audio.length,
          }),
          headers,
        ))!.status,
        201,
      );
      assert.equal(
        (await call(path, "PUT", f.managed.audio, {
          ...auth,
          "content-type": "audio/mpeg",
        }))!.status,
        200,
      );
    }
    const sealedResponse = await call(
      `/api/uploads/${second.submissionId}/seal`,
      "POST",
      "{}",
      headers,
    );
    assert.equal(sealedResponse!.status, 202);
    const secondJob = (await sealedResponse!.json()) as { jobId: string };
    assert.notEqual(secondJob.jobId, f.sealed.jobId);
    const historyResponse = await call("/api/uploads");
    assert.equal(historyResponse!.status, 200);
    const history = (await historyResponse!.json()) as {
      uploads: {
        submissionId: string;
        postId: string;
        title: string;
        state: string;
        jobId: string;
      }[];
    };
    assert.equal(history.uploads.length, 2);
    assert.deepEqual(
      history.uploads.find((row) => row.submissionId === f.row.submission_id),
      {
        submissionId: f.row.submission_id,
        postId: f.row.post_id,
        title: f.managed.title,
        state: "failed",
        jobId: f.sealed.jobId,
      },
    );
    assert.equal(
      history.uploads.find((row) => row.submissionId === second.submissionId)
        ?.jobId,
      secondJob.jobId,
    );
    assert.deepEqual(
      await f.community.db
        .prepare("SELECT * FROM media_submissions WHERE submission_id=?")
        .bind(f.row.submission_id)
        .first(),
      original,
    );
    assert.deepEqual(await loadJob(f.community.db, f.sealed.jobId), oldJob);
    const retained = await call(
      `/api/jobs/${encodeURIComponent(f.sealed.jobId)}`,
    );
    assert.equal(retained!.status, 200);
    const retainedJob = (await retained!.json()) as {
      jobId: string;
      phase: string;
      resumable: boolean;
    };
    assert.equal(retainedJob.jobId, f.sealed.jobId);
    assert.equal(retainedJob.phase, "failed");
    assert.equal(retainedJob.resumable, false);
    assert.equal(
      (await call("/api/uploads", "GET", undefined, {}))!.status,
      401,
    );
  } finally {
    await f.dispose();
  }
});
