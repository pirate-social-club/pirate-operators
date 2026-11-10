import { check, digest } from "../packages/protocol/index.ts";
import {
  speechAdmissionObjectName,
  type SpeechAdmissionPolicy,
  type SpeechChannel,
} from "./study-speech-admission.ts";
import type { SpeechBudget } from "./speech-budget.ts";

export interface SpeechAdmissionEnv {
  SPEECH_ADMISSION_CONFIG?: string;
  SPEECH_BUDGET?: DurableObjectNamespace<SpeechBudget>;
}
/** Only trusted server adapters choose a channel. Identity and generation come
 * from managed deployment configuration, never from the caller's request. */
export async function reserveCommunitySpeech(
  env: SpeechAdmissionEnv,
  channel: SpeechChannel,
  requestId: string,
  payloadDigest: string,
  units = 1,
) {
  check(env.SPEECH_BUDGET, "speech_budget_unconfigured");
  if (!env.SPEECH_ADMISSION_CONFIG) {
    await env.SPEECH_BUDGET.getByName("elevenlabs-service").claim();
    return {
      async resolve(
        _state: "succeeded" | "refused" | "unknown",
        _evidence: unknown,
      ) {},
    };
  }
  const policy = JSON.parse(
    env.SPEECH_ADMISSION_CONFIG,
  ) as SpeechAdmissionPolicy;
  const budget = env.SPEECH_BUDGET.getByName(speechAdmissionObjectName(policy));
  await budget.reserve({
    communityId: policy.communityId,
    keyGeneration: policy.keyGeneration,
    channel,
    requestId,
    payloadDigest,
    units,
  });
  const result = await budget.dispatch(requestId);
  check(result.dispatch, "speech_dispatch_already_claimed");
  return {
    async resolve(
      state: "succeeded" | "refused" | "unknown",
      evidence: unknown,
    ) {
      await budget.resolve(requestId, state, digest(evidence));
    },
  };
}

export async function reconcileCommunitySpeech(
  env: SpeechAdmissionEnv,
  requestId: string,
  state: "succeeded" | "refused",
  evidence: unknown,
) {
  if (!env.SPEECH_ADMISSION_CONFIG) return;
  check(env.SPEECH_BUDGET, "speech_budget_unconfigured");
  const policy = JSON.parse(
    env.SPEECH_ADMISSION_CONFIG,
  ) as SpeechAdmissionPolicy;
  await env.SPEECH_BUDGET.getByName(speechAdmissionObjectName(policy)).resolve(
    requestId,
    state,
    digest(evidence),
  );
}
