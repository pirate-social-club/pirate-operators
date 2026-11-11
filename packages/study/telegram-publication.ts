import type { Address, Hex } from "viem";
import { bytes32, exact, insist, object } from "../community/common.ts";
import { address } from "../community/manifest-core.ts";
import { digest } from "../protocol/index.ts";

export interface TelegramStudyFacts {
  schema: "pirate.study.telegram-publication-fence/1";
  version: 1;
  grantId: string;
  actor: {
    communityId: Hex;
    botId: string;
    generation: number;
    userId: string;
    chatId: string;
  };
  accountId: string;
  authorityVersion: string;
}
export interface TelegramStudyFence {
  facts: TelegramStudyFacts;
  hash: Hex;
}
export interface TelegramStudyContext {
  communityId: Hex;
  lessonId: string;
  learner: Address;
  startedAt: number;
  authorizationId: Hex;
  contract: Address;
}

const id = (value: unknown) => {
  insist(
    typeof value === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(value),
    "study_telegram_fence_invalid",
    409,
  );
  return value;
};
const telegramId = (value: unknown) => {
  insist(
    typeof value === "string" &&
      /^[1-9][0-9]{0,15}$/.test(value) &&
      BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
    "study_telegram_fence_invalid",
    409,
  );
  return value;
};
export function telegramStudyFacts(value: unknown): TelegramStudyFacts {
  const input = object(value),
    actor = object(input.actor);
  exact(input, [
    "schema",
    "version",
    "grantId",
    "actor",
    "accountId",
    "authorityVersion",
  ]);
  exact(actor, ["communityId", "botId", "generation", "userId", "chatId"]);
  const userId = telegramId(actor.userId),
    chatId = telegramId(actor.chatId);
  insist(
    input.schema === "pirate.study.telegram-publication-fence/1" &&
      input.version === 1 &&
      userId === chatId &&
      typeof actor.generation === "number" &&
      Number.isSafeInteger(actor.generation) &&
      actor.generation > 0,
    "study_telegram_fence_invalid",
    409,
  );
  return {
    schema: input.schema,
    version: input.version,
    grantId: id(input.grantId),
    accountId: id(input.accountId),
    authorityVersion: id(input.authorityVersion),
    actor: {
      communityId: bytes32(actor.communityId),
      botId: telegramId(actor.botId),
      generation: actor.generation,
      userId,
      chatId,
    },
  };
}

export function telegramStudyFence(value: unknown): TelegramStudyFence {
  const input = object(value);
  exact(input, ["facts", "hash"]);
  const facts = telegramStudyFacts(input.facts);
  const hash = bytes32(input.hash);
  insist(digest(facts) === hash, "study_telegram_fence_changed", 409);
  return { facts, hash };
}

/** This request goes only to the configured internal service binding. No
 * client can supply a resolver endpoint. Outages leave the result pending. */
export async function resolveTelegramStudyFence(
  service: Pick<Fetcher, "fetch"> | undefined,
  fence: TelegramStudyFence,
  context: TelegramStudyContext,
) {
  insist(service, "study_telegram_fence_unavailable", 503);
  insist(
    context.communityId === fence.facts.actor.communityId &&
      /^[a-zA-Z0-9_-]{16,128}$/.test(context.lessonId) &&
      Number.isSafeInteger(context.startedAt) &&
      context.startedAt > 0,
    "study_telegram_fence_context_changed",
    409,
  );
  address(context.learner);
  address(context.contract);
  bytes32(context.authorizationId);
  const response = await service.fetch(
    "https://study-telegram.internal/check",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fence, context }),
    },
  );
  insist(response.ok, "study_telegram_fence_unavailable", 503);
  const result = object(await response.json());
  exact(result, ["schema", "hash", "contextHash", "allowed"]);
  insist(
    result.schema === "pirate.study.telegram-fence-observation/1" &&
      result.hash === fence.hash &&
      result.contextHash === digest(context) &&
      typeof result.allowed === "boolean",
    "study_telegram_fence_context_changed",
    503,
  );
  return result.allowed;
}
