// packages/protocol/records.ts against the frozen vectors computed with cast
// (fixtures/learning-records-v1.json), and its static ABI against the
// compiled contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toEventSignature, toFunctionSignature, type AbiEvent, type AbiFunction, type Hex } from "viem";
import { compile } from "../harness/compile.ts";
import {
  ACTIVITY_KARAOKE,
  LINE_STATUSES,
  leafOf,
  lineKeyOf,
  merkleProof,
  merkleRoot,
  periodOf,
  recordHashOf,
  recordsAbi,
  recordsHashOf,
  scoringPolicyOf,
  songKeyOf,
} from "../packages/protocol/records.ts";
import { rewardScore } from "../packages/protocol/payments.ts";
import { KARAOKE_SCORING_VERSION } from "../packages/scoring/scoring.ts";

const v = JSON.parse(readFileSync("fixtures/learning-records-v1.json", "utf8"));

test("text identifiers, leaves, root and proofs match the vectors", () => {
  assert.equal(ACTIVITY_KARAOKE, v.activity.karaoke);
  assert.equal(scoringPolicyOf(5), v.scoringPolicy["karaoke-scoring/5"]);
  assert.equal(KARAOKE_SCORING_VERSION, 5);
  const leaves: Hex[] = v.manifest.leaves.map(
    (l: { ordinal: number; lineId: string; lineVersion: number; lineKey: Hex; leaf: Hex }) => {
      assert.equal(lineKeyOf(l.lineId), l.lineKey);
      const leaf = leafOf(l.ordinal, l.lineId, l.lineVersion);
      assert.equal(leaf, l.leaf);
      return leaf;
    },
  );
  assert.equal(merkleRoot(leaves), v.manifest.linesRoot);
  leaves.forEach((_, i) => assert.deepEqual(merkleProof(leaves, i), v.manifest.proofs[String(i + 1)]));
  // An odd node is promoted unchanged, and its proof skips that level.
  assert.equal(merkleRoot(leaves.slice(0, 3)), v.manifest.threeLeafRoot);
  // Leaf 3 of three has no sibling at the leaf level; its one sibling is hash(1, 2).
  assert.deepEqual(merkleProof(leaves.slice(0, 3), 2), [v.manifest.proofs["3"][1]]);
});

test("record hashes, the records hash and the song key match the vectors", () => {
  const hashes = v.records.lines.map(
    (l: { ordinal: number; status: number; scoreBps: number; final: boolean; revision: number; recordHash: Hex }) => {
      const leaf = v.manifest.leaves[l.ordinal - 1];
      const hash = recordHashOf({
        attemptId: v.records.attemptId,
        ordinal: l.ordinal,
        lineKey: leaf.lineKey,
        lineVersion: leaf.lineVersion,
        status: l.status,
        scoreBps: l.scoreBps,
        final: l.final,
        revision: l.revision,
      });
      assert.equal(hash, l.recordHash);
      return hash;
    },
  );
  assert.equal(recordsHashOf(hashes), v.records.recordsHash);
  const { songKey, ...song } = v.songKey;
  assert.equal(songKeyOf(song), songKey);
  // Assessed 9000, unpaid, silent and unattempted: 9000 over four lines.
  const reward = rewardScore(
    v.records.lines.map((l: { status: number; scoreBps: number }) => ({
      status: LINE_STATUSES[l.status],
      scoreBps: LINE_STATUSES[l.status] === "assessed" ? l.scoreBps : null,
    })),
  );
  assert.deepEqual(reward, { linesTotal: 4, unmeasuredCount: 0, rewardScoreBps: 2250 });
});

test("periods start at the shared 17:00 UTC boundary", () => {
  assert.equal(periodOf(1793552400), 0);
  assert.equal(periodOf(1793552400 + 86399), 0);
  assert.equal(periodOf(1793552400 + 86400), 1);
  assert.throws(() => periodOf(1793552399), /before_epoch/);
});

test("the static ABI matches the compiled LearningRecords", () => {
  const compiled = compile().LearningRecords.abi;
  const signature = (item: AbiFunction | AbiEvent) =>
    item.type === "event" ? toEventSignature(item) : toFunctionSignature(item);
  const ours = recordsAbi.filter((i) => i.type === "function" || i.type === "event") as (AbiFunction | AbiEvent)[];
  for (const item of ours) {
    const match = compiled.find(
      (c) => (c.type === "function" || c.type === "event") && c.name === item.name,
    ) as AbiFunction | AbiEvent | undefined;
    assert.ok(match, item.name);
    assert.equal(signature(item), signature(match));
    if (item.type === "event")
      assert.deepEqual(
        item.inputs.map((i) => i.indexed ?? false),
        match.inputs.map((i) => (i as { indexed?: boolean }).indexed ?? false),
        item.name,
      );
  }
});
