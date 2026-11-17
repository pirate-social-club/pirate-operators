import { digest } from "../packages/protocol/index.ts";
import { StudyError, studyCheck } from "../packages/study/contracts.ts";
import { studyPrivateV5Profile } from "../packages/study/private-v5.ts";
import type { SpeechAdmissionEnv } from "./study-speech-reservation.ts";
import type { SpeechAdmissionPolicy } from "./study-speech-admission.ts";

export interface StudyPrivateV5Env extends SpeechAdmissionEnv {
  STUDY_PRIVATE_V5_PROFILE?: string;
  ELEVENLABS_API_KEY?: string;
}
/** No legacy unbounded/zero daily limit. Both trusted processes must select the
 * exact reviewed generation and nonzero reserved website Study budget. */
export function privateStudyV5Profile(
  env: StudyPrivateV5Env,
  communityId: string,
) {
  try {
    studyCheck(
      env.STUDY_PRIVATE_V5_PROFILE &&
        env.SPEECH_ADMISSION_CONFIG &&
        env.SPEECH_BUDGET,
      "study_private_v5_runtime_required",
      503,
    );
    const profile = studyPrivateV5Profile(
      JSON.parse(env.STUDY_PRIVATE_V5_PROFILE),
    );
    const policy = JSON.parse(
      env.SPEECH_ADMISSION_CONFIG,
    ) as SpeechAdmissionPolicy;
    studyCheck(
      Object.keys(policy).sort().join() ===
        [
          "communityId",
          "keyGeneration",
          "dailyUnits",
          "websiteStudyReservedUnits",
          "telegramTrialUnits",
        ]
          .sort()
          .join() &&
        profile.communityId === communityId &&
        policy.communityId === communityId &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(policy.keyGeneration) &&
        [
          policy.dailyUnits,
          policy.websiteStudyReservedUnits,
          policy.telegramTrialUnits,
        ].every(Number.isSafeInteger) &&
        policy.dailyUnits > 0 &&
        policy.websiteStudyReservedUnits > 0 &&
        policy.websiteStudyReservedUnits <= policy.dailyUnits &&
        policy.telegramTrialUnits >= 0 &&
        policy.telegramTrialUnits <=
          policy.dailyUnits - policy.websiteStudyReservedUnits &&
        profile.speechPolicyHash === digest(policy),
      "study_private_v5_speech_admission_required",
      503,
    );
    return profile;
  } catch (error) {
    if (error instanceof StudyError) throw error;
    throw new StudyError("study_private_v5_runtime_required", 503);
  }
}
