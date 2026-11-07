// Pure public preparation. Reviewed nonce numbers are not allocated by planning.
import {
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {
  canonical,
  exact,
  hashJson,
  insist,
  object,
} from "../../packages/community/common.ts";
import { digest } from "../../packages/protocol/index.ts";
import { resultManifestUri } from "../../packages/records/result-manifest.ts";
import { studyQualificationPolicy } from "../../packages/records/study-qualification.ts";
import { learningV3PublicityPolicy } from "../../services/learning-policy-v3.ts";
import { textKey } from "../../packages/protocol/records.ts";
import type { ControllerScope } from "./controller-inventory.ts";
import type { ControllerOperation } from "./controller-dispatch-catalog.ts";
import type { StudyDeploymentArtifact } from "./study-deployment-artifact.ts";

export const studyDeploymentSteps = [
  "deploy",
  "karaoke_grader",
  "study_grader",
  "karaoke_policy",
  "study_policy",
] as const;
export type StudyDeploymentStep = (typeof studyDeploymentSteps)[number];
export interface StudyDeploymentProfile extends ControllerScope {
  schema: "pirate.study-deployment/1";
  chainId: 6343;
  directory: Address;
  directoryCodeHash: Hex;
  registry: Address;
  configurationRevision: string;
  resultsV2: { contract: Address; codeHash: Hex };
  contract: Address;
  grader: Address;
  publicityPolicy: Hex;
  sourceHash: Hex;
  artifactHash: Hex;
  policies: {
    karaoke: { sha256: Hex; uri: string; effectivePeriod: string };
    study: { sha256: Hex; uri: string; effectivePeriod: string };
  };
  gas: Record<StudyDeploymentStep, string>;
  maximumGasPriceWei: string;
  dataFeeReserveWei: string;
  maximumTotalWei: string;
  notBefore: string;
  deadline: string;
}
const positive = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9][0-9]*$/.test(v);
const address = (v: unknown): v is Address =>
  typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v) && BigInt(v) !== 0n;
