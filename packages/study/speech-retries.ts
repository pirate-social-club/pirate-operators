import {
  StudySpeechError,
  type StudyTranscriber,
} from "./speech-transcriber.ts";

/** Only an explicit rate-limit refusal proves speech was not processed.
 * Connection errors, timeouts and malformed success never permit redispatch. */
export function withSafeStudySpeechRetries(
  provider: StudyTranscriber,
  pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
): StudyTranscriber {
  return {
    providerRetention: provider.providerRetention,
    ...(provider.recover ? { recover: provider.recover.bind(provider) } : {}),
    async transcribe(...input) {
      for (let retry = 0; ; retry++) {
        try {
          return await provider.transcribe(...input);
        } catch (error) {
          if (
            !(error instanceof StudySpeechError) ||
            error.outcome !== "known_failed" ||
            error.code !== "speech_rate_limited" ||
            retry >= 2
          )
            throw error;
          await pause(250 * (retry + 1));
        }
      }
    },
  };
}
