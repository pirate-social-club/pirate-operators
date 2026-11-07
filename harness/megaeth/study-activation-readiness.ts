// Review is independently supplied, byte-bound and fresh; no secret/provider access.
import { readFileSync } from "node:fs";
import {
  canonical,
  exact,
  hashJson,
  insist,
  object,
} from "../../packages/community/common.ts";
import { privateExistingFile, sha256File } from "./controller-inventory.ts";
import {
  activationPath,
  activationReadinessScope,
  activationWindow,
  type StudyActivationProfile,
} from "./study-activation-plan.ts";
export const activationMigrations = [
  "0009_study.sql",
  "0010_study_retention.sql",
] as const;
export const activationChecks = [
  "compatibleApplicationDeployed",
  "compatibleOperatorDeployed",
  "migrationsApplied",
  "historyAwareReadersDeployed",
  "existingKaraokeV2ReadsPassed",
  "v2RecoveryPreserved",
  "privateHistoryPreserved",
  "freshV3DisclosureAndEnrollmentRequired",
  "sameDurableObjectsAndNativeLedger",
  "speechQuotaZero",
  "noRewardsActivation",
] as const;
export const activationEvidenceKinds = [
  "application",
  "operator",
  "migrations",
  "readers",
  "v2Readback",
  "retention",
] as const;
export function readActivationReadiness(
  p: StudyActivationProfile,
  now: number,
) {
  activationWindow(p, now);
  privateExistingFile(p.readiness.record);
  insist(
    sha256File(p.readiness.record) === p.readiness.sha256,
    "study_activation_readiness_changed",
  );
  const report = object(JSON.parse(readFileSync(p.readiness.record, "utf8")));
  exact(report, [
    "schema",
    "scopeHash",
    "decision",
    "reviewedBy",
    "observedAt",
    "validUntil",
    "release",
    "migrations",
    "checks",
    "evidence",
  ]);
  insist(
    report.schema === "pirate.study-activation-readiness/1" &&
      report.scopeHash === activationReadinessScope(p) &&
      report.decision === "accept-activation" &&
      report.reviewedBy === "independent_reviewer" &&
      canonical(report.release) === canonical(p.release) &&
      canonical(report.migrations) === canonical(activationMigrations),
    "study_activation_readiness_not_accepted",
  );
  insist(
    Date.parse(String(report.observedAt)) >= Date.parse(p.notBefore) &&
      Date.parse(String(report.observedAt)) <= now &&
      Date.parse(String(report.validUntil)) >= Date.parse(p.deadline),
    "study_activation_readiness_stale",
  );
  const checks = object(report.checks);
  exact(checks, [...activationChecks]);
  insist(
    activationChecks.every((k) => checks[k] === true),
    "study_activation_release_gate_missing",
  );
  const evidence = object(report.evidence);
  exact(evidence, [...activationEvidenceKinds]);
  const seen = new Set<string>();
  for (const kind of activationEvidenceKinds) {
    const row = object(evidence[kind]);
    exact(row, ["path", "sha256"]);
    insist(
      activationPath(row.path) &&
        typeof row.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(row.sha256) &&
        !seen.has(row.path),
      "study_activation_evidence_invalid",
    );
    seen.add(row.path);
    privateExistingFile(row.path);
    insist(
      sha256File(row.path) === row.sha256,
      "study_activation_evidence_changed",
    );
  }
  privateExistingFile(p.custody.record);
  insist(
    sha256File(p.custody.record) === p.custody.sha256,
    "study_activation_custody_changed",
  );
  const custody = object(JSON.parse(readFileSync(p.custody.record, "utf8")));
  insist(
    Date.parse(String(custody.expiresAt)) >= Date.parse(p.deadline) &&
      now < Date.parse(String(custody.expiresAt)),
    "study_activation_custody_expired",
  );
  return {
    readinessSha256: p.readiness.sha256,
    evidenceHash: hashJson(evidence),
  };
}
