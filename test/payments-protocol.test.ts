import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { digest, supportedChain, type Song } from "../packages/protocol/index.ts";
import {
  qualifies,
  quoteIdOf,
  rewardScore,
  segmentUnit,
  unitHash,
  validateManifest,
  verifyKaraokeResult,
  type KaraokeResultBody,
  type LineOutcome,
  type OperatorQuote,
} from "../packages/protocol/payments.ts";
import { fixtureLyrics, fixtureManifest } from "../harness/karaoke-fixture.ts";

test("only local anvil and MegaETH testnet are accepted", () => {
  assert.equal(supportedChain(31337), 31337);
  assert.equal(supportedChain(6343), 6343);
  for (const chainId of [0, 1, 10, 1337, 99999])
    assert.throws(() => supportedChain(chainId), /unsupported_chain/);
});

const line = (lineId: string, status: LineOutcome["status"], scoreBps: number | null): LineOutcome => ({
  lineId,
  lineVersion: 1,
  status,
  scoreBps,
});
test("withholding a purchase for a weak line lowers the reward score exactly as missing it", () => {
  const sungBadly = rewardScore([line("a", "assessed", 9000), line("b", "assessed", 9000), line("c", "assessed", 9000), line("d", "assessed", 1000)]);
  const unpaid = rewardScore([line("a", "assessed", 9000), line("b", "assessed", 9000), line("c", "assessed", 9000), line("d", "unpaid", null)]);
  const silent = rewardScore([line("a", "assessed", 9000), line("b", "assessed", 9000), line("c", "assessed", 9000), line("d", "silent", null)]);
  assert.equal(sungBadly.rewardScoreBps, 7000);
  assert.equal(unpaid.rewardScoreBps, 6750);
  assert.equal(silent.rewardScoreBps, unpaid.rewardScoreBps);
  // Unmeasured lines leave the denominator; integer division rounds down.
  assert.equal(rewardScore([line("a", "assessed", 10000), line("b", "unmeasured", null), line("c", "assessed", 1)]).rewardScoreBps, 5000);
  assert.equal(rewardScore([line("a", "unmeasured", null)]).rewardScoreBps, null);
});

const song: Song = {
  communityId: "fixture-community",
  audio: "0x00",
  title: "Protocol",
  lyrics: fixtureLyrics,
  artwork: "a",
  original: true,
};
test("manifests keep every scored line whole inside one segment", () => {
  const manifest = fixtureManifest(song);
  validateManifest(manifest, 10000);
  const split = structuredClone(manifest);
  split.segments[0].lineIds.push("line-02");
  assert.throws(() => validateManifest(split, 10000), /invalid_manifest/);
  const long = structuredClone(manifest);
  long.segments[0].endMs = 12000;
  long.segments[1].startMs = 12000;
  assert.throws(() => validateManifest(long, 10000), /invalid_manifest/);
  assert.throws(() => validateManifest(manifest, 1000), /invalid_manifest/);
});

test("the verifier refuses omitted, duplicated or invented lines and a zero denominator", () => {
  const manifest = fixtureManifest(song);
  const quote: OperatorQuote = {
    operator: "0x0000000000000000000000000000000000000002" as Address,
    recipient: "0x0000000000000000000000000000000000000002" as Address,
    chainId: 31337,
    payments: "0x0000000000000000000000000000000000000009" as Address,
    token: "0x0000000000000000000000000000000000000008" as Address,
    admissionPrice: "2000",
    segmentPrice: "1000",
    scoringPolicy: "karaoke-scoring/5",
    maxSegmentMs: 10000,
    maxUnpaidRun: 2,
    validFrom: 0,
    validUntil: 1,
  };
  const ticketId = digest("ticket") as Hex;
  const lines = manifest.lines.map((l) => line(l.lineId, "assessed", 8000));
  const billing = manifest.segments.map((s) => ({
    segmentId: s.segmentId,
    take: 0,
    lineIds: s.lineIds,
    redemption: {
      chainId: 31337,
      payments: quote.payments,
      unit: unitHash(segmentUnit(ticketId, s.segmentId, 0)),
      digest: digest(s.segmentId) as Hex,
      txHash: digest(`tx-${s.segmentId}`) as Hex,
    },
  }));
  const summary = { scoreBps: 8000, coverageBps: 10000, scoringVersion: 5 };
  const make = (outcomes: LineOutcome[]): KaraokeResultBody => ({
    attemptId: digest(ticketId) as Hex,
    ticketId,
    communityId: "fixture-community",
    participant: quote.operator,
    songHash: manifest.songHash,
    manifestSha256: digest(manifest) as Hex,
    quoteId: quoteIdOf(quote),
    community: quote.operator,
    mode: "performance",
    status: "completed",
    finality: "final",
    revision: 1,
    startedAt: 0,
    lastAudioAt: 0,
    endedAt: 1,
    closedAtBlock: 1,
    summary,
    summaryHash: digest(summary) as Hex,
    lines: outcomes,
    billing,
    linesHash: digest(outcomes) as Hex,
    billingHash: digest(billing) as Hex,
    ...rewardScore(outcomes),
    paidCount: billing.length,
    paidAmount: String(billing.length * 1000),
  });
  assert.equal(verifyKaraokeResult(make(lines), manifest, quote).rewardScoreBps, 8000);
  assert.throws(() => verifyKaraokeResult(make(lines.slice(1)), manifest, quote), /line_list_mismatch/);
  assert.throws(
    () => verifyKaraokeResult(make([lines[0], lines[0], lines[2], lines[3]]), manifest, quote),
    /line_list_mismatch/,
  );
  assert.throws(
    () => verifyKaraokeResult(make([...lines.slice(0, 3), line("line-99", "assessed", 1)]), manifest, quote),
    /line_list_mismatch/,
  );
  assert.throws(
    () => verifyKaraokeResult(make([...lines.slice(0, 3), line("line-04", "unpaid", 0)]), manifest, quote),
    /invalid_line_outcome/,
  );
  const unmeasured = manifest.lines.map((l) => line(l.lineId, "unmeasured", null));
  const zero = make(unmeasured);
  assert.equal(verifyKaraokeResult(zero, manifest, quote).rewardScoreBps, null);
  assert.equal(qualifies(zero, { minRewardScoreBps: 0, maxUnmeasuredBps: 10000 }), false);
});