const hash = (v: unknown): v is Hex =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v) && v !== zeroHash;
export function studyDeploymentPolicies(grader: Address) {
  const karaoke = {
    schema: "pirate.learning-policy/2",
    version: "pirate.karaoke-testnet/2026-11-06/1",
    clockVersion: 1,
    activity: 1,
    graders: [grader.toLowerCase()],
    scoringPolicies: [textKey("karaoke-scoring/5")],
    terminalStatuses: [1, 2, 3, 4],
    minScoreBps: 7000,
    maxUnmeasuredBps: 1000,
    rewards: false,
  };
  const study = studyQualificationPolicy([grader]);
  return Object.fromEntries(
    Object.entries({ karaoke, study }).map(([name, document]) => {
      const sha256 = digest(document);
      return [
        name,
        {
          document,
          bytes: canonical(document),
          sha256,
          uri: resultManifestUri(sha256),
        },
      ];
    }),
  ) as {
    karaoke: {
      document: typeof karaoke;
      bytes: string;
      sha256: Hex;
      uri: string;
    };
    study: { document: typeof study; bytes: string; sha256: Hex; uri: string };
  };
}
export function studyDeploymentPlan(
  profile: StudyDeploymentProfile,
  artifact: StudyDeploymentArtifact,
) {
  exact(object(profile), [
    "schema",
    "chainId",
    "directory",
    "directoryCodeHash",
    "registry",
    "configurationRevision",
    "resultsV2",
    "communityId",
    "controller",
    "contract",
    "grader",
    "publicityPolicy",
    "sourceHash",
    "artifactHash",
    "policies",
    "nonce",
    "gas",
    "maximumGasPriceWei",
    "dataFeeReserveWei",
    "maximumTotalWei",
    "notBefore",
    "deadline",
    "inventory",
    "custody",
  ]);
  insist(
    profile.schema === "pirate.study-deployment/1" && profile.chainId === 6343,
    "study_deployment_wrong_profile",
  );
  insist(
    [
      profile.directory,
      profile.registry,
      profile.resultsV2.contract,
      profile.controller,
      profile.contract,
      profile.grader,
    ].every(address) &&
      [
        profile.directoryCodeHash,
        profile.resultsV2.codeHash,
        profile.communityId,
        profile.sourceHash,
        profile.artifactHash,
      ].every(hash),
    "study_deployment_invalid_identity",
  );
  exact(object(profile.resultsV2), ["contract", "codeHash"]);
  insist(
    profile.contract.toLowerCase() !==
      profile.resultsV2.contract.toLowerCase() &&
      positive(profile.configurationRevision) &&
      BigInt(profile.configurationRevision) <= 0xffffffffffffffffn,
    "study_deployment_wrong_predecessor",
  );
  insist(
    profile.sourceHash === artifact.sourceHash &&
      profile.artifactHash === hashJson(artifact) &&
      profile.publicityPolicy === learningV3PublicityPolicy,
    "study_deployment_source_or_publicity_changed",
  );
  insist(
    Number.isSafeInteger(profile.nonce) &&
      profile.nonce >= 0 &&
      Number.isSafeInteger(profile.nonce + 4) &&
      getContractAddress({
        from: profile.controller,
        nonce: BigInt(profile.nonce),
      }).toLowerCase() === profile.contract.toLowerCase(),
    "study_deployment_address_or_nonce_changed",
  );
  exact(object(profile.gas), [...studyDeploymentSteps]);
  insist(
    [
      ...Object.values(profile.gas),
      profile.maximumGasPriceWei,
      profile.dataFeeReserveWei,
      profile.maximumTotalWei,
    ].every(positive),
    "study_deployment_invalid_bounds",
  );
  const maximumFeeWei = Object.values(profile.gas).reduce(
    (sum, gas) =>
      sum +
      BigInt(gas) * BigInt(profile.maximumGasPriceWei) +
      BigInt(profile.dataFeeReserveWei),
    0n,
  );
  insist(
    maximumFeeWei <= BigInt(profile.maximumTotalWei),
    "study_deployment_aggregate_cap",
  );
  const start = Date.parse(profile.notBefore),
    end = Date.parse(profile.deadline);
  insist(
    Number.isFinite(start) &&
      Number.isFinite(end) &&
      new Date(start).toISOString() === profile.notBefore &&
      new Date(end).toISOString() === profile.deadline &&
      end > start &&
      end - start <= 900000,
    "study_deployment_invalid_window",
  );
  insist(
    Array.isArray(profile.inventory) &&
      profile.inventory.length > 0 &&
      profile.inventory.length <= 64 &&
      new Set(profile.inventory.map((row) => row.path)).size ===
        profile.inventory.length,
    "study_deployment_inventory_required",
  );
  for (const row of profile.inventory) {
    exact(object(row), ["path", "sha256", "format"]);
    insist(
      row.path.startsWith("/") &&
        /^[0-9a-f]{64}$/.test(row.sha256) &&
        [
          "deployment-journal-v1",
          "deploy-results-v2-custom",
          "activation-journal",
        ].includes(row.format),
      "study_deployment_inventory_invalid",
    );
  }
  exact(object(profile.custody), [
    "record",
    "sha256",
    "ownerRole",
    "exclusions",
  ]);
  insist(
    profile.custody.ownerRole === "workspace_coordinator" &&
      profile.custody.record.startsWith("/") &&
      /^[0-9a-f]{64}$/.test(profile.custody.sha256) &&
      Array.isArray(profile.custody.exclusions) &&
      profile.custody.exclusions.length > 0 &&
      profile.custody.exclusions.every(
        (v) => typeof v === "string" && v.trim(),
      ),
    "study_deployment_custody_required",
  );
  const policies = studyDeploymentPolicies(profile.grader);
  exact(object(profile.policies), ["karaoke", "study"]);
  for (const name of ["karaoke", "study"] as const) {
    const selected = profile.policies[name];
    exact(object(selected), ["sha256", "uri", "effectivePeriod"]);
    insist(
      selected.sha256 === policies[name].sha256 &&
        selected.uri === policies[name].uri &&
        positive(selected.effectivePeriod) &&
        BigInt(selected.effectivePeriod) <= 0xffffffffffffffffn,
      "study_deployment_policy_changed",
    );
  }
  const data = [
    encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [profile.controller, profile.communityId, profile.publicityPolicy],
    }),
    ...([1, 2] as const).map((activity) =>
      encodeFunctionData({
        abi: artifact.abi,
        functionName: "setGrader",
        args: [profile.grader, activity, true],
      }),
    ),
    ...(["karaoke", "study"] as const).map((name, index) =>
      encodeFunctionData({
        abi: artifact.abi,
        functionName: "activatePolicy",
        args: [
          index + 1,
          profile.policies[name].sha256,
          profile.policies[name].uri,
          BigInt(profile.policies[name].effectivePeriod),
        ],
      }),
    ),
  ];
  const profileHash = hashJson(profile);
  const operations = studyDeploymentSteps.map((step, index) => ({
    step,
    profileHash: hashJson({ profileHash, step }),
    nonce: profile.nonce + index,
    controller: profile.controller,
    contractAddress: profile.contract,
    journalKey: "deployment" as const,
    ...(index ? { to: profile.contract } : {}),
    data: data[index],
    gas: profile.gas[step],
    maximumGasPriceWei: profile.maximumGasPriceWei,
    maximumFeeWei: (
      BigInt(profile.gas[step]) * BigInt(profile.maximumGasPriceWei) +
      BigInt(profile.dataFeeReserveWei)
    ).toString(),
  }));
  return {
    profileHash,
    contract: profile.contract,
    maximumFeeWei: maximumFeeWei.toString(),
    policies,
    operations,
    executionReady: false as const,
    effects: {
      networkRequests: 0,
      keysRead: 0,
      stateWrites: 0,
      transactions: 0,
    },
  };
}
export type StudyDeploymentOperation = ReturnType<
  typeof studyDeploymentPlan
>["operations"][number] &
  ControllerOperation;
export function studyDeploymentWindow(
  profile: StudyDeploymentProfile,
  now: number,
) {
  insist(
    now >= Date.parse(profile.notBefore) && now < Date.parse(profile.deadline),
    "study_deployment_window_closed",
  );
}
