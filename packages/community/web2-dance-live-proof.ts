/** Extension to the private native publication live readback. The usual
 * unsigned-consent readback has no Dance header or response field. */
export const web2DanceLiveProofHeader = "X-Pirate-Dance-Live-Proof";

export interface Web2DanceLiveProof {
  rewardSha256: string | null;
  scopeSha256?: string | null;
}

export function web2DanceLiveProofMode(proof: Web2DanceLiveProof) {
  if (proof.rewardSha256 === null) return "dormant";
  if (proof.scopeSha256 === undefined) return "reward";
  return proof.scopeSha256 === null ? "reward-only" : "scope";
}
