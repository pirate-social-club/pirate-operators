import { getAddress, encodeAbiParameters, keccak256, type Hex } from "viem";
import { amount, bytes32, exact, insist, object } from "../community/common.ts";
import type { RewardsProfile } from "./contracts.ts";

export function rewardAddress(value: unknown): string {
  insist(
    typeof value === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(value) &&
      BigInt(value) !== 0n,
    "invalid_reward_address",
  );
  return getAddress(value).toLowerCase();
}
export function rewardAmount(value: unknown): bigint {
  const n = amount(value);
  insist(n < 2n ** 256n, "reward_amount_out_of_range");
  return n;
}
export function rewardId(value: unknown): string {
  insist(
    typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value),
    "invalid_reward_id",
  );
  return value;
}
export function rewardTime(value: unknown): number {
  insist(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "invalid_reward_time",
  );
  return value;
}
export function rewardProfile(raw: string): RewardsProfile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("rewards_profile_invalid");
  }
  const p = object(value);
  const keys = [
    "schema",
    "programId",
    "mode",
    "chainId",
    "token",
    "decimals",
    "operatorWallet",
    "payoutWallet",
    "ticketWallet",
    "veryAppId",
    "rpcUrl",
    "resultSourceHash",
  ];
  exact(p, [
    ...keys,
    ...(Object.hasOwn(p, "rehearsal") ? ["rehearsal"] : []),
    ...(Object.hasOwn(p, "rehearsalHistory") ? ["rehearsalHistory"] : []),
  ]);
  insist(
    p.schema === "pirate.manual-rewards/1" &&
      p.chainId === 6343 &&
      ["simulated", "live-testnet"].includes(String(p.mode)),
    "rewards_profile_invalid",
  );
  bytes32(p.programId);
  insist(
    typeof p.decimals === "number" &&
      Number.isInteger(p.decimals) &&
      p.decimals >= 6 &&
      p.decimals <= 18,
    "invalid_reward_decimals",
  );
  insist(
    typeof p.veryAppId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(p.veryAppId),
    "invalid_very_app",
  );
  insist(
    typeof p.rpcUrl === "string" && new URL(p.rpcUrl).protocol === "https:",
    "invalid_reward_rpc",
  );
  insist(
    p.mode === "simulated" || p.mode === "live-testnet",
    "invalid_reward_mode",
  );
  const rehearsalConfig = (value: unknown) => {
    const r = object(value);
    exact(r, ["schema", "offerId", "prizeUsdcAtomic"]);
    insist(
      p.mode === "live-testnet" && r.schema === "pirate.reward-rehearsal/1",
      "reward_rehearsal_profile_invalid",
    );
    const prize = rewardAmount(r.prizeUsdcAtomic);
    rewardAmount(
      (prize * 10n ** BigInt((p.decimals as number) - 6)).toString(),
    );
    return {
      schema: "pirate.reward-rehearsal/1" as const,
      offerId: rewardId(r.offerId),
      prizeUsdcAtomic: prize.toString(),
    };
  };
  const rehearsal = Object.hasOwn(p, "rehearsal")
    ? rehearsalConfig(p.rehearsal)
    : undefined;
  let rehearsalHistory: RewardsProfile["rehearsalHistory"];
  if (Object.hasOwn(p, "rehearsalHistory")) {
    insist(
      rehearsal &&
        Array.isArray(p.rehearsalHistory) &&
        p.rehearsalHistory.length > 0 &&
        p.rehearsalHistory.length <= 32,
      "reward_rehearsal_profile_invalid",
    );
    rehearsalHistory = (p.rehearsalHistory as unknown[]).map(rehearsalConfig);
    const ids = [...rehearsalHistory, rehearsal].map((r) => r.offerId);
    insist(
      new Set(ids).size === ids.length,
      "reward_rehearsal_profile_invalid",
    );
  }
  return {
    schema: "pirate.manual-rewards/1",
    programId: bytes32(p.programId),
    chainId: 6343,
    mode: p.mode,
    decimals: p.decimals,
    veryAppId: p.veryAppId,
    rpcUrl: p.rpcUrl,
    token: rewardAddress(p.token),
    operatorWallet: rewardAddress(p.operatorWallet),
    payoutWallet: rewardAddress(p.payoutWallet),
    ticketWallet: rewardAddress(p.ticketWallet),
    resultSourceHash: bytes32(p.resultSourceHash),
    ...(rehearsal ? { rehearsal } : {}),
    ...(rehearsalHistory ? { rehearsalHistory } : {}),
  };
}
/** Stable per program/network, independent of wallet, drawing, credit and request. */
export function rewardProgramScope(programId: string) {
  const scope = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint256" }],
      ["pirate-manual-rewards-scope/2", bytes32(programId), 6343n],
    ),
  );
  const mapped = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }],
      ["pirate-very-external-nullifier/2", scope],
    ),
  );
  const externalNullifier = (BigInt(mapped) & ((1n << 160n) - 1n)).toString();
  insist(externalNullifier !== "0", "invalid_reward_scope");
  return { scope, externalNullifier };
}
export function rewardSubject(scope: Hex, subject: string) {
  insist(
    /^[1-9][0-9]{0,76}$/.test(subject) &&
      BigInt(subject) <
        21888242871839275222246405745257275088548364400416034343698204186575808495617n,
    "invalid_reward_subject",
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint256" }],
      ["pirate-manual-rewards-subject/2", scope, BigInt(subject)],
    ),
  );
}
