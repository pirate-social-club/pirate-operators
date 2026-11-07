// No public RPC or key file: exercise the registry against real private SQLite.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivationJournal } from "../harness/megaeth/activation-journal.ts";
import { correctionFixture } from "./study-correction-fixture.ts";
import { correctionIntent } from "../harness/megaeth/study-correction-plan.ts";
import {
  registerControllerProfile,
  markControllerPrepared,
  auditControllerCatalog,
} from "../harness/megaeth/controller-dispatch-catalog.ts";
import {
  runCorrection,
  type CorrectionTransaction,
} from "../harness/megaeth/study-correction-runner.ts";

function persist(path: string, stored: CorrectionTransaction) {
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY,value TEXT)",
    );
    db.prepare("INSERT OR REPLACE INTO records VALUES (?,?)").run(
      "correction",
      JSON.stringify(stored),
    );
  } finally {
    db.close();
  }
  chmodSync(path, 0o600);
}
test("participating controller profiles cannot bypass a missing or unknown prior journal", async () => {
  const f = await correctionFixture(),
    hash = correctionIntent(f.profile).profileHash,
    path = join(f.directory, hash.slice(2) + ".sqlite");
  await registerControllerProfile(f.client, f.profile, f.journal, path);
  assert.equal(
    (await registerControllerProfile(f.client, f.profile, f.journal, path))
      .registered,
    1,
  );
  const next = structuredClone(f.profile);
  next.operation = { kind: "invalidate", reason: `0x${"1".repeat(64)}` };
  const nextPath = join(
    f.directory,
    correctionIntent(next).profileHash.slice(2) + ".sqlite",
  );
  await assert.rejects(
    registerControllerProfile(f.client, next, f.journal, nextPath),
    /ENOENT/,
  );
  f.state.lostResponse = true;
  await runCorrection(f.client, f.profile, f.journal, f.loadKey);
  persist(path, f.journal.get<CorrectionTransaction>("correction")!);
  await assert.rejects(
    registerControllerProfile(f.client, next, f.journal, nextPath),
    /missing/,
  );
  assert.equal(f.journal.get<unknown[]>("controller:profiles")!.length, 1);
});
test("only a confirmed canonical consumed nonce clears the participating-profile fence", async () => {
  const f = await correctionFixture(),
    hash = correctionIntent(f.profile).profileHash,
    path = join(f.directory, hash.slice(2) + ".sqlite");
  await registerControllerProfile(f.client, f.profile, f.journal, path);
  f.state.landed = true;
  await runCorrection(f.client, f.profile, f.journal, f.loadKey);
  persist(path, f.journal.get<CorrectionTransaction>("correction")!);
  const next = structuredClone(f.profile);
  next.operation = { kind: "invalidate", reason: `0x${"2".repeat(64)}` };
  next.nonce = 26;
  const nextPath = join(
    f.directory,
    correctionIntent(next).profileHash.slice(2) + ".sqlite",
  );
  f.state.canonical = false;
  await assert.rejects(
    registerControllerProfile(f.client, next, f.journal, nextPath),
    /unresolved/,
  );
  f.state.canonical = true;
  assert.equal(
    (await registerControllerProfile(f.client, next, f.journal, nextPath))
      .registered,
    2,
  );
});
test("catalog paths cannot redirect readback outside the fixed signer directory", async () => {
  const f = await correctionFixture(),
    hash = correctionIntent(f.profile).profileHash,
    path = join(f.directory, hash.slice(2) + ".sqlite");
  f.journal.set("controller:profiles", [
    { profileHash: hash, nonce: 25, journalPath: "/unexpected.sqlite" },
  ]);
  await assert.rejects(
    registerControllerProfile(f.client, f.profile, f.journal, path),
    /entry_changed/,
  );
  assert.equal(f.state.keyReads, 0);
  assert.equal(f.state.sends.length, 0);
});

test("registration crash may resume only before preparation; a prepared missing or empty journal fails closed", async () => {
  const f = await correctionFixture(),
    hash = correctionIntent(f.profile).profileHash,
    path = join(f.directory, hash.slice(2) + ".sqlite");
  await registerControllerProfile(f.client, f.profile, f.journal, path);
  assert.equal(
    (await registerControllerProfile(f.client, f.profile, f.journal, path))
      .registered,
    1,
  );
  const stored: CorrectionTransaction = {
    profileHash: hash,
    nonce: 25,
    gasPriceWei: "2",
    maximumFeeWei: correctionIntent(f.profile).maximumFeeWei,
  };
  persist(path, stored);
  markControllerPrepared(f.journal, path, stored);
  assert.equal(
    (await registerControllerProfile(f.client, f.profile, f.journal, path))
      .registered,
    1,
  );
  renameSync(path, join(f.directory, "preserved-journal"));
  await assert.rejects(
    registerControllerProfile(f.client, f.profile, f.journal, path),
    /ENOENT/,
  );
  renameSync(join(f.directory, "preserved-journal"), path);
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM records");
  db.close();
  await assert.rejects(
    registerControllerProfile(f.client, f.profile, f.journal, path),
    /prepared_journal_missing/,
  );
  assert.equal(f.state.keyReads, 0);
});

