import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { decodeFunctionData, parseTransaction } from "viem";
import {
  correctionIntent,
  correctionWindow,
} from "../harness/megaeth/study-correction-plan.ts";
import { observeCorrection } from "../harness/megaeth/study-correction-observation.ts";
import {
  readControllerInventory,
  sha256File,
} from "../harness/megaeth/controller-inventory.ts";
import {
  correctionStatus,
  runCorrection,
  type CorrectionTransaction,
} from "../harness/megaeth/study-correction-runner.ts";
import { resultsV3Abi } from "../packages/protocol/learning-results-v3.ts";
import { correctionFixture } from "./study-correction-fixture.ts";

test("manual Study plan authenticates canonical event and finite inventory without writes or key access", async () => {
  const f = await correctionFixture(),
    files = f.files(),
    before = files.map((name) => sha256File(f.directory + "/" + name));
  const plan = correctionIntent(f.profile),
    observation = await observeCorrection(f.client, f.profile);
  assert.equal(
    decodeFunctionData({ abi: resultsV3Abi, data: plan.data }).functionName,
    "correct",
  );
  assert.equal(observation.currentCommitment, f.profile.previous.commitment);
  assert.equal(
    (await readControllerInventory(f.client, f.profile, 199n)).length,
    1,
  );
  assert.deepEqual(f.files(), files);
  assert.deepEqual(
    files.map((name) => sha256File(f.directory + "/" + name)),
    before,
  );
  assert.equal(f.state.keyReads, 0);
  assert.deepEqual(f.journal.entries(""), []);
  assert.equal(f.state.sends.length, 0);
});
test("Study correction refuses changed selection, missing first pass, no change and a zero invalidation reason", async () => {
  const f = await correctionFixture();
  f.profile.operation = {
    kind: "correct",
    outcomes: f.profile.previous.outcomes,
    status: 1,
  };
  assert.throws(() => correctionIntent(f.profile), /no_change/);
  f.profile.operation = {
    kind: "correct",
    outcomes: "0x000201000201000401000701",
    status: 1,
  };
  assert.throws(() => correctionIntent(f.profile));
  f.profile.operation = {
    kind: "correct",
    outcomes: "0x000704000201000a01000401",
    status: 1,
  };
  assert.throws(() => correctionIntent(f.profile), /outcomes/);
  f.profile.operation = { kind: "invalidate", reason: `0x${"0".repeat(64)}` };
  assert.throws(() => correctionIntent(f.profile), /invalidation/);
});
test("manual Study refuses wrong chain, changed code/registration, orphan proof and stale head without key access", async () => {
  for (const change of [
    "chain",
    "code",
    "directoryRevision",
    "canonical",
    "current",
  ] as const) {
    const f = await correctionFixture();
    if (change === "chain") f.state.chain = 1;
    if (change === "code") f.state.code = "0x6001";
    if (change === "directoryRevision") f.state.directoryRevision = 5n;
    if (change === "canonical") f.state.canonical = false;
    if (change === "current") f.state.current = `0x${"9".repeat(64)}`;
    await assert.rejects(
      runCorrection(f.client, f.profile, f.journal, f.loadKey),
    );
    assert.equal(f.state.keyReads, 0);
    assert.equal(f.state.sends.length, 0);
  }
});
test("manual Study fails closed for missing, changed, permissive and unresolved inventory", async () => {
  for (const change of ["missing", "hash", "mode", "raw", "settled"] as const) {
    const f = await correctionFixture();
    if (change === "missing") f.profile.inventory[0].path += ".missing";
    if (change === "hash") writeFileSync(f.inventoryPath, "changed");
    if (change === "mode") chmodSync(f.inventoryPath, 0o644);
    if (change === "raw") {
      const doc = JSON.parse(readFileSync(f.inventoryPath, "utf8"));
      delete doc.intents.old.raw;
      writeFileSync(f.inventoryPath, JSON.stringify(doc));
      f.profile.inventory[0].sha256 = sha256File(f.inventoryPath);
    }
    if (change === "settled")
      f.client.getTransactionReceipt = async () => {
        throw Error("unavailable_receipt");
      };
    f.refreshCustody();
    await assert.rejects(readControllerInventory(f.client, f.profile, 199n));
    assert.equal(f.state.keyReads, 0);
  }
});
test("manual Study enforces nonce, window, gas and balance before key access", async () => {
  for (const change of ["nonce", "window", "gas", "balance"] as const) {
    const f = await correctionFixture();
    if (change === "nonce") f.state.pendingNonce++;
    if (change === "window") {
      f.profile.deadline = new Date(Date.now() - 1).toISOString();
      f.profile.notBefore = new Date(Date.now() - 60000).toISOString();
      f.refreshCustody();
    }
    if (change === "gas") f.state.gas = 500001n;
    if (change === "balance") f.state.balance = 1n;
    await assert.rejects(
      runCorrection(f.client, f.profile, f.journal, f.loadKey),
    );
    assert.equal(f.state.keyReads, 0);
    assert.equal(f.state.sends.length, 0);
  }
});
test("lost correction response recovers the one signed transaction without another key read or charge", async () => {
  const f = await correctionFixture();
  f.state.lostResponse = true;
  f.state.landed = true;
  assert.equal(
    (await runCorrection(f.client, f.profile, f.journal, f.loadKey)).state,
    "unknown",
  );
  const stored = f.journal.get<CorrectionTransaction>("correction")!;
  assert.equal(parseTransaction(stored.raw!).nonce, 25);
  assert.equal(stored.maximumFeeWei, "5000100");
  assert.equal(
    (
      await runCorrection(f.client, f.profile, f.journal, () => {
        throw Error("key_must_not_be_read");
      })
    ).state,
    "confirmed",
  );
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.keyReads, 1);
  assert.equal(
    f.journal.get<CorrectionTransaction>("correction")!.raw,
    stored.raw,
  );
});
test("unknown unlanded correction replays identical bytes, and expired status remains read-only", async () => {
  const f = await correctionFixture();
  f.state.lostResponse = true;
  await runCorrection(f.client, f.profile, f.journal, f.loadKey);
  const stored = f.journal.get<CorrectionTransaction>("correction")!;
  await runCorrection(f.client, f.profile, f.journal, () => {
    throw Error("no_resign");
  });
  assert.equal(f.state.sends.length, 2);
  assert.equal(f.state.sends[0], f.state.sends[1]);
  assert.equal(f.state.keyReads, 1);
  assert.throws(
    () => correctionWindow(f.profile, Date.parse(f.profile.deadline)),
    /window_closed/,
  );
  assert.equal(
    (await correctionStatus(f.client, f.profile, stored)).state,
    "unknown",
  );
});
test("signed correction that exceeds data-fee reserve remains charged and unsent", async () => {
  const f = await correctionFixture();
  f.state.dataFee = 101n;
  await assert.rejects(
    runCorrection(f.client, f.profile, f.journal, f.loadKey),
    /data_fee_cap/,
  );
  const stored = f.journal.get<CorrectionTransaction>("correction")!;
  assert.ok(stored.raw);
  assert.equal(stored.maximumFeeWei, "5000100");
  assert.equal(f.state.sends.length, 0);
});

