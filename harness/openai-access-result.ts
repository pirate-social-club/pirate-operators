import { createHash } from "node:crypto";
import type { ProviderResponse } from "../packages/moderation/provider-http.ts";
/** Retain only closed metadata fields. Error messages and full bodies can
 * contain account data and credentials and must never enter evidence. */
export function openAiAccessResult(response: ProviderResponse, apiKey: string) {
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(response.body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      body = parsed;
  } catch {}
  const error =
    body.error && typeof body.error === "object"
      ? (body.error as Record<string, unknown>)
      : {};
  const code = (value: unknown) =>
    typeof value === "string" &&
    /^[a-z_][a-z0-9_]{0,79}$/.test(value) &&
    !value.includes(apiKey)
      ? value
      : null;
  return {
    status: response.status,
    modelId: body.id === "gpt-6-luna" ? "gpt-6-luna" : null,
    errorCode: code(error.code),
    errorType: code(error.type),
    providerRequestIdPresent: Boolean(response.requestId),
    responseSha256: createHash("sha256").update(response.body).digest("hex"),
  };
}
