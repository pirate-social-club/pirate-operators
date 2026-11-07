import type { Env } from "./runtime.ts";

/** Both releases keep the existing operator and shared speech object identities. */
export const isLearningProfile = (env: Pick<Env, "OPERATOR_PROFILE">) =>
  env.OPERATOR_PROFILE === "pirate-karaoke-testnet-v2" ||
  env.OPERATOR_PROFILE === "pirate-learning-testnet-v3";

export function admittedLearningProfile(env: Env) {
  const version = env.OPERATOR_PROFILE === "pirate-learning-testnet-v3" ? 3 : 2;
  const address = (value?: string) =>
    !!value && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0+$/i.test(value);
  return (
    isLearningProfile(env) &&
    env.ROLE === "operator" &&
    env.PAYMENT_CHAIN_ID === "6343" &&
    env.SERVICE_MODE === "internal" &&
    address(env.RESULTS_V2_CONTRACT) &&
    (version === 2
      ? !env.RESULTS_V3_CONTRACT
      : address(env.RESULTS_V3_CONTRACT) &&
        env.RESULTS_V3_CONTRACT!.toLowerCase() !==
          env.RESULTS_V2_CONTRACT!.toLowerCase()) &&
    !!env.SPEECH_BUDGET &&
    !!env.SPONSOR_CAP_WEI &&
    !!env.SPONSOR_GAS_PRICE_WEI &&
    !!env.SPONSOR_GAS_LIMIT &&
    !!env.SPONSOR_DATA_FEE_WEI
  );
}
