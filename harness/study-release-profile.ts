// Public preparation data only. This neither establishes custody nor authorizes a send.
import type { Address, Hex } from "viem";
import { hashJson, insist, object } from "../packages/community/common.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { learningV3PublicityPolicy } from "../services/learning-policy-v3.ts";
import type { ReviewedUpdate } from "./reviewed-update.ts";

export const retainedLearningOperator = {
  worker: "pirate-learning-testnet-v2",
  origin: "https://pirate-learning-testnet-v2.piratesocialclub.workers.dev",
  publisher: "0x14b90a55657d9695a727254eaec5e0e32d20d602",
  issuer: "0xbf85a150114d3df8b90a7793c0ea4b2f4bb8c319",
} as const;
export const retainedResultsV2 = {
  contract: "0xc26d3b5df9e191148424323bb61ee019e432dc74",
  codeHash:
    "0x65d365c9cc7d2c1138c583a5cd272728e40a04b44a0994989655ab5a48f885fe",
} as const;
export const retainedLearningController =
  "0x274f223809f00cbdd51d05de3abc8fd3368fde16" as const;
export interface StudyReleaseSelection {
  schema: "pirate.study-release-selection/1";
  chainId: 6343;
  communityId: Hex;
  controller: Address;
  resultsV2: typeof retainedResultsV2;
  resultsV3: { contract: Address; codeHash: Hex; publicityPolicy: Hex };
  reviewedUpdate: ReviewedUpdate;
}
const exact = (v: Record<string, unknown>, keys: string[]) =>
  insist(
    Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
    "study_release_unknown_or_missing_field",
    409,
  );
const address = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v) && BigInt(v) !== 0n;
const hash = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v) && BigInt(v) !== 0n;

export function studyReleaseSelection(value: unknown): StudyReleaseSelection {
  const p = object(value),
    v2 = object(p.resultsV2),
    v3 = object(p.resultsV3),
    update = object(p.reviewedUpdate);
  exact(p, [
    "schema",
    "chainId",
    "communityId",
    "controller",
    "resultsV2",
    "resultsV3",
    "reviewedUpdate",
  ]);
  exact(v2, ["contract", "codeHash"]);
  exact(v3, ["contract", "codeHash", "publicityPolicy"]);
  exact(update, [
    "previousPlanPath",
    "previousProfileHash",
    "expectedExecutionSha256",
    "expectedResultSha256",
  ]);
  insist(
    p.schema === "pirate.study-release-selection/1" &&
      p.chainId === 6343 &&
      p.communityId === firstSong.directoryProfile.communityId &&
      p.controller === retainedLearningController,
    "study_release_wrong_community",
    409,
  );
  insist(
    v2.contract === retainedResultsV2.contract &&
      v2.codeHash === retainedResultsV2.codeHash &&
      address(v3.contract) &&
      v3.contract !== v2.contract &&
      hash(v3.codeHash) &&
      v3.publicityPolicy === learningV3PublicityPolicy,
    "study_release_wrong_contract_or_disclosure",
    409,
  );
  insist(
    typeof update.previousPlanPath === "string" &&
      /^docs\/deployments\/[a-z0-9][a-z0-9.-]*\.json$/.test(
        update.previousPlanPath,
      ) &&
      [
        update.previousProfileHash,
        update.expectedExecutionSha256,
        update.expectedResultSha256,
      ].every(hash),
    "study_release_invalid_predecessor",
    409,
  );
  return structuredClone(p) as unknown as StudyReleaseSelection;
}

export function studyReleasePlan(value: unknown) {
  const selection = studyReleaseSelection(value);
  return {
    schema: "pirate.study-release-preparation/1",
    selectionHash: hashJson(selection),
    selection,
    executionReady: false,
    operator: {
      ...retainedLearningOperator,
      profile: "pirate-learning-testnet-v3",
      retainedObjects: ["STATE:ServiceState", "SPEECH_BUDGET:SpeechBudget"],
      speechDailyLimit: 0,
    },
    application: {
      origin: firstSong.origin,
      additionalMigrations: ["0009_study.sql", "0010_study_retention.sql"],
      studyContract: selection.resultsV3.contract,
    },
    order: [
      "Complete honest Karaoke acceptance and explicit resource/custody handback.",
      "Review and execute a separately bounded V3 deployment, graders and prospective policies.",
      "Refresh exact source, artifacts, predecessor, inventory and deployment evidence.",
      "Deploy the retained operator with both contract targets and unchanged accounting.",
      "Deploy app, migrations and readers; verify old songs, V2 recovery and versioned disclosure.",
      "Only then activate the directory revision and verify both activities.",
      "Capture ordinary-MOSS/provider acceptance, independent public readback and full costs.",
    ],
    effects: {
      networkRequests: 0,
      privateKeysRead: 0,
      transactions: 0,
      resourceChanges: 0,
    },
  };
}
