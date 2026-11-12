// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import { formatUnits } from "viem";
import type {
  ClaimOutcome as RewardClaimOutcome,
  RewardCredit,
} from "../../../../../packages/rewards/contracts.ts";

export type WinningView = Readonly<{
  creditId: string;
  amount: string;
  status: string;
  detail: string | null;
  canClaim: boolean;
  /** Claimed and paid to the persona wallet, so it can be sent on. */
  canSend: boolean;
  sendActionLabel: string;
}>;

/**
 * Spec 015 §5.2a. Only participant pool winnings carry a claim; other credits
 * are paid without one and are not listed here. The amount shown is the
 * confirmed credit, never a projection (§5.2a.1).
 */
export function winningViews(
  credits: readonly RewardCredit[],
): readonly WinningView[] {
  return credits.flatMap((credit): WinningView[] => {
    const claim = credit.claim;
    if (claim === null) return [];
    const amount = `${formatUnits(BigInt(credit.amount_atomic), credit.token_decimals)} test USDm`;
    const base = {
      creditId: credit.credit_id,
      amount,
      canSend: false,
      sendActionLabel: "Send",
    };
    if (claim.status === "unclaimed") {
      return [
        {
          ...base,
          status: "Held for you",
          detail: "Verify with a palm scan to claim it.",
          canClaim: BigInt(credit.amount_atomic) > BigInt(credit.paid_atomic),
        },
      ];
    }
    if (claim.status === "subject_conflict") {
      return [
        {
          ...base,
          status: "Held",
          detail:
            "This palm scan is linked to another reward account. Your amount stays held; contact support.",
          canClaim: false,
        },
      ];
    }
    switch (claim.payout_status) {
      case "confirmed":
        return [
          {
            ...base,
            status: "Sent to your wallet",
            detail: null,
            canClaim: false,
            canSend:
              credit.chain_id === 6343 &&
              credit.paid_atomic === credit.amount_atomic &&
              credit.claim.status === "accepted",
          },
        ];
      case "awaiting_payment":
        return [
          {
            ...base,
            status: "Claimed",
            detail: "Awaiting payment. Payments are processed daily.",
            canClaim: false,
          },
        ];
      default:
        return [
          {
            ...base,
            status: "Claimed",
            detail: "Sending to your wallet.",
            canClaim: false,
          },
        ];
    }
  });
}

export type ClaimStep =
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "verify" }>
  | Readonly<{ kind: "held" }>
  | Readonly<{ kind: "support" }>
  | Readonly<{ kind: "unavailable" }>;

export function claimStep(outcome: RewardClaimOutcome): ClaimStep {
  switch (outcome) {
    case "accepted":
      return { kind: "done" };
    case "verification_missing":
    case "verification_stale":
      return { kind: "verify" };
    // Evidence for more than one Very subject is refused permanently; another
    // scan cannot fix it, so never send the user back round the scan.
    case "subject_conflict":
      return { kind: "held" };
    default:
      return { kind: "unavailable" };
  }
}

/** Same-origin return path that resumes one claim after the palm scan. */
export function verifyToClaimUrl(creditId: string): string {
  const returnTo = `/wallet?claim=${encodeURIComponent(creditId)}`;
  return `/verify/very?purpose=reward_claim&return_to=${encodeURIComponent(returnTo)}`;
}
