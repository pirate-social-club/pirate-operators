import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateStore } from "../harness/testnet/store.ts";

test("SDK store preserves bigint channel state and serializes atomic updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pirate-testnet-store-"));
  let db = new PrivateStore("fixture", dir);
  try {
    const store = db.adapter("server:");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.update("amount", (value) => ({
          op: "set",
          value: ((value as bigint) ?? 0n) + 1n,
          result: null,
        })),
      ),
    );
    assert.equal(await store.get("amount"), 20n);
    assert.throws(
      () => new PrivateStore("fixture", dir),
      /testnet_wallet_already_in_use/,
    );
    db.close();
    db = new PrivateStore("fixture", dir);
    assert.equal(await db.adapter("server:").get("amount"), 20n);
  } finally {
    db.close();
  }
});
