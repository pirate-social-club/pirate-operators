import {
  bytes32,
  exact,
  hashJson,
  insist,
  object,
} from "../community/common.ts";
import { address, decimal } from "../community/manifest-core.ts";
import type { DanceCanonicalSource } from "./reader.ts";
import { danceSourceHash } from "./wire.ts";

/** Parse the exact, non-secret release selection. Both the content hash and
 * the recomputed on-chain source identity must match. */
export function selectedDanceRewardSource(
  raw: string,
  expectedHash: string,
): DanceCanonicalSource {
  const x = object(JSON.parse(raw));
  exact(x, [
    "schema",
    "domain",
    "sourceHash",
    "pin",
    "capturePolicy",
    "capturePolicyRuntimeHash",
  ]);
  insist(
    hashJson(x) === bytes32(expectedHash) &&
      x.schema === "pirate.dance-verdict/1",
    "dance_reward_source_selection_changed",
    503,
  );
  const d = object(x.domain);
  exact(d, ["chainId", "verifier", "communityId"]);
  insist(d.chainId === 6343, "dance_wrong_chain", 503);
  const domain = {
    chainId: 6343n,
    verifier: address(d.verifier),
    communityId: bytes32(d.communityId),
  };
  const p = object(x.pin);
  exact(p, [
    "directory",
    "directoryRuntimeHash",
    "v4",
    "v4RuntimeHash",
    "posts",
    "postsRuntimeHash",
    "fixedPublisher",
    "publicityPolicyHash",
    "rulesSha256",
    "termsSha256",
    "rubricSha256",
    "mediaPolicySha256",
    "deploymentBlock",
    "runtimeCodeHash",
  ]);
  const pin = {
    directory: address(p.directory),
    directoryRuntimeHash: bytes32(p.directoryRuntimeHash),
    v4: address(p.v4),
    v4RuntimeHash: bytes32(p.v4RuntimeHash),
    posts: address(p.posts),
    postsRuntimeHash: bytes32(p.postsRuntimeHash),
    fixedPublisher: address(p.fixedPublisher),
    publicityPolicyHash: bytes32(p.publicityPolicyHash),
    rulesSha256: bytes32(p.rulesSha256),
    termsSha256: bytes32(p.termsSha256),
    rubricSha256: bytes32(p.rubricSha256),
    mediaPolicySha256: bytes32(p.mediaPolicySha256),
    deploymentBlock: BigInt(decimal(p.deploymentBlock)),
    runtimeCodeHash: bytes32(p.runtimeCodeHash),
  };
  const sourceHash = bytes32(x.sourceHash);
  insist(
    pin.deploymentBlock > 0n &&
      pin.deploymentBlock < 1n << 64n &&
      danceSourceHash(domain, pin) === sourceHash,
    "dance_source_pin_changed",
    503,
  );
  return {
    schema: x.schema,
    domain,
    pin,
    sourceHash,
    capturePolicy: address(x.capturePolicy),
    capturePolicyRuntimeHash: bytes32(x.capturePolicyRuntimeHash),
  };
}
