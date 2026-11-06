import { encodeFunctionData, zeroHash, type Address, type Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  enrollmentTypes,
  revocationTypes,
  type Enrollment,
} from "../packages/protocol/learning-results.ts";
import {
  acceptedByAccount,
  activationOf,
  checkActivation,
  codeOf,
  nonceOf,
} from "./accounts.ts";
import { intentOf } from "./operator-tx.ts";
import { reserveSponsorship, sponsorLimits } from "./sponsor-budget.ts";
import {
  submitResultTransaction,
  type ResultStore,
} from "./learning-transactions.ts";
import {
  resultClient as client,
  readResultContract as read,
  contractAbi,
  contractDomain,
  contractEnrollmentId,
  resultsTarget,
  retainedTarget,
  pendingEnrollmentKey,
  revocationKey,
  sameResultsTarget,
  type ResultsTarget,
} from "./learning-contract.ts";
import type { Env } from "./runtime.ts";

export interface BoundEnrollment {
  // Absent only on pre-successor V2 records. Never infer V3 for these rows.
  target?: ResultsTarget;
  activities?: number;
  id: Hex;
  issuedAt: number;
  expiresAt: number;
}
/** Read every configured generation; a failed read cannot imply consent stopped. */
export async function learningEnrollments(
  env: Env,
  store: ResultStore,
  learner: Address,
) {
  const targets = [resultsTarget(env, 2)];
  if (env.RESULTS_V3_CONTRACT) targets.push(resultsTarget(env, 3));
  const grants: (BoundEnrollment & { revocationPending: boolean })[] = [];
  let pendingEnrollment = false;
  for (const target of targets) {
    pendingEnrollment ||= !!store.get(pendingEnrollmentKey(target, learner));
    const [id, activities, issuedAt, expiresAt] = await read<
      readonly [Hex, bigint, bigint, bigint]
    >(env, target, "enrollments", [learner]);
    if (id === zeroHash || expiresAt <= BigInt(store.now())) continue;
    const revocationPending = store
      .entries("revocationIntent:")
      .some(({ value }) => {
        const job = value as RevocationJob;
        return (
          job.pending &&
          job.grantId === id &&
          job.learner.toLowerCase() === learner.toLowerCase() &&
          sameResultsTarget(retainedTarget(env, job.target), target)
        );
      });
    grants.push({
      target,
      id,
      activities: Number(activities),
      issuedAt: Number(issuedAt),
      expiresAt: Number(expiresAt),
      revocationPending,
    });
  }
  return { grants, pendingEnrollment };
}
export async function activeEnrollment(
  env: Env,
  learner: Address,
  destination: ResultsTarget = resultsTarget(env),
  requiredActivities: 1 | 2 | 3 = 1,
): Promise<BoundEnrollment> {
  destination = retainedTarget(env, destination);
  check(
    destination.version === 3 || requiredActivities === 1,
    "unsupported_activity",
  );
  const [id, activities, issuedAt, expiresAt] = await read<
    readonly [Hex, bigint, bigint, bigint]
  >(env, destination, "enrollments", [learner]);
  check(
    id !== zeroHash &&
      (activities & BigInt(requiredActivities)) ===
        BigInt(requiredActivities) &&
      expiresAt > BigInt(Math.floor(Date.now() / 1000)),
    "enrollment_required",
  );
  return {
    id,
    issuedAt: Number(issuedAt),
    expiresAt: Number(expiresAt),
    activities: Number(activities),
    target: destination,
  };
}
export async function enrollmentRequest(
  env: Env,
  learner: Address,
  now: number,
  destination: ResultsTarget = resultsTarget(env),
) {
  destination = retainedTarget(env, destination);
  const [nonce, publicityPolicy, communityId] = await Promise.all([
    read<bigint>(env, destination, "nextNonce", [learner]),
    read<Hex>(env, destination, "publicityPolicy"),
    read<Hex>(env, destination, "communityId"),
  ]);
  const message = {
    learner,
    communityId,
    activities: destination.version === 3 ? "3" : "1",
    publicityPolicy,
    expiresAt: String(now + 30 * 86400),
    nonce: String(nonce),
  };
  return {
    target: destination,
    domain: contractDomain(destination),
    types: enrollmentTypes,
    primaryType: "Enrollment" as const,
    message,
  };
}
export async function acceptEnrollment(
  env: Env,
  store: ResultStore,
  e: Enrollment,
  signature: Hex,
  destination: ResultsTarget = resultsTarget(env),
) {
  destination = retainedTarget(env, destination);
  check(
    e.communityId.toLowerCase() === env.COMMUNITY_ID.toLowerCase(),
    "wrong_community",
  );
  const id = contractEnrollmentId(destination, e),
    key = pendingEnrollmentKey(destination, e.learner);
  const checkPending = () => {
    const pending = store.get<PendingEnrollmentJob>(key);
    check(
      !pending ||
        (contractEnrollmentId(
          retainedTarget(env, pending.target),
          restoreEnrollment(pending.enrollment),
        ) === id &&
          pending.signature === signature),
      "enrollment_pending",
    );
  };
  checkPending();
  const savePending = () => {
    checkPending();
    store.set(key, {
      target: destination,
      enrollment: {
        ...e,
        activities: String(e.activities),
        expiresAt: String(e.expiresAt),
        nonce: String(e.nonce),
      },
      signature,
    });
  };
  const activation = activationOf(signature);
  if (activation) {
    await checkActivation(
      env,
      e.learner,
      activation,
      Number(env.PAYMENT_CHAIN_ID),
    );
    const verified = await client(env).verifyTypedData({
      address: e.learner,
      domain: contractDomain(destination),
      types: enrollmentTypes,
      primaryType: "Enrollment",
      message: { ...e },
      signature,
    });
    check(verified, "invalid_consent");
    if ((await codeOf(env, e.learner)) === "0x") {
      check(
        env.APPROVED_ACTIVATION_ACCOUNT?.toLowerCase() ===
          e.learner.toLowerCase(),
        "account_activation_not_approved",
      );
      if (!intentOf(store, "record_activate", id))
        check(
          activation.authorization.nonce === (await nonceOf(env, e.learner)),
          "authorization_nonce_stale",
        );
      store.transaction(() => {
        savePending();
        reserveSponsorship(store, sponsorLimits(env), `record_activate:${id}`);
        reserveSponsorship(store, sponsorLimits(env), `record_enroll:${id}`);
      });
      const activated = await submitResultTransaction(
        env,
        store,
        "record_activate",
        id,
        activation.data,
        activation.initializer,
        [activation.authorization],
      );
      if (!activated?.mined) return activated;
      check(activated.mined.status === "success", "account_activation_failed");
    }
    check(
      await acceptedByAccount(env, e.learner, id, activation.inner),
      "consent_refused_by_account",
    );
  }
  const data = encodeFunctionData({
    abi: contractAbi(destination),
    functionName: "enroll",
    args: [e, activation?.inner ?? signature],
  });
  // Simulation rejects invalid consent before reserving/signing any transaction.
  if (!intentOf(store, "record_enroll", id))
    await client(env).call({ to: destination.contract, data });
  store.transaction(() => {
    savePending();
    reserveSponsorship(store, sponsorLimits(env), `record_revoke:${id}`);
  });
  const row = await submitResultTransaction(
    env,
    store,
    "record_enroll",
    id,
    data,
    destination.contract,
  );
  if (row?.mined) store.delete(key);
  return row;
}
export async function resumeEnrollments(env: Env, store: ResultStore) {
  for (const { value } of store.entries("pendingEnrollment:")) {
    const job = value as PendingEnrollmentJob;
    try {
      await acceptEnrollment(
        env,
        store,
        restoreEnrollment(job.enrollment),
        job.signature,
        retainedTarget(env, job.target),
      );
    } catch {
      /* Keep authenticated unknown work for bounded recovery. */
    }
  }
  for (const { value } of store.entries("revocationIntent:")) {
    const job = value as RevocationJob;
    if (!job.pending) continue;
    try {
      await acceptRevocation(
        env,
        store,
        job.learner,
        BigInt(job.nonce),
        job.signature,
        retainedTarget(env, job.target),
      );
    } catch {
      /* Retain authenticated work for bounded recovery. */
    }
  }
}

