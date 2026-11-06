// Public, read-only preparation. No key or mutable journal belongs in this module.
import { encodeFunctionData, zeroHash, type Address, type Hex } from "viem";
import { hashJson, insist } from "../../packages/community/common.ts";
import {
  resultsV3Abi,
  resultCommitment,
  type TerminalResult,
} from "../../packages/protocol/learning-results-v3.ts";
import { learningV3PublicityPolicy } from "../../services/learning-policy-v3.ts";
import {
  projectStudyRevisions,
  restoreStudyResult,
  type StudyRevisionEvidence,
} from "../../services/study-revisions.ts";

export interface StudyCorrectionProfile {
  schema: "pirate.study-correction/1";
  chainId: 6343;
  directory: Address;
  directoryCodeHash: Hex;
  registry: Address;
  configurationRevision: string;
  contract: Address;
  codeHash: Hex;
  communityId: Hex;
  controller: Address;
  publicityPolicy: Hex;
  previous: StudyRevisionEvidence;
  operation:
    | { kind: "correct"; outcomes: Hex; status: number }
    | { kind: "invalidate"; reason: Hex };
  nonce: number;
  gas: string;
  maximumGasPriceWei: string;
  dataFeeReserveWei: string;
  maximumTotalWei: string;
  notBefore: string;
  deadline: string;
  inventory: {
    path: string;
    sha256: string;
    format:
      | "deployment-journal-v1"
      | "deploy-results-v2-custom"
      | "activation-journal";
  }[];
  custody: {
    record: string;
    sha256: string;
    ownerRole: "workspace_coordinator";
    exclusions: string[];
  };
}
const bytes32 = (v: unknown): v is Hex =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v) && v !== zeroHash;
const address = (v: unknown): v is Address =>
  typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v) && BigInt(v) !== 0n;
const positive = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9][0-9]*$/.test(v);
export function correctionIntent(profile: StudyCorrectionProfile) {
  insist(
    profile.schema === "pirate.study-correction/1" && profile.chainId === 6343,
    "correction_wrong_profile",
  );
  insist(
    [
      profile.directory,
      profile.registry,
      profile.contract,
      profile.controller,
    ].every(address) &&
      [profile.directoryCodeHash, profile.codeHash, profile.communityId].every(
        bytes32,
      ),
    "correction_invalid_target",
  );
  insist(
    profile.publicityPolicy === learningV3PublicityPolicy,
    "correction_wrong_publicity",
  );
  insist(
    positive(profile.configurationRevision) &&
      Number.isSafeInteger(profile.nonce) &&
      profile.nonce >= 0,
    "correction_invalid_nonce_or_revision",
  );
  insist(
    [
      profile.gas,
      profile.maximumGasPriceWei,
      profile.dataFeeReserveWei,
      profile.maximumTotalWei,
    ].every(positive),
    "correction_invalid_fee_bounds",
  );
  const maximumFee =
    BigInt(profile.gas) * BigInt(profile.maximumGasPriceWei) +
    BigInt(profile.dataFeeReserveWei);
  insist(
    maximumFee <= BigInt(profile.maximumTotalWei),
    "correction_total_fee_cap",
  );
  const start = Date.parse(profile.notBefore),
    end = Date.parse(profile.deadline);
  insist(
    Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start &&
      end - start <= 900000,
    "correction_invalid_window",
  );
  insist(
    Array.isArray(profile.inventory) &&
      profile.inventory.length > 0 &&
      profile.inventory.length <= 64 &&
      new Set(profile.inventory.map((x) => x.path)).size ===
        profile.inventory.length,
    "correction_inventory_required",
  );
  for (const row of profile.inventory)
    insist(
      typeof row.path === "string" &&
        row.path.startsWith("/") &&
        /^[0-9a-f]{64}$/.test(row.sha256) &&
        [
          "deployment-journal-v1",
          "deploy-results-v2-custom",
          "activation-journal",
        ].includes(row.format),
      "correction_invalid_inventory",
    );
  insist(
    profile.custody?.ownerRole === "workspace_coordinator" &&
      profile.custody.record.startsWith("/") &&
      /^[0-9a-f]{64}$/.test(profile.custody.sha256) &&
      profile.custody.exclusions.length > 0 &&
      profile.custody.exclusions.every(
        (x) => typeof x === "string" && x.trim().length > 0,
      ),
    "correction_custody_record_required",
  );
  const previous = {
    ...profile.previous,
    result: restoreStudyResult(profile.previous.result),
  };
  projectStudyRevisions(previous, [], previous.commitment);
  insist(
    previous.result.song.communityId === profile.communityId &&
      previous.result.song.chainId === 6343n &&
      previous.result.revision < 0xffffffff,
    "correction_previous_context",
  );
  let next: TerminalResult, outcomes: Hex, data: Hex;
  if (profile.operation.kind === "correct") {
    outcomes = profile.operation.outcomes;
    insist(
      Number.isInteger(profile.operation.status) &&
        profile.operation.status >= 1 &&
        profile.operation.status <= 4 &&
        (outcomes !== previous.outcomes ||
          profile.operation.status !== previous.result.status),
      "correction_no_change_or_status",
    );
    next = {
      ...previous.result,
      revision: previous.result.revision + 1,
      supersedes: previous.commitment,
      status: profile.operation.status,
    };
    data = encodeFunctionData({
      abi: resultsV3Abi,
      functionName: "correct",
      args: [previous.result, previous.outcomes, outcomes, next.status],
    });
  } else {
    insist(
      profile.operation.kind === "invalidate" &&
        bytes32(profile.operation.reason) &&
        previous.result.status !== 5,
      "correction_invalid_invalidation",
    );
    outcomes = previous.outcomes;
    next = {
      ...previous.result,
      revision: previous.result.revision + 1,
      supersedes: previous.commitment,
      status: 5,
    };
    data = encodeFunctionData({
      abi: resultsV3Abi,
      functionName: "invalidate",
      args: [previous.result, outcomes, profile.operation.reason],
    });
  }
  const commitment = resultCommitment(next, outcomes);
  // Exercise coverage, immutable context, ancestry and invalidation are checked
  // using the same strict proof validator as public observation, without I/O.
  projectStudyRevisions(
    previous,
    [
      {
        ...previous,
        result: next,
        outcomes,
        commitment,
        blockNumber: (BigInt(previous.blockNumber) + 1n).toString(),
      },
    ],
    commitment,
  );
  return {
    profileHash: hashJson(profile),
    to: profile.contract,
    data,
    gas: profile.gas,
    nonce: profile.nonce,
    maximumFeeWei: maximumFee.toString(),
    next,
    outcomes,
    commitment,
  };
}
export function correctionWindow(
  profile: StudyCorrectionProfile,
  now = Date.now(),
) {
  insist(
    now >= Date.parse(profile.notBefore) && now < Date.parse(profile.deadline),
    "correction_window_closed",
  );
}
