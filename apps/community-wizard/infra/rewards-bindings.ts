// Self-contained copy in the reviewed Alchemy package. No ambient default enables rewards.
export function applicationRewardsBindings(
  env: Readonly<Record<string, string | undefined>>,
) {
  const profile = env.REWARDS_PROFILE_JSON,
    source = env.REWARDS_RESULT_SOURCE_JSON;
  if (profile === undefined && source === undefined) return {};
  if (!profile || !source) throw Error("reward_release_binding_missing");
  const p = JSON.parse(profile),
    s = JSON.parse(source);
  if (
    p.schema !== "pirate.manual-rewards/1" ||
    p.mode !== "live-testnet" ||
    p.chainId !== 6343 ||
    p.operatorWallet !== p.payoutWallet ||
    s.schema !== "pirate.reward-result-source/1"
  )
    throw Error("reward_release_binding_invalid");
  if (p.rehearsal !== undefined) {
    const r = p.rehearsal;
    if (
      !r ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      Object.keys(r).sort().join(",") !== "offerId,prizeUsdcAtomic,schema" ||
      r.schema !== "pirate.reward-rehearsal/1" ||
      typeof r.offerId !== "string" ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(r.offerId) ||
      typeof r.prizeUsdcAtomic !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(r.prizeUsdcAtomic) ||
      !Number.isInteger(p.decimals) ||
      p.decimals < 6 ||
      p.decimals > 18 ||
      BigInt(r.prizeUsdcAtomic) * 10n ** BigInt(p.decimals - 6) >= 2n ** 256n
    )
      throw Error("reward_release_binding_invalid");
  }
  return { REWARDS_PROFILE_JSON: profile, REWARDS_RESULT_SOURCE_JSON: source };
}
