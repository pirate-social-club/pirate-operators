import type { RewardCloseReadinessV1 } from "./contracts.ts";

/** Server projection of the existing rule: opening is inclusive, cutoff exclusive for entries. */
export function rewardCloseReadiness(
  offers: { offerId: string; cutoffAt: number; state: string }[],
  checkedAt: number,
  confirmedTimestamp: number | null,
): RewardCloseReadinessV1 {
  return {
    schema: "pirate.reward-close-readiness/1",
    checkedAt,
    offers: Object.fromEntries(
      offers
        .filter((offer) => offer.state === "open")
        .map((offer) => [
          offer.offerId,
          {
            cutoffAt: offer.cutoffAt,
            state:
              checkedAt < offer.cutoffAt
                ? "before_cutoff"
                : confirmedTimestamp === null
                  ? "unavailable"
                  : confirmedTimestamp < offer.cutoffAt
                    ? "awaiting_confirmation"
                    : "ready",
            ...(confirmedTimestamp === null ? {} : { confirmedTimestamp }),
          },
        ]),
    ),
  };
}

/** A browser clock is never evidence that the chain has confirmed a cutoff. */
export function closeAvailability(
  offer: { offerId: string; cutoffAt: number; state: string },
  readiness: RewardCloseReadinessV1 | undefined,
  now = Date.now(),
) {
  const row = readiness?.offers?.[offer.offerId];
  if (offer.state !== "open")
    return { ready: false, reason: "Entries already closed." };
  if (
    readiness?.schema !== "pirate.reward-close-readiness/1" ||
    !Number.isSafeInteger(readiness.checkedAt) ||
    readiness.checkedAt > now + 30000 ||
    now - readiness.checkedAt > 60000 ||
    row?.cutoffAt !== offer.cutoffAt
  )
    return { ready: false, reason: "Refresh to check chain confirmation." };
  if (row.state === "before_cutoff")
    return { ready: false, reason: "Entries are still open until the cutoff." };
  if (row.state === "awaiting_confirmation")
    return {
      ready: false,
      reason:
        "Waiting for the chain to confirm the cutoff. This can take several minutes.",
    };
  if (
    row.state === "ready" &&
    Number.isSafeInteger(row.confirmedTimestamp) &&
    row.confirmedTimestamp! >= offer.cutoffAt &&
    readiness.checkedAt >= offer.cutoffAt
  )
    return { ready: true, reason: "Cutoff confirmed on chain." };
  return {
    ready: false,
    reason: "Chain confirmation is unavailable. Refresh to check again.",
  };
}
