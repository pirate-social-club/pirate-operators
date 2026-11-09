// The operator's half of V4: a learner's community sign-in is the standing
// publication permission. A sign-in is relayed to LearningResultsV4.authorize,
// and withdrawal is the learner's signed Revocation relayed to revoke, an
// explicit account-settings action. Both are sponsored as enrollment was.
import { encodeFunctionData, hashTypedData, type Address, type Hex } from "viem";
import {
  resultsV4Abi,
  signInIdV4,
  signInTypes,
  type SignIn,
} from "../packages/protocol/learning-results-v4.ts";
import { revocationTypes } from "../packages/protocol/learning-results.ts";
import { check } from "../packages/protocol/index.ts";
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
  contractDomain,
  resultsTarget,
  retainedTarget,
  revocationKey,
  sameResultsTarget,
  type ResultsTarget,
} from "./learning-contract.ts";
import type { Env } from "./runtime.ts";
import { body } from "./service-call.ts";

/**
 * The V4 contract's RELAY_WINDOW, the thirty-day community session: a sign-in
 * is recorded within it or never.
 */
export const AUTHORIZATION_RELAY_WINDOW_S = 30 * 86400;
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
  for (const { value } of store.entries("revocationIntent:4:")) {
    const job = value as RevocationJobV4;
    if (!job.pending) continue;
    try {
      await acceptRevocationV4(
        env,
        store,
        job.learner,
        BigInt(job.nonce),
        job.signature,
      );
    } catch {
      /* Retained: an authenticated withdrawal is retried until mined. */
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

/** The EIP-712 digest the contract's revocationDigest computes; the withdrawal's id. */
export const revocationIdV4 = (
  target: ResultsTarget,
  learner: Address,
  nonce: bigint,
) =>
  hashTypedData({
    domain: contractDomain(target),
    types: revocationTypes,
    primaryType: "Revocation",
    message: { learner, nonce },
  });

/** The typed Revocation the learner signs to turn public results off. */
export async function revocationRequestV4(env: Env, learner: Address) {
  const target = resultsTarget(env, 4);
  return {
    target,
    domain: contractDomain(target),
    types: revocationTypes,
    primaryType: "Revocation" as const,
    message: {
      learner,
      nonce: String(await read<bigint>(env, target, "nextNonce", [learner])),
    },
  };
}

interface RevocationJobV4 {
  target: ResultsTarget;
  learner: Address;
  nonce: string;
  signature: Hex;
  data: Hex;
  grantId: Hex;
  pending: boolean;
}

/**
 * Relays the learner's signed withdrawal to `revoke`. Unlike V3 there is no
 * grant to find: revoking is valid whether or not a sign-in is recorded yet,
 * and it also bars every sign-in made at or before it. Idempotent per nonce.
 */
export async function acceptRevocationV4(
  env: Env,
  store: ResultStore,
  learner: Address,
  nonce: bigint,
  signature: Hex,
) {
  const target = resultsTarget(env, 4);
  const data = encodeFunctionData({
    abi: resultsV4Abi,
    functionName: "revoke",
    args: [learner, nonce, activationOf(signature)?.inner ?? signature],
  });
  const key = revocationKey(target, learner, nonce);
  let job = store.get<RevocationJobV4>(key);
  if (!job) {
    // Simulation applies the nonce and signature rules before anything is reserved.
    await client(env).call({ to: target.contract, data });
    job = {
      target,
      learner,
      nonce: String(nonce),
      signature,
      data,
      grantId: revocationIdV4(target, learner, nonce),
      pending: true,
    };
    store.set(key, job);
  }
  check(
    job.data === data &&
      sameResultsTarget(retainedTarget(env, job.target), target),
    "revocation_payload_changed",
  );
  const row = await submitResultTransaction(
    env,
    store,
    "record_revoke",
    job.grantId,
    data,
    target.contract,
  );
  if (row?.mined) store.set(key, { ...job, pending: false });
  return row;
}

/**
 * POST /authorization relays a sign-in; POST /authorization/revoke returns the
 * Revocation to sign, or relays a signed one; GET /authorization/:learner
 * reads permission.
 */
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
  if (path === "/authorization/revoke" && request.method === "POST") {
    const { learner, nonce, signature } = await body<{
      learner: Address;
      nonce?: string;
      signature?: Hex;
    }>(request);
    check(
      typeof learner === "string" && /^0x[0-9a-fA-F]{40}$/.test(learner),
      "invalid_wallet",
    );
    if (signature === undefined)
      return Response.json(await revocationRequestV4(env, learner));
    check(
      typeof signature === "string" &&
        /^0x[0-9a-fA-F]+$/.test(signature) &&
        typeof nonce === "string" &&
        /^[0-9]{1,20}$/.test(nonce),
      "invalid_consent",
    );
    const row = await acceptRevocationV4(
      env,
      store,
      learner,
      BigInt(nonce),
      signature,
    );
    return Response.json({ state: row?.mined?.status ?? "pending" });
  }
  const learner = /^\/authorization\/(0x[0-9a-fA-F]{40})$/.exec(path);
  if (learner && request.method === "GET")
    return Response.json(await authorizationState(env, learner[1] as Address));
  return null;
}