test("the durable prepared marker commits before key access and a signing crash reuses the same intent", async () => {
  const f = await correctionFixture(),
    hash = correctionIntent(f.profile).profileHash,
    path = join(f.directory, hash.slice(2) + ".sqlite");
  await registerControllerProfile(f.client, f.profile, f.journal, path);
  let journal = new ActivationJournal(path);
  const prepared = (stored: CorrectionTransaction) =>
    markControllerPrepared(f.journal, path, stored);
  try {
    await assert.rejects(
      runCorrection(
        f.client,
        f.profile,
        journal,
        () => {
          assert.equal(
            f.journal.get<{ stage: string }[]>("controller:profiles")![0].stage,
            "prepared",
          );
          assert.equal(
            journal.get<CorrectionTransaction>("correction")!.nonce,
            25,
          );
          throw Error("simulated_crash_before_signing");
        },
        () => Date.now(),
        prepared,
      ),
      /simulated_crash/,
    );
  } finally {
    journal.close();
  }
  await registerControllerProfile(f.client, f.profile, f.journal, path);
  journal = new ActivationJournal(path);
  f.state.landed = true;
  try {
    assert.equal(
      (
        await runCorrection(
          f.client,
          f.profile,
          journal,
          f.loadKey,
          () => Date.now(),
          prepared,
        )
      ).state,
      "confirmed",
    );
  } finally {
    journal.close();
  }
  assert.equal(f.state.keyReads, 1);
  assert.equal(f.state.sends.length, 1);
});

test("planning inspects an existing participating registry without changing its bytes or creating journals", async () => {
  const f = await correctionFixture(),
    path = join(
      f.directory,
      correctionIntent(f.profile).profileHash.slice(2) + ".sqlite",
    );
  const catalogPath = join(f.directory, "dispatch-custody.sqlite");
  const lease = new ActivationJournal(catalogPath);
  try {
    await registerControllerProfile(f.client, f.profile, lease, path);
  } finally {
    lease.close();
  }
  const { sha256File } = await import(
    "../harness/megaeth/controller-inventory.ts"
  );
  const before = sha256File(catalogPath),
    files = f.files();
  assert.equal(
    (await auditControllerCatalog(f.client, f.profile, path))
      .registeredProfiles,
    1,
  );
  assert.equal(sha256File(catalogPath), before);
  assert.deepEqual(f.files(), files);
  assert.equal(f.state.keyReads, 0);
});

async function preparedNamespace() {
  const f = await correctionFixture(),
    hash = correctionIntent(f.profile).profileHash,
    path = join(f.directory, hash.slice(2) + ".sqlite"),
    catalogPath = join(f.directory, "dispatch-custody.sqlite");
  const lease = new ActivationJournal(catalogPath);
  await registerControllerProfile(f.client, f.profile, lease, path);
  const reopened = new ActivationJournal(path);
  try {
    const stored: CorrectionTransaction = {
      profileHash: hash,
      nonce: 25,
      gasPriceWei: "2",
      maximumFeeWei: correctionIntent(f.profile).maximumFeeWei,
    };
    reopened.set("correction", stored);
    markControllerPrepared(lease, path, stored);
  } finally {
    reopened.close();
    lease.close();
  }
  return { ...f, path, catalogPath };
}
test("a missing central catalog cannot hide a surviving prepared journal in planning or fresh execution", async () => {
  const f = await preparedNamespace();
  renameSync(f.catalogPath, f.catalogPath + ".lost");
  await assert.rejects(
    auditControllerCatalog(f.client, f.profile, f.path),
    /namespace_orphan/,
  );
  const lease = new ActivationJournal(f.catalogPath);
  try {
    await assert.rejects(
      registerControllerProfile(f.client, f.profile, lease, f.path),
      /namespace_orphan/,
    );
  } finally {
    lease.close();
  }
  assert.equal(f.state.keyReads, 0);
  assert.equal(f.state.sends.length, 0);
});
test("missing or incomplete catalog rows cannot hide owned profile journals", async () => {
  const f = await preparedNamespace(),
    lease = new ActivationJournal(f.catalogPath);
  try {
    lease.delete("controller:profiles");
  } finally {
    lease.close();
  }
  await assert.rejects(
    auditControllerCatalog(f.client, f.profile, f.path),
    /namespace_orphan/,
  );
});
test("an orphaned owned profile lock alone refuses planning", async () => {
  const f = await preparedNamespace();
  renameSync(f.catalogPath, f.catalogPath + ".lost");
  renameSync(f.path, join(f.directory, "preserved-profile"));
  await assert.rejects(
    auditControllerCatalog(f.client, f.profile, f.path),
    /namespace_orphan/,
  );
});
test("unreviewed profile sidecars refuse planning even when indexed", async () => {
  const f = await preparedNamespace();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(f.path + "-wal", "unknown", { mode: 0o600 });
  await assert.rejects(
    auditControllerCatalog(f.client, f.profile, f.path),
    /sidecar/,
  );
});
