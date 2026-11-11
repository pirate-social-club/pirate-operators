// V4 Study permission, read from chain. A lesson binds the learner's sign-in
// authorization in force when it started; it may publish only while the
// contract's publish rule still accepts that authorization.
import type { Address, Hex } from "viem";
import { resultsV4Abi } from "../packages/protocol/learning-results-v4.ts";
import { check } from "../packages/protocol/index.ts";
import { STUDY_AUTH_HEADER } from "../packages/study/operator-auth.ts";
import {
  validateStudyOffer,
  type AnyStudyLessonOffer,
  type StudyLessonOfferV4,
} from "../packages/study/operator-contract.ts";
import {
  resultClient,
  resultsTarget,
  retainedTarget,
  sameResultsTarget,
  type ResultsTarget,
} from "./learning-contract.ts";
import type { ResultStore } from "./learning-transactions.ts";
import { reserveSponsorship, sponsorLimits } from "./sponsor-budget.ts";
import {
  studyTelegramPublication,
  telegramStudyDenied,
} from "./study-telegram-publication.ts";
import { closedStudyPublication } from "./study-private-publication.ts";
import type { StudyBinding } from "./study-operator.ts";
import type { Env } from "./runtime.ts";

/** Stored in a V4 binding in place of a V3 enrollment. */
export interface BoundAuthorization {
  id: Hex;
  issuedAt: number;
  target: ResultsTarget;
}

/**
 * `publish` requires `authorizationLearner(id) == learner`,
 * `authorizedSince(learner) != 0`, `authorizationIssuedAt(id) >= since` and
 * `authorizationIssuedAt(id) <= startedAt`. This reads the first three live.
 */
export async function studyAuthorizationState(
  env: Env,
  target: ResultsTarget,
  learner: Address,
  id: Hex,
) {
  target = retainedTarget(env, target);
  check(target.version === 4, "unsupported_results_version");
  const chain = resultClient(env);
  const blockNumber = await chain.getBlockNumber({ cacheTime: 0 });
  const read = <T>(functionName: string, args: unknown[]) =>
    chain.readContract({
      address: target.contract,
      abi: resultsV4Abi,
      functionName,
      args,
      blockNumber,
    } as never) as Promise<T>;
  const [owner, issuedAt, since] = await Promise.all([
    read<Address>("authorizationLearner", [id]),
    read<bigint>("authorizationIssuedAt", [id]),
    read<bigint>("authorizedSince", [learner]),
  ]);
  return {
    /** The authorization exists and belongs to this learner. */
    ownedBy: owner.toLowerCase() === learner.toLowerCase() && issuedAt > 0n,
    issuedAt: Number(issuedAt),
    /** Not withdrawn, and permission has not restarted after a withdrawal. */
    unbroken: since !== 0n && since <= issuedAt,
  };
}

/** Whether a bound authorization still permits a lesson that started at `startedAtMs`. */
export async function studyAuthorizationPermits(
  env: Env,
  authorization: BoundAuthorization,
  learner: Address,
  startedAtMs: number,
) {
  const state = await studyAuthorizationState(
    env,
    authorization.target,
    learner,
    authorization.id,
  );
  return (
    state.ownedBy &&
    state.unbroken &&
    state.issuedAt === authorization.issuedAt &&
    state.issuedAt * 1000 <= startedAtMs
  );
}

/** A V4 lesson binding: the sign-in authorization in force at its start. */
export interface StudyAuthorizationBinding {
  offer: StudyLessonOfferV4;
  offerHash: Hex;
  exercisesHash: Hex;
  target: ResultsTarget;
  authorization: BoundAuthorization;
  enrollment?: never;
}
/**
 * The results contract the community issuer named. V4 is chosen only when
 * the request names the configured V4 contract; anything else is V3 as before,
 * so V3 lessons keep working beside V4.
 */
export function studyAuthorityTarget(
  env: Env,
  request: Request,
): ResultsTarget {
  if (env.RESULTS_V4_CONTRACT) {
    let named: unknown;
    try {
      named = JSON.parse(request.headers.get(STUDY_AUTH_HEADER) ?? "")?.request
        ?.contract;
    } catch {
      /* Verification below refuses a malformed header. */
    }
    // Only a request naming V4 depends on the V4 setting's validity.
    if (
      typeof named === "string" &&
      named.toLowerCase() === env.RESULTS_V4_CONTRACT.toLowerCase()
    )
      return resultsTarget(env, 4);
  }
  return resultsTarget(env, 3);
}

/**
 * V4: the lesson binds the sign-in authorization the application chose. It
 * must be the learner's, issued no later than the lesson started, with
 * permission unbroken since. Later sign-ins never move that start.
 */
export async function bindAuthorizedLesson(
  env: Env,
  store: ResultStore,
  offer: AnyStudyLessonOffer,
  target: ResultsTarget,
  hash: Hex,
): Promise<StudyAuthorizationBinding> {
  const exercisesHash = validateStudyOffer(offer, store.now(), 4),
    v4 = offer as StudyLessonOfferV4;
  const state = await studyAuthorizationState(
    env,
    target,
    v4.learner,
    v4.authorizationId,
  );
  check(
    state.ownedBy && state.issuedAt * 1000 <= v4.startedAt,
    "study_authorization_mismatch",
  );
  check(state.unbroken, "study_authorization_required");
  return store.transaction(() => {
    check(!closedStudyPublication(store, v4.lessonId), "study_history_expired");
    const telegram = studyTelegramPublication(v4, target, env.COMMUNITY_ID);
    check(
      !telegram || !telegramStudyDenied(store, telegram.fence),
      "study_telegram_grant_withdrawn",
    );
    const concurrent = store.get<StudyBinding>(`studyBinding:${v4.lessonId}`);
    if (concurrent) {
      check(
        concurrent.offerHash === hash &&
          sameResultsTarget(concurrent.target, target),
        "study_lesson_binding_changed",
      );
      return concurrent as StudyAuthorizationBinding;
    }
    reserveSponsorship(
      store,
      sponsorLimits(env),
      `record_result:study:${v4.lessonId}:1`,
    );
    reserveSponsorship(
      store,
      sponsorLimits(env),
      `record_result:study:${v4.lessonId}:2`,
    );
    const binding: StudyAuthorizationBinding = {
      offer: v4,
      offerHash: hash,
      exercisesHash,
      target,
      authorization: {
        id: v4.authorizationId,
        issuedAt: state.issuedAt,
        target,
      },
    };
    store.set(`studyBinding:${v4.lessonId}`, binding);
    return binding;
  });
}
