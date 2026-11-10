import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../packages/protocol/index.ts";
import {
  unpackStudyOutcomes,
  resultPeriod,
} from "../packages/protocol/learning-results-v3.ts";
import {
  completedStudyBundle,
  terminalStudyFacts,
} from "../packages/study/result-adapter.ts";
import { studyFactsBundle } from "../packages/study/terminal-facts.ts";
import {
  studyQualificationPolicyV5,
  qualifiesStudyResultV5,
} from "../packages/study/qualification-v5.ts";
import { studyResultFixture } from "./study-result-fixture.ts";
import type { PublicResultV3 } from "../packages/records/results-v3.ts";
import {
  reviewStudyGraderActivation,
  STUDY_SCORING_POLICY_V5_HASH,
} from "../packages/study/grader-revision.ts";

test("v5 terminal facts bind a new scoring policy while historical bundle bytes remain frozen", () => {
  const f = studyResultFixture();
  const before = structuredClone(f.bundle);
  const input = structuredClone(f.input);
  input.state.graderRevision = "script_aware_token_phonetic_v5";
  const next = completedStudyBundle(input);
  assert.equal(next.result.scoringPolicy, STUDY_SCORING_POLICY_V5_HASH);
  assert.notEqual(next.result.scoringPolicy, before.result.scoringPolicy);
  assert.deepEqual(completedStudyBundle(f.input), before);
  const terminal = terminalStudyFacts(input);
  assert.equal(terminal.schema, "pirate.study-terminal-facts/2");
  const { state, ...binding } = input;
  assert.throws(
    () =>
      studyFactsBundle({
        ...binding,
        terminal: { ...terminal, schema: "pirate.study-terminal-facts/1" },
      }),
    /invalid_study_terminal_facts/,
  );
});

test("v5 qualification is prospective and rejects old grading, wrong period, incomplete and unverified results", () => {
  const f = studyResultFixture();
  f.input.state.graderRevision = "script_aware_token_phonetic_v5";
  const { result, outcomes } = completedStudyBundle(f.input);
  const policy = studyQualificationPolicyV5([result.grader]);
  result.qualificationPolicy = digest(policy);
  const evidence: PublicResultV3 = {
    result,
    commitment: digest("fixture"),
    period: resultPeriod(result.completedAt),
    verified: true,
    problems: [],
    assessment: {
      activity: 2,
      outcomes: unpackStudyOutcomes(outcomes, result.linesTotal),
    },
  };
  const period = evidence.period;
  const activation = {
    schema: "pirate.study-grader-activation/1" as const,
    revision: "script_aware_token_phonetic_v5" as const,
    epochStartS: 1793552400,
    periodSeconds: 86400,
    effectivePeriod: Number(period),
    effectiveAtMs: (1793552400 + Number(period) * 86400) * 1000,
  };
  const policies = new Map([[digest(policy), policy]]);
  assert.equal(
    qualifiesStudyResultV5(evidence, policies, period, activation),
    true,
  );
  assert.throws(
    () => reviewStudyGraderActivation(activation, activation.effectiveAtMs),
    /not_prospective/,
  );
  for (const altered of [
    { ...evidence, verified: false },
    { ...evidence, period: period - 1n },
    {
      ...evidence,
      result: {
        ...result,
        startedAt: BigInt(activation.effectiveAtMs / 1000) - 1n,
      },
    },
    {
      ...evidence,
      result: { ...result, scoringPolicy: f.bundle.result.scoringPolicy },
    },
    { ...evidence, result: { ...result, status: 2 as const } },
    {
      ...evidence,
      assessment: {
        activity: 2 as const,
        outcomes: unpackStudyOutcomes(outcomes, result.linesTotal).map(
          (line, i) =>
            i === 0 ? { ...line, status: "unmeasured" as const } : line,
        ),
      },
    },
  ])
    assert.equal(
      qualifiesStudyResultV5(altered, policies, period, activation),
      false,
    );
});
