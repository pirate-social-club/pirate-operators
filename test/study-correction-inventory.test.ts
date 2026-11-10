// Regression coverage from the independent initial-candidate refusal review.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { correctionFixture } from "./study-correction-fixture.ts";
import {
  readControllerInventory,
  sha256File,
} from "../harness/megaeth/controller-inventory.ts";
import { correctionIntent } from "../harness/megaeth/study-correction-plan.ts";
async function inventory(extra: Record<string, unknown>, includeLegacy = true) {
  const f = await correctionFixture(),
    old = JSON.parse(readFileSync(f.inventoryPath, "utf8")).intents.old;
  const path = join(f.directory, "inventory.sqlite"),
    db = new DatabaseSync(path);
  db.exec("CREATE TABLE records(key TEXT PRIMARY KEY,value TEXT)");
  const insert = db.prepare("INSERT INTO records VALUES(?,?)");
  if (includeLegacy) insert.run("tx:0000000024", JSON.stringify(old));
  for (const [key, value] of Object.entries(extra))
    insert.run(key, JSON.stringify(value));
  db.close();
  chmodSync(path, 0o600);
  f.profile.inventory = [
    { path, sha256: sha256File(path), format: "activation-journal" },
  ];
  f.refreshCustody();
  return { ...f, old, path };
}
test("an allocated intent without a matching signed/canonical row is never omitted from inventory", async () => {
  const f = await inventory({ "intent:record_result:future": { nonce: 25 } });
  await assert.rejects(
    readControllerInventory(f.client, f.profile, 199n),
    /transaction_missing/,
  );
  assert.equal(f.state.keyReads, 0);
});
test("settled legacy rows cannot hide an unresolved own correction", async () => {
  const f = await inventory({
    correction: {
      profileHash: `0x${"8".repeat(64)}`,
      nonce: 25,
      gasPriceWei: "2",
      maximumFeeWei: "5000100",
    },
  });
  await assert.rejects(
    readControllerInventory(f.client, f.profile, 199n),
    /unresolved_allocation/,
  );
});
test("a correction-only journal is normalized and checked against its signed canonical transaction", async () => {
  const initial = await correctionFixture(),
    old = JSON.parse(readFileSync(initial.inventoryPath, "utf8")).intents.old;
  const f = await inventory(
    {
      correction: {
        ...old,
        profileHash: correctionIntent(initial.profile).profileHash,
        gasPriceWei: "1",
        maximumFeeWei: "21000",
      },
    },
    false,
  );
  const seen = await readControllerInventory(f.client, f.profile, 199n);
  assert.deepEqual(seen, [{ nonce: 24, hash: old.hash }]);
});
