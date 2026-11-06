import { test } from "node:test";
import assert from "node:assert/strict";
import { zeroHash } from "viem";
import { digest } from "../packages/protocol/index.ts";
import {
  resultCommitment,
  unpackStudyOutcomes,
  packStudyOutcomes,
} from "../packages/protocol/learning-results-v3.ts";
import {
  reducePublicResultsV3,
  type V3SourcePorts,
} from "../packages/records/results-v3.ts";
import { qualifiesStudyResult } from "../packages/records/study-qualification.ts";
import { studyResultFixture } from "./study-result-fixture.ts";
import { fixtureManifest } from "../harness/karaoke-fixture.ts";
import {
  packOutcomes,
  orderedExercisesHash,
} from "../packages/protocol/learning-results.ts";
import { reducePublicResults } from "../packages/records/results-v2.ts";

function fixture() {
  const f = studyResultFixture();
  const ports: V3SourcePorts = {
    communityId: f.source.communityId,
    studyManifest: async () => f.source,
    authenticateStudy: async (source) => digest(source) === digest(f.source),
  };
  const event = {
    ...f.bundle,
    commitment: resultCommitment(f.bundle.result, f.bundle.outcomes),
    blockNumber: 10n,
    logIndex: 0,
  };
  return {
    ...f,
    ports,
    event,
    policies: new Map([[digest(f.policy), f.policy]]),
  };
}

test("independent Study readback authenticates the full source and recomputes first-pass qualification", async () => {
  const f = fixture();
  const [read] = await reducePublicResultsV3([f.event, f.event], f.ports);
  assert(read.verified);
  assert.equal(qualifiesStudyResult(read, f.policies, read.period), true);
  assert.equal(qualifiesStudyResult(read, f.policies, read.period - 1n), false);
  assert.equal(
    qualifiesStudyResult(
      { ...read, result: { ...read.result, qualificationPolicy: zeroHash } },
      f.policies,
      read.period,
    ),
    false,
  );
  const [untrusted] = await reducePublicResultsV3([f.event], {
    ...f.ports,
    authenticateStudy: undefined,
  });
  assert.equal(untrusted.verified, false);
  assert(untrusted.problems.includes("source_unverified"));
  const [unavailable] = await reducePublicResultsV3([f.event], {
    ...f.ports,
    studyManifest: undefined,
  });
  assert.equal(unavailable.verified, false);
});

test("changed, shortened or unavailable source never falls back to favorable evidence", async () => {
  const f = fixture();
  const source = structuredClone(f.source);
  source.lines.pop();
  source.sourceText = source.sourceText.split("\n").slice(0, -1).join("\n");
  const [shortened] = await reducePublicResultsV3([f.event], {
    ...f.ports,
    studyManifest: async () => source,
  });
  assert.equal(shortened.verified, false);
  const outcomes = packStudyOutcomes(
    unpackStudyOutcomes(f.bundle.outcomes, 4).map((x) => ({
      ...x,
      status: "incorrect",
    })),
  );
  const result = {
    ...f.bundle.result,
    revision: 2,
    supersedes: f.event.commitment,
  };
  const corrected = {
    result,
    outcomes,
    commitment: resultCommitment(result, outcomes),
    blockNumber: 11n,
    logIndex: 0,
  };
  const [read] = await reducePublicResultsV3([corrected, f.event], f.ports);
  assert(read.verified);
  assert.equal(read.result.revision, 2);
  assert.equal(read.result.completedAt, f.bundle.result.completedAt);
  assert.equal(qualifiesStudyResult(read, f.policies, read.period), false);
  const invalid = {
    ...corrected,
    result: { ...result, exercisesHash: digest("changed set") },
  };
  invalid.commitment = resultCommitment(invalid.result, invalid.outcomes);
  const [rejected] = await reducePublicResultsV3([f.event, invalid], f.ports);
  assert.equal(rejected.verified, false);
  assert.equal(rejected.result.revision, 2);
  assert(rejected.problems.includes("revision_mismatch"));
  const third = {
    ...invalid,
    result: { ...invalid.result, revision: 3, supersedes: invalid.commitment },
    blockNumber: 12n,
  };
  third.commitment = resultCommitment(third.result, third.outcomes);
  const [brokenChain] = await reducePublicResultsV3(
    [f.event, invalid, third],
    f.ports,
  );
  assert(brokenChain.problems.includes("revision_chain_unverified"));
});

