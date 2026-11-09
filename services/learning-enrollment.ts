import { encodeFunctionData, zeroHash, type Address, type Hex } from "viem";
import {
  resultsV4Abi,
  signInIdV4,
  signInTypes,
  type SignIn,
} from "../packages/protocol/learning-results-v4.ts";
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
import { intentOf, type TxRow } from "./operator-tx.ts";
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
  enrollmentResultsTarget,
  resultsTarget,
  retainedTarget,
  pendingEnrollmentKey,
  revocationKey,
  sameResultsTarget,
  type ResultsTarget,
} from "./learning-contract.ts";
import type { Env } from "./runtime.ts";
import { body } from "./service-call.ts";
import { STUDY_LESSON_LIFETIME_MS } from "../packages/study/lesson.ts";
import {
  learningV3Disclosure,
  learningV3PublicityPolicy,
} from "./learning-policy-v3.ts";

export interface BoundEnrollment {
  // Absent only on pre-successor V2 records. Never infer V3 for these rows.
  target?: ResultsTarget;
  activities?: number;
  id: Hex;
  issuedAt: number;
  expiresAt: number;
}

/** Only new practice/consent uses this gate; historical recovery remains separate. */
export async function checkLearningDisclosure(
  env: Env,
  destination: ResultsTarget,
) {
  if (destination.version !== 3) return;
  const publicity = await read<Hex>(env, destination, "publicityPolicy");
  check(
    publicity.toLowerCase() === learningV3PublicityPolicy,
    "learning_disclosure_mismatch",
  );
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
  destination: ResultsTarget = enrollmentResultsTarget(env),
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
  destination: ResultsTarget = enrollmentResultsTarget(env),
) {
  destination = retainedTarget(env, destination);
  const [nonce, publicityPolicy, communityId] = await Promise.all([
    read<bigint>(env, destination, "nextNonce", [learner]),
    read<Hex>(env, destination, "publicityPolicy"),
    read<Hex>(env, destination, "communityId"),
  ]);
  if (destination.version === 3)
    check(
      publicityPolicy.toLowerCase() === learningV3PublicityPolicy,
      "learning_disclosure_mismatch",
    );
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
    ...(destination.version === 3 ? { disclosure: learningV3Disclosure } : {}),
    domain: contractDomain(destination),
    types: enrollmentTypes,
    primaryType: "Enrollment" as const,
    message,
  };
}

/** Reuse a grant with at least an hour, publication grace and a minute left.
 * A legacy lesson's binding checks its deadline against the grant; a new
 * lesson's binding requires the grant to be live, and the lesson closes at the
 * grant's last second. */
