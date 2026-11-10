// Draft public metadata only. No private file, network, credential or write API.
import {
  canonical,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import {
  studyReleaseSelection,
  type StudyReleaseSelection,
  retainedLearningOperator,
} from "./study-release-profile.ts";
import {
  learningV4ReleaseSelection,
  type LearningV4ReleaseSelection,
} from "./learning-v4-release-profile.ts";
import { firstSong } from "../services/first-song-profile.ts";
export const operatorAccount = "08a4c22cf52e2ecae883e36f80a33f4a";
export const retainedLimits = {
  serviceMode: "internal",
  sponsorCapWei: "500000000000000",
  gasPriceWei: "1000000",
  gasLimit: "1500000",
  dataFeeWei: "100000000000",
  speechDailyLimit: 0,
  historyRetentionDays: 30,
} as const;
export interface OperatorProfile {
  schema: "pirate.study-operator-release/1";
  selection: StudyReleaseSelection;
  learningV4?: LearningV4ReleaseSelection;
  /** One sponsored pilot account, replaced only with a distinct V4 runtime. */
  activationAccount?: { previous: string; next: string };
  worker: {
    accountId: string;
    stack: string;
    stage: "testnet";
    logicalId: "Operator";
    name: string;
    origin: string;
    tag: string;
  };
  objects: {
    STATE: { className: "ServiceState"; namespaceId: string };
    SPEECH_BUDGET: { className: "SpeechBudget"; namespaceId: string };
  };
  artifact: {
    entryPoint: "services/karaoke-audio-runtime.ts";
    sha256: string;
    bytes: number;
    sourceHashes: Record<string, string>;
  };
  predecessor: {
    /** Historical profiles omit this and retain the original V2 boundary. */
    resultsVersion?: 2 | 3;
    moduleSha256: string;
    publicSettingsInvariantSha256: string;
    encryptedStateFiles: Record<string, string>;
    quoteWindowSha256: string;
  };
  retained: {
    limits: typeof retainedLimits;
    quoteValidFrom: number;
    quoteValidUntil: number;
    runtimeEvidenceSha256: string;
  };
  custody: {
    record: string;
    sha256: string;
    ownerRole: "workspace_coordinator";
    exclusions: string[];
  };
  window: { notBefore: string; deadline: string };
  execution: {
    moduleName: string;
    operatorKeyFileSha256: string;
    runtimeEvidencePath: string;
    reviewedPlanPath: string | null;
    reviewedPlanSha256: string | null;
    predecessorFiles: {
      kind: "operator-module" | "alchemy-source";
      path: string;
      sha256: string;
    }[];
  };
}
const hash = (x: unknown): x is string =>
  typeof x === "string" && /^0x[0-9a-f]{64}$/.test(x) && BigInt(x) !== 0n;
const id = (x: unknown): x is string =>
  typeof x === "string" && /^[0-9a-f]{32}$/.test(x);
function exact(value: Record<string, unknown>, keys: string[]) {
  insist(
    Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
    "study_operator_profile_fields",
    409,
  );
}
export function operatorProfile(value: unknown): OperatorProfile {
  const p = object(value),
    w = object(p.worker),
    objects = object(p.objects),
    a = object(p.artifact),
    previous = object(p.predecessor),
    retained = object(p.retained),
    custody = object(p.custody),
    window = object(p.window),
    execution = object(p.execution);
  exact(p, [
    "schema",
    "selection",
    "worker",
    "objects",
    "artifact",
    "predecessor",
    "retained",
    "custody",
    "window",
    "execution",
    ...(Object.hasOwn(p, "learningV4") ? ["learningV4"] : []),
    ...(Object.hasOwn(p, "activationAccount") ? ["activationAccount"] : []),
  ]);
  exact(w, [
    "accountId",
    "stack",
    "stage",
    "logicalId",
    "name",
    "origin",
    "tag",
  ]);
  exact(objects, ["STATE", "SPEECH_BUDGET"]);
  exact(a, ["entryPoint", "sha256", "bytes", "sourceHashes"]);
  exact(previous, [
    "moduleSha256",
    "publicSettingsInvariantSha256",
    "encryptedStateFiles",
    "quoteWindowSha256",
    ...(Object.hasOwn(previous, "resultsVersion") ? ["resultsVersion"] : []),
  ]);
  insist(
    !Object.hasOwn(previous, "resultsVersion") ||
      previous.resultsVersion === 2 ||
      previous.resultsVersion === 3,
    "study_operator_predecessor_version_invalid",
    409,
  );
  exact(retained, [
    "limits",
    "quoteValidFrom",
    "quoteValidUntil",
    "runtimeEvidenceSha256",
  ]);
  exact(custody, ["record", "sha256", "ownerRole", "exclusions"]);
  exact(window, ["notBefore", "deadline"]);
  exact(execution, [
    "moduleName",
    "operatorKeyFileSha256",
    "runtimeEvidencePath",
    "reviewedPlanPath",
    "reviewedPlanSha256",
    "predecessorFiles",
  ]);
  const absolute = (v: unknown) =>
    typeof v === "string" && v.startsWith("/") && !v.split("/").includes("..");
  insist(
    typeof execution.moduleName === "string" &&
      /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(execution.moduleName) &&
      hash(execution.operatorKeyFileSha256) &&
      absolute(execution.runtimeEvidencePath) &&
      ((execution.reviewedPlanPath === null &&
        execution.reviewedPlanSha256 === null) ||
        (absolute(execution.reviewedPlanPath) &&
          hash(execution.reviewedPlanSha256))),
    "study_operator_execution_inputs_invalid",
    409,
  );
  insist(
    Array.isArray(execution.predecessorFiles) &&
      execution.predecessorFiles.length > 0 &&
      execution.predecessorFiles.length <= 32,
    "study_operator_predecessor_source_missing",
    409,
  );
  let modules = 0;
  for (const item of execution.predecessorFiles) {
    const row = object(item);
    exact(row, ["kind", "path", "sha256"]);
    insist(
      ["operator-module", "alchemy-source"].includes(String(row.kind)) &&
        absolute(row.path) &&
        /\.(ts|mjs)$/.test(String(row.path)) &&
        !String(row.path).includes("/.config/") &&
        hash(row.sha256),
      "study_operator_predecessor_source_invalid",
      409,
    );
    if (row.kind === "operator-module") {
      modules++;
      insist(
        row.sha256 === previous.moduleSha256,
        "study_operator_predecessor_artifact_changed",
        409,
      );
    }
  }
  insist(modules === 1, "study_operator_predecessor_module_missing", 409);
  studyReleaseSelection(p.selection);
  if (p.learningV4 !== undefined) {
    const v4 = learningV4ReleaseSelection(p.learningV4);
    const selection = studyReleaseSelection(p.selection);
    insist(
      v4.controller === selection.controller &&
        v4.communityOrigin === firstSong.origin &&
        v4.contract !== selection.resultsV2.contract &&
        v4.contract !== selection.resultsV3.contract,
      "study_operator_v4_selection_changed",
      409,
    );
  }
  if (p.activationAccount !== undefined) {
    const selected = object(p.activationAccount);
    exact(selected, ["previous", "next"]);
    insist(
      p.learningV4 &&
        previous.moduleSha256 !== a.sha256 &&
        [selected.previous, selected.next].every(
          (v) =>
            typeof v === "string" &&
            /^0x[0-9a-f]{40}$/.test(v) &&
            BigInt(v) !== 0n,
        ) &&
        selected.previous !== selected.next,
      "study_operator_activation_selection_invalid",
      409,
    );
  }
  insist(
    p.schema === "pirate.study-operator-release/1" &&
      w.accountId === operatorAccount &&
      w.stack === retainedLearningOperator.worker &&
      w.stage === "testnet" &&
      w.logicalId === "Operator" &&
      w.name === retainedLearningOperator.worker &&
      w.origin === retainedLearningOperator.origin &&
      id(w.tag),
    "study_operator_wrong_physical_target",
    409,
  );
  for (const [name, className] of [
    ["STATE", "ServiceState"],
    ["SPEECH_BUDGET", "SpeechBudget"],
  ]) {
    const item = object(objects[name!]);
    exact(item, ["className", "namespaceId"]);
    insist(
      item.className === className && id(item.namespaceId),
      "study_operator_namespace_changed",
      409,
    );
  }
  insist(
    object(objects.STATE).namespaceId !==
      object(objects.SPEECH_BUDGET).namespaceId,
    "study_operator_namespace_alias",
    409,
  );
  insist(
    a.entryPoint === "services/karaoke-audio-runtime.ts" &&
      hash(a.sha256) &&
      Number.isSafeInteger(a.bytes) &&
      Number(a.bytes) > 0 &&
      Number(a.bytes) <= 16 * 1024 * 1024,
    "study_operator_artifact_invalid",
    409,
  );
  const sources = object(a.sourceHashes),
    states = object(previous.encryptedStateFiles);
  insist(
    Object.keys(sources).length > 0 &&
      Object.keys(sources).length <= 1024 &&
      Object.entries(sources).every(
        ([path, digest]) =>
          /^(?:(?:packages|services|harness|apps)\/[a-zA-Z0-9._/-]+\.(?:ts|json)|(?:apps\/community-wizard\/)?package(?:-lock)?\.json)$/.test(
            path,
          ) &&
          !path.split("/").includes("..") &&
          hash(digest),
      ),
    "study_operator_source_inventory_invalid",
    409,
  );
  insist(
    Object.hasOwn(sources, a.entryPoint as string),
    "study_operator_entrypoint_unbound",
    409,
  );
  insist(
    Object.keys(states).length > 0 &&
      Object.keys(states).length <= 128 &&
      Object.entries(states).every(
        ([path, digest]) =>
          /^pirate-learning-testnet-v2\/testnet\/[a-zA-Z0-9._/-]+\.json$/.test(
            path,
          ) &&
          !path.split("/").includes("..") &&
          hash(digest),
      ),
    "study_operator_state_inventory_invalid",
    409,
  );
  insist(
    Object.hasOwn(states, "pirate-learning-testnet-v2/testnet/Operator.json"),
    "study_operator_worker_state_missing",
    409,
  );
  insist(
    [
      previous.moduleSha256,
      previous.publicSettingsInvariantSha256,
      previous.quoteWindowSha256,
      retained.runtimeEvidenceSha256,
    ].every(hash),
    "study_operator_predecessor_invalid",
    409,
  );
  insist(
    canonical(retained.limits) === canonical(retainedLimits),
    "study_operator_limits_changed",
    409,
  );
  insist(
    Number.isSafeInteger(retained.quoteValidFrom) &&
      Number.isSafeInteger(retained.quoteValidUntil) &&
      Number(retained.quoteValidFrom) > 0 &&
      Number(retained.quoteValidUntil) > Number(retained.quoteValidFrom),
    "study_operator_quote_invalid",
    409,
  );
  insist(
    typeof custody.record === "string" &&
      custody.record.startsWith("/") &&
      !custody.record.split("/").includes("..") &&
      hash(custody.sha256) &&
      custody.ownerRole === "workspace_coordinator" &&
      Array.isArray(custody.exclusions) &&
      custody.exclusions.length > 0 &&
      custody.exclusions.length <= 64 &&
      custody.exclusions.every(
        (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 256,
      ),
    "study_operator_custody_invalid",
    409,
  );
  const start = Date.parse(String(window.notBefore)),
    end = Date.parse(String(window.deadline));
  insist(
    typeof window.notBefore === "string" &&
      typeof window.deadline === "string" &&
      window.notBefore.endsWith("Z") &&
      window.deadline.endsWith("Z") &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start &&
      end - start <= 900000,
    "study_operator_window_invalid",
    409,
  );
  return structuredClone(p) as unknown as OperatorProfile;
}
export function operatorPlan(value: unknown) {
  const profile = operatorProfile(value);
  return {
    schema: "pirate.study-operator-preparation/1",
    profileHash: hashJson(profile),
    profile,
    executionReady: false,
    changes: {
      operatorProfile: "pirate-learning-testnet-v3",
      resultsV2: profile.selection.resultsV2.contract,
      resultsV3: profile.selection.resultsV3.contract,
      ...(profile.learningV4 ? { resultsV4: profile.learningV4.contract } : {}),
    },
    preserved: {
      worker: profile.worker,
      objects: profile.objects,
      limits: profile.retained.limits,
    },
    effects: {
      networkRequests: 0,
      privateKeysRead: 0,
      transactions: 0,
      resourceChanges: 0,
    },
  };
}