test("missing first passes and invalidation cannot qualify, even with high numeric proportions", async () => {
  const f = fixture();
  const outcomes = packStudyOutcomes(
    unpackStudyOutcomes(f.bundle.outcomes, 4).map((x, i) => ({
      ...x,
      status: i === 0 ? "unmeasured" : "correct",
    })),
  );
  let result = { ...f.bundle.result, status: 2 };
  let event = {
    ...f.event,
    result,
    outcomes,
    commitment: resultCommitment(result, outcomes),
  };
  const [abandoned] = await reducePublicResultsV3([event], f.ports);
  assert(abandoned.verified);
  assert.equal(
    qualifiesStudyResult(abandoned, f.policies, abandoned.period),
    false,
  );
  result = { ...result, status: 1 };
  event = { ...event, result, commitment: resultCommitment(result, outcomes) };
  const [fakeCompleted] = await reducePublicResultsV3([event], f.ports);
  assert.equal(fakeCompleted.verified, false);
  result = {
    ...f.bundle.result,
    status: 5,
    revision: 2,
    supersedes: f.event.commitment,
  };
  const invalidation = {
    ...f.event,
    result,
    blockNumber: 11n,
    commitment: resultCommitment(result, f.bundle.outcomes),
  };
  const [invalidated] = await reducePublicResultsV3(
    [f.event, invalidation],
    f.ports,
  );
  assert.equal(invalidated.verified, false);
  assert.equal(invalidated.result.status, 5);
});

test("the V3 reader keeps Karaoke encoding identical to independent V2 history reconstruction", async () => {
  const f = fixture();
  const manifest = fixtureManifest({
    communityId: f.source.communityId,
    audio: "0x01",
    lyrics: "fixture",
    title: "fixture",
    artwork: "fixture",
    original: true,
  });
  manifest.song = { ...f.bundle.result.song, chainId: 6343 };
  const outcomes = packOutcomes([
    { status: "assessed", scoreBps: 7500 },
    { status: "silent", scoreBps: null },
    { status: "unmeasured", scoreBps: null },
    { status: "unattempted", scoreBps: null },
  ]);
  const result = {
    ...f.bundle.result,
    activity: 1,
    contentRevision: digest(manifest),
    exercisesHash: orderedExercisesHash(4),
    linesTotal: 4,
  };
  const event = {
    ...f.event,
    result,
    outcomes,
    commitment: resultCommitment(result, outcomes),
  };
  const [v3] = await reducePublicResultsV3([event], {
    ...f.ports,
    karaokeManifest: async () => manifest,
    authenticateKaraoke: async () => true,
  });
  const [v2] = await reducePublicResults(
    [event],
    async () => manifest,
    async () => true,
  );
  assert(v3.verified && v2.verified);
  assert.equal(v3.assessment?.activity, 1);
  if (v3.assessment?.activity === 1)
    assert.deepEqual(v3.assessment.lines, v2.lines);
});

test("qualification rejects a changed policy even when the supplied hash matches it", async () => {
  const f = fixture();
  const [read] = await reducePublicResultsV3([f.event], f.ports);
  const weaker = JSON.parse(JSON.stringify(f.policy));
  weaker.minCorrectNumerator = 0;
  const hash = digest(weaker);
  assert.equal(
    qualifiesStudyResult(
      { ...read, result: { ...read.result, qualificationPolicy: hash } },
      new Map([[hash, weaker]]),
      read.period,
    ),
    false,
  );
});
