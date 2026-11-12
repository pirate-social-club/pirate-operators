import type {
  RewardCredit,
  RewardWalletView,
} from "../../../../packages/rewards/contracts.ts";

import {
  assertRewardCreditOwner,
  rewardWalletOwner,
} from "./private-reward-scope.ts";

export function rewardSummary(view: RewardWalletView, credits: RewardCredit[]) {
  assertRewardCreditOwner(credits, rewardWalletOwner(view));
  let earned = 0n,
    pending = 0n,
    claimable = 0n,
    held = 0n,
    awaiting = 0n;
  const seen = new Set<string>();
  for (const credit of credits) {
    if (seen.has(credit.credit_id)) throw Error("Duplicate reward credit.");
    seen.add(credit.credit_id);
    if (
      credit.chain_id !== view.chainId ||
      credit.token_address.toLowerCase() !== view.token.toLowerCase() ||
      credit.token_decimals !== view.decimals ||
      !/^(0|[1-9][0-9]*)$/.test(credit.amount_atomic) ||
      !/^(0|[1-9][0-9]*)$/.test(credit.paid_atomic)
    )
      throw Error("Reward currency changed. Reload to check again.");
    const amount = BigInt(credit.amount_atomic),
      paid = BigInt(credit.paid_atomic);
    if (paid > amount) throw Error("Invalid reward accounting.");
    const unpaid = amount - paid;
    earned += amount;
    pending += unpaid;
    if (credit.claim.status === "unclaimed") claimable += unpaid;
    else if (credit.claim.status === "subject_conflict") held += unpaid;
    else awaiting += unpaid;
  }
  return Object.fromEntries(
    Object.entries({ earned, pending, claimable, held, awaiting }).map(
      ([key, value]) => [key, value.toString()],
    ),
  ) as Record<"earned" | "pending" | "claimable" | "held" | "awaiting", string>;
}

export function drawingStatus(drawing: RewardWalletView["drawings"][number]) {
  if (drawing.qualified === false)
    return "You did not qualify for this drawing.";
  if (drawing.state === "no_prize") return "This drawing had no prize.";
  if (drawing.qualified === null) return "Eligibility is still being checked.";
  if (drawing.state === "open" || drawing.state === "closed")
    return "Drawing pending. A prize is not guaranteed.";
  return "Lottery winnings recorded.";
}
