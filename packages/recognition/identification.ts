import { identifyMp3, type AcrCredentials } from "../moderation/acrcloud.ts";
import type {
  ProviderTransport,
  ProviderResponse,
} from "../moderation/provider-http.ts";
export interface MediaIdentificationRequest {
  version: "media-identification-request-v1";
  operationId: string;
  audioRevision: number;
  analysisRevision: number;
  canonicalAudioSha256: string;
  requestId: string;
  signal: AbortSignal;
  sample: { bytes: Uint8Array; filename: string; contentType: string };
}
export type MediaIdentificationOutcome = {
  outcome: "retained_reference_match" | "retryable_failure" | "rejected";
  context: {
    operationId: string;
    audioRevision: number;
    analysisRevision: number;
    canonicalAudioSha256: string;
    adapterRevision: string;
  };
  evidence: {
    provider: "acrcloud";
    matchKind: string;
    providerMatchId: string;
  };
};
export interface MediaIdentificationProviderService {
  identify(
    request: MediaIdentificationRequest,
  ): Promise<MediaIdentificationOutcome>;
}
export function catalogIdentification(
  credentials: AcrCredentials,
  adapterRevision: string,
  received: (receipt: ProviderResponse) => Promise<void>,
  transport?: ProviderTransport,
): MediaIdentificationProviderService {
  return {
    async identify(request) {
      request.signal.throwIfAborted();
      const result = await identifyMp3(
        request.sample.bytes,
        credentials,
        received,
        transport
          ? {
              request: (req) =>
                transport.request(
                  new Request(req, {
                    signal: AbortSignal.any([request.signal, req.signal]),
                  }),
                ),
            }
          : undefined,
      );
      const match = result.details.match as
        | { kind?: string; id?: string }
        | undefined;
      return {
        outcome:
          result.code === 0 &&
          Array.isArray(result.details.matches) &&
          result.details.matches.length === 1 &&
          match?.kind === "custom_files"
            ? "retained_reference_match"
            : "rejected",
        context: {
          operationId: request.operationId,
          audioRevision: request.audioRevision,
          analysisRevision: request.analysisRevision,
          canonicalAudioSha256: request.canonicalAudioSha256,
          adapterRevision,
        },
        evidence: {
          provider: "acrcloud",
          matchKind: match?.kind === "custom_files" ? "custom" : "music",
          providerMatchId: match?.id ?? "",
        },
      };
    },
  };
}
