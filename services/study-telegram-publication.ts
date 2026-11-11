import type { Address, Hex } from "viem";
import { bytes32, insist } from "../packages/community/common.ts";
import { digest } from "../packages/protocol/index.ts";
import type { AnyStudyLessonOffer } from "../packages/study/operator-contract.ts";
import {
  resolveTelegramStudyFence,
  telegramStudyFence,
  type TelegramStudyContext,
  type TelegramStudyFence,
} from "../packages/study/telegram-publication.ts";
import type { ResultsTarget } from "./learning-contract.ts";
import type { ResultStore } from "./learning-transactions.ts";
import type { Env } from "./runtime.ts";

const deniedKey = (fence: TelegramStudyFence) =>
  `studyTelegramDenied:${fence.hash}`;
const scopeKey = (actor: TelegramStudyFence["facts"]["actor"]) =>
  `studyTelegramScopeDenied:${digest([actor.communityId, actor.botId, actor.generation])}`;

/** Only the trusted invalidation bridge can call these against the operator's
 * store. These writes and the broadcast-attempt record share that store. */
export function recordTelegramStudyDenial(
  store: ResultStore,
  value: TelegramStudyFence,
  scope = false,
) {
  const fence = telegramStudyFence(value);
  store.transaction(() => {
    store.set(scope ? scopeKey(fence.facts.actor) : deniedKey(fence), true);
  });
}

export function telegramStudyDenied(
  store: ResultStore,
  fence: TelegramStudyFence,
) {
  return (
    store.get(deniedKey(fence)) === true ||
    store.get(scopeKey(fence.facts.actor)) === true
  );
}

export function studyTelegramPublication(
  offer: AnyStudyLessonOffer,
  target: ResultsTarget,
  communityId: string,
) {
  insist(offer && typeof offer === "object", "invalid_study_lesson_binding");
  if (offer.speechChannel !== "telegram-linked") {
    insist(
      offer.telegramFence === undefined,
      "study_telegram_fence_invalid",
      409,
    );
    return null;
  }
  insist(
    offer.telegramFence && target.version === 4 && offer.authorizationId,
    "study_telegram_fence_missing",
    409,
  );
  const fence = telegramStudyFence(offer.telegramFence);
  const context: TelegramStudyContext = {
    communityId: bytes32(communityId),
    lessonId: offer.lessonId,
    learner: offer.learner.toLowerCase() as Address,
    startedAt: offer.startedAt,
    authorizationId: bytes32(offer.authorizationId),
    contract: target.contract.toLowerCase() as Address,
  };
  insist(
    fence.facts.actor.communityId === context.communityId,
    "study_telegram_fence_context_changed",
    409,
  );
  return { fence, context };
}

export async function checkTelegramStudyPublication(
  env: Pick<Env, "STUDY_TELEGRAM_AUTHORITY">,
  store: ResultStore,
  publication: ReturnType<typeof studyTelegramPublication>,
) {
  if (!publication) return;
  const { fence, context } = publication;
  insist(
    !telegramStudyDenied(store, fence),
    "study_telegram_grant_withdrawn",
    409,
  );
  insist(
    await resolveTelegramStudyFence(
      env.STUDY_TELEGRAM_AUTHORITY,
      fence,
      context,
    ),
    "study_telegram_grant_withdrawn",
    409,
  );
  insist(
    !telegramStudyDenied(store, fence),
    "study_telegram_grant_withdrawn",
    409,
  );
}

export function telegramResultPublication(
  env: Pick<Env, "COMMUNITY_ID">,
  store: ResultStore,
  ref: string,
) {
  const id = /^study:([a-zA-Z0-9_-]{16,128}):1$/.exec(ref)?.[1];
  if (!id) return null;
  const binding = store.get<{
    offer: AnyStudyLessonOffer;
    target: ResultsTarget;
  }>(`studyBinding:${id}`);
  const job = store.get<{
    telegramFence?: TelegramStudyFence;
    result: { learner: Address; enrollmentId: Hex; startedAt: string };
    target: ResultsTarget;
  }>(`studyPublication:${id}`);
  if (!binding) {
    insist(!job?.telegramFence, "study_telegram_fence_missing", 409);
    return null;
  }
  const publication = studyTelegramPublication(
    binding.offer,
    binding.target,
    env.COMMUNITY_ID,
  );
  if (!publication) {
    insist(!job?.telegramFence, "study_telegram_fence_changed", 409);
    return null;
  }
  insist(
    job?.telegramFence &&
      telegramStudyFence(job.telegramFence).hash === publication.fence.hash &&
      job.target.version === 4 &&
      job.target.chainId === binding.target.chainId &&
      job.target.contract.toLowerCase() === publication.context.contract &&
      job.result.learner.toLowerCase() === publication.context.learner &&
      job.result.enrollmentId === publication.context.authorizationId &&
      String(job.result.startedAt) ===
        String(Math.floor(publication.context.startedAt / 1000)),
    "study_telegram_fence_changed",
    409,
  );
  return publication;
}
