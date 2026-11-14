import test from "node:test";
import assert from "node:assert/strict";
import { hashText, publicId } from "../packages/community/common.ts";
import { resolveKnownMatch } from "../packages/recognition/matching.ts";
import { associationId } from "../packages/recognition/model.ts";
import { RecognitionStore } from "../packages/recognition/store.ts";
import {
  communityA,
  communityB,
  publication,
  publisherB,
  recognitionFixture,
} from "./shared-recognition-fixture.ts";

test("two signed communities share one enrolled recording, including restrictive licenses", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    assert.equal(a.status, 202);
    assert.equal(await f.run(a.body.recordingId), "progress");
    assert.equal(await f.run(a.body.recordingId), "ready");
    const b = await f.enroll(publication(communityB));
    assert.equal(b.status, 202);
    assert.equal(b.body.state, "ready");
    assert.equal(b.body.recordingId, a.body.recordingId);
    assert.notEqual(b.body.associationId, a.body.associationId);
    assert.deepEqual(f.counts(), { uploads: 1, deletes: 0, identify: 1 });
    const rows = await f.db
      .prepare(
        "SELECT publication_json FROM shared_recognition_publications WHERE state='active'",
      )
      .all<{ publication_json: string }>();
    assert.equal(rows.results.length, 2);
    assert.ok(
      rows.results.every(
        (row) => JSON.parse(row.publication_json).allowsDerivatives === false,
      ),
    );
  } finally {
    await f.dispose();
  }
});
test("a different creator cannot overwrite the same recording; the association batch rolls back", async () => {
  const f = await recognitionFixture();
  try {
    await f.enroll();
    const b = await f.enroll({
      ...publication(communityB),
      creatorKey: `eip155:6343:0x${"55".repeat(20)}`,
    });
    assert.equal(b.status, 409);
    assert.equal(
      (await f.db
        .prepare("SELECT count(*) AS n FROM shared_recognition_publications")
        .first<{ n: number }>())!.n,
      1,
    );
    assert.equal(f.counts().uploads, 0);
  } finally {
    await f.dispose();
  }
});
test("another pending original cannot bypass the canonical creator binding", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    await f.run(a.body.recordingId);
    await f.run(a.body.recordingId);
    assert.equal(
      (
        await f.enroll({
          ...publication(communityB),
          audioSha256: hashText("separate-pending-original"),
        })
      ).status,
      202,
    );
    const unauthorized = await f.enroll({
      ...publication(communityB),
      postId: hashText("unauthorized-same-bytes-post"),
      creatorKey: `eip155:6343:0x${"55".repeat(20)}`,
    });
    assert.equal(unauthorized.status, 409);
    assert.equal(
      (await f.db
        .prepare("SELECT count(*) AS n FROM shared_recognition_publications")
        .first<{ n: number }>())!.n,
      2,
    );
    assert.equal(f.counts().uploads, 1);
  } finally {
    await f.dispose();
  }
});
test("wrong publisher and cross-community status requests cannot use another association", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    const denied = await f.request(
      "catalog_status",
      { associationId: a.body.associationId },
      communityA,
      publicId(),
      publisherB,
    );
    assert.equal(denied.status, 403);
    const cross = await f.request(
      "catalog_status",
      { associationId: a.body.associationId },
      communityB,
    );
    assert.equal(cross.status, 404);
    assert.equal(f.counts().uploads, 0);
  } finally {
    await f.dispose();
  }
});
test("exact request replay is idempotent and changed bodies cannot reuse a signed nonce", async () => {
  const f = await recognitionFixture();
  try {
    const p = publication(),
      nonce = publicId(),
      body = { postId: p.postId, publicationRevision: 1 };
    assert.equal(
      (await f.request("catalog_enroll", body, communityA, nonce)).status,
      202,
    );
    assert.equal(
      (await f.request("catalog_enroll", body, communityA, nonce)).status,
      202,
    );
    const changed = await f.request(
      "catalog_enroll",
      { ...body, publicationRevision: 2 },
      communityA,
      nonce,
    );
    assert.equal(changed.status, 409);
    assert.equal(
      (await f.db
        .prepare("SELECT count(*) AS n FROM shared_recognition_publications")
        .first<{ n: number }>())!.n,
      1,
    );
  } finally {
    await f.dispose();
  }
});
test("lost successful upload response survives restart and never purchases a second upload", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    f.flags({ loseUpload: true });
    await assert.rejects(
      f.run(a.body.recordingId),
      /simulated lost upload response/,
    );
    assert.equal(
      (await f.store().get(a.body.recordingId))!.state,
      "upload_unknown",
    );
    f.restart();
    await f.recover();
    assert.equal(await f.run(a.body.recordingId), "progress");
    assert.equal(await f.run(a.body.recordingId), "ready");
    assert.equal(f.counts().uploads, 1);
    const receipts = await f.db
      .prepare(
        "SELECT kind FROM shared_recognition_events WHERE kind LIKE 'receipt:%'",
      )
      .all();
    assert.ok(receipts.results.length >= 3);
  } finally {
    await f.dispose();
  }
});
test("provider outage and processing lag hold enrollment without duplicate uploads", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    f.flags({ catalogOutage: true });
    assert.equal(await f.run(a.body.recordingId), "waiting");
    assert.equal(f.counts().uploads, 0);
    f.flags({ catalogOutage: false });
    assert.equal(await f.run(a.body.recordingId), "progress");
    f.flags({ indexLag: true });
    assert.equal(await f.run(a.body.recordingId), "waiting");
    assert.equal(
      (await f.store().get(a.body.recordingId))!.state,
      "processing",
    );
    assert.equal(f.counts().identify, 0);
    f.restart();
    f.flags({ indexLag: false });
    assert.equal(await f.run(a.body.recordingId), "ready");
    assert.deepEqual(f.counts(), { uploads: 1, deletes: 0, identify: 1 });
  } finally {
    await f.dispose();
  }
});
test("identification-index lag stays pending after Console readiness and preserves verification usage", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    await f.run(a.body.recordingId);
    f.flags({ verificationLag: true });
    assert.equal(await f.run(a.body.recordingId), "waiting");
    assert.equal(
      (await f.store().get(a.body.recordingId))!.state,
      "processing",
    );
    f.restart();
    f.flags({ verificationLag: false });
    assert.equal(await f.run(a.body.recordingId), "ready");
    assert.deepEqual(f.counts(), { uploads: 1, deletes: 0, identify: 2 });
  } finally {
    await f.dispose();
  }
});
test("an intent interrupted before transport remains unknown rather than blindly sending later", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    f.flags({ denyUpload: true });
    await assert.rejects(f.run(a.body.recordingId), /simulated quota refusal/);
    assert.equal(
      (await f.store().get(a.body.recordingId))!.state,
      "upload_unknown",
    );
    f.flags({ denyUpload: false });
    assert.equal(await f.run(a.body.recordingId), "waiting");
    assert.equal(f.counts().uploads, 0);
  } finally {
    await f.dispose();
  }
});
test("lease expiry during media read prevents upload and leaves a recoverable pending job", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    f.flags({ expireRead: true });
    await assert.rejects(
      f.run(a.body.recordingId),
      /recognition_claim_or_association_changed/,
    );
    assert.equal(f.counts().uploads, 0);
    assert.equal((await f.store().get(a.body.recordingId))!.state, "pending");
    f.flags({ expireRead: false });
    assert.equal(await f.run(a.body.recordingId), "progress");
  } finally {
    await f.dispose();
  }
});
test("a transition cannot adopt a successor claim acquired before its caller resumes", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll(),
      original = (await f.store().claim(a.body.recordingId))!;
    let successorToken: string | null = null;
    const db = new Proxy(f.db, {
      get(target, key) {
        if (key === "withSession")
          return (...args: Parameters<D1Database["withSession"]>) => {
            const session = target.withSession(...args);
            return new Proxy(session, {
              get(current, property) {
                if (property === "batch")
                  return async (
                    ...statements: Parameters<D1DatabaseSession["batch"]>
                  ) => {
                    const results = await current.batch(...statements);
                    f.advanceClock(60001);
                    successorToken = (await f
                      .store()
                      .claim(a.body.recordingId))!.claim_token;
                    return results;
                  };
                const value = Reflect.get(current, property);
                return typeof value === "function"
                  ? value.bind(current)
                  : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const transitioned = await new RecognitionStore(
      db,
      original.namespace,
      f.store().now,
    ).transition(original, "upload_unknown", { reason: "upload_intent" });
    assert.notEqual(successorToken, original.claim_token);
    assert.equal(transitioned.claim_token, original.claim_token);
    await assert.rejects(
      f.store().requireClaim(transitioned),
      /recognition_claim_lost/,
    );
    await f.store().release(transitioned);
    assert.equal(
      (await f.store().get(a.body.recordingId))!.claim_token,
      successorToken,
    );
    assert.equal(f.counts().uploads, 0);
  } finally {
    await f.dispose();
  }
});
test("withdrawing one publication retains recognition; the last withdrawal deletes exactly its file", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    await f.run(a.body.recordingId);
    await f.run(a.body.recordingId);
    await f.enroll(publication(communityB));
    assert.equal((await f.withdraw(publication())).status, 200);
    assert.equal(await f.run(a.body.recordingId), "idle");
    assert.equal(f.counts().deletes, 0);
    assert.equal((await f.withdraw(publication(communityB))).status, 200);
    assert.equal(await f.run(a.body.recordingId), "deleted");
    assert.equal(f.counts().deletes, 1);
    const replay = await f.enroll();
    assert.equal(replay.body.state, "withdrawn");
    assert.equal((await f.store().get(a.body.recordingId))!.state, "deleted");
  } finally {
    await f.dispose();
  }
});
test("withdrawn association replay cannot reactivate it while another community retains the recording", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    await f.run(a.body.recordingId);
    await f.run(a.body.recordingId);
    await f.enroll(publication(communityB));
    await f.withdraw(publication());
    const replay = await f.enroll();
    assert.equal(replay.body.state, "withdrawn");
    assert.equal(
      (await f.store().association(a.body.associationId, communityA))!.state,
      "withdrawn",
    );
    assert.equal(f.counts().uploads, 1);
  } finally {
    await f.dispose();
  }
});
test("a queue wakeup failure cannot lose the committed enrollment obligation", async () => {
  const f = await recognitionFixture();
  try {
    f.flags({ rejectWake: true });
    const a = await f.enroll();
    assert.equal(a.status, 503);
    f.flags({ rejectWake: false });
    f.restart();
    await f.recover();
    assert.equal(f.wakes.length, 1);
    assert.equal(await f.run(f.wakes[0]!), "progress");
    assert.equal(f.counts().uploads, 1);
  } finally {
    await f.dispose();
  }
});
test("verification reads all provider candidates instead of trusting the old first-match summary", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    await f.run(a.body.recordingId);
    f.flags({ extraCandidate: true });
    assert.equal(await f.run(a.body.recordingId), "failed");
    assert.equal((await f.store().get(a.body.recordingId))!.state, "failed");
  } finally {
    await f.dispose();
  }
});
test("excluded video_audio candidates do not hide the single expected custom recording", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    await f.run(a.body.recordingId);
    f.flags({ excludedVideo: true });
    assert.equal(await f.run(a.body.recordingId), "ready");
  } finally {
    await f.dispose();
  }
});
test("new publication revision replaces only its old association and stale replay stays withdrawn", async () => {
  const f = await recognitionFixture();
  try {
    const first = await f.enroll();
    const second = await f.enroll(publication(communityA, 2));
    assert.equal(first.body.recordingId, second.body.recordingId);
    assert.equal(
      (await f.store().association(associationId(publication()), communityA))!
        .state,
      "withdrawn",
    );
    const replay = await f.enroll();
    assert.equal(replay.status, 202);
    assert.equal(replay.body.state, "withdrawn");
    assert.equal(
      (await f.store().association(second.body.associationId, communityA))!
        .state,
      "active",
    );
    assert.equal(
      (await f.db
        .prepare("SELECT count(*) AS n FROM shared_recognition_recordings")
        .first<{ n: number }>())!.n,
      1,
    );
    const forged = await f.enroll({
      ...publication(communityA, 2),
      audioSha256: hashText("changed-media"),
    });
    assert.equal(forged.status, 409);
    assert.equal(
      (await f.db
        .prepare("SELECT count(*) AS n FROM shared_recognition_recordings")
        .first<{ n: number }>())!.n,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test("retained verification response recovers after termination without another identification call", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    await f.run(a.body.recordingId);
    f.flags({ loseVerificationReturn: true });
    await assert.rejects(
      f.run(a.body.recordingId),
      /simulated termination after receipt/,
    );
    assert.equal(
      (await f.store().get(a.body.recordingId))!.state,
      "verification_unknown",
    );
    f.restart();
    assert.equal(await f.run(a.body.recordingId), "ready");
    assert.equal(f.counts().identify, 1);
  } finally {
    await f.dispose();
  }
});
test("unknown identification outcome cannot purchase a second verification automatically", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    await f.run(a.body.recordingId);
    f.flags({ loseVerification: true });
    await assert.rejects(
      f.run(a.body.recordingId),
      /simulated lost verification response/,
    );
    f.flags({ loseVerification: false });
    assert.equal(await f.run(a.body.recordingId), "waiting");
    assert.equal(f.counts().identify, 1);
  } finally {
    await f.dispose();
  }
});
test("known matches reuse verified creator identity and enforce fresh source permissions", async () => {
  const f = await recognitionFixture();
  try {
    const p = publication(),
      a = await f.enroll(p);
    await f.run(a.body.recordingId);
    await f.run(a.body.recordingId);
    const candidates = [{ kind: "custom_files" as const, id: "custom-1" }],
      other = `eip155:6343:0x${"55".repeat(20)}`;
    assert.equal(
      (
        await resolveKnownMatch(
          f.store(),
          p.creatorKey,
          candidates,
          null,
          async () => p,
        )
      ).decision,
      "reuse",
    );
    assert.equal(
      (
        await resolveKnownMatch(
          f.store(),
          other,
          candidates,
          null,
          async () => p,
        )
      ).decision,
      "block",
    );
    assert.equal(
      (await resolveKnownMatch(f.store(), other, candidates, p, async () => p))
        .decision,
      "block",
    );
    assert.equal(
      (
        await resolveKnownMatch(
          f.store(),
          p.creatorKey,
          candidates,
          null,
          async () => ({ ...p, termsRevision: 2 }),
        )
      ).decision,
      "hold",
    );
    assert.equal(
      (
        await resolveKnownMatch(
          f.store(),
          p.creatorKey,
          [],
          null,
          async () => p,
        )
      ).decision,
      "hold",
    );
    assert.equal(
      (
        await resolveKnownMatch(
          f.store(),
          p.creatorKey,
          candidates,
          null,
          async () => {
            await f
              .store()
              .withdraw(p, hashText("withdrawn-during-authority-read"));
            return p;
          },
        )
      ).decision,
      "hold",
    );
  } finally {
    await f.dispose();
  }
});

