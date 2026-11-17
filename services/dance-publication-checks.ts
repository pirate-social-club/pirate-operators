import { encodeFunctionData, keccak256, stringToHex, type Hex } from "viem";
import { insist } from "../packages/community/common.ts";
import { consentAddress, consentDigest } from "../packages/protocol/publication-consent.ts";
import { publicationConsentAbi } from "../packages/protocol/generated/publication-consent-v1.ts";
import {
  danceCaptureHash, danceSourceHash,
  type DanceCapture, type DanceDecision, type DanceDomain, type DanceSourcePin,
} from "../packages/dance-chain/v2/wire.ts";

/** Root-owned, in-process selection. Not a request field or a readiness flag. */
export interface DancePublicationSelectionV2 {
  readonly version: 2;
  readonly domain: DanceDomain;
  readonly pin: DanceSourcePin;
  readonly sourceHash: Hex;
}
type Reviewer = Pick<DanceDecision,
  "reviewerWallet" | "reviewerPublicationGrantId" | "intentAcceptedAtMs">;
type Request = { kind: "capture"; capture: DanceCapture } |
  { kind: "review"; capture: DanceCapture; reviewer: Reviewer };

function boundSeconds(ms: bigint): bigint {
  insist(typeof ms === "bigint" && ms > 0n && ms <= 9_007_199_254_740_991n &&
    ms / 1000n > 0n, "dance_publication_bound_time_invalid", 409);
  return ms / 1000n;
}

/** Only constructs checkGrant reads from ORIGINAL retained V2 fields. No
 * allowed boolean, latest-grant lookup, signature, relay, DB write or fallback.
 * The caller must verify the source/runtime and canonical anchor, execute ALL
 * reads there, and join original-account/current-authority D1 fences before
 * accepting work. These plans are not historical receipt evidence. */
export function dancePublicationChecks(
  selected: DancePublicationSelectionV2 | undefined,
  original: Request,
) {
  const { selected: source, original: request } = structuredClone({ selected, original });
  insist(source?.version === 2, "dance_publication_source_unavailable", 503);
  const { domain, pin } = source;
  insist(domain.chainId === 6343n || domain.chainId === 31337n, "dance_wrong_chain", 503);
  consentAddress(domain.verifier);
  consentDigest(domain.communityId);
  for (const address of [pin.directory, pin.consentRegistry, pin.posts]) consentAddress(address);
  for (const hash of [pin.directoryRuntimeHash, pin.consentRegistryRuntimeHash,
    pin.postsRuntimeHash, pin.runtimeCodeHash, pin.learnerConsentPolicyHash,
    pin.reviewerConsentPolicyHash, pin.publicityPolicyHash, pin.rulesSha256,
    pin.termsSha256, pin.rubricSha256, pin.mediaPolicySha256]) consentDigest(hash);
  insist(typeof pin.deploymentBlock === "bigint" && pin.deploymentBlock >= 0n &&
    pin.deploymentBlock <= 0xffffffffffffffffn &&
    pin.executionRule === keccak256(stringToHex("directory-current-publisher/1")) &&
    consentDigest(source.sourceHash) === danceSourceHash(domain, pin),
    "dance_publication_source_changed", 503);
  insist(request?.kind === "capture" || request?.kind === "review",
    "dance_publication_request_invalid", 409);
  const capture = request.capture;
  insist(capture?.song?.chainId === domain.chainId &&
    capture.song.communityId === domain.communityId && capture.song.posts === pin.posts &&
    capture.rulesSha256 === pin.rulesSha256 && capture.termsSha256 === pin.termsSha256 &&
    capture.rubricSha256 === pin.rubricSha256 && capture.mediaPolicySha256 === pin.mediaPolicySha256,
    "dance_publication_capture_changed", 409);
  const check = (purpose: "dance-verdict" | "dance-review-attribution",
    grantId: Hex, learner: Hex, atMs: bigint, policyHash: Hex) => {
    const args = Object.freeze([
      consentDigest(grantId), consentAddress(learner), keccak256(stringToHex(purpose)),
      domain.verifier, policyHash, boundSeconds(atMs),
    ] as const);
    return Object.freeze({ purpose, address: pin.consentRegistry, args,
      data: encodeFunctionData({ abi: publicationConsentAbi, functionName: "checkGrant", args }) });
  };
  const learner = check("dance-verdict", capture.publicationGrantId, capture.learner,
    capture.reservedAtMs, pin.learnerConsentPolicyHash);
  const calls = [learner];
  if (request.kind === "review") {
    insist(request.reviewer, "dance_publication_reviewer_missing", 409);
    const r = request.reviewer;
    calls.push(check("dance-review-attribution", r.reviewerPublicationGrantId,
      r.reviewerWallet, r.intentAcceptedAtMs, pin.reviewerConsentPolicyHash));
  }
  return Object.freeze({
    kind: "read-plan" as const, version: 2 as const, chainId: domain.chainId,
    sourceHash: source.sourceHash, captureHash: danceCaptureHash(domain, capture),
    calls: Object.freeze(calls),
  });
}
