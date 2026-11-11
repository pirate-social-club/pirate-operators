// COORDINATOR PROPOSAL ONLY against reviewed 7ea composition. No live entry,
// origin, internal/public binding or runtime is selected by this file.
import {
  communityFetch,
  communityScheduled,
  type CommunityDependencies,
  type CommunityEnv,
} from "./community-application.ts";
import type { telegramConnectedCommunity } from "./telegram-connected-community.ts";
import { telegramCheck } from "../packages/telegram/contracts.ts";
import { httpsOrigin } from "../packages/telegram/security.ts";

export function telegramConnectedMount(options: {
  env: CommunityEnv;
  dependencies: CommunityDependencies & {
    linkedAuthority: NonNullable<CommunityDependencies["linkedAuthority"]>;
  };
  telegram: ReturnType<typeof telegramConnectedCommunity>;
  selectedOrigin: string;
}) {
  const { env, dependencies, telegram } = options;
  const origin = httpsOrigin(options.selectedOrigin);
  telegramCheck(
    dependencies.linkedAuthority.ports.transitions === telegram.transitions,
    "telegram_managed_publication_required",
    503,
  );
  // Called from startup, existing scheduled drain and the native DO alarm.
  // Neither branch is conditional on ordinary Telegram readiness. The shared
  // core retains canonical closure before remote work and its fair SQL scans.
  async function recover() {
    const failures: unknown[] = [];
    try {
      await communityScheduled(env, dependencies);
    } catch (error) {
      failures.push(error);
    }
    try {
      await telegram.alarm();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, "community_recovery_pending");
  }
  return {
    async fetch(request: Request) {
      const config = await dependencies.configuration();
      telegramCheck(
        config.app.origin === origin && new URL(request.url).origin === origin,
        "telegram_community_origin_changed",
        503,
      );
      telegram.transitions.assertTarget(
        config.communityId,
        config.learningRecords,
      );
      const path = new URL(request.url).pathname;
      if (path === "/api/telegram/webhook") return telegram.webhook(request);
      if (
        path.startsWith("/api/telegram/") ||
        (path === "/telegram/connect/return" &&
          request.headers.get("accept")?.includes("application/json"))
      )
        return telegram.routes(request);
      // Full-page connect/return navigation remains the existing website shell.
      // Its admitted controller performs JSON inspection and authenticated
      // completion; a full-page GET never silently redeems an account link.
      return communityFetch(request, env, dependencies);
    },
    recover,
    // Existing DO's alarm event forwards here, using the same actual storage
    // and earliest scheduler as the factory and linkedAuthority.ports.wake.
    alarm: recover,
    scheduled: recover,
    // Existing internal operator service binding ONLY; never public routing.
    publicationAuthority: telegram.publicationAuthority,
  };
}