export async function revocationRequest(
  env: Env,
  learner: Address,
  destination: ResultsTarget = resultsTarget(env),
) {
  destination = retainedTarget(env, destination);
  return {
    target: destination,
    domain: contractDomain(destination),
    types: revocationTypes,
    primaryType: "Revocation" as const,
    message: {
      learner,
      nonce: String(
        await read<bigint>(env, destination, "nextNonce", [learner]),
      ),
    },
  };
}
export async function acceptRevocation(
  env: Env,
  store: ResultStore,
  learner: Address,
  nonce: bigint,
  signature: Hex,
  destination: ResultsTarget = resultsTarget(env),
) {
  destination = retainedTarget(env, destination);
  const data = encodeFunctionData({
    abi: contractAbi(destination),
    functionName: "revoke",
    args: [learner, nonce, activationOf(signature)?.inner ?? signature],
  });
  const key = revocationKey(destination, learner, nonce);
  let job = store.get<RevocationJob>(key);
  if (!job) {
    await client(env).call({ to: destination.contract, data });
    const [grantId] = await read<readonly [Hex, bigint, bigint, bigint]>(
      env,
      destination,
      "enrollments",
      [learner],
    );
    check(grantId !== zeroHash, "enrollment_required");
    job = {
      target: destination,
      learner,
      nonce: String(nonce),
      signature,
      data,
      grantId,
      pending: true,
    };
    store.set(key, job);
  }
  check(
    job.data === data &&
      sameResultsTarget(retainedTarget(env, job.target), destination),
    "revocation_payload_changed",
  );
  const row = await submitResultTransaction(
    env,
    store,
    "record_revoke",
    job.grantId,
    data,
    destination.contract,
  );
  if (row?.mined) store.set(key, { ...job, pending: false });
  return row;
}
interface RevocationJob {
  target?: ResultsTarget;
  learner: Address;
  nonce: string;
  signature: Hex;
  data: Hex;
  grantId: Hex;
  pending: boolean;
}

interface PendingEnrollmentJob {
  target?: ResultsTarget;
  enrollment: Record<string, string>;
  signature: Hex;
}
const restoreEnrollment = (e: Record<string, string>): Enrollment => ({
  learner: e.learner as Address,
  communityId: e.communityId as Hex,
  publicityPolicy: e.publicityPolicy as Hex,
  activities: BigInt(e.activities),
  expiresAt: BigInt(e.expiresAt),
  nonce: BigInt(e.nonce),
});
