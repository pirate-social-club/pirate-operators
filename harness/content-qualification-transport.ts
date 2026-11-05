import { insist } from "../packages/community/common.ts";
import type { ProviderTransport } from "../packages/moderation/provider-http.ts";

export interface QualificationTransportOptions {
  deadline: number;
  maxRequests: number;
  maxRequestBytes: number;
  requests(): number;
  /** Increment and durably sync the reserved request count. Never refund a
   * reservation when the deadline or caller signal expires during this write. */
  reserve(): Promise<void>;
  now?: () => number;
  send?: (request: Request) => Promise<Response>;
}
export function qualificationTransport(
  options: QualificationTransportOptions,
): ProviderTransport {
  const now = options.now ?? Date.now,
    send = options.send ?? fetch;
  return {
    async request(request) {
      const url = new URL(request.url);
      insist(
        url.origin === "https://api.openai.com" &&
          ["/v1/moderations", "/v1/responses"].includes(url.pathname),
        "unapproved_qualification_request",
      );
      insist(
        now() < options.deadline && options.requests() < options.maxRequests,
        "qualification_request_bound",
      );
      insist(
        (await request.clone().arrayBuffer()).byteLength <=
          options.maxRequestBytes,
        "qualification_input_bound",
      );
      await options.reserve();
      // Body acquisition and durable fsync may both have consumed the window.
      // Retain the started intent and reserved count even when no send is allowed.
      insist(now() < options.deadline, "qualification_deadline_expired");
      const outbound = new Request(request, {
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(options.deadline - now()),
        ]),
      });
      insist(now() < options.deadline, "qualification_deadline_expired");
      outbound.signal.throwIfAborted();
      return send(outbound);
    },
  };
}
