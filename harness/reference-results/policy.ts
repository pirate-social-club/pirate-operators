// Independent public qualification documents. No application policy validator.
import type { Hex } from "viem";
import type { ReferenceSnapshot } from "./facts.ts";
import type { ReferencePolicyDocument } from "./board.ts";
import { publicDocument, requireFact } from "./checks.ts";
import { studyPolicy } from "./study.ts";

export function policyDocument(
  snapshot: ReferenceSnapshot,
  uri: string,
  hash: Hex,
  activity = 1,
): ReferencePolicyDocument | undefined {
  try {
    if (activity === 2) return studyPolicy(snapshot, uri, hash);
    const d = publicDocument(snapshot, uri, hash, 65536);
    const fields = [
      "schema",
      "version",
      "clockVersion",
      "activity",
      "graders",
      "scoringPolicies",
      "terminalStatuses",
      "minScoreBps",
      "maxUnmeasuredBps",
      "rewards",
    ];
    requireFact(
      Object.keys(d).sort().join(",") === fields.sort().join(","),
      "unknown_policy_fields",
    );
    requireFact(
      d.schema === "pirate.learning-policy/2" &&
        d.clockVersion === 1 &&
        d.activity === 1 &&
        typeof d.version === "string" &&
        typeof d.rewards === "boolean" &&
        Array.isArray(d.graders) &&
        d.graders.length &&
        d.graders.every(
          (g: unknown) => typeof g === "string" && /^0x[0-9a-f]{40}$/.test(g),
        ) &&
        Array.isArray(d.scoringPolicies) &&
        d.scoringPolicies.length &&
        d.scoringPolicies.every(
          (h: unknown) => typeof h === "string" && /^0x[0-9a-f]{64}$/.test(h),
        ) &&
        Array.isArray(d.terminalStatuses) &&
        d.terminalStatuses.every(
          (s: unknown) =>
            Number.isInteger(s) && Number(s) >= 1 && Number(s) <= 4,
        ) &&
        Number.isInteger(d.minScoreBps) &&
        d.minScoreBps >= 0 &&
        d.minScoreBps <= 10000 &&
        Number.isInteger(d.maxUnmeasuredBps) &&
        d.maxUnmeasuredBps >= 0 &&
        d.maxUnmeasuredBps <= 10000,
      "unsupported_policy",
    );
    return d as unknown as ReferencePolicyDocument;
  } catch {
    return undefined;
  }
}
