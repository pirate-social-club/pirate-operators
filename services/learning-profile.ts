import { COMMUNITY_LEARNING_PROFILE_V1 } from "../packages/community-setup/bindings.ts";
import { activationLimits, sponsorLimits } from "./sponsor-budget.ts";
import type { Env } from "./runtime.ts";

/** A fresh V4 community has no historical results destinations. */
export const isLearningProfile = (env: Pick<Env, "OPERATOR_PROFILE">) =>
  env.OPERATOR_PROFILE === "pirate-karaoke-testnet-v2" ||
  env.OPERATOR_PROFILE === "pirate-learning-testnet-v3" ||
  env.OPERATOR_PROFILE === COMMUNITY_LEARNING_PROFILE_V1;

export function admittedLearningProfile(env: Env) {
  const version = env.OPERATOR_PROFILE === "pirate-learning-testnet-v3" ? 3 : 2;
  const address = (value?: string) =>
    !!value && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0+$/i.test(value);
  const fresh = env.OPERATOR_PROFILE === COMMUNITY_LEARNING_PROFILE_V1;
  if (fresh) {
    try {
      const firstUse = activationLimits(env),
        fees = sponsorLimits(env);
      const data = env.SPONSOR_DATA_FEE_WEI;
      if (
        !data ||
        !/^(0|[1-9][0-9]{0,77})$/.test(data) ||
        firstUse.total > fees.cap ||
        2n * (fees.gas * fees.gasPrice + BigInt(data)) > firstUse.perAccount
      )
        return false;
    } catch {
      return false;
    }
  }
  const configuredTargets = fresh
    ? address(env.RESULTS_V4_CONTRACT) &&
      env.RESULTS_V2_CONTRACT === undefined &&
      env.RESULTS_V3_CONTRACT === undefined
    : address(env.RESULTS_V2_CONTRACT) &&
      (version === 2
        ? !env.RESULTS_V3_CONTRACT
        : address(env.RESULTS_V3_CONTRACT) &&
          env.RESULTS_V3_CONTRACT!.toLowerCase() !==
            env.RESULTS_V2_CONTRACT!.toLowerCase());
  return (
    isLearningProfile(env) &&
    env.ROLE === "operator" &&
    env.PAYMENT_CHAIN_ID === "6343" &&
    env.SERVICE_MODE === "internal" &&
    configuredTargets &&
    !!env.SPEECH_BUDGET &&
    !!env.SPONSOR_CAP_WEI &&
    !!env.SPONSOR_GAS_PRICE_WEI &&
    !!env.SPONSOR_GAS_LIMIT &&
    !!env.SPONSOR_DATA_FEE_WEI
  );
}
