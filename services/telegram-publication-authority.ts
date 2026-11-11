import type { Address, Hex } from "viem";
import {
  bytes32,
  exact,
  insist,
  object,
} from "../packages/community/common.ts";
import { address } from "../packages/community/manifest-core.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  telegramStudyFence,
  type TelegramStudyContext,
  type TelegramStudyDenial,
} from "../packages/study/telegram-publication.ts";
import {
  TelegramError,
  telegramCheck,
  type BotRegistration,
  type BotScope,
  type TelegramGrant,
} from "../packages/telegram/contracts.ts";
import { privateHeaders, readJson } from "../packages/telegram/security.ts";
import { connectedPracticeAuthorization } from "./learning-sign-in.ts";
import type { StudyEnv } from "./study-community.ts";
import {
  denyManagedStudyPublication,
  type StudyOperatorPorts,
} from "./study-operator-client.ts";
import type { TelegramGrants } from "./telegram-grants.ts";

const endpoint = "https://study-telegram.internal/check";
function parseContext(value: unknown): TelegramStudyContext {
  const x = object(value);
  exact(x, [
    "communityId",
    "lessonId",
    "learner",
    "startedAt",
    "authorizationId",
    "contract",
  ]);
  insist(
    typeof x.lessonId === "string" &&
      /^[a-zA-Z0-9_-]{16,128}$/.test(x.lessonId) &&
      typeof x.startedAt === "number" &&
      Number.isSafeInteger(x.startedAt) &&
      x.startedAt > 0,
    "study_telegram_fence_context_changed",
    409,
  );
  return {
    communityId: bytes32(x.communityId),
    lessonId: x.lessonId,
    learner: address(x.learner),
    startedAt: x.startedAt,
    authorizationId: bytes32(x.authorizationId),
    contract: address(x.contract),
  };
}

/** Bound only to the internal operator service, never mounted on public
 * community routes. A trusted grant and exact original V4 authorization must
 * survive both sides of the existing connected-learning check. */
export function telegramPublicationAuthority(input: {
  db: D1Database;
  env: Pick<StudyEnv, "KARAOKE_OPERATOR">;
  grants: TelegramGrants;
  communityId: Hex;
  contract: Address;
}) {
  return async (request: Request): Promise<Response> => {
    const reply = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: privateHeaders() });
    try {
      insist(
        request.url === endpoint && request.method === "POST",
        "study_telegram_route_not_found",
        404,
      );
      const body = object(await readJson(request, 4096));
      exact(body, ["fence", "context"]);
      const fence = telegramStudyFence(body.fence);
      const context = parseContext(body.context);
      insist(
        context.communityId === input.communityId &&
          fence.facts.actor.communityId === context.communityId &&
          context.contract === input.contract,
        "study_telegram_fence_context_changed",
        403,
      );
      const facts = fence.facts,
        actor = facts.actor;
      const linked = {
        communityId: actor.communityId,
        botId: actor.botId,
        generation: actor.generation,
        startedAtMs: context.startedAt,
      };
      const observe = (allowed: boolean) =>
        reply({
          schema: "pirate.study.telegram-fence-observation/1",
          hash: fence.hash,
          contextHash: digest(context),
          allowed,
        });
      const link = async () => {
        const grant = await input.grants.assert(actor, facts.grantId);
        telegramCheck(
          grant.accountId === facts.accountId &&
            grant.authorityVersion === facts.authorityVersion &&
            grant.wallet.toLowerCase() === context.learner &&
            grant.linkedAt <= context.startedAt,
          "telegram_authority_changed",
          403,
        );
        return {
          ...linked,
          version: 1 as const,
          accountId: grant.accountId,
          wallet: grant.wallet.toLowerCase(),
          linkedAtMs: grant.linkedAt,
          revokedAtMs: grant.revokedAt,
        };
      };
      try {
        const admitted = await connectedPracticeAuthorization(
          input.env,
          input.db,
          linked,
          link,
          input.grants.now(),
        );
        if ("pending" in admitted && admitted.pending)
          return reply({ error: "study_telegram_authority_pending" }, 503);
        await link();
        return observe(admitted.id === context.authorizationId);
      } catch (error) {
        if (
          error instanceof TelegramError &&
          [403, 409].includes(error.status) &&
          [
            "telegram_authority_changed",
            "telegram_bot_changed",
            "telegram_connection_required",
            "telegram_start_required",
          ].includes(error.code)
        )
          return observe(false);
        throw error;
      }
    } catch {
      // Do not include grant or actor fields in errors or logs.
      return reply({ error: "study_telegram_fence_unavailable" }, 503);
    }
  };
}

export function telegramPublicationInvalidation(ports: StudyOperatorPorts) {
  const base = {
    schema: "pirate.study.telegram-publication-denial/1" as const,
    communityId: ports.authority.communityId,
  };
  const send = async (scope: string, denial: TelegramStudyDenial) => {
    insist(
      scope === base.communityId,
      "study_telegram_fence_context_changed",
      403,
    );
    await denyManagedStudyPublication(ports, denial);
  };
  return {
    grant: (grant: TelegramGrant) =>
      send(grant.communityId, {
        ...base,
        kind: "grant",
        botId: grant.botId,
        grantId: grant.id,
      }),
    scope: (scope: BotScope) =>
      send(scope.communityId, {
        ...base,
        kind: "scope",
        botId: scope.botId,
        generation: scope.generation,
      }),
    authorization: (authorizationId: Hex) =>
      send(base.communityId, {
        ...base,
        kind: "authorization",
        authorizationId,
      }),
  };
}

/** Separate managed configuration entry. No changed bot generation is
 * acknowledged until the old scope's operator tombstone is durable. */
export async function configureTelegramPublicationScope(
  grants: TelegramGrants,
  next: BotRegistration,
  invalidation: Pick<
    ReturnType<typeof telegramPublicationInvalidation>,
    "scope"
  >,
) {
  const staged = grants.stagePublicationScope(next);
  if (!staged.pending) return staged.registration;
  await invalidation.scope(staged.pending.from);
  return grants.finishPublicationScope(staged.pending);
}
