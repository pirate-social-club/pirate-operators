import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import {
  activationWrappingKey,
  sealActivation,
  openActivation,
  type ActivationPayload,
} from "../src/activation-vault.ts";
import {
  retainActivation,
  retainedActivation,
  requireActivationRecovery,
} from "../src/server/activation-recovery.ts";

const payload: ActivationPayload = {
  consentSignature: "fixture-signed-consent",
  message: "Zml4dHVyZS1tZXNzYWdl",
  publicOutput: "Zml4dHVyZS1wdWJsaWMtb3V0cHV0",
  encryptedShare: "Zml4dHVyZS1lbmNyeXB0ZWQtc2hhcmU",
};
test("activation proof reopens from only the passkey-protected seed and rejects changed identity or ciphertext", async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32)),
    originalSeed = new Uint8Array(seed),
    key = await activationWrappingKey(seed, "credential"),
    record = await sealActivation(key, "credential", "attempt", payload);
  seed.fill(0);
  const reopened = await activationWrappingKey(originalSeed, "credential");
  assert.deepEqual(
    await openActivation(reopened, "credential", "attempt", record),
    payload,
  );
  assert.ok(!JSON.stringify(record).includes(payload.consentSignature));
  await assert.rejects(
    openActivation(reopened, "credential", "another-attempt", record),
  );
  await assert.rejects(
    openActivation(reopened, "other-credential", "attempt", record),
  );
  await assert.rejects(
    openActivation(
      await activationWrappingKey(new Uint8Array(32), "credential"),
      "credential",
      "attempt",
      record,
    ),
  );
  await assert.rejects(
    openActivation(reopened, "credential", "attempt", {
      ...record,
      payloadHash: "a".repeat(43),
    }),
  );
  await assert.rejects(
    openActivation(reopened, "credential", "attempt", {
      ...record,
      ciphertext:
        (record.ciphertext[0] === "a" ? "b" : "a") + record.ciphertext.slice(1),
    }),
  );
  await assert.rejects(crypto.subtle.exportKey("raw", key));
  originalSeed.fill(0);
});
test("D1 retains one immutable encrypted proof before DKG and binds the funded payload to that exact attempt", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
  });
  try {
    const DB = await mf.getD1Database("DB"),
      env = { DB };
    await DB.exec((await readFile("schema.sql", "utf8")).replaceAll("\n", " "));
    await DB.prepare(
      "INSERT INTO credentials(id,cose_key,counter,sui_public_key,sui_address,sealed_seed,created) VALUES('credential','fixture',0,'fixture','0x1','encrypted-fixture',0)",
    ).run();
    await DB.prepare(
      "INSERT INTO attempts(id,account,credential_id,intent,created) VALUES('attempt','private-account','credential','{}',0)",
    ).run();
    await assert.rejects(
      requireActivationRecovery(env, "attempt", "credential", { ...payload }),
      /activation_recovery_required/,
    );
    const key = await activationWrappingKey(
        crypto.getRandomValues(new Uint8Array(32)),
        "credential",
      ),
      record = await sealActivation(key, "credential", "attempt", payload);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        retainActivation(env, "attempt", "credential", record),
      ),
    );
    assert.equal(
      (await DB.prepare("SELECT COUNT(*) AS n FROM activation_recovery").first<{
        n: number;
      }>())!.n,
      1,
    );
    assert.deepEqual(
      await retainedActivation(env, "attempt", "credential"),
      record,
    );
    await requireActivationRecovery(env, "attempt", "credential", {
      ...payload,
    });
    await assert.rejects(
      requireActivationRecovery(env, "attempt", "credential", {
        ...payload,
        publicOutput: "changed",
      }),
      /activation_recovery_required/,
    );
    await assert.rejects(
      requireActivationRecovery(env, "other-attempt", "credential", {
        ...payload,
      }),
      /activation_recovery_required/,
    );
    await assert.rejects(
      retainActivation(
        env,
        "attempt",
        "credential",
        await sealActivation(key, "credential", "attempt", payload),
      ),
      /activation_recovery_conflict/,
    );
    assert.deepEqual(
      await openActivation(
        key,
        "credential",
        "attempt",
        (await retainedActivation(env, "attempt", "credential"))!,
      ),
      payload,
    );
    assert.equal(
      (await DB.prepare("SELECT COUNT(*) AS n FROM submissions").first<{
        n: number;
      }>())!.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
