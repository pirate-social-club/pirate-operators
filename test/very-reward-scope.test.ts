import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { scopeSignal } from "../harness/very/proof.ts";
import {
  VERY_SCALAR_FIELD,
  expectedVeryScopeSignal,
  rewardPoolScope,
  veryRewardNullifier,
  veryScopeForPool,
  type RewardPoolContext,
} from "../packages/protocol/very-reward-scope.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/very-reward-scope-v1.json", import.meta.url),
    "utf8",
  ),
);
const context: RewardPoolContext = {
  chainId: 84532n,
  pool: "0x1111111111111111111111111111111111111111",
  drawingId: 7n,
};

test("Very reward mapping agrees with independent frozen vectors and the probe parser", () => {
  assert.equal(fixture.version, "pirate-very-reward-scope/1");
  assert.equal(fixture.vectors.length, 4);
  for (const vector of fixture.vectors) {
    const derived = veryScopeForPool({
      chainId: BigInt(vector.chainId),
      pool: vector.pool,
      drawingId: BigInt(vector.drawingId),
    });
    assert.deepEqual(
      derived,
      {
        scope: vector.poolScope,
        externalNullifier: vector.externalNullifier,
        expectedScopeSignal: vector.expectedScopeSignal,
      },
      vector.id,
    );
    assert.equal(
      scopeSignal(derived.externalNullifier),
      vector.expectedScopeSignal,
    );
    assert.equal(
      veryRewardNullifier(derived.scope, vector.syntheticSubject),
      vector.rewardNullifier,
    );
  }
});

test("chain, pool and drawing separate scopes; address casing does not", () => {
  const scopes = fixture.vectors.map(
    (vector: { poolScope: string }) => vector.poolScope,
  );
  const external = fixture.vectors.map(
    (vector: { externalNullifier: string }) => vector.externalNullifier,
  );
  const rewards = fixture.vectors.map(
    (vector: { rewardNullifier: string }) => vector.rewardNullifier,
  );
  assert.equal(new Set(scopes).size, 4);
  assert.equal(new Set(external).size, 4);
  assert.equal(new Set(rewards).size, 4);
  const pool = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address;
  assert.deepEqual(
    veryScopeForPool({ ...context, pool }),
    veryScopeForPool({
      ...context,
      pool: `0x${pool.slice(2).toUpperCase()}` as Address,
    }),
  );
  const scope = rewardPoolScope(context);
  assert.equal(
    veryRewardNullifier(scope, "12345"),
    fixture.vectors[0].rewardNullifier,
  );
  assert.notEqual(
    veryRewardNullifier(scope, "12346"),
    fixture.vectors[0].rewardNullifier,
  );
});

test("wallet, recipient and request labels cannot alter duplicate-prevention inputs", () => {
  const first = {
    ...context,
    wallet: "wallet-a",
    recipient: "recipient-a",
    challenge: "17",
  };
  const second = {
    ...context,
    wallet: "wallet-b",
    recipient: "recipient-b",
    challenge: "18",
  };
  assert.deepEqual(veryScopeForPool(first), veryScopeForPool(second));
  assert.equal(
    veryRewardNullifier(rewardPoolScope(first), "12345"),
    veryRewardNullifier(rewardPoolScope(second), "12345"),
  );
});

test("pool context rejects ambiguous or out-of-range values", () => {
  for (const chainId of [0n, -1n, 1n << 256n, 84532 as unknown as bigint])
    assert.throws(
      () => rewardPoolScope({ ...context, chainId }),
      /invalid_chain_id/,
    );
  for (const drawingId of [-1n, 1n << 256n, 7 as unknown as bigint])
    assert.throws(
      () => rewardPoolScope({ ...context, drawingId }),
      /invalid_drawing_id/,
    );
  for (const pool of [
    "0x0",
    `0x${"0".repeat(40)}`,
    `0x${"1".repeat(41)}`,
    `0x${"g".repeat(40)}`,
  ])
    assert.throws(
      () => rewardPoolScope({ ...context, pool: pool as Address }),
      /invalid_pool_address/,
    );
  assert.doesNotThrow(() => rewardPoolScope({ ...context, drawingId: 0n }));
  assert.doesNotThrow(() =>
    rewardPoolScope({
      ...context,
      chainId: (1n << 256n) - 1n,
      drawingId: (1n << 256n) - 1n,
    }),
  );
});

test("scope and subject encodings reject aliases and field overflow", () => {
  const scope = rewardPoolScope(context);
  for (const value of [
    "0",
    "01",
    "-1",
    "1.0",
    "1e2",
    " 1",
    "1 ",
    "",
    "9".repeat(78),
    1 as unknown as string,
  ]) {
    assert.throws(
      () => expectedVeryScopeSignal(value),
      /invalid_very_external_nullifier/,
    );
    assert.throws(
      () => veryRewardNullifier(scope, value),
      /invalid_very_subject/,
    );
  }
  assert.throws(
    () => expectedVeryScopeSignal((1n << 160n).toString()),
    /invalid_very_external_nullifier/,
  );
  assert.throws(
    () => veryRewardNullifier(scope, VERY_SCALAR_FIELD.toString()),
    /invalid_very_subject/,
  );
  assert.doesNotThrow(() =>
    expectedVeryScopeSignal(((1n << 160n) - 1n).toString()),
  );
  assert.doesNotThrow(() =>
    veryRewardNullifier(scope, (VERY_SCALAR_FIELD - 1n).toString()),
  );
  for (const invalid of [
    "0x1",
    `0x${"0".repeat(63)}`,
    `0x${"0".repeat(65)}`,
    `0x${"g".repeat(64)}`,
  ])
    assert.throws(
      () => veryRewardNullifier(invalid as Hex, "1"),
      /invalid_reward_scope/,
    );
});
