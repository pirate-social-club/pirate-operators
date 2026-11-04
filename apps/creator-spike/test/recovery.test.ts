import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import {
  bindActiveCredential,
  recordSignatureSubmission,
} from "../src/server/binding.ts";
import {
  acquireOperatorLock,
  beginSignaturePreparation,
  saveSignaturePreparation,
  claimSignaturePreparation,
  capturedSignaturePreparation,
  releaseUnsubmittedPreparation,
} from "../src/server/operator-lock.ts";

async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch(){return new Response('fixture')} }",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec((await readFile("schema.sql", "utf8")).replaceAll("\n", " "));
    for (const id of ["a", "b"]) {
      await db
        .prepare(
          "INSERT INTO credentials(id,cose_key,counter,sui_public_key,sui_address,sealed_seed,created,status) VALUES(?,'fixture',0,'fixture',?,'fixture',0,'active')",
        )
        .bind(id, `fixture-owner-${id}`)
        .run();
      await db
        .prepare(
          "INSERT INTO attempts(id,account,credential_id,intent,created) VALUES(?,?,?,'fixture',0)",
        )
        .bind(`attempt-${id}`, `account-${id}`, id)
        .run();
      await db
        .prepare(
          "INSERT INTO signatures(id,credential_id,message,status,created) VALUES(?,?,'fixed-fixture','reserved',0)",
        )
        .bind(`signature-${id}`, id)
        .run();
    }
    return { db, dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

test("concurrent creator exchanges cannot report success for different bound credentials", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled(
      ["a", "b"].map((id) => bindActiveCredential(f.db, "account", id)),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const winner =
      results.findIndex((r) => r.status === "fulfilled") === 0 ? "a" : "b";
    assert.equal(
      (await f.db
        .prepare("SELECT credential_id FROM bindings WHERE account='account'")
        .first<{ credential_id: string }>())!.credential_id,
      winner,
    );
    await bindActiveCredential(f.db, "account", winner);
    await assert.rejects(
      bindActiveCredential(f.db, "account", winner === "a" ? "b" : "a"),
      /creator_binding_conflict/,
    );
  } finally {
    await f.dispose();
  }
});

test("replaying a confirmed signature cannot regress verified status or its receipt", async () => {
  const f = await fixture();
  try {
    await recordSignatureSubmission(f.db, "signature-a", "digest-a", "sign-a");
    await f.db
      .prepare(
        "UPDATE signatures SET status='verified',result=? WHERE id='signature-a'",
      )
      .bind(JSON.stringify({ status: "verified", signature: "fixture-proof" }))
      .run();
    await recordSignatureSubmission(f.db, "signature-a", "digest-a", "sign-a");
    await bindActiveCredential(f.db, "account", "a");
    const row = await f.db
      .prepare(
        "SELECT s.status,s.result FROM signatures s JOIN bindings b ON b.credential_id=s.credential_id WHERE b.account='account'",
      )
      .first<{ status: string; result: string }>();
    assert.equal(row!.status, "verified");
    assert.equal(JSON.parse(row!.result).signature, "fixture-proof");
    await assert.rejects(
      recordSignatureSubmission(
        f.db,
        "signature-a",
        "different-digest",
        "sign-a",
      ),
      /signature_submission_conflict/,
    );
  } finally {
    await f.dispose();
  }
});

test("preparing a signature reserves gas against another creator's activation", async () => {
  const f = await fixture();
  try {
    const p = await beginSignaturePreparation(
      f.db,
      "signature-a",
      "attempt-a:sign",
      1000,
    );
    await saveSignaturePreparation(
      f.db,
      "signature-a",
      p.token,
      "raw-gas-version-1",
      1001,
    );
    await assert.rejects(
      acquireOperatorLock(f.db, "attempt-b:dkg", 1002),
      /operator_busy_reconciling_transaction/,
    );
    await claimSignaturePreparation(
      f.db,
      "signature-a",
      "raw-gas-version-1",
      "captured-user-proof",
      1003,
    );
    // Losing the next response, or even the persistence attempt, must not free
    // the gas while an authorized submission is being reconciled.
    await assert.rejects(
      acquireOperatorLock(f.db, "attempt-b:dkg", 999999),
      /operator_busy_reconciling_transaction/,
    );
    const captured = await capturedSignaturePreparation(f.db, "signature-a");
    assert.equal(captured!.user_signature, "captured-user-proof");
    await releaseUnsubmittedPreparation(f.db, "signature-a", captured!.token);
    assert.equal(
      (await f.db
        .prepare("SELECT holder FROM operator_lock")
        .first<{ holder: string }>())!.holder,
      "attempt-a:sign",
    );
  } finally {
    await f.dispose();
  }
});

test("an abandoned unsigned approval expires and stale bytes require fresh preparation and proof", async () => {
  const f = await fixture();
  try {
    const p = await beginSignaturePreparation(
      f.db,
      "signature-a",
      "attempt-a:sign",
      1000,
    );
    await saveSignaturePreparation(
      f.db,
      "signature-a",
      p.token,
      "raw-gas-version-1",
      1001,
    );
    await acquireOperatorLock(f.db, "attempt-b:dkg", 301001);
    await assert.rejects(
      claimSignaturePreparation(
        f.db,
        "signature-a",
        "raw-gas-version-1",
        "old-proof",
        301002,
      ),
      /signature_preparation_expired_or_busy_retry/,
    );
    // The other creator's confirmed activation consumed the old gas version.
    await f.db
      .prepare("DELETE FROM operator_lock WHERE holder='attempt-b:dkg'")
      .run();
    const next = await beginSignaturePreparation(
      f.db,
      "signature-a",
      "attempt-a:sign",
      301003,
    );
    await saveSignaturePreparation(
      f.db,
      "signature-a",
      next.token,
      "raw-gas-version-2",
      301004,
    );
    await assert.rejects(
      claimSignaturePreparation(
        f.db,
        "signature-a",
        "raw-gas-version-1",
        "old-proof",
        301005,
      ),
      /signature_preparation_expired_or_busy_retry/,
    );
    await claimSignaturePreparation(
      f.db,
      "signature-a",
      "raw-gas-version-2",
      "fresh-proof",
      301006,
    );
    assert.equal(
      (await capturedSignaturePreparation(f.db, "signature-a"))!.user_signature,
      "fresh-proof",
    );
  } finally {
    await f.dispose();
  }
});

test("an uncertain persisted transaction retains its gas reservation through lease expiry", async () => {
  const f = await fixture();
  try {
    const p = await beginSignaturePreparation(
      f.db,
      "signature-a",
      "attempt-a:sign",
      1000,
    );
    await saveSignaturePreparation(
      f.db,
      "signature-a",
      p.token,
      "signed-bytes-fixture",
      1001,
    );
    await claimSignaturePreparation(
      f.db,
      "signature-a",
      "signed-bytes-fixture",
      "user-proof",
      1002,
    );
    await f.db
      .prepare(
        "INSERT INTO submissions(id,attempt_id,kind,digest,bytes,signatures,status,created) VALUES('attempt-a:sign','attempt-a','sign','digest','signed-bytes-fixture','[]','pending',1003)",
      )
      .run();
    await assert.rejects(
      acquireOperatorLock(f.db, "attempt-b:dkg", 999999),
      /operator_busy_reconciling_transaction/,
    );
    await assert.rejects(
      beginSignaturePreparation(f.db, "signature-a", "attempt-a:sign", 999999),
      /signature_preparation_busy_retry/,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM submissions")
        .first<{ n: number }>())!.n,
      1,
    );
  } finally {
    await f.dispose();
  }
});
