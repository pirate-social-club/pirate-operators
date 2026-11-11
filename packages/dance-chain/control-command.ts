import { keccak256, stringToHex, type Hex } from "viem";
import { canonical, hashJson, insist } from "../community/common.ts";
import { address } from "../community/manifest-core.ts";
import type { DanceControlIntent } from "../dance/contracts.ts";
import type { DanceControlBinding } from "../dance/control-contracts.ts";
import type { DanceCanonicalSource } from "./reader.ts";
import { danceCommand, danceSourceHash } from "./wire.ts";

export const controlJson = (value: unknown): string =>
  canonical(
    JSON.parse(
      JSON.stringify(value, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    ),
  );
export function controlSource(json: string): DanceCanonicalSource {
  const s = JSON.parse(json);
  insist(
    typeof s.domain?.chainId === "string" &&
      /^\d+$/.test(s.domain.chainId) &&
      typeof s.pin?.deploymentBlock === "string" &&
      /^\d+$/.test(s.pin.deploymentBlock),
    "dance_control_source_invalid",
    503,
  );
  s.domain.chainId = BigInt(s.domain.chainId);
  s.pin.deploymentBlock = BigInt(s.pin.deploymentBlock);
  insist(
    s.schema === "pirate.dance-verdict/1" &&
      s.domain.chainId === 6343n &&
      danceSourceHash(s.domain, s.pin).toLowerCase() ===
        s.sourceHash.toLowerCase(),
    "dance_control_source_invalid",
    503,
  );
  return s;
}
export function controlEpoch(value: unknown, positive = false): number {
  insist(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= (positive ? 1 : 0) &&
      value <= Number.MAX_SAFE_INTEGER,
    "dance_control_epoch_invalid",
    503,
  );
  return value;
}
/** Called BEFORE acceptance/dispatch with the already admitted exact source and
 * current owner account caller. Never fill these from a later role observation. */
export function canonicalDanceControlBinding(
  source: DanceCanonicalSource,
  intent: DanceControlIntent,
  caller: string,
): DanceControlBinding {
  const { localIntegrityHash, ...body } = intent;
  insist(
    hashJson(body) === localIntegrityHash &&
      source.domain.communityId === intent.communityId &&
      source.domain.chainId === 6343n &&
      danceSourceHash(source.domain, source.pin) === source.sourceHash &&
      (intent.operation === "grant" || intent.operation === "revoke"),
    "dance_control_binding_invalid",
    503,
  );
  const wallet = address(intent.wallet.toLowerCase()),
    owner = address(caller.toLowerCase());
  insist(
    intent.expectedReviewerEpoch < Number.MAX_SAFE_INTEGER,
    "dance_control_epoch_invalid",
    503,
  );
  const expectedReviewerEpoch = BigInt(
    controlEpoch(intent.expectedReviewerEpoch),
  );
  const common = {
    expectedOwnerEpoch: BigInt(controlEpoch(intent.ownerEpoch, true)),
    expectedConfigurationRevision: BigInt(
      controlEpoch(intent.expectedConfigurationRevision, true),
    ),
    reviewerWallet: wallet,
    expectedReviewerEpoch,
  };
  const id = keccak256(stringToHex(intent.commandId));
  insist(
    intent.operation === "revoke"
      ? intent.expiresAtMs === 0
      : Number.isSafeInteger(intent.expiresAtMs) &&
          intent.expiresAtMs > 0 &&
          intent.expiresAtMs % 1000 === 0,
    "dance_control_expiry_not_exact_seconds",
    503,
  );
  const command =
    intent.operation === "grant"
      ? danceCommand(source.domain, "grantReviewer", owner, id, {
          ...common,
          expiresAtSeconds: BigInt(intent.expiresAtMs / 1000),
        })
      : danceCommand(source.domain, "revokeReviewer", owner, id, common);
  const binding = {
    version: "pirate.dance-control-binding/1" as const,
    commandId: intent.commandId,
    intentHash: intent.localIntegrityHash,
    communityId: intent.communityId,
    sourceHash: source.sourceHash,
    sourceJson: controlJson(source),
    caller: owner,
    wallet,
    operation: intent.operation,
    expectedEpoch: intent.expectedReviewerEpoch,
    wireId: command.id,
    commandHash: command.hash,
    encodedPayload: command.encoded,
    calldata: command.data,
  };
  return { ...binding, bindingHash: hashJson(binding) };
}
export function verifyControlBinding(
  intent: DanceControlIntent,
  binding: DanceControlBinding,
) {
  const source = controlSource(binding.sourceJson);
  const expected = canonicalDanceControlBinding(source, intent, binding.caller);
  insist(
    canonical(expected) === canonical(binding),
    "dance_control_binding_changed",
    503,
  );
  return {
    source,
    binding: expected,
    resourceId:
      `0x${address(binding.wallet).slice(2).padStart(64, "0")}` as Hex,
  };
}
