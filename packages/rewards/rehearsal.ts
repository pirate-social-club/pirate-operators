import { canonical, hashJson, insist } from "../community/common.ts";
import type {
  RewardOfferInput,
  RewardRehearsal,
  RewardRehearsalTerms,
  RewardSources,
  RewardsProfile,
} from "./contracts.ts";

function all(profile: RewardsProfile): RewardRehearsal[] {
  return [
    ...(profile.rehearsalHistory ?? []),
    ...(profile.rehearsal ? [profile.rehearsal] : []),
  ];
}

/**
 * A rehearsal's fictional drawing is its position in the append-only list, so
 * the original keeps drawing 0 and each successor gets its own drawing slot
 * for the same song. Live Megapot drawings that low are long past.
 */
function termsOf(
  profile: RewardsProfile,
  config: RewardRehearsal,
): RewardRehearsalTerms {
  const ordinal = all(profile).findIndex((r) => r.offerId === config.offerId);
  insist(
    profile.mode === "live-testnet" && profile.chainId === 6343,
    "reward_rehearsal_profile_invalid",
    409,
  );
  const purchaseHash = hashJson({
    schema: "pirate.simulated-ticket/1",
    programId: profile.programId,
    rehearsal: config,
  });
  return {
    ...config,
    drawingId: String(ordinal),
    purchaseHash,
    ticketIds: [BigInt(purchaseHash).toString()],
  };
}

/** The one rehearsal that may still be attached. */
export function rehearsalTerms(
  profile: RewardsProfile,
): RewardRehearsalTerms | null {
  return profile.rehearsal ? termsOf(profile, profile.rehearsal) : null;
}

/** Current or retired rehearsal terms; a retired offer keeps its original terms. */
export function rehearsalTermsFor(
  profile: RewardsProfile,
  offerId: string,
): RewardRehearsalTerms | null {
  const config = all(profile).find((r) => r.offerId === offerId);
  return config ? termsOf(profile, config) : null;
}

export function isRetiredRehearsal(profile: RewardsProfile, offerId: string) {
  return (profile.rehearsalHistory ?? []).some((r) => r.offerId === offerId);
}

/**
 * Each earlier profile this one rolled over from, nearest first. A rollover
 * retires the current rehearsal and names a new one, and changes nothing else,
 * so every predecessor is derivable from its successor exactly.
 */
export function rewardProfileAncestors(
  profile: RewardsProfile,
): RewardsProfile[] {
  const found: RewardsProfile[] = [];
  let current = profile;
  while (current.rehearsalHistory?.length) {
    const history = current.rehearsalHistory;
    const { rehearsalHistory: _, ...rest } = current;
    current = {
      ...rest,
      rehearsal: history.at(-1)!,
      ...(history.length > 1 ? { rehearsalHistory: history.slice(0, -1) } : {}),
    };
    found.push(current);
  }
  return found;
}

/** True only when `next` is exactly one rehearsal rollover of `previous`. */
export function isRehearsalRollover(
  previous: RewardsProfile,
  next: RewardsProfile,
) {
  const parent = rewardProfileAncestors(next)[0];
  // The new rehearsal keeps the retired one's prize, so a rollover cannot
  // enlarge the program's obligations.
  return (
    !!parent &&
    canonical(parent) === canonical(previous) &&
    next.rehearsal!.prizeUsdcAtomic === parent.rehearsal!.prizeUsdcAtomic
  );
}

export function assertRehearsalOffer(
  profile: RewardsProfile,
  input: RewardOfferInput,
) {
  const terms = rehearsalTermsFor(profile, input.offerId);
  insist(
    terms &&
      input.offerId === terms.offerId &&
      input.drawingId === terms.drawingId &&
      input.purchaseHash === terms.purchaseHash &&
      canonical(input.ticketIds) === canonical(terms.ticketIds),
    "reward_rehearsal_offer_changed",
    409,
  );
  return terms;
}

/** Only external purchase/settlement are simulated. Qualifiers retain their real reader. */
export function withRewardRehearsal(
  profile: RewardsProfile,
  live: RewardSources,
): RewardSources {
  if (!profile.rehearsal) return live;
  insist(live.mode === "live-testnet", "reward_rehearsal_source_invalid", 409);
  return {
    mode: live.mode,
    qualifiers: live.qualifiers,
    async purchase(input, current) {
      insist(
        canonical(current) === canonical(profile),
        "reward_rehearsal_profile_changed",
        409,
      );
      insist(
        !isRetiredRehearsal(profile, input.offerId),
        "reward_rehearsal_retired",
        409,
      );
      if (input.offerId !== profile.rehearsal!.offerId)
        return live.purchase(input, current);
      assertRehearsalOffer(profile, input);
      return {
        mode: "simulated",
        receiptHash: hashJson({
          schema: "pirate.simulated-purchase/1",
          programId: profile.programId,
          input,
        }),
      };
    },
    async winnings(input, current, claimHash) {
      insist(
        canonical(current) === canonical(profile),
        "reward_rehearsal_profile_changed",
        409,
      );
      const terms = rehearsalTermsFor(profile, input.offerId);
      if (!terms) return live.winnings(input, current, claimHash);
      assertRehearsalOffer(profile, input);
      insist(
        claimHash === undefined,
        "reward_rehearsal_has_no_collection_transaction",
        409,
      );
      return {
        mode: "simulated",
        usdcAtomic: terms.prizeUsdcAtomic,
        receiptHash: hashJson({
          schema: "pirate.simulated-settlement/1",
          programId: profile.programId,
          input,
          prizeUsdcAtomic: terms.prizeUsdcAtomic,
        }),
      };
    },
  };
}
