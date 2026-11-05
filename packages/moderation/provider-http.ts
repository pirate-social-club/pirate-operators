import { hashText, insist, object } from "../community/common.ts";

export interface ProviderResponse {
  status: number;
  contentType: string;
  requestId: string | null;
  body: string;
  bodySha256: string;
}
export interface ProviderTransport {
  request(request: Request): Promise<Response>;
}
export const providerFetch: ProviderTransport = {
  request: (request) => fetch(request),
};

/** One send only. The caller durably marks running before entry and retains
 * the response before interpreting it. Unknown sends are never auto-retried. */
export async function providerRequest(
  request: Request,
  transport: ProviderTransport,
  received: (response: ProviderResponse) => Promise<void>,
  maxBytes = 1024 * 1024,
): Promise<ProviderResponse> {
  const response = await transport.request(request);
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  if (reader)
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > maxBytes) {
          await reader.cancel();
          insist(false, "provider_response_too_large", 503);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const body = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const receipt = {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    requestId: response.headers.get("x-request-id")?.slice(0, 256) ?? null,
    body,
    bodySha256: hashText(body),
  };
  await received(receipt);
  return receipt;
}
export function providerJson(response: ProviderResponse) {
  insist(
    response.status >= 200 &&
      response.status < 300 &&
      /^(application\/json|text\/plain)(?:;|$)/i.test(response.contentType),
    "provider_unavailable",
    503,
  );
  insist(
    hashText(response.body) === response.bodySha256,
    "provider_receipt_hash_mismatch",
    503,
  );
  try {
    return object(JSON.parse(response.body));
  } catch {
    insist(false, "invalid_provider_response", 503);
  }
}