export async function enrollmentForPractice(
  env: Env,
  store: ResultStore,
  learner: Address,
  destination: ResultsTarget,
  activity: 1 | 2 = 1,
) {
  destination = retainedTarget(env, destination);
  await checkLearningDisclosure(env, destination);
  check(activity === 1 || destination.version === 3, "unsupported_activity");
  const pending = () => !!store.get(pendingEnrollmentKey(destination, learner));
  if (activity === 2 && pending())
    return { pending: true as const, target: destination };
  try {
    const grant = await activeEnrollment(env, learner, destination, activity);
    if (
      activity === 1 ||
      grant.expiresAt >=
        store.now() + Math.ceil(STUDY_LESSON_LIFETIME_MS / 1000) + 120
    )
      return {
        active: true as const,
        target: destination,
        activities: grant.activities,
        expiresAt: grant.expiresAt,
      };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "enrollment_required")
      throw error;
  }
  if (pending()) return { pending: true as const, target: destination };
  return enrollmentRequest(env, learner, store.now(), destination);
}
export async function acceptEnrollment(
  env: Env,
  store: ResultStore,
  e: Enrollment,
  signature: Hex,
  destination: ResultsTarget = enrollmentResultsTarget(env),
) {
  destination = retainedTarget(env, destination);
  if (destination.version === 3) {
    // Check before account activation, pending intent or sponsorship allocation.
    await checkLearningDisclosure(env, destination);
    check(
      e.publicityPolicy.toLowerCase() === learningV3PublicityPolicy,
      "learning_disclosure_mismatch",
    );
  }
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
  destination: ResultsTarget = enrollmentResultsTarget(env),
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
  destination: ResultsTarget = enrollmentResultsTarget(env),
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

/** The V4 contract's RELAY_WINDOW: a sign-in is recorded within seven days or never. */
export const AUTHORIZATION_RELAY_WINDOW_S = 7 * 86400;
export interface AuthorizationReceipt {
  id: Hex;
  state: "pending" | "success" | "reverted";
  txHash: Hex | null;
}
interface PendingAuthorizationJob {
  target: ResultsTarget;
  signIn: Record<string, string>;
  signature: Hex;
}
const authorizationKey = (target: ResultsTarget, id: Hex) =>
  `pendingAuthorization:${target.contract.toLowerCase()}:${id}`;
export const restoreSignIn = (a: Record<string, unknown>): SignIn => ({
  learner: String(a.learner) as Address,
  communityId: String(a.communityId) as Hex,
  origin: String(a.origin),
  publicationPolicy: String(a.publicationPolicy) as Hex,
  nonce: String(a.nonce) as Hex,
  issuedAt: BigInt(String(a.issuedAt)),
  expiresAt: BigInt(String(a.expiresAt)),
});
const storedSignIn = (a: SignIn): Record<string, string> => ({
  ...a,
  issuedAt: String(a.issuedAt),
  expiresAt: String(a.expiresAt),
});
/** The contract's own refusals are final; anything else is retried. */
const contractRefusal =
  /\b(stale_sign_in|revoked_sign_in|replayed_sign_in|invalid_sign_in|invalid_consent)\b/;
async function simulateAuthorization(env: Env, to: Address, data: Hex) {
  try {
    await client(env).call({ to, data });
  } catch (error) {
    const refusal = contractRefusal.exec(
      error instanceof Error ? error.message : "",
    );
    check(!refusal, refusal?.[1] ?? "");
    throw error;
  }
}

/**
 * Relays a learner's V4 sign-in to `authorize`, sponsored as enrollment was.
 * Idempotent per authorization id: a repeated call returns the same
 * transaction, and a sign-in already on chain needs none.
 */
export async function acceptAuthorization(
  env: Env,
  store: ResultStore,
  a: SignIn,
  signature: Hex,
  destination: ResultsTarget = resultsTarget(env, 4),
): Promise<AuthorizationReceipt> {
  destination = retainedTarget(env, destination);
  check(destination.version === 4, "unsupported_results_version");
  check(
    a.communityId.toLowerCase() === env.COMMUNITY_ID.toLowerCase(),
    "wrong_community",
  );
  const id = signInIdV4(destination.chainId, destination.contract, a),
    key = authorizationKey(destination, id);
  const checkPending = () => {
    const pending = store.get<PendingAuthorizationJob>(key);
    check(!pending || pending.signature === signature, "authorization_pending");
  };
  checkPending();
  const receipt = (row?: TxRow): AuthorizationReceipt => ({
    id,
    state: row?.mined?.status ?? "pending",
    txHash: row?.hash ?? null,
  });
  if (
    !intentOf(store, "record_authorize", id) &&
    !intentOf(store, "record_activate", id)
  ) {
    // The relay window is a hard limit: nothing is reserved or signed after it.
    if (store.now() > Number(a.issuedAt) + AUTHORIZATION_RELAY_WINDOW_S) {
      store.delete(key);
      check(false, "stale_sign_in");
    }
    // Anyone may relay a sign-in; one already recorded needs no transaction.
    const recorded = await read<Address>(
      env,
      destination,
      "authorizationLearner",
      [id],
    );
    if (recorded.toLowerCase() === a.learner.toLowerCase()) {
      store.delete(key);
      return { id, state: "success", txHash: null };
    }
  }
  const savePending = () => {
    checkPending();
    store.set(key, { target: destination, signIn: storedSignIn(a), signature });
  };
  const activation = activationOf(signature);
  if (activation) {
    await checkActivation(
      env,
      a.learner,
      activation,
      Number(env.PAYMENT_CHAIN_ID),
    );
    const verified = await client(env).verifyTypedData({
      address: a.learner,
      domain: contractDomain(destination),
      types: signInTypes,
      primaryType: "SignIn",
      message: { ...a },
      signature,
    });
    check(verified, "invalid_consent");
    if ((await codeOf(env, a.learner)) === "0x") {
      check(
        env.APPROVED_ACTIVATION_ACCOUNT?.toLowerCase() ===
          a.learner.toLowerCase(),
        "account_activation_not_approved",
      );
      if (!intentOf(store, "record_activate", id))
        check(
          activation.authorization.nonce === (await nonceOf(env, a.learner)),
          "authorization_nonce_stale",
        );
      store.transaction(() => {
        savePending();
        reserveSponsorship(store, sponsorLimits(env), `record_activate:${id}`);
        reserveSponsorship(store, sponsorLimits(env), `record_authorize:${id}`);
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
      if (!activated?.mined) return receipt();
      check(activated.mined.status === "success", "account_activation_failed");
    }
    check(
      await acceptedByAccount(env, a.learner, id, activation.inner),
      "consent_refused_by_account",
    );
  }
  const data = encodeFunctionData({
    abi: resultsV4Abi,
    functionName: "authorize",
    args: [a, activation?.inner ?? signature],
  });
  // Simulation applies every contract rule before anything is reserved or signed.
  if (!intentOf(store, "record_authorize", id))
    await simulateAuthorization(env, destination.contract, data);
  store.transaction(() => {
    savePending();
    reserveSponsorship(store, sponsorLimits(env), `record_authorize:${id}`);
  });
  const row = await submitResultTransaction(
    env,
    store,
    "record_authorize",
    id,
    data,
    destination.contract,
  );
  if (row?.mined) store.delete(key);
  return receipt(row);
}

/** Alarm recovery: each stored sign-in is retried until mined or out of its window. */
export async function resumeAuthorizations(env: Env, store: ResultStore) {
  for (const { value } of store.entries("pendingAuthorization:")) {
    const job = value as PendingAuthorizationJob;
    try {
      await acceptAuthorization(
        env,
        store,
        restoreSignIn(job.signIn),
        job.signature,
        retainedTarget(env, job.target),
      );
    } catch {
      /* Retained until mined or refused; the window bounds new work. */
    }
  }
}

/** Live permission as the chain records it, for the application. */
export async function authorizationState(env: Env, learner: Address) {
  const target = resultsTarget(env, 4);
  const [since, revokedAt] = await Promise.all([
    read<bigint>(env, target, "authorizedSince", [learner]),
    read<bigint>(env, target, "revokedAt", [learner]),
  ]);
  return { since: Number(since), revokedAt: Number(revokedAt) };
}

/** POST /authorization relays a sign-in; GET /authorization/:learner reads permission. */
export async function authorizationRoute(
  request: Request,
  env: Env,
  store: ResultStore,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/authorization" && request.method === "POST") {
    const { signIn, signature } = await body<{
      signIn: Record<string, unknown>;
      signature: Hex;
    }>(request);
    check(
      signIn !== null &&
        typeof signIn === "object" &&
        typeof signature === "string" &&
        /^0x[0-9a-fA-F]+$/.test(signature),
      "invalid_consent",
    );
    return Response.json(
      await acceptAuthorization(env, store, restoreSignIn(signIn), signature),
    );
  }
  const learner = /^\/authorization\/(0x[0-9a-fA-F]{40})$/.exec(path);
  if (learner && request.method === "GET")
    return Response.json(await authorizationState(env, learner[1] as Address));
  return null;
}
