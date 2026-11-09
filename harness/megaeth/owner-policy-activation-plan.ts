// One exact revision-four to revision-five transition naming the unregistered
// owner policy. Public preparation only: no client, key, secret or state.
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
import {
  OWNER_POLICY_HASH,
  OWNER_POLICY_VERSION,
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../../packages/community/owner-policy.ts";
import { firstSong } from "../../services/first-song-profile.ts";
import { configureAbi } from "./curated-configuration-plan.ts";
import type { ControllerScope } from "./controller-inventory.ts";
import type { ActivationOperation } from "./configure-activation.ts";

export interface OwnerPolicyActivationProfile extends ControllerScope {
  schema: "pirate.owner-policy-activation/1";
  chainId: 6343;
  /** Revisions one to four exactly as published, oldest first. */
  history: CommunityConfig[];
  historyHashes: Hex[];
  manifestSha256: Hex;
  pin: PinIntent;
  sourceHash: Hex;
  /** The deployed readers and owner selection this activation depends on. */
  release: {
    applicationProfile: Hex;
    applicationModule: Hex;
    managedProfile: Hex;
    managedModule: Hex;
    selectionSha256: Hex;
  };
  readiness: { record: string; sha256: string };
  gas: string;
  maximumGasPriceWei: string;
  dataFeeReserveWei: string;
  maximumTotalWei: string;
  notBefore: string;
  deadline: string;
}
const hash = (v: unknown): v is Hex =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v) && BigInt(v) !== 0n;
export const ownerActivationPath = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("/") && !v.split("/").includes("..");
const decimal = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9][0-9]*$/.test(v);
export function ownerActivationWindow(
  p: OwnerPolicyActivationProfile,
  now: number,
) {
  insist(
    now >= Date.parse(p.notBefore) && now < Date.parse(p.deadline),
    "owner_policy_activation_window_closed",
  );
}
/** Omits only the evidence digests, to avoid report/custody hash cycles. */
export function ownerActivationReadinessScope(p: OwnerPolicyActivationProfile) {
  const { readiness, custody, ...rest } = p;
  return hashJson({
    ...rest,
    custody: { ownerRole: custody.ownerRole, exclusions: custody.exclusions },
  });
}
/** The successor manifest: only the revision and the admission policy change. */
export function ownerPolicySuccessor(before: CommunityConfig) {
  return {
    ...before,
    configurationRevision: 5,
    policies: {
      ...before.policies,
      admission: {
        version: UNREGISTERED_OWNER_POLICY_VERSION,
        sha256: UNREGISTERED_OWNER_POLICY_HASH,
      },
    },
  };
}
export async function ownerPolicyActivationPlan(
  p: OwnerPolicyActivationProfile,
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
    "sourceHash",
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
    p.schema === "pirate.owner-policy-activation/1" &&
      p.chainId === 6343 &&
      p.communityId === firstSong.directoryProfile.communityId,
    "owner_policy_activation_wrong_community",
  );
  insist(
    Array.isArray(p.history) &&
      p.history.length === 4 &&
      Array.isArray(p.historyHashes) &&
      p.historyHashes.length === 4,
    "owner_policy_activation_history_required",
  );
  const history: CommunityConfig[] = [];
  for (const [i, raw] of p.history.entries()) {
    const config = validateConfig(raw, history);
    insist(
      canonical(config) === canonical(raw) &&
        hashJson(config) === p.historyHashes[i],
      "owner_policy_activation_history_changed",
    );
    history.push(config);
  }
  const before = history[3]!;
  insist(
    before.configurationRevision === 4 &&
      before.chainId === 6343 &&
      before.directory === firstSong.directoryProfile.directory &&
      before.registry === firstSong.directoryProfile.registry &&
      before.communityId === p.communityId &&
      before.postsContract === firstSong.posts.address &&
      before.app.origin === firstSong.origin &&
      before.controller.toLowerCase() === p.controller.toLowerCase() &&
      before.policies.admission.version === OWNER_POLICY_VERSION &&
      before.policies.admission.sha256 === OWNER_POLICY_HASH,
    "owner_policy_activation_wrong_predecessor",
  );
  insist(
    hash(p.sourceHash) && p.sourceHash === sourceHash,
    "owner_policy_activation_source_changed",
  );
  const manifest = validateConfig(ownerPolicySuccessor(before), history);
  // Every field other than the revision and the admission policy is unchanged.
  insist(
    canonical({
      ...manifest,
      configurationRevision: before.configurationRevision,
      policies: { ...manifest.policies, admission: before.policies.admission },
    }) === canonical(before),
    "owner_policy_activation_unrelated_field_changed",
  );
  const bytes = new TextEncoder().encode(canonical(manifest)),
    pin = await preparePin(bytes, "application/json");
  insist(
    p.manifestSha256 === hashJson(manifest) &&
      canonical(p.pin) === canonical(pin),
    "owner_policy_activation_manifest_or_pin_changed",
  );
  insist(
    Number.isSafeInteger(p.nonce) && p.nonce >= 0,
    "owner_policy_activation_nonce_invalid",
  );
  insist(
    [p.gas, p.maximumGasPriceWei, p.dataFeeReserveWei, p.maximumTotalWei].every(
      decimal,
    ) &&
      BigInt(p.gas) <= 1500000n &&
      BigInt(p.maximumGasPriceWei) <= 1000000n &&
      BigInt(p.dataFeeReserveWei) <= 100000000000n,
    "owner_policy_activation_bounds_invalid",
  );
  const maximumFeeWei =
    BigInt(p.gas) * BigInt(p.maximumGasPriceWei) + BigInt(p.dataFeeReserveWei);
  insist(
    maximumFeeWei <= BigInt(p.maximumTotalWei) &&
      BigInt(p.maximumTotalWei) <= 500000000000000n,
    "owner_policy_activation_aggregate_cap",
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
    "owner_policy_activation_window_invalid",
  );
  insist(
    Array.isArray(p.inventory) &&
      p.inventory.length > 0 &&
      p.inventory.length <= 64 &&
      new Set(p.inventory.map((x) => x.path)).size === p.inventory.length,
    "owner_policy_activation_inventory_required",
  );
  for (const row of p.inventory) {
    exact(object(row), ["path", "sha256", "format"]);
    insist(
      ownerActivationPath(row.path) &&
        /^[0-9a-f]{64}$/.test(row.sha256) &&
        [
          "deployment-journal-v1",
          "deploy-results-v2-custom",
          "activation-journal",
        ].includes(row.format),
      "owner_policy_activation_inventory_invalid",
    );
  }
  exact(object(p.custody), ["record", "sha256", "ownerRole", "exclusions"]);
  insist(
    ownerActivationPath(p.custody.record) &&
      /^[0-9a-f]{64}$/.test(p.custody.sha256) &&
      p.custody.ownerRole === "workspace_coordinator" &&
      Array.isArray(p.custody.exclusions) &&
      p.custody.exclusions.length > 0 &&
      p.custody.exclusions.every((x) => typeof x === "string" && x.trim()),
    "owner_policy_activation_custody_required",
  );
  exact(object(p.readiness), ["record", "sha256"]);
  insist(
    ownerActivationPath(p.readiness.record) &&
      /^[0-9a-f]{64}$/.test(p.readiness.sha256),
    "owner_policy_activation_readiness_required",
  );
  exact(object(p.release), [
    "applicationProfile",
    "applicationModule",
    "managedProfile",
    "managedModule",
    "selectionSha256",
  ]);
  insist(
    Object.values(p.release).every(hash),
    "owner_policy_activation_release_identity_invalid",
  );
  const profileHash = hashJson(p);
  const operation: ActivationOperation = {
    profileHash,
    step: "configure",
    controller: p.controller,
    nonce: p.nonce,
    journalKey: "deployment",
    to: before.directory as Hex,
    data: encodeFunctionData({
      abi: configureAbi,
      functionName: "configure",
      args: [
        p.communityId,
        4n,
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
  };
  return {
    profileHash,
    history,
    before,
    manifest,
    bytes,
    pin,
    operation,
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
export type OwnerPolicyActivationPlan = Awaited<
  ReturnType<typeof ownerPolicyActivationPlan>
>;
