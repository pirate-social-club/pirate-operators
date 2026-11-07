import test from "node:test";
import assert from "node:assert/strict";
import {
  operatorPlan,
  operatorProfile,
  retainedLimits,
  operatorAccount,
  type OperatorProfile,
} from "../harness/study-operator-profile.ts";
import {
  runOperator,
  type OperatorRunnerPorts,
  type LiveOperator,
} from "../harness/study-operator-runner.ts";
import {
  retainedResultsV2,
  retainedLearningController,
  retainedLearningOperator,
} from "../harness/study-release-profile.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { learningV3PublicityPolicy } from "../services/learning-policy-v3.ts";
const h = (s: string) => "0x" + s.repeat(64),
  now = Date.parse("2026-11-07T08:00:00.000Z");
function fixture(): OperatorProfile {
  return {
    schema: "pirate.study-operator-release/1",
    selection: {
      schema: "pirate.study-release-selection/1",
      chainId: 6343,
      communityId: firstSong.directoryProfile.communityId,
      controller: retainedLearningController,
      resultsV2: structuredClone(retainedResultsV2),
      resultsV3: {
        contract: "0x1111111111111111111111111111111111111111",
        codeHash: h("1") as any,
        publicityPolicy: learningV3PublicityPolicy,
      },
      reviewedUpdate: {
        previousPlanPath:
          "docs/deployments/synthetic-operator-test.application-plan-v18.json",
        previousProfileHash: h("2"),
        expectedExecutionSha256: h("3"),
        expectedResultSha256: h("4"),
      },
    },
    worker: {
      accountId: operatorAccount,
      stack: retainedLearningOperator.worker,
      stage: "testnet",
      logicalId: "Operator",
      name: retainedLearningOperator.worker,
      origin: retainedLearningOperator.origin,
      tag: "a".repeat(32),
    },
    objects: {
      STATE: { className: "ServiceState", namespaceId: "b".repeat(32) },
      SPEECH_BUDGET: { className: "SpeechBudget", namespaceId: "c".repeat(32) },
    },
    artifact: {
      entryPoint: "services/karaoke-audio-runtime.ts",
      sha256: h("5"),
      bytes: 1000,
      sourceHashes: { "services/karaoke-audio-runtime.ts": h("6") },
    },
    predecessor: {
      moduleSha256: h("7"),
      publicSettingsInvariantSha256: h("8"),
      encryptedStateFiles: {
        "pirate-learning-testnet-v2/testnet/Operator.json": h("9"),
      },
      quoteWindowSha256: h("a"),
    },
    retained: {
      limits: structuredClone(retainedLimits),
      quoteValidFrom: Math.floor(now / 1000) - 100,
      quoteValidUntil: Math.floor(now / 1000) + 86400,
      runtimeEvidenceSha256: h("b"),
    },
    custody: {
      record: "/synthetic/private/test-custody.json",
      sha256: h("c"),
      ownerRole: "workspace_coordinator",
      exclusions: ["all legacy operator writers stopped"],
    },
    execution: {
      moduleName: "operator.mjs",
      operatorKeyFileSha256: h("d"),
      runtimeEvidencePath: "/synthetic/private/runtime.json",
      reviewedPlanPath: "/synthetic/private/plan-review.json",
      reviewedPlanSha256: h("e"),
      predecessorFiles: [
        {
          kind: "operator-module",
          path: "/synthetic/private/operator.mjs",
          sha256: h("7"),
        },
      ],
    },
    window: {
      notBefore: new Date(now - 1000).toISOString(),
      deadline: new Date(now + 300000).toISOString(),
    },
  };
}
function setup(profile = fixture()) {
  const calls: string[] = [];
  let existing = "none",
    applied = false,
    failApply = false,
    timestamp = now;
  const live = (): LiveOperator => ({
    workerTag: profile.worker.tag,
    namespaces: structuredClone(profile.objects),
    moduleSha256: applied
      ? profile.artifact.sha256
      : profile.predecessor.moduleSha256,
    publicSettingsInvariantSha256:
      profile.predecessor.publicSettingsInvariantSha256,
    runtimeEvidenceSha256: profile.retained.runtimeEvidenceSha256,
  });
  const note = (name: string) => async () => {
    calls.push(name);
  };
  const ports: OperatorRunnerPorts = {
    verifySourceAndArtifact: note("source"),
    observeContracts: note("contracts"),
    acquireLock: async () => {
      calls.push("lock");
      return note("unlock");
    },
    loadCloudCredential: async () => {
      calls.push("cloud");
      return {};
    },
    observeOperator: async () => {
      calls.push("live");
      return live();
    },
    authenticateRetainedState: note("state"),
    qualifyCustodyAndRuntime: note("custody"),
    existingExecution: async () => {
      calls.push("existing");
      return existing as any;
    },
    preservePredecessor: note("preserve"),
    recordPrepared: async () => {
      calls.push("prepared");
      existing = "prepared";
    },
    recordDispatched: async () => {
      calls.push("dispatched");
      existing = "dispatched";
    },
    loadRuntimeSecrets: async () => {
      calls.push("secrets");
      return {};
    },
    applyOnce: async () => {
      calls.push("apply");
      if (failApply) throw Error("synthetic unknown apply");
      applied = true;
    },
    verifyPreservedSuccessor: note("successor"),
    recordUnknown: async () => {
      calls.push("unknown");
      existing = "unknown";
    },
    recordComplete: async () => {
      calls.push("complete");
      existing = "complete";
    },
    now: () => timestamp,
  };
  return {
    profile,
    ports,
    calls,
    setExisting: (v: string) => (existing = v),
    setApplied: (v: boolean) => (applied = v),
    setFail: (v: boolean) => (failApply = v),
    setTime: (v: number) => (timestamp = v),
  };
}

export { fixture, setup };
