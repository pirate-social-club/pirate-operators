import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeFunctionData } from "viem";
import { studyPublicationFixture } from "./study-publication-fixture.ts";
import { publishManagedStudy } from "../services/study-operator-client.ts";
import { intentOf, txRow } from "../services/operator-tx.ts";
import {
  resultPeriod,
  resultsV3Abi,
} from "../packages/protocol/learning-results-v3.ts";
import {
  STUDY_SCORING_POLICY_V5_HASH,
  type StudyGraderActivation,
} from "../packages/study/grader-revision.ts";
import {
  studyQualificationPolicyV5,
  qualifiesStudyResultV5,
} from "../packages/study/qualification-v5.ts";
import { digest } from "../packages/protocol/index.ts";

test(
  "actual v5 lesson publishes its frozen grader, rejects downgrade and qualifies only under the prospective policy",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixture(19685, { v4: true });
    try {
      const sql = await readFile(
        new URL("../packages/study/grader-v5-migration.sql", import.meta.url),
        "utf8",
      );
      await f.db.batch(
        sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .filter((s) => s.trim())
          .map((s) => f.db.prepare(s)),
      );
      const period = resultPeriod(BigInt(f.clock() / 1000)) + 1n;
      const activation: StudyGraderActivation = {
        schema: "pirate.study-grader-activation/1",
        revision: "script_aware_token_phonetic_v5",
        epochStartS: 1793552400,
        periodSeconds: 86400,
        effectivePeriod: Number(period),
        effectiveAtMs: (1793552400 + Number(period) * 86400) * 1000,
      };
      const policy = studyQualificationPolicyV5([
        f.operatorEnv.OPERATOR_ADDRESS,
      ]);
      await f.evm.write(
        f.v4,
        "LearningResultsV4",
        "activatePolicy",
        [2, digest(policy), "ipfs://local-v5-policy-fixture", period],
        3,
      );
      (
        f.env as typeof f.env & { STUDY_GRADER_ACTIVATION: string }
      ).STUDY_GRADER_ACTIVATION = JSON.stringify(activation);
      f.advance(activation.effectiveAtMs - f.clock() + 1000);
      await f.mineClock();
      // Delay only terminal publication; speech and binding use real handlers.
      const original = f.env.KARAOKE_OPERATOR!;
      f.env.KARAOKE_OPERATOR = {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          if (
            new URL(input instanceof Request ? input.url : String(input))
              .pathname === "/study/terminal"
          )
            throw Error("fixture terminal held");
          return original.fetch(input, init);
        },
      } as Fetcher;
      let lesson = await f.start();
      assert.equal(lesson.graderRevision, "script_aware_token_phonetic_v5");
      const uncounted = await f.answer(lesson, false);
      assert.equal(
        uncounted.attempt.grade?.rerecordReason,
        "low_voice_overlap",
      );
      assert.equal(uncounted.lesson.progress.firstPassGraded, 0);
      lesson = uncounted.lesson;
      while (lesson.status === "active")
        lesson = (await f.answer(lesson, true)).lesson;
      const terminal = await f.terminal(lesson.lessonId);
      await assert.rejects(
        publishManagedStudy(f.operator, {
          ...terminal,
          terminal: {
            ...terminal.terminal,
            schema: "pirate.study-terminal-facts/1",
            graderRevision: undefined,
          },
        }),
        /study_grader_binding_changed/,
      );
      await publishManagedStudy(f.operator, terminal);
      const intent = intentOf(
        f.store,
        "record_result",
        `study:${lesson.lessonId}:1`,
      )!;
      const transaction = txRow(f.store, intent.nonce!)!;
      const decoded = decodeFunctionData({
        abi: resultsV3Abi,
        data: transaction.data,
      });
      assert.equal(decoded.functionName, "publish");
      if (decoded.functionName !== "publish") throw Error("expected publish");
      assert.equal(decoded.args[0].scoringPolicy, STUDY_SCORING_POLICY_V5_HASH);
      const [evidence] = await f.readResults();
      assert.equal(evidence.verified, true, evidence.problems.join(","));
      assert.equal(
        qualifiesStudyResultV5(
          evidence,
          new Map([[digest(policy), policy]]),
          period,
          activation,
        ),
        true,
      );
    } finally {
      await f.dispose();
    }
  },
);
