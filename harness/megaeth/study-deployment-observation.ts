// Fixed-chain public boundary for a single frozen pre-activation operation.
import { keccak256, zeroHash, type PublicClient } from "viem";
import { insist } from "../../packages/community/common.ts";
import { directoryAbi } from "../../packages/community/directory-reader.ts";
import {
  fetchPublicIpfs,
  type IpfsTransport,
} from "../../packages/community/ipfs.ts";
import { resultPeriod } from "../../packages/protocol/learning-results.ts";
import { runtimeMatches } from "../compile-community.ts";
import type { StudyDeploymentArtifact } from "./study-deployment-artifact.ts";
import {
  studyDeploymentPlan,
  studyDeploymentSteps,
  type StudyDeploymentOperation,
  type StudyDeploymentProfile,
} from "./study-deployment-plan.ts";
export async function observeStudyDeployment(
  client: PublicClient,
  profile: StudyDeploymentProfile,
  artifact: StudyDeploymentArtifact,
  operation: StudyDeploymentOperation,
  transport?: IpfsTransport,
) {
  const plan = studyDeploymentPlan(profile, artifact);
  insist(
    plan.operations.some((row) => row.profileHash === operation.profileHash),
    "study_deployment_operation_changed",
  );
  insist((await client.getChainId()) === 6343, "study_deployment_wrong_chain");
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head > 0n, "study_deployment_missing_head");
  const blockNumber = head - 1n;
  const [
    block,
    directoryCode,
    v2Code,
    v3Code,
    row,
    gasPrice,
    latestNonce,
    pendingNonce,
  ] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.getCode({ address: profile.directory, blockNumber }),
    client.getCode({ address: profile.resultsV2.contract, blockNumber }),
    client.getCode({ address: profile.contract, blockNumber }),
    client.readContract({
      address: profile.directory,
      abi: directoryAbi,
      functionName: "getCommunity",
      args: [profile.communityId],
      blockNumber,
    }),
    client.getGasPrice(),
    client.getTransactionCount({
      address: profile.controller,
      blockTag: "latest",
    }),
    client.getTransactionCount({
      address: profile.controller,
      blockTag: "pending",
    }),
  ]);
  insist(
    directoryCode &&
      keccak256(directoryCode) === profile.directoryCodeHash &&
      v2Code &&
      keccak256(v2Code) === profile.resultsV2.codeHash,
    "study_deployment_predecessor_code_changed",
  );
  insist(
    row.registry.toLowerCase() === profile.registry.toLowerCase() &&
      row.configurationRevision.toString() === profile.configurationRevision &&
      row.configuration.controller.toLowerCase() ===
        profile.controller.toLowerCase() &&
      row.configuration.learningRecords.toLowerCase() ===
        profile.resultsV2.contract.toLowerCase(),
    "study_deployment_registration_changed",
  );
  const index = studyDeploymentSteps.indexOf(operation.step);
  if (!index) {
    insist(
      !v3Code || v3Code === "0x",
      "study_deployment_unattributed_contract",
    );
  } else {
    insist(
      v3Code && runtimeMatches(v3Code, artifact),
      "study_deployment_runtime_changed",
    );
    const read = (functionName: string, args: readonly unknown[] = []) =>
      client.readContract({
        address: profile.contract,
        abi: artifact.abi,
        functionName,
        args,
        blockNumber,
      });
    const [
      version,
      controller,
      community,
      publicity,
      karaoke,
      study,
      karaokePolicy,
      studyPolicy,
    ] = await Promise.all([
      read("VERSION"),
      read("controller"),
      read("communityId"),
      read("publicityPolicy"),
      read("graders", [profile.grader, 1]),
      read("graders", [profile.grader, 2]),
      read("policyFor", [1, BigInt(profile.policies.karaoke.effectivePeriod)]),
      read("policyFor", [2, BigInt(profile.policies.study.effectivePeriod)]),
    ]);
    insist(
      version === 3 &&
        String(controller).toLowerCase() === profile.controller.toLowerCase() &&
        community === profile.communityId &&
        publicity === profile.publicityPolicy,
      "study_deployment_contract_identity_changed",
    );
    insist(
      karaoke === index > 1 &&
        study === index > 2 &&
        karaokePolicy ===
          (index > 3 ? profile.policies.karaoke.sha256 : zeroHash) &&
        studyPolicy === zeroHash,
      "study_deployment_prior_step_state_changed",
    );
  }
  insist(
    gasPrice > 0n && gasPrice <= BigInt(profile.maximumGasPriceWei),
    "study_deployment_gas_price_cap",
  );
  const period = resultPeriod(block.timestamp);
  insist(
    [profile.policies.karaoke, profile.policies.study].every(
      (policy) => BigInt(policy.effectivePeriod) > period,
    ),
    "study_deployment_policy_not_prospective",
  );
  for (const name of ["karaoke", "study"] as const) {
    const policy = plan.policies[name];
    const { bytes } = await fetchPublicIpfs(
      policy.uri,
      policy.sha256,
      65536,
      transport,
    );
    insist(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes) === policy.bytes,
      "study_deployment_policy_bytes_changed",
    );
  }
  insist(
    (await client.getBlock({ blockNumber })).hash === block.hash &&
      block.number === blockNumber &&
      block.hash,
    "study_deployment_canonical_head_changed",
  );
  return {
    head: { number: blockNumber.toString(), hash: block.hash },
    latestNonce,
    pendingNonce,
    gasPriceWei: gasPrice.toString(),
  };
}
