import type { AcceptedIntent } from "./intent.ts";
import { sha256 } from "viem";
import {
  bytes32,
  exact,
  insist,
  integer,
  object,
  text,
} from "../community/common.ts";
import { identifyMp3, type AcrCredentials } from "../moderation/acrcloud.ts";
import {
  providerFetch,
  providerJson,
  type ProviderResponse,
  type ProviderTransport,
} from "../moderation/provider-http.ts";
import type { EnrollmentDependencies, Verification } from "./worker.ts";
import type { Recording, VerifiedPublication } from "./model.ts";

export interface VerificationOptions {
  credentials: AcrCredentials;
  sample(
    publication: VerifiedPublication | AcceptedIntent,
    signal: AbortSignal,
  ): Promise<{
    bytes: Uint8Array;
    sampleSha256: string;
    canonicalAudioSha256: string;
  }>;
  received(recording: Recording, receipt: ProviderResponse): Promise<void>;
  transport?: ProviderTransport;
}
/** Reads all retained candidates from the persisted provider response, independent
 * of the V1 summary parser that intentionally exposes only its first candidate. */
export function catalogVerification(
  options: VerificationOptions,
): EnrollmentDependencies["verify"] {
  return async (r, p, signal, beforeSend) => {
    const sample = await options.sample(p, signal);
    insist(
      sample.canonicalAudioSha256 === r.audio_sha256 &&
        sha256(sample.bytes) === sample.sampleSha256,
      "recognition_verification_sample_changed",
      409,
    );
    signal.throwIfAborted();
    let receipt: ProviderResponse | undefined;
    await identifyMp3(
      sample.bytes,
      options.credentials,
      async (value) => {
        await options.received(r, value);
        receipt = value;
      },
      {
        async request(request) {
          await beforeSend();
          signal.throwIfAborted();
          return (options.transport ?? providerFetch).request(
            new Request(request, {
              signal: AbortSignal.any([request.signal, signal]),
            }),
          );
        },
      },
    );
    insist(receipt, "recognition_verification_receipt_missing", 503);
    return verificationFromReceipt(r, receipt);
  };
}

export function verificationFromReceipt(
  r: Recording,
  value: unknown,
): Verification {
  const v = object(value);
  exact(v, ["status", "contentType", "requestId", "body", "bodySha256"]);
  const receipt: ProviderResponse = {
    status: integer(v.status, 100, 599),
    contentType: text(v.contentType, 256),
    requestId: v.requestId === null ? null : text(v.requestId, 256),
    body: text(v.body, 1024 * 1024),
    bodySha256: bytes32(v.bodySha256),
  };
  const status = object(providerJson(receipt).status);
  // Console processing readiness can precede identification-index visibility.
  // A known no-match is inconclusive here and can retry under the quota port.
  if (status.code === 2004 || status.code === 1001)
    return { outcome: "waiting" };
  if (status.code !== 0) return { outcome: "rejected" };
  const metadata = object(providerJson(receipt).metadata),
    retained: { kind: string; id: string }[] = [];
  for (const kind of ["music", "custom_files"]) {
    const rows = metadata[kind] ?? [];
    insist(
      Array.isArray(rows) && rows.length <= 64,
      "recognition_candidates_invalid",
      503,
    );
    for (const input of rows) {
      const row = object(input),
        meta =
          row.user_defined === undefined || row.user_defined === null
            ? {}
            : object(row.user_defined);
      if (meta.content_type === "video_audio") continue;
      insist(
        typeof row.acrid === "string" && row.acrid.length > 0,
        "recognition_candidates_invalid",
        503,
      );
      retained.push({ kind, id: row.acrid });
    }
  }
  return retained.length === 1 &&
    retained[0]!.kind === "custom_files" &&
    retained[0]!.id === r.provider_match_id
    ? {
        outcome: "match",
        matchId: r.provider_match_id!,
        evidenceSha256: receipt.bodySha256,
      }
    : { outcome: "rejected" };
}
