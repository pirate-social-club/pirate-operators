// Independent readiness and block-pinned observation for the owner policy
// activation. Readiness is byte-bound and fresh; observation only reads.
import { readFileSync } from "node:fs";
import type { PublicClient } from "viem";
import {
  canonical,
  exact,
  hashJson,
  insist,
  object,
} from "../../packages/community/common.ts";
import { readConfigurationHistory } from "../../packages/community/directory-reader.ts";
import {
  fetchPublicIpfs,
  type IpfsTransport,
} from "../../packages/community/ipfs.ts";
import { firstSong } from "../../services/first-song-profile.ts";
import { privateExistingFile, sha256File } from "./controller-inventory.ts";
import {
  ownerActivationPath,
  ownerActivationReadinessScope,
  ownerActivationWindow,
  type OwnerPolicyActivationPlan,
  type OwnerPolicyActivationProfile,
} from "./owner-policy-activation-plan.ts";

export const ownerActivationMigrations = [
  "0012_owner_budget_windows.sql",
  "0004_owner_budget_windows.sql",
] as const;
/** Readers first, policy second: each must be independently confirmed. */
export const ownerActivationChecks = [
  "managedPublishingDeployed",
  "applicationPublishingDeployed",
  "migrationsApplied",
  "readersAcceptAllPostFormats",
  "existingSongsAndHistoryRead",
  "ownerReleaseConfigured",
  "historicalOperationsDisposed",
  "noRegistrationDependency",
] as const;
export const ownerActivationEvidenceKinds = [
  "managed",
  "application",
  "migrations",
  "readers",
  "readback",
  "dispositions",
] as const;
export function readOwnerActivationReadiness(
  p: OwnerPolicyActivationProfile,
  now: number,
) {
  ownerActivationWindow(p, now);
  privateExistingFile(p.readiness.record);
  insist(
    sha256File(p.readiness.record) === p.readiness.sha256,
    "owner_policy_activation_readiness_changed",
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
    report.schema === "pirate.owner-policy-activation-readiness/1" &&
      report.scopeHash === ownerActivationReadinessScope(p) &&
      report.decision === "accept-activation" &&
      report.reviewedBy === "independent_reviewer" &&
      canonical(report.release) === canonical(p.release) &&
      canonical(report.migrations) === canonical(ownerActivationMigrations),
    "owner_policy_activation_readiness_not_accepted",
  );
  insist(
    Date.parse(String(report.observedAt)) >= Date.parse(p.notBefore) &&
      Date.parse(String(report.observedAt)) <= now &&
      Date.parse(String(report.validUntil)) >= Date.parse(p.deadline),
    "owner_policy_activation_readiness_stale",
  );
  const checks = object(report.checks);
  exact(checks, [...ownerActivationChecks]);
  insist(
    ownerActivationChecks.every((k) => checks[k] === true),
    "owner_policy_activation_release_gate_missing",
  );
  const evidence = object(report.evidence);
  exact(evidence, [...ownerActivationEvidenceKinds]);
  const seen = new Set<string>();
  for (const kind of ownerActivationEvidenceKinds) {
    const row = object(evidence[kind]);
    exact(row, ["path", "sha256"]);
    insist(
      ownerActivationPath(row.path) &&
        typeof row.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(row.sha256) &&
        !seen.has(row.path),
      "owner_policy_activation_evidence_invalid",
    );
    seen.add(row.path);
    privateExistingFile(row.path);
    insist(
      sha256File(row.path) === row.sha256,
      "owner_policy_activation_evidence_changed",
    );
  }
  privateExistingFile(p.custody.record);
  insist(
    sha256File(p.custody.record) === p.custody.sha256,
    "owner_policy_activation_custody_changed",
  );
  const custody = object(JSON.parse(readFileSync(p.custody.record, "utf8")));
  insist(
    Date.parse(String(custody.expiresAt)) >= Date.parse(p.deadline) &&
      now < Date.parse(String(custody.expiresAt)),
    "owner_policy_activation_custody_expired",
  );
  return {
    readinessSha256: p.readiness.sha256,
    evidenceHash: hashJson(evidence),
  };
}

/**
 * Reads the directory at one block. Before activation the live history must
 * equal the profile's four revisions; after it, those four plus exactly the
 * planned revision five, whose pinned bytes must be the planned manifest.
 */
export async function observeOwnerActivation(
  client: PublicClient,
  p: OwnerPolicyActivationProfile,
  plan: OwnerPolicyActivationPlan,
  transport?: IpfsTransport,
  successor = false,
  requirePin = false,
) {
  insist(
    plan.profileHash === hashJson(p),
    "owner_policy_activation_profile_changed",
  );
  insist(
    (await client.getChainId()) === 6343,
    "owner_policy_activation_wrong_chain",
  );
  const history = await readConfigurationHistory(
    client,
    {
      ...firstSong.directoryProfile,
      deploymentBlock: BigInt(firstSong.directoryProfile.deploymentBlock),
    },
    transport,
  );
  insist(
    canonical(history) ===
      canonical(successor ? [...plan.history, plan.manifest] : plan.history),
    "owner_policy_activation_directory_changed",
  );
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head > 0n, "owner_policy_activation_missing_head");
  const blockNumber = head - 1n,
    block = await client.getBlock({ blockNumber });
  const [gasPrice, latestNonce, pendingNonce] = await Promise.all([
    client.getGasPrice(),
    client.getTransactionCount({ address: p.controller, blockTag: "latest" }),
    client.getTransactionCount({ address: p.controller, blockTag: "pending" }),
  ]);
  if (requirePin || successor) {
    const fetched = await fetchPublicIpfs(
      plan.pin.uri,
      plan.pin.sha256,
      65536,
      transport,
    );
    insist(
      canonical(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes),
        ),
      ) === canonical(plan.manifest),
      "owner_policy_activation_pin_bytes_changed",
    );
  }
  insist(
    successor || (gasPrice > 0n && gasPrice <= BigInt(p.maximumGasPriceWei)),
    "owner_policy_activation_gas_price_cap",
  );
  insist(
    block.hash && (await client.getBlock({ blockNumber })).hash === block.hash,
    "owner_policy_activation_head_changed",
  );
  return {
    head: { number: blockNumber.toString(), hash: block.hash },
    latestNonce,
    pendingNonce,
    gasPriceWei: gasPrice.toString(),
  };
}
