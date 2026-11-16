import { insist } from "../packages/community/common.ts";
import { createHostedEnrollmentService, hostedError } from "./hosted-community-enrollment.ts";
import { createHostedFundingService } from "./hosted-community-funding.ts";
import { configuredHostedRuntime, type HostedCommunityEnv } from "./hosted-community-runtime.ts";

export default {
  async fetch(request: Request, env: HostedCommunityEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      insist(["/prepare", "/redeem", "/status", "/initial-topup"].includes(url.pathname) && !url.search && !url.hash, "not_found", 404);
      const runtime = configuredHostedRuntime(env);
      insist(!request.headers.has("host") || request.headers.get("host") === new URL(runtime.policy.serviceOrigin).host, "wrong_host", 403);
      return await (url.pathname === "/initial-topup" ? createHostedFundingService(runtime) : createHostedEnrollmentService(runtime))(request);
    } catch (error) { return hostedError(error); }
  },
} satisfies ExportedHandler<HostedCommunityEnv>;
