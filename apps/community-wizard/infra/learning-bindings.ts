// Self-contained: this file is copied alongside the packaged Alchemy application.
// Semantic V3 selection never renames the physical Worker or object namespaces.
// The V4 contract is optional and absent unless explicitly supplied, so a
// deployment without it binds exactly what it did before.
type Environment = Readonly<Record<string, string | undefined>>;
const v2 = "pirate-karaoke-testnet-v2",
  v3 = "pirate-learning-testnet-v3";
export function learningContractBindings(env: Environment) {
  const profile = env.LEARNING_PROFILE ?? v2,
    contract = env.LEARNING_RESULTS_CONTRACT,
    successor = env.LEARNING_RESULTS_V3_CONTRACT,
    v4 = env.LEARNING_RESULTS_V4_CONTRACT;
  const address = (v?: string) =>
    !!v && /^0x[0-9a-f]{40}$/.test(v) && BigInt(v) !== 0n;
  if (
    !(
      (profile === v2 || profile === v3) &&
      address(contract) &&
      (profile === v2
        ? !successor
        : address(successor) &&
          successor !== contract &&
          (!env.LEARNING_SPEECH_DAILY_LIMIT ||
            env.LEARNING_SPEECH_DAILY_LIMIT === "0")) &&
      // V4 succeeds V3 for new work; V2 and V3 stay bound for historical work.
      (v4 === undefined ||
        (profile === v3 &&
          address(v4) &&
          v4 !== contract &&
          v4 !== successor))
    )
  )
    throw new Error("learning_release_contract_binding_invalid");
  return {
    OPERATOR_PROFILE: profile,
    RESULTS_V2_CONTRACT: contract!,
    ...(profile === v3 ? { RESULTS_V3_CONTRACT: successor! } : {}),
    ...(v4 !== undefined ? { RESULTS_V4_CONTRACT: v4 } : {}),
  };
}
export function applicationLearningBindings(env: Environment) {
  if (
    !env.LEARNING_PROFILE &&
    !env.LEARNING_RESULTS_V3_CONTRACT &&
    env.LEARNING_RESULTS_V4_CONTRACT === undefined
  )
    return {};
  const binding = learningContractBindings(env);
  return binding.OPERATOR_PROFILE === v3
    ? {
        STUDY_RESULTS_V3_CONTRACT: binding.RESULTS_V3_CONTRACT!,
        ...(binding.RESULTS_V4_CONTRACT !== undefined
          ? { STUDY_RESULTS_V4_CONTRACT: binding.RESULTS_V4_CONTRACT }
          : {}),
      }
    : {};
}
