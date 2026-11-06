import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, type Hex, type PublicClient } from "viem";
import { observeStudyRelease } from "../harness/study-release-observation.ts";
import { selectionFixture } from "./fixtures/study-release.ts";
import { publicCapture, hash } from "./fixtures/reference-results.ts";

function fixture(change: Record<string, unknown> = {}) {
  const p = selectionFixture(),
    code = "0x60016000" as Hex;
  p.resultsV3.codeHash = keccak256(code);
  const captured = publicCapture(),
    pinned: bigint[] = [];
  const state: Record<string, unknown> = {
    VERSION: 3,
    communityId: p.communityId,
    publicityPolicy: p.resultsV3.publicityPolicy,
    controller: p.controller,
    karaoke: true,
    study: true,
    ...change,
  };
  let blockReads = 0;
  const client = {
    getChainId: async () => state.chainId ?? 6343,
    getBlockNumber: async () => 100n,
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      pinned.push(blockNumber);
      return {
        number: state.wrongBlock ? 98n : blockNumber,
        hash: state.reorg && ++blockReads > 1 ? hash("reorg") : hash("block"),
      };
    },
    async getCode({
      address,
      blockNumber,
    }: {
      address: string;
      blockNumber: bigint;
    }) {
      pinned.push(blockNumber);
      if (state.wrongCode) return "0x00";
      return address === p.resultsV2.contract ? captured.codes[address] : code;
    },
    async readContract({
      functionName,
      args,
      blockNumber,
    }: {
      functionName: string;
      args?: unknown[];
      blockNumber: bigint;
    }) {
      pinned.push(blockNumber);
      return functionName === "graders"
        ? state[args![1] === 1 ? "karaoke" : "study"]
        : state[functionName];
    },
  } as unknown as PublicClient;
  return { p, client, pinned };
}
test("release observation pins both runtime hashes and V3 authority/graders to a rechecked canonical block", async () => {
  const f = fixture(),
    result = await observeStudyRelease(f.client, f.p);
  assert.equal(result.blockNumber, "99");
  assert.equal(result.blockHash, hash("block"));
  assert.equal(f.pinned.length, 10);
  assert.ok(f.pinned.every((n) => n === 99n));
});
for (const [name, change] of Object.entries({
  chain: { chainId: 4326 },
  version: { VERSION: 2 },
  community: { communityId: hash("other") },
  publicity: { publicityPolicy: hash("other") },
  controller: { controller: `0x${"1".repeat(40)}` },
  karaoke: { karaoke: false },
  study: { study: false },
  runtime: { wrongCode: true },
  canonical: { reorg: true },
  number: { wrongBlock: true },
}))
  test(`release observation refuses changed ${name}`, async () => {
    const f = fixture(change);
    await assert.rejects(observeStudyRelease(f.client, f.p), /study_release_/);
  });
