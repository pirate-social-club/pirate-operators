import { bumpBootstrap } from "./study-linked-withdrawal-contract.ts";
import type { ResultStore } from "./learning-transactions.ts";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  resultsAbi,
  resultsDomain,
  enrollmentIdOf,
  type Enrollment,
} from "../packages/protocol/learning-results.ts";
import {
  resultsV3Abi,
  resultsV3Domain,
  enrollmentV3Id,
} from "../packages/protocol/learning-results-v3.ts";
import {
  resultsV4Abi,
  resultsV4Domain,
} from "../packages/protocol/learning-results-v4.ts";
import type { Env } from "./runtime.ts";

export interface ResultsTarget {
  chainId: 31337 | 6343;
  version: 2 | 3 | 4;
  contract: Address;
}
/** Earlier settings remain the historical destinations when a successor
 * becomes the default; V4 is the default for new work when configured. */
export function resultsTarget(
  env: Env,
  version: 2 | 3 | 4 = env.RESULTS_V4_CONTRACT
    ? 4
    : env.RESULTS_V3_CONTRACT
      ? 3
      : 2,
): ResultsTarget {
  check(
    version === 2 || version === 3 || version === 4,
    "unsupported_results_version",
  );
  const chainId = Number(env.PAYMENT_CHAIN_ID),
    contract =
      version === 2
        ? env.RESULTS_V2_CONTRACT
        : version === 3
          ? env.RESULTS_V3_CONTRACT
          : env.RESULTS_V4_CONTRACT;
  check(chainId === 31337 || chainId === 6343, "unsupported_results_chain");
  check(
    typeof contract === "string" &&
      /^0x[0-9a-f]{40}$/i.test(contract) &&
      !/^0x0+$/i.test(contract),
    "results_unconfigured",
  );
  return { chainId, version, contract: contract.toLowerCase() as Address };
}
/**
 * The newest target that has learning enrollments, for V2 and V3 work. V4 has
 * none, since its permission is the learner's sign-in, so configuring V4 never
 * moves enrollment requests, grants or revocations onto it.
 */
export const enrollmentResultsTarget = (env: Env) =>
  resultsTarget(env, env.RESULTS_V3_CONTRACT ? 3 : 2);
/** No absent legacy field may inherit the successor's default contract. */
export function retainedTarget(env: Env, saved?: ResultsTarget): ResultsTarget {
  const expected = resultsTarget(env, saved?.version ?? 2);
  check(
    !saved ||
      (saved.chainId === expected.chainId &&
        saved.version === expected.version &&
        typeof saved.contract === "string" &&
        saved.contract.toLowerCase() === expected.contract),
    "results_target_changed",
  );
  return expected;
}
export const sameResultsTarget = (a: ResultsTarget, b: ResultsTarget) =>
  a.chainId === b.chainId &&
  a.version === b.version &&
  a.contract.toLowerCase() === b.contract.toLowerCase();
export const resultClient = (env: Env) =>
  createPublicClient({ transport: http(env.RPC_URL) });
export const contractAbi = (target: ResultsTarget) =>
  target.version === 2
    ? resultsAbi
    : target.version === 3
      ? resultsV3Abi
      : resultsV4Abi;
export const contractDomain = (target: ResultsTarget) =>
  (target.version === 2
    ? resultsDomain
    : target.version === 3
      ? resultsV3Domain
      : resultsV4Domain)(target.chainId, target.contract);
/** V2/V3 only: V4 has no separate enrollment; see signInIdV4. */
export const contractEnrollmentId = (
  target: ResultsTarget,
  enrollment: Enrollment,
) => {
  check(target.version !== 4, "unsupported_results_version");
  return (target.version === 2 ? enrollmentIdOf : enrollmentV3Id)(
    target.chainId,
    target.contract,
    enrollment,
  );
};
export const readResultContract = <T>(
  env: Env,
  target: ResultsTarget,
  functionName: string,
  args: unknown[] = [],
) =>
  resultClient(env).readContract({
    address: retainedTarget(env, target).contract,
    abi: contractAbi(target),
    functionName,
    args,
  } as never) as Promise<T>;
