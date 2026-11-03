import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { assertNetwork, rejectFixtureKeys } from "../harness/testnet/config.ts";
import { sign, verify } from "../packages/protocol/index.ts";

test("public-chain signing rejects the local public fixture keys", () => {
  const keys = Array.from({ length: 9 }, () => generatePrivateKey());
  assert.doesNotThrow(() => rejectFixtureKeys(keys));
  assert.throws(
    () =>
      rejectFixtureKeys([...keys.slice(0, 8), `0x${"1".padStart(64, "0")}`]),
    /public_fixture_key_refused/,
  );
  assert.throws(
    () => rejectFixtureKeys([...keys.slice(0, 8), keys[0]]),
    /duplicate_testnet_key/,
  );
});
test("mainnet chain IDs are refused before a testnet operation", async () => {
  await assertNetwork(async () => 84532, 84532);
  await assertNetwork(async () => 42431, 42431);
  await assert.rejects(
    assertNetwork(async () => 8453, 84532),
    /testnet_chain_mismatch/,
  );
  await assert.rejects(
    assertNetwork(async () => 4217, 42431),
    /testnet_chain_mismatch/,
  );
});
test("service signatures cannot be replayed between local and Base Sepolia domains", async () => {
  const key = generatePrivateKey();
  const signer = privateKeyToAccount(key).address;
  const record = await sign("evidence", { hash: "test" }, key, 84532);
  assert.deepEqual(
    await verify(record, "evidence", signer, 84532),
    record.body,
  );
  await assert.rejects(
    verify(record, "evidence", signer, 31337),
    /bad_signature/,
  );
});