test("manual Study binds pending recovery and refuses altered signed transaction bytes", async () => {
  const f = await correctionFixture();
  f.state.lostResponse = true;
  await runCorrection(f.client, f.profile, f.journal, f.loadKey);
  f.state.pendingNonce = 26;
  assert.equal(
    (
      await runCorrection(f.client, f.profile, f.journal, () => {
        throw Error("no_key");
      })
    ).state,
    "pending",
  );
  assert.equal(f.state.sends.length, 1);
  const saved = f.journal.get<CorrectionTransaction>("correction")!;
  f.journal.set("correction", { ...saved, nonce: 26 });
  await assert.rejects(
    runCorrection(f.client, f.profile, f.journal, f.loadKey),
    /journal_.*changed/,
  );
});

test("manual Study reads the two other explicit journal formats and rejects reserved SQLite state", async () => {
  const f = await correctionFixture();
  const old = JSON.parse(readFileSync(f.inventoryPath, "utf8")).intents.old;
  writeFileSync(
    f.inventoryPath,
    JSON.stringify({
      schema: "pirate.testnet-deployment-journal/1",
      chainId: 6343,
      signer: f.profile.controller,
      profileHash: `0x${"d".repeat(64)}`,
      transactions: { old },
    }),
  );
  f.profile.inventory[0].format = "deployment-journal-v1";
  f.profile.inventory[0].sha256 = sha256File(f.inventoryPath);
  f.refreshCustody();
  assert.equal(
    (await readControllerInventory(f.client, f.profile, 199n)).length,
    1,
  );
  const path = join(f.directory, "old.sqlite"),
    db = new DatabaseSync(path);
  db.exec("CREATE TABLE records (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO records VALUES (?,?)").run(
    "tx:0000000024",
    JSON.stringify(old),
  );
  db.prepare("INSERT INTO records VALUES (?,?)").run(
    "intent:record_result:old",
    JSON.stringify({ nonce: 24 }),
  );
  db.close();
  chmodSync(path, 0o600);
  f.profile.inventory[0] = {
    path,
    sha256: sha256File(path),
    format: "activation-journal",
  };
  f.refreshCustody();
  assert.equal(
    (await readControllerInventory(f.client, f.profile, 199n)).length,
    1,
  );
  const changed = new DatabaseSync(path);
  changed
    .prepare("INSERT INTO records VALUES (?,?)")
    .run("sponsor:ledger", JSON.stringify({ reserved: "1" }));
  changed.close();
  f.profile.inventory[0].sha256 = sha256File(path);
  f.refreshCustody();
  await assert.rejects(
    readControllerInventory(f.client, f.profile, 199n),
    /unresolved_reservation/,
  );
  assert.equal(f.state.keyReads, 0);
  assert.equal(f.state.sends.length, 0);
});

