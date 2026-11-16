import { encodeFunctionData, zeroHash, type Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  consentUint64,
  parsePublicationGrant,
  preparePublicationGrant,
} from "../packages/protocol/publication-consent.ts";
import {
  learningCommitmentV5,
  type LearningResultV5,
} from "../packages/protocol/learning-results-v5.ts";
import { learningResultsV5Abi } from "../packages/protocol/generated/learning-results-v5.ts";
import type { BoundPublicationGrantV1 } from "../packages/protocol/publication-runtime-v1.ts";

type Facts = Omit<LearningResultV5, "grantId"> & {
  grantId?: never;
  enrollmentId?: never;
  authorizationId?: never;
};

/** Pure encoding only. The caller authenticates facts, current source/grant,
 * roles and policy, and retains original work before dispatch. This function
 * performs no signature verification, permission read, relay or transaction. */
export function prepareInitialLearningV5(
  facts: Facts,
  outcomes: Hex,
  binding: BoundPublicationGrantV1,
  expectedConfigurationRevision: string,
) {
  check(
    !("grantId" in facts) && !("enrollmentId" in facts) &&
      !("authorizationId" in facts) &&
      binding.schema === "pirate.bound-publication-grant/1" &&
      binding.source.schema === "pirate.publication-source/1" &&
      binding.source.resultsVersion === 5,
    "invalid_v5_binding",
  );
  const g = parsePublicationGrant(binding.grant);
  const purpose = facts.activity === 1 ? "karaoke-results" :
    facts.activity === 2 ? "study-results" : null;
  const boundAt = consentUint64(binding.boundAtS);
  const recordedAt = consentUint64(binding.recordedAtS);
  const revision = consentUint64(expectedConfigurationRevision);
  // Digest preparation only; the empty signature is never dispatched.
  const prepared = preparePublicationGrant(
    BigInt(binding.source.chainId), binding.source.registry, binding.grant, "0x",
  );
  check(
    purpose !== null && g.purpose === purpose &&
      prepared.digest === binding.grantId &&
      g.communityId === binding.source.communityId &&
      facts.song.communityId === g.communityId &&
      facts.learner.toLowerCase() === g.learner &&
      g.publicationTarget === binding.source.registry &&
      g.publicationTargetRuntimeHash === binding.source.registryRuntimeHash &&
      recordedAt > 0n && recordedAt <= boundAt &&
      g.validAfter <= boundAt && boundAt < g.expiresAt &&
      facts.startedAt === boundAt && facts.completedAt >= boundAt &&
      facts.revision === 1 && facts.supersedes === zeroHash && revision > 0n,
    "invalid_v5_publication",
  );
  const result: LearningResultV5 = { ...facts, grantId: binding.grantId };
  return {
    result,
    commitment: learningCommitmentV5(result, outcomes),
    calldata: encodeFunctionData({
      abi: learningResultsV5Abi,
      functionName: "publish",
      args: [result, outcomes, revision],
    }),
  };
}
