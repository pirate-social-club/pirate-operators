import type { Address, Hex } from "viem";
import { hashJson, insist } from "../community/common.ts";
import { songKeyOf } from "../protocol/records.ts";
import type {
  QualificationEntry,
  RewardOfferInput,
} from "../rewards/contracts.ts";
import { offerInput } from "../rewards/offers.ts";
import { rewardId } from "../rewards/validation.ts";
import type { DanceCanonicalSource, VerifiedDanceVerdict } from "./reader.ts";
import {
  danceAccountCommitment,
  danceOfferId,
  type DanceCapture,
} from "./wire.ts";

export interface CapturedDanceAccount {
  accountId: string;
  wallet: Address;
  accountCommitment: Hex;
  identityEpoch: bigint;
}
export interface DanceQualificationProofs {
  /** Read retained immutable captures; a current credential lookup is insufficient. */
  capturedAccount(
    sourceHash: Hex,
    commitment: Hex,
    identityEpoch: bigint,
  ): Promise<CapturedDanceAccount | null>;
  /** Authenticate the exact historical song and audio bytes at the verdict position. */
  authenticateSong(
    song: DanceCapture["song"],
    block: bigint,
    blockHash: Hex,
  ): Promise<boolean>;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function qualifyDanceVerdict(
  source: DanceCanonicalSource,
  verdict: VerifiedDanceVerdict,
  offer: RewardOfferInput,
  frozenInputHash: string,
  proofs: DanceQualificationProofs,
): Promise<QualificationEntry | null> {
  const bound = verdict.capture.offer;
  const { song } = verdict.capture;
  insist(
    hashJson(offerInput(offer)) === frozenInputHash,
    "reward_offer_input_changed",
    503,
  );
  if (
    !offer.resultSources?.some((hash) => same(hash, source.sourceHash)) ||
    !same(verdict.sourceHash, source.sourceHash) ||
    !bound.present ||
    !same(
      bound.offerIdCommitment,
      danceOfferId(source.domain, offer.offerId),
    ) ||
    !same(bound.inputHash, frozenInputHash) ||
    !same(bound.sourceHash, source.sourceHash) ||
    bound.opensAtMs !== BigInt(offer.opensAt) ||
    bound.cutoffAtMs !== BigInt(offer.cutoffAt) ||
    songKeyOf({ ...song, chainId: Number(song.chainId) }) !== offer.songKey ||
    verdict.verdict !== "pass" ||
    !verdict.withinFrozenOfferWindow ||
    verdict.committedAtMs < offer.opensAt ||
    verdict.committedAtMs >= offer.cutoffAt
  )
    return null;
  const [account, songVerified] = await Promise.all([
    proofs.capturedAccount(
      source.sourceHash,
      verdict.learnerAccountCommitment,
      verdict.capture.identityEpoch,
    ),
    proofs.authenticateSong(
      song,
      verdict.provenance.blockNumber,
      verdict.provenance.blockHash,
    ),
  ]);
  insist(songVerified, "dance_historical_song_unverified", 503);
  insist(
    account &&
      account.identityEpoch === verdict.capture.identityEpoch &&
      same(account.wallet, verdict.learner) &&
      same(account.accountCommitment, verdict.learnerAccountCommitment) &&
      same(
        danceAccountCommitment(
          source.domain,
          account.accountId,
          account.wallet,
        ),
        account.accountCommitment,
      ),
    "dance_historical_account_unverified",
    503,
  );
  return {
    accountId: rewardId(account.accountId),
    wallet: account.wallet.toLowerCase(),
    evidenceHash: verdict.evidenceHash,
    completedAt: verdict.committedAtMs,
  };
}
