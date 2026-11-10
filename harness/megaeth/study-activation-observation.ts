// Block-pinned predecessor/target state. Only a separately explicit mode calls it.
import { keccak256, zeroHash, type PublicClient } from "viem";
import {
  canonical,
  hashJson,
  insist,
} from "../../packages/community/common.ts";
import { readConfigurationHistory } from "../../packages/community/directory-reader.ts";
import {
  fetchPublicIpfs,
  type IpfsTransport,
} from "../../packages/community/ipfs.ts";
import { firstSong } from "../../services/first-song-profile.ts";
import { learningV3PublicityPolicy } from "../../services/learning-policy-v3.ts";
import { learningV4PublicityPolicy } from "../../services/learning-policy-v4.ts";
import {
  retainedResultsV2,
  retainedLearningOperator,
} from "../study-release-profile.ts";
import { resultPeriod } from "../../packages/protocol/learning-results.ts";
import { runtimeMatches } from "../compile-community.ts";
import type { StudyDeploymentArtifact } from "./study-deployment-artifact.ts";
import type {
  StudyActivationPlan,
  StudyActivationProfile,
} from "./study-activation-plan.ts";
export async function observeStudyActivation(
  client: PublicClient,
  p: StudyActivationProfile,
  artifact: StudyDeploymentArtifact,
  plan: StudyActivationPlan,
  transport?: IpfsTransport,
  successor = false,
  requirePin = false,
) {
  const v4 = p.schema === "pirate.study-activation/2";
  insist(plan.profileHash === hashJson(p), "study_activation_profile_changed");
  insist((await client.getChainId()) === 6343, "study_activation_wrong_chain");
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
    "study_activation_directory_changed",
  );
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head > 0n, "study_activation_missing_head");
  const blockNumber = head - 1n,
    block = await client.getBlock({ blockNumber });
  const [v2, v3, gasPrice, latestNonce, pendingNonce] = await Promise.all([
    client.getCode({ address: retainedResultsV2.contract, blockNumber }),
    client.getCode({ address: p.contract, blockNumber }),
    client.getGasPrice(),
    client.getTransactionCount({ address: p.controller, blockTag: "latest" }),
    client.getTransactionCount({ address: p.controller, blockTag: "pending" }),
  ]);
  insist(
    v2 &&
      keccak256(v2) === retainedResultsV2.codeHash &&
      v3 &&
      keccak256(v3) === p.codeHash &&
      runtimeMatches(v3, artifact),
    "study_activation_contract_code_changed",
  );
  if (v4) {
    const previous = await client.getCode({
      address: p.predecessor!.contract,
      blockNumber,
    });
    insist(
      previous && keccak256(previous) === p.predecessor!.codeHash,
      "study_activation_predecessor_code_changed",
    );
  }
  const read = (functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: p.contract,
      abi: artifact.abi,
      functionName,
      args,
      blockNumber,
    });
  const [version, controller, community, publicity, karaoke, study] =
    await Promise.all([
      read("VERSION"),
      read("controller"),
      read("communityId"),
      read("publicityPolicy"),
      read("graders", [retainedLearningOperator.publisher, 1]),
      read("graders", [retainedLearningOperator.publisher, 2]),
    ]);
  insist(
    version === (v4 ? 4 : 3) &&
      String(controller).toLowerCase() === p.controller.toLowerCase() &&
      community === p.communityId &&
      publicity ===
        (v4 ? learningV4PublicityPolicy : learningV3PublicityPolicy) &&
      karaoke === true &&
      study === true,
    "study_activation_contract_state_changed",
  );
  if (v4)
    insist(
      (await read("communityOrigin")) === p.communityOrigin,
      "study_activation_contract_origin_changed",
    );
  const currentPeriod = resultPeriod(block.timestamp);
  for (const [i, name] of (["karaoke", "study"] as const).entries()) {
    const policy = p.policies[name],
      declared = BigInt(policy.effectivePeriod);
    const [atDeclared, atCurrent] = await Promise.all([
      read("policyFor", [i + 1, declared]),
      read("policyFor", [i + 1, currentPeriod]),
    ]);
    insist(
      atDeclared === policy.sha256 &&
        atCurrent === (currentPeriod >= declared ? policy.sha256 : zeroHash),
      "study_activation_policy_state_changed",
    );
    const fetched = await fetchPublicIpfs(
      policy.uri,
      policy.sha256,
      65536,
      transport,
    );
    insist(
      new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes) ===
        plan.policies[name].bytes,
      "study_activation_policy_bytes_changed",
    );
  }
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
      "study_activation_pin_bytes_changed",
    );
  }
  insist(
    successor || (gasPrice > 0n && gasPrice <= BigInt(p.maximumGasPriceWei)),
    "study_activation_gas_price_cap",
  );
  insist(
    block.hash && (await client.getBlock({ blockNumber })).hash === block.hash,
    "study_activation_head_changed",
  );
  return {
    head: { number: blockNumber.toString(), hash: block.hash },
    latestNonce,
    pendingNonce,
    gasPriceWei: gasPrice.toString(),
    currentPeriod: currentPeriod.toString(),
    qualifyingPolicyActive:
      currentPeriod >= BigInt(p.policies.karaoke.effectivePeriod) &&
      currentPeriod >= BigInt(p.policies.study.effectivePeriod),
  };
}
