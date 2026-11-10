// Self-contained: this file is copied alongside the packaged Alchemy application.
// Semantic V3 selection never renames the physical Worker or object namespaces.
type Environment = Readonly<Record<string, string | undefined>>;
const v2 = "pirate-karaoke-testnet-v2",
  v3 = "pirate-learning-testnet-v3";
export function learningContractBindings(env: Environment) {
  const profile = env.LEARNING_PROFILE ?? v2,
    contract = env.LEARNING_RESULTS_CONTRACT,
    successor = env.LEARNING_RESULTS_V3_CONTRACT;
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
            env.LEARNING_SPEECH_DAILY_LIMIT === "0"))
    )
  )
    throw new Error("learning_release_contract_binding_invalid");
  return {
    OPERATOR_PROFILE: profile,
    RESULTS_V2_CONTRACT: contract!,
    ...(profile === v3 ? { RESULTS_V3_CONTRACT: successor! } : {}),
  };
}
export function applicationLearningBindings(env: Environment) {
  if (!env.LEARNING_PROFILE && !env.LEARNING_RESULTS_V3_CONTRACT) return {};
  const binding = learningContractBindings(env);
  return binding.OPERATOR_PROFILE === v3
    ? { STUDY_RESULTS_V3_CONTRACT: binding.RESULTS_V3_CONTRACT! }
    : {};
}
