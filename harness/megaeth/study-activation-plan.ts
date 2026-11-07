// One exact revision-three to revision-four transition. Public preparation only.
import { encodeFunctionData, type Hex } from "viem";
import {
  canonical,
  exact,
  hashJson,
  insist,
  object,
} from "../../packages/community/common.ts";
import {
  validateConfig,
  type CommunityConfig,
} from "../../packages/community/config-manifest.ts";
import { preparePin, type PinIntent } from "../../packages/community/ipfs.ts";
import { firstSong } from "../../services/first-song-profile.ts";
import {
  retainedResultsV2,
  retainedLearningOperator,
} from "../study-release-profile.ts";
import { configureAbi } from "./curated-configuration-plan.ts";
import { studyDeploymentPolicies } from "./study-deployment-plan.ts";
import type { StudyDeploymentArtifact } from "./study-deployment-artifact.ts";
import type { ControllerScope } from "./controller-inventory.ts";
export interface StudyActivationProfile extends ControllerScope {
  schema: "pirate.study-activation/1";
  chainId: 6343;
  history: CommunityConfig[];
  historyHashes: Hex[];
  manifestSha256: Hex;
  pin: PinIntent;
  contract: Hex;
  codeHash: Hex;
  artifactHash: Hex;
  sourceHash: Hex;
  policies: {
    karaoke: { sha256: Hex; uri: string; effectivePeriod: string };
    study: { sha256: Hex; uri: string; effectivePeriod: string };
  };
  release: {
    applicationProfile: Hex;
    applicationModule: Hex;
    operatorProfile: Hex;
    operatorModule: Hex;
    operatorTag: string;
    stateNamespace: string;
    speechNamespace: string;
    readerSourceHash: Hex;
  };
  readiness: { record: string; sha256: string };
  gas: string;
  maximumGasPriceWei: string;
  dataFeeReserveWei: string;
  maximumTotalWei: string;
  notBefore: string;
  deadline: string;
}
export const studyActivationPeriod = "6";
export const activationHash = (v: unknown): v is Hex =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v) && BigInt(v) !== 0n;
export const activationPath = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("/") && !v.split("/").includes("..");
const decimal = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9][0-9]*$/.test(v);
export function activationWindow(p: StudyActivationProfile, now: number) {
  insist(
    now >= Date.parse(p.notBefore) && now < Date.parse(p.deadline),
    "study_activation_window_closed",
  );
}
/** Omit only evidence-reference digests to avoid report/custody hash cycles. */
export function activationReadinessScope(p: StudyActivationProfile) {
  const { readiness, custody, ...rest } = p;
  return hashJson({
    ...rest,
    custody: { ownerRole: custody.ownerRole, exclusions: custody.exclusions },
  });
}
export async function studyActivationPlan(
  p: StudyActivationProfile,
  artifact: StudyDeploymentArtifact,
  sourceHash: Hex,
) {
  exact(object(p), [
    "schema",
    "chainId",
    "communityId",
    "controller",
    "nonce",
    "inventory",
    "custody",
    "history",
    "historyHashes",
    "manifestSha256",
    "pin",
    "contract",
    "codeHash",
    "artifactHash",
    "sourceHash",
    "policies",
    "release",
    "readiness",
    "gas",
    "maximumGasPriceWei",
    "dataFeeReserveWei",
    "maximumTotalWei",
    "notBefore",
    "deadline",
  ]);
  insist(
    p.schema === "pirate.study-activation/1" &&
      p.chainId === 6343 &&
      p.communityId === firstSong.directoryProfile.communityId,
    "study_activation_wrong_community",
  );
  insist(
    Array.isArray(p.history) &&
      p.history.length === 3 &&
      Array.isArray(p.historyHashes) &&
      p.historyHashes.length === 3,
    "study_activation_history_required",
  );
  const history: CommunityConfig[] = [];
  for (const [i, raw] of p.history.entries()) {
    const config = validateConfig(raw, history);
    insist(
      canonical(config) === canonical(raw) &&
        hashJson(config) === p.historyHashes[i],
      "study_activation_history_changed",
    );
    history.push(config);
  }
  const before = history[2]!;
  insist(
    before.configurationRevision === 3 &&
      before.chainId === 6343 &&
      before.directory === firstSong.directoryProfile.directory &&
      before.registry === firstSong.directoryProfile.registry &&
      before.communityId === p.communityId &&
      before.postsContract === firstSong.posts.address &&
      before.app.origin === firstSong.origin &&
      before.controller.toLowerCase() === p.controller.toLowerCase() &&
      before.learningRecords === retainedResultsV2.contract,
    "study_activation_wrong_predecessor",
  );
  insist(
    /^0x[0-9a-f]{40}$/i.test(p.contract) &&
      BigInt(p.contract) !== 0n &&
      p.contract.toLowerCase() !== retainedResultsV2.contract,
    "study_activation_wrong_v3",
  );
  insist(
    activationHash(p.codeHash) &&
      activationHash(p.sourceHash) &&
      p.sourceHash === sourceHash &&
      p.artifactHash === hashJson(artifact),
    "study_activation_source_changed",
  );
  const manifest = validateConfig(
    {
      ...before,
      configurationRevision: 4,
      learningRecords: p.contract.toLowerCase(),
    },
    history,
  );
  const bytes = new TextEncoder().encode(canonical(manifest)),
    pin = await preparePin(bytes, "application/json");
  insist(
    p.manifestSha256 === hashJson(manifest) &&
      canonical(p.pin) === canonical(pin),
    "study_activation_manifest_or_pin_changed",
  );
  insist(
    Number.isSafeInteger(p.nonce) && p.nonce >= 0,
    "study_activation_nonce_invalid",
  );
  insist(
    [p.gas, p.maximumGasPriceWei, p.dataFeeReserveWei, p.maximumTotalWei].every(
      decimal,
    ) &&
      BigInt(p.gas) <= 1500000n &&
      BigInt(p.maximumGasPriceWei) <= 1000000n &&
      BigInt(p.dataFeeReserveWei) <= 100000000000n,
    "study_activation_bounds_invalid",
  );
  const maximumFeeWei =
    BigInt(p.gas) * BigInt(p.maximumGasPriceWei) + BigInt(p.dataFeeReserveWei);
  insist(
    maximumFeeWei <= BigInt(p.maximumTotalWei) &&
      BigInt(p.maximumTotalWei) <= 500000000000000n,
    "study_activation_aggregate_cap",
  );
  const start = Date.parse(p.notBefore),
    end = Date.parse(p.deadline);
  insist(
    Number.isFinite(start) &&
      Number.isFinite(end) &&
      new Date(start).toISOString() === p.notBefore &&
      new Date(end).toISOString() === p.deadline &&
      end > start &&
      end - start <= 900000,
    "study_activation_window_invalid",
  );
  insist(
    Array.isArray(p.inventory) &&
      p.inventory.length > 0 &&
      p.inventory.length <= 64 &&
      new Set(p.inventory.map((x) => x.path)).size === p.inventory.length,
    "study_activation_inventory_required",
  );
  for (const row of p.inventory) {
    exact(object(row), ["path", "sha256", "format"]);
    insist(
      activationPath(row.path) &&
        /^[0-9a-f]{64}$/.test(row.sha256) &&
        [
          "deployment-journal-v1",
          "deploy-results-v2-custom",
          "activation-journal",
        ].includes(row.format),
      "study_activation_inventory_invalid",
    );
  }
  exact(object(p.custody), ["record", "sha256", "ownerRole", "exclusions"]);
  insist(
    activationPath(p.custody.record) &&
      /^[0-9a-f]{64}$/.test(p.custody.sha256) &&
      p.custody.ownerRole === "workspace_coordinator" &&
      Array.isArray(p.custody.exclusions) &&
      p.custody.exclusions.length > 0 &&
      p.custody.exclusions.every((x) => typeof x === "string" && x.trim()),
    "study_activation_custody_required",
  );
  exact(object(p.readiness), ["record", "sha256"]);
  insist(
    activationPath(p.readiness.record) &&
      /^[0-9a-f]{64}$/.test(p.readiness.sha256),
    "study_activation_readiness_required",
  );
  exact(object(p.release), [
    "applicationProfile",
    "applicationModule",
    "operatorProfile",
    "operatorModule",
    "operatorTag",
    "stateNamespace",
    "speechNamespace",
    "readerSourceHash",
  ]);
  insist(
    [
      p.release.applicationProfile,
      p.release.applicationModule,
      p.release.operatorProfile,
      p.release.operatorModule,
      p.release.readerSourceHash,
    ].every(activationHash) &&
      [
        p.release.operatorTag,
        p.release.stateNamespace,
        p.release.speechNamespace,
      ].every((x) => /^[0-9a-f]{32}$/.test(x)) &&
      p.release.stateNamespace !== p.release.speechNamespace,
    "study_activation_release_identity_invalid",
  );
  const policies = studyDeploymentPolicies(retainedLearningOperator.publisher);
  exact(object(p.policies), ["karaoke", "study"]);
  for (const name of ["karaoke", "study"] as const) {
    const selected = p.policies[name];
    exact(object(selected), ["sha256", "uri", "effectivePeriod"]);
    insist(
      selected.sha256 === policies[name].sha256 &&
        selected.uri === policies[name].uri &&
        selected.effectivePeriod === studyActivationPeriod &&
        BigInt(selected.effectivePeriod) <= 0xffffffffffffffffn,
      "study_activation_policy_changed",
    );
  }
  const profileHash = hashJson(p);
  return {
    profileHash,
    history,
    before,
    manifest,
    bytes,
    pin,
    policies,
    operation: {
      profileHash,
      step: "configure" as const,
      controller: p.controller,
      nonce: p.nonce,
      journalKey: "deployment" as const,
      to: before.directory,
      contractAddress: p.contract,
      data: encodeFunctionData({
        abi: configureAbi,
        functionName: "configure",
        args: [
          p.communityId,
          3n,
          {
            controller: manifest.controller,
            publisher: manifest.publisher,
            operatorPayments: manifest.operatorPayments,
            learningRecords: manifest.learningRecords,
            sha256Digest: pin.sha256,
            uri: pin.uri,
          },
        ],
      }),
      gas: p.gas,
      maximumGasPriceWei: p.maximumGasPriceWei,
      maximumFeeWei: maximumFeeWei.toString(),
    },
    executionReady: false as const,
    effects: {
      networkRequests: 0,
      keysRead: 0,
      stateWrites: 0,
      pinAdds: 0,
      transactions: 0,
    },
  };
}
export type StudyActivationPlan = Awaited<
  ReturnType<typeof studyActivationPlan>
>;
export type StudyActivationOperation = StudyActivationPlan["operation"];
