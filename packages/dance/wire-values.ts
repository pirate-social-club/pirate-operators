import { insist } from "../community/common.ts";
import { rewardId } from "../rewards/validation.ts";
import type { DanceCapture, DanceSourcePin } from "./contracts.ts";
const ZERO = "0x" + "00".repeat(32);
/** Values/preimages ONLY. Root owns exact final ABI/keccak implementation. */
export function offerIdPreimage(
  originalAsciiOfferId: string,
  source: DanceSourcePin,
) {
  rewardId(originalAsciiOfferId);
  return {
    domain: "pirate.dance-offer-id/1",
    chainId: source.chainId,
    contractAddress: source.address,
    communityId: source.communityId,
    originalAsciiOfferId,
  };
}
export function optionalOffer(c: DanceCapture) {
  const o = c.offer;
  return o
    ? {
        present: true,
        offerIdCommitment: o.offerIdCommitment,
        inputHash: o.inputHash,
        sourceHash: o.sourceHash,
        opensAtMs: o.opensAtMs,
        cutoffAtMs: o.cutoffAtMs,
      }
    : {
        present: false,
        offerIdCommitment: ZERO,
        inputHash: ZERO,
        sourceHash: ZERO,
        opensAtMs: 0,
        cutoffAtMs: 0,
      };
}
export function optionalReference(c: DanceCapture) {
  const r = c.reference;
  insist(
    Number.isSafeInteger(c.startSample + c.durationSamples) &&
      c.startSample >= 0 &&
      c.durationSamples >= 288000 &&
      c.durationSamples <= 1440000 &&
      c.startSample + c.durationSamples <= c.songDurationSamples,
    "dance_interval_invalid",
  );
  return {
    present: !!r,
    id: r?.id ?? ZERO,
    revision: r?.revision ?? 0,
    epoch: r?.epoch ?? 0,
    segmentLayoutSha256: r?.segmentLayoutSha256 ?? ZERO,
    segmentId: r?.segmentId ?? ZERO,
    startSample: c.startSample,
    durationSamples: c.durationSamples,
  };
}
