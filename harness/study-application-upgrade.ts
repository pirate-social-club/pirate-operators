import { canonical, insist, object } from "../packages/community/common.ts";
import { learningV3PublicityPolicy } from "../services/learning-policy-v3.ts";
import {
  retainedLearningOperator,
  retainedResultsV2,
} from "./study-release-profile.ts";

/** An explicit functional successor; the historical migration-8/quota-10 gate stays intact. */
export function assertStudyApplicationUpgrade(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  const changed = new Set([
    "sourceHashes",
    "bundleSha256",
    "bundleBytes",
    "assets",
    "migrations",
    "learning",
    "acceptance",
    "reviewedUpdate",
  ]);
  const fixed = (p: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(p).filter(([k]) => !changed.has(k)));
  insist(
    canonical(fixed(previous)) === canonical(fixed(next)),
    "study_upgrade_unrelated_intent_changed",
    409,
  );
  insist(
    previous.learning &&
      next.learning &&
      typeof previous.learning === "object" &&
      typeof next.learning === "object",
    "study_upgrade_learning_missing",
    409,
  );
  const old = object(previous.learning),
    learning = object(next.learning);
  insist(
    old.chainId === 6343 &&
      old.contract === retainedResultsV2.contract &&
      old.operator === retainedLearningOperator.publisher &&
      old.issuer === retainedLearningOperator.issuer &&
      old.operatorWorker === retainedLearningOperator.worker &&
      old.operatorOrigin === retainedLearningOperator.origin &&
      old.accounting === "internal" &&
      old.speechDailyCalls === 0 &&
      old.historyRetentionDays === 30,
    "study_upgrade_previous_learning_unqualified",
    409,
  );
  const address = learning.studyContract;
  insist(
    typeof address === "string" &&
      /^0x[0-9a-f]{40}$/.test(address) &&
      BigInt(address) !== 0n &&
      address !== old.contract &&
      typeof learning.studyCodeHash === "string" &&
      /^0x[0-9a-f]{64}$/.test(learning.studyCodeHash) &&
      BigInt(learning.studyCodeHash) !== 0n &&
      learning.publicityPolicy === learningV3PublicityPolicy &&
      learning.operatorProfile === "pirate-learning-testnet-v3" &&
      typeof learning.acceptance === "string" &&
      learning.acceptance.length > 0 &&
      next.acceptance === learning.acceptance,
    "study_upgrade_target_unqualified",
    409,
  );
  const expected = {
    ...old,
    operatorProfile: "pirate-learning-testnet-v3",
    studyContract: address,
    studyCodeHash: learning.studyCodeHash,
    publicityPolicy: learningV3PublicityPolicy,
    acceptance: learning.acceptance,
  };
  insist(
    canonical(learning) === canonical(expected),
    "study_upgrade_learning_intent_changed",
    409,
  );
  if (old.studyContract)
    insist(
      old.studyContract === address &&
        old.studyCodeHash === learning.studyCodeHash &&
        old.publicityPolicy === learning.publicityPolicy,
      "study_upgrade_target_changed",
      409,
    );
  const migrations = previous.migrations;
  insist(
    Array.isArray(migrations) &&
      migrations.every((p) => typeof p === "string") &&
      new Set(migrations).size === migrations.length &&
      migrations.at(-1) ===
        (old.studyContract ? "0010_study_retention.sql" : "0008_karaoke.sql") &&
      (old.studyContract ||
        !migrations.some(
          (p) => p.startsWith("0009_") || p.startsWith("0010_"),
        )),
    "study_upgrade_previous_migrations_unqualified",
    409,
  );
  insist(
    canonical(next.migrations) ===
      canonical(
        old.studyContract
          ? migrations
          : [...migrations, "0009_study.sql", "0010_study_retention.sql"],
      ),
    "study_upgrade_migrations_changed",
    409,
  );
}
