// Independently owned first-song adapter. Protocol/response provenance is
// recorded in docs/moderation-source-provenance.json.
import {
  hashText,
  insist,
  integer,
  object,
  text,
} from "../community/common.ts";
import {
  providerFetch,
  providerJson,
  providerRequest,
  type ProviderResponse,
  type ProviderTransport,
} from "./provider-http.ts";

const hosts = new Set([
  "identify-eu-west-1.acrcloud.com",
  "identify-us-west-2.acrcloud.com",
  "identify-ap-southeast-1.acrcloud.com",
]);
export function acrEndpoint(host: string) {
  insist(hosts.has(host), "invalid_acrcloud_region", 503);
  return `https://${host}/v1/identify`;
}
export interface AcrCredentials {
  host: string;
  accessKey: string;
  accessSecret: string;
}
export type AcrResult = {
  code: 0 | 1001 | 2004;
  providerId: string;
  details: Record<string, unknown>;
};
export async function identifyMp3(
  sample: Uint8Array,
  credentials: AcrCredentials,
  received: (response: ProviderResponse) => Promise<void>,
  transport = providerFetch,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  insist(
    sample.length > 0 && sample.length <= 4000000,
    "invalid_acrcloud_sample",
    503,
  );
  const endpoint = acrEndpoint(credentials.host);
  insist(
    credentials.accessKey.length > 0 && credentials.accessSecret.length > 0,
    "acrcloud_credentials_missing",
    503,
  );
  const timestamp = String(integer(nowSeconds, 1, Number.MAX_SAFE_INTEGER));
  const content = [
    "POST",
    "/v1/identify",
    credentials.accessKey,
    "audio",
    "1",
    timestamp,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(credentials.accessSecret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content)),
  );
  const signature = btoa(String.fromCharCode(...signed));
  const form = new FormData();
  for (const [name, value] of Object.entries({
    access_key: credentials.accessKey,
    sample_bytes: String(sample.length),
    timestamp,
    signature,
    data_type: "audio",
    signature_version: "1",
  }))
    form.append(name, value);
  form.append(
    "sample",
    new Blob([new Uint8Array(sample)], { type: "audio/mpeg" }),
    "sample.mp3",
  );
  const request = new Request(endpoint, {
    method: "POST",
    body: form,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  return parseAcrResponse(await providerRequest(request, transport, received));
}
export function parseAcrResponse(response: ProviderResponse): AcrResult {
  const body = providerJson(response),
    status = object(body.status),
    code = integer(status.code, 0, 10000);
  insist(
    code === 0 || code === 1001 || code === 2004,
    "acrcloud_unavailable",
    503,
  );
  const details: Record<string, unknown> = {
    responseSha256: response.bodySha256,
    providerCode: code,
  };
  if (code !== 0)
    return {
      code,
      providerId: response.requestId ?? hashText(response.body),
      details,
    };
  const metadata = object(body.metadata),
    candidates: {
      id: string;
      kind: string;
      record: Record<string, unknown>;
    }[] = [];
  const seen = new Set<string>();
  let excluded = 0;
  for (const kind of ["music", "custom_files"]) {
    const values = metadata[kind] ?? [];
    insist(
      Array.isArray(values) && values.length <= 64,
      "acrcloud_invalid_match",
      503,
    );
    for (const value of values) {
      const record = object(value),
        id = text(record.acrid, 128);
      insist(id.length > 0, "acrcloud_invalid_match", 503);
      insist(!seen.has(id), "acrcloud_duplicate_match", 503);
      seen.add(id);
      const custom =
        record.user_defined === undefined || record.user_defined === null
          ? {}
          : object(record.user_defined);
      insist(
        custom.content_type === undefined ||
          typeof custom.content_type === "string",
        "acrcloud_invalid_match",
        503,
      );
      // Preserve the reviewed retained-reference rule: excluded video_audio
      // candidates do not turn a music upload into an identified reference.
      if (custom.content_type === "video_audio") {
        excluded++;
        continue;
      }
      candidates.push({ id, kind, record });
    }
  }
  const match = candidates[0];
  if (!match) {
    insist(excluded > 0, "acrcloud_success_without_candidates", 503);
    return {
      code: 1001,
      providerId: response.requestId ?? hashText(response.body),
      details: { ...details, allCandidatesExcluded: true },
    };
  }
  details.match = {
    id: match.id,
    kind: match.kind,
    title:
      typeof match.record.title === "string"
        ? match.record.title.slice(0, 512)
        : null,
    score:
      typeof match.record.score === "number" &&
      Number.isFinite(match.record.score)
        ? match.record.score
        : null,
  };
  return { code: 0, providerId: response.requestId ?? match.id, details };
}
