// V4 Study permission, read from chain. A lesson binds the learner's sign-in
// authorization in force when it started; it may publish only while the
// contract's publish rule still accepts that authorization.
import type { Address, Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  readResultContract,
  retainedTarget,
  type ResultsTarget,
} from "./learning-contract.ts";
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
  const [owner, issuedAt, since] = await Promise.all([
    readResultContract<Address>(env, target, "authorizationLearner", [id]),
    readResultContract<bigint>(env, target, "authorizationIssuedAt", [id]),
    readResultContract<bigint>(env, target, "authorizedSince", [learner]),
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