test("correction status refuses a canonical receipt returned for a different transaction hash", async () => {
  const f = await correctionFixture();
  f.state.lostResponse = true;
  await runCorrection(f.client, f.profile, f.journal, f.loadKey);
  const stored = f.journal.get<CorrectionTransaction>("correction")!,
    original = f.client.getTransactionReceipt;
  f.client.getTransactionReceipt = (async ({ hash }: { hash: string }) =>
    hash === stored.hash
      ? original({ hash: f.profile.previous.transactionHash })
      : original({ hash: hash as `0x${string}` })) as typeof original;
  await assert.rejects(
    correctionStatus(f.client, f.profile, stored),
    /not_canonical/,
  );
});
test("correction pending recovery refuses another response hash with the same controller and nonce", async () => {
  const f = await correctionFixture();
  f.state.lostResponse = true;
  await runCorrection(f.client, f.profile, f.journal, f.loadKey);
  f.state.pendingNonce = 26;
  const original = f.client.getTransaction;
  f.client.getTransaction = (async (...args: Parameters<typeof original>) => ({
    ...(await original(...args)),
    hash: `0x${"9".repeat(64)}`,
  })) as typeof original;
  await assert.rejects(
    runCorrection(f.client, f.profile, f.journal, () => {
      throw Error("no_key");
    }),
    /pending_conflict/,
  );
});

test("manual invalidation preserves old outcomes and confirmed status stays available after the window", async () => {
  const f = await correctionFixture();
  f.profile.operation = { kind: "invalidate", reason: `0x${"3".repeat(64)}` };
  f.refreshCustody();
  const intent = correctionIntent(f.profile);
  assert.equal(intent.next.status, 5);
  assert.equal(intent.outcomes, f.profile.previous.outcomes);
  assert.equal(
    decodeFunctionData({ abi: resultsV3Abi, data: intent.data }).functionName,
    "invalidate",
  );
  f.state.landed = true;
  assert.equal(
    (await runCorrection(f.client, f.profile, f.journal, f.loadKey)).state,
    "confirmed",
  );
  assert.equal(
    (
      await runCorrection(
        f.client,
        f.profile,
        f.journal,
        () => {
          throw Error("no_key");
        },
        () => Date.parse(f.profile.deadline) + 1,
      )
    ).state,
    "confirmed",
  );
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.keyReads, 1);
});
