import { canonical, hashJson, insist } from "../community/common.ts";
import type {
  RewardOfferInput,
  RewardRehearsalTerms,
  RewardSources,
  RewardsProfile,
} from "./contracts.ts";

/** Immutable opt-in: one mock external drawing within a real testnet program. */
export function rehearsalTerms(
  profile: RewardsProfile,
): RewardRehearsalTerms | null {
  const config = profile.rehearsal;
  if (!config) return null;
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
    drawingId: "0",
    purchaseHash,
    ticketIds: [BigInt(purchaseHash).toString()],
  };
}

export function assertRehearsalOffer(
  profile: RewardsProfile,
  input: RewardOfferInput,
) {
  const terms = rehearsalTerms(profile);
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
  const terms = rehearsalTerms(profile);
  if (!terms) return live;
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
      if (input.offerId !== terms.offerId) return live.purchase(input, current);
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
      if (input.offerId !== terms.offerId)
        return live.winnings(input, current, claimHash);
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