export const resultPolicyAt = (
  env: Env,
  target: ResultsTarget,
  activity: 1 | 2,
  period: bigint,
) => {
  check(target.version !== 2 || activity === 1, "unsupported_activity");
  return readResultContract<Hex>(
    env,
    target,
    "policyFor",
    target.version === 2 ? [period] : [activity, period],
  );
};
export const pendingEnrollmentKey = (target: ResultsTarget, learner: Address) =>
  `pendingEnrollment:${target.version === 2 ? "" : `${target.version}:${target.contract.toLowerCase()}:`}${learner.toLowerCase()}`;
/**
 * Set when this operator accepts the learner's signed V4 Revocation. From
 * then on, that learner's results bound to an earlier version (a V2 or V3
 * enrollment) that are not yet sent stay private: V4 is the community's
 * records, and turning public results back on never resumes them. It needs
 * no V3 revoke, which only the learner can sign.
 */
export const legacyResultsWithheldKey = (learner: string) =>
  `legacyResultsWithheld:${learner.toLowerCase()}`;
export const legacyResultsWithheld = (
  store: { get<T>(key: string): T | undefined },
  learner: string,
) => store.get(legacyResultsWithheldKey(learner)) !== undefined;
/**
 * Whether the learner's earlier-version results not yet sent stay private:
 * the marker above, or a withdrawal on this operator's V4 contract by any
 * path, including the learner's own direct `revoke` call, which never reaches
 * this operator. Only `revoke` writes `revokedAt`, and a later sign-in
 * (`authorize`) never resets it, so it is nonzero from the learner's first
 * withdrawal on, even after they sign in again. A withdrawal found on chain
 * is recorded as the marker, so it holds from then on without another read.
 * Without a configured V4 contract nothing is read. A failed read throws, so
 * the caller keeps the result pending and never sends it on an error.
 */
export async function legacyResultsWithdrawn(
  env: Env,
  store: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    now(): number;
  },
  learner: Address,
  blockNumber?: bigint,
) {
  if (legacyResultsWithheld(store, learner)) return true;
  if (!env.RESULTS_V4_CONTRACT) return false;
  const target = resultsTarget(env, 4);
  const chain = resultClient(env),
    observedBlock =
      blockNumber ?? (await chain.getBlockNumber({ cacheTime: 0 }));
  const at = {
    address: target.contract,
    abi: resultsV4Abi,
    args: [learner],
    blockNumber: observedBlock,
  } as const;
  const [revokedAt, revocationNonce] = await Promise.all([
    chain.readContract({ ...at, functionName: "revokedAt" }),
    chain.readContract({ ...at, functionName: "nextNonce" }),
  ]);
  check(
    typeof revokedAt === "bigint" &&
      revokedAt >= 0n &&
      typeof revocationNonce === "bigint" &&
      revocationNonce >= 0n &&
      revocationNonce < 1n << 64n &&
      (revokedAt === 0n ? revocationNonce === 0n : revocationNonce > 0n),
    "study_withdrawal_signal_unavailable",
  );
  if (revokedAt === 0n) return false;
  if (!legacyResultsWithheld(store, learner)) {
    const journal = store as ResultStore;
    check(journal.durableStudyWrite, "study_binding_wake_unconfigured");
    await journal.durableStudyWrite(() => {
      if (!legacyResultsWithheld(journal, learner)) {
        journal.set(legacyResultsWithheldKey(learner), {
          at: journal.now(),
          revokedAt: String(revokedAt),
          revocationNonce: String(revocationNonce),
          source: "chain",
        });
        bumpBootstrap(journal);
      }
    });
  }
  return true;
}
export const revocationKey = (
  target: ResultsTarget,
  learner: Address,
  nonce: bigint,
) =>
  `revocationIntent:${target.version === 2 ? "" : `${target.version}:${target.contract.toLowerCase()}:`}${learner.toLowerCase()}:${nonce}`;
