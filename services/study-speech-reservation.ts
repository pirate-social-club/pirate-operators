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
      async resolveDigest(
        _state: "succeeded" | "refused" | "unknown",
        _digest: string,
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
    async resolveDigest(
      state: "succeeded" | "refused" | "unknown",
      evidenceDigest: string,
    ) {
      check(/^0x[0-9a-f]{64}$/.test(evidenceDigest), "speech_evidence_invalid");
      await budget.resolve(requestId, state, evidenceDigest);
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

/** Internal compensation consumes the exact original observation hash; it
 * cannot recover or log the discarded private assessment content. */
export async function reconcileCommunitySpeechDigest(
  env: SpeechAdmissionEnv,
  requestId: string,
  state: "succeeded" | "refused",
  evidenceDigest: string,
) {
  if (!env.SPEECH_ADMISSION_CONFIG) return;
  check(/^0x[0-9a-f]{64}$/.test(evidenceDigest), "speech_evidence_invalid");
  check(env.SPEECH_BUDGET, "speech_budget_unconfigured");
  const policy = JSON.parse(
    env.SPEECH_ADMISSION_CONFIG,
  ) as SpeechAdmissionPolicy;
  await env.SPEECH_BUDGET.getByName(speechAdmissionObjectName(policy)).resolve(
    requestId,
    state,
    evidenceDigest,
  );
}