test("signed enrollment of a verified different encoding reuses the canonical recording without another upload", async () => {
  const f = await recognitionFixture();
  try {
    const a = await f.enroll();
    await f.run(a.body.recordingId);
    await f.run(a.body.recordingId);
    const p = {
      ...publication(communityB),
      audioSha256: hashText("verified-different-encoding"),
      audioBytes: 123,
    };
    f.resolveWith(async (submitted) => {
      assert.equal(submitted.audioSha256, p.audioSha256);
      return {
        recordingId: a.body.recordingId,
        evidenceSha256: hashText("retained-acoustic-match"),
      };
    });
    const b = await f.enroll(p);
    assert.equal(b.status, 202);
    assert.equal(b.body.recordingId, a.body.recordingId);
    assert.equal(b.body.state, "ready");
    assert.equal(f.counts().uploads, 1);
    await f.withdraw(publication());
    assert.equal(await f.run(a.body.recordingId), "idle");
    assert.equal(f.counts().deletes, 0);
    await assert.rejects(
      f.store().associateMatched(
        {
          ...p,
          postId: hashText("wrong-creator-post"),
          creatorKey: `eip155:6343:0x${"55".repeat(20)}`,
        },
        a.body.recordingId,
        hashText("match"),
      ),
      /recognition_match_binding_changed/,
    );
  } finally {
    await f.dispose();
  }
});
test("a no-match obtained before another recording becomes ready cannot create a second recording", async () => {
  const f = await recognitionFixture();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  try {
    f.resolveWith(async (p) => {
      if (p.communityId === communityB) {
        entered.resolve();
        await resume.promise;
      }
      return null;
    });
    const pending = f.enroll({
      ...publication(communityB),
      audioSha256: hashText("different-encoding-with-stale-no-match"),
    });
    await entered.promise;
    const a = await f.enroll();
    await f.run(a.body.recordingId);
    await f.run(a.body.recordingId);
    resume.resolve();
    assert.equal((await pending).status, 409);
    assert.equal(
      (await f.db
        .prepare("SELECT count(*) AS n FROM shared_recognition_recordings")
        .first<{ n: number }>())!.n,
      1,
    );
    assert.equal(f.counts().uploads, 1);
  } finally {
    resume.resolve();
    await f.dispose();
  }
});
test("atomic pending-record coverage serializes new recordings and leaves no orphan on refusal", async () => {
  const f = await recognitionFixture();
  try {
    const p = publication(),
      other = {
        ...publication(communityB),
        audioSha256: hashText("other-new-recording"),
      };
    const results = await Promise.all([f.enroll(p), f.enroll(other)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
    assert.equal(
      (await f.db
        .prepare("SELECT count(*) AS n FROM shared_recognition_recordings")
        .first<{ n: number }>())!.n,
      1,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT count(*) AS n FROM shared_recognition_publications")
        .first<{ n: number }>())!.n,
      1,
    );
  } finally {
    await f.dispose();
  }
});
