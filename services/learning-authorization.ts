// The operator's half of V4: a learner's community sign-in is the standing
// publication permission. A sign-in is relayed to LearningResultsV4.authorize,
// and withdrawal is the learner's signed Revocation relayed to revoke, an
// explicit account-settings action. Both are sponsored as enrollment was.
import {
  encodeFunctionData,
  hashTypedData,
  type Address,
  type Hex,
} from "viem";
import {
  resultsV4Abi,
  type SignIn,
} from "../packages/protocol/learning-results-v4.ts";
import { revocationTypes } from "../packages/protocol/learning-results.ts";
import { check, digest } from "../packages/protocol/index.ts";
import {
  stageLinkedWithdrawal,
  guardLinkedWithdrawal,
} from "./study-linked-withdrawal.ts";
import {
  acceptedByAccount,
  activationOf,
  checkActivation,
  codeOf,
  nonceOf,
} from "./accounts.ts";
import {
  dispatch,
  enqueue,
  intentOf,
  txRow,
  type TxRow,
  type TxKind,
} from "./operator-tx.ts";
import {
  activationLimits,
  authorizationRetired,
  chargeSponsorship,
  retireUnallocatedAuthorization,
  reserveActivationSponsorship,
  reserveSponsorship,
  sponsorLimits,
  type ActivationSponsorEnv,
} from "./sponsor-budget.ts";
import {
  submitResultTransaction,
  type ResultStore,
} from "./learning-transactions.ts";
import {
  resultClient as client,
  readResultContract as read,
  contractDomain,
  legacyResultsWithheld,
  legacyResultsWithheldKey,
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
export const LEARNING_AUTHORITY_INTERFACE = "pirate.learning-authorization/1";
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
function retireAuthorizationWork(
  env: Env,
  store: ResultStore,
  learner: Address,
  id: Hex,
  key: string,
) {
  return store.transaction(() => {
    retireUnallocatedAuthorization(store, sponsorLimits(env), learner, id);
    store.delete(key);
  });
}
/** The compact sign-in, as the application stores and sends it. */
export const restoreSignIn = (a: Record<string, unknown>): SignIn => ({
  learner: String(a.learner) as Address,
  nonce: String(a.nonce) as Hex,
  issuedAt: BigInt(String(a.issuedAt)),
});
const storedSignIn = (a: SignIn): Record<string, string> => ({
  learner: a.learner,
  nonce: a.nonce,
  issuedAt: String(a.issuedAt),
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
  // The contract renders the text from its own community, origin and policy:
  // its digest is the authorization id, and a sign-in for another community
  // is a different text that it refuses as invalid_consent.
  const id = await read<Hex>(env, destination, "signInDigest", [a]),
    key = authorizationKey(destination, id);
  const checkPending = () => {
    const pending = store.get<PendingAuthorizationJob>(key);
    check(!pending || pending.signature === signature, "authorization_pending");
  };
  const expiresAt = Number(a.issuedAt) + AUTHORIZATION_RELAY_WINDOW_S;
  const expired = () => store.now() > expiresAt;
  const retire = () => retireAuthorizationWork(env, store, a.learner, id, key);
  const ensureOpen = () => {
    if (expired()) retire();
    check(!authorizationRetired(store, id), "stale_sign_in");
  };
  const receipt = (row?: TxRow): AuthorizationReceipt => ({
    id,
    // Only withheld result rows are ever cancelled or superseded; never an
    // authorization. Neither is a success.
    state:
      row?.mined?.status === "success" || row?.mined?.status === "reverted"
        ? row.mined.status
        : "pending",
    txHash: row?.hash ?? null,
  });
  if (expired() || authorizationRetired(store, id)) {
    if (expired()) retire();
    const prior = intentOf(store, "record_authorize", id);
    if (prior?.nonce != null) return receipt(txRow(store, prior.nonce));
    check(false, "stale_sign_in");
  }
  checkPending();
  // The allocation gate rechecks time and tombstones after dispatch's awaited
  // fee/nonce reads. It never withholds or refunds an allocated transaction.
  const submit = async (
    kind: "record_activate" | "record_authorize",
    data: Hex,
    to: Address,
    authorizations?: Parameters<typeof enqueue>[6],
  ) => {
    ensureOpen();
    const limits = sponsorLimits(env),
      previous = intentOf(store, kind, id);
    check(
      !previous ||
        (previous.to.toLowerCase() === to.toLowerCase() &&
          previous.data === data),
      "result_transaction_changed",
    );
    store.transaction(() => {
      check(!authorizationRetired(store, id), "stale_sign_in");
      reserveSponsorship(store, limits, `${kind}:${id}`);
      enqueue(store, kind, id, to, data, limits.gas, authorizations);
      chargeSponsorship(store, limits, `${kind}:${id}`);
    });
    const row = await dispatch(
      env,
      store,
      kind,
      id,
      { maxFeePerGas: limits.gasPrice, maxTotalFee: limits.cap },
      {
        reason: "stale_sign_in",
        recorded(k: TxKind, ref: string) {
          if (
            ref !== id ||
            (k !== "record_activate" && k !== "record_authorize") ||
            intentOf(store, k, ref)?.nonce != null
          )
            return false;
          if (expired()) retire();
          return authorizationRetired(store, id);
        },
        withheld: async () => false,
        limits: () => ({
          maxFeePerGas: limits.gasPrice,
          maxTotalFee: limits.cap,
        }),
      },
    );
    check(row || !authorizationRetired(store, id), "stale_sign_in");
    return row;
  };
  if (
    !intentOf(store, "record_authorize", id) &&
    !intentOf(store, "record_activate", id)
  ) {
    // The contract requires issuedAt <= block.timestamp. A sign-in issued by
    // an application clock ahead of the chain is not yet valid, which is
    // retryable and never the final stale_sign_in. Nothing is reserved.
    const head = await client(env).getBlock({ blockTag: "latest" });
    check(a.issuedAt <= head.timestamp, "sign_in_not_yet_valid");
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
    check(!authorizationRetired(store, id), "stale_sign_in");
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
    const verified = await client(env).verifyHash({
      address: a.learner,
      hash: id,
      signature,
    });
    check(verified, "invalid_consent");
    if ((await codeOf(env, a.learner)) === "0x") {
      const limits = activationLimits(env as Env & ActivationSponsorEnv);
      const revokedAt = await read<bigint>(env, destination, "revokedAt", [
        a.learner,
      ]);
      check(a.issuedAt > revokedAt, "revoked_sign_in");
      if (!intentOf(store, "record_activate", id))
        check(
          activation.authorization.nonce === (await nonceOf(env, a.learner)),
          "authorization_nonce_stale",
        );
      ensureOpen();
      store.transaction(() => {
        savePending();
        reserveActivationSponsorship(
          store,
          sponsorLimits(env),
          limits,
          a.learner,
          id,
        );
      });
      const activated = await submit(
        "record_activate",
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
  ensureOpen();
  store.transaction(() => {
    savePending();
    reserveSponsorship(store, sponsorLimits(env), `record_authorize:${id}`);
  });
  const row = await submit("record_authorize", data, destination.contract);
  if (row?.mined) store.delete(key);
  return receipt(row);
}

/** Alarm recovery: each stored sign-in is retried until mined or out of its window. */
export async function resumeAuthorizations(env: Env, store: ResultStore) {
  for (const { key, value } of store.entries("pendingAuthorization:")) {
    const job = value as PendingAuthorizationJob;
    try {
      const target = retainedTarget(env, job.target),
        signIn = restoreSignIn(job.signIn);
      const id = key.slice(key.lastIndexOf(":") + 1) as Hex;
      if (
        store.now() > Number(signIn.issuedAt) + AUTHORIZATION_RELAY_WINDOW_S &&
        /^0x[0-9a-f]{64}$/.test(id) &&
        key === authorizationKey(target, id)
      ) {
        // The journal already bound this digest before reserving. Expiry and
        // the never-allocated proof need no RPC availability to reclaim it.
        retireAuthorizationWork(env, store, signIn.learner, id, key);
        continue;
      }
      await acceptAuthorization(env, store, signIn, job.signature, target);
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
        job.target,
      );
    } catch {
      /* Retained: an authenticated withdrawal is retried until mined. */
    }
  }
}

/** Live permission as the chain records it, for the application. */
export async function authorizationState(
  env: Env,
  learner: Address,
  store?: ResultStore,
) {
  const target = resultsTarget(env, 4);
  const chain = client(env);
  const blockNumber = await chain.getBlockNumber({ cacheTime: 0 });
  const readAt = (
    functionName: "authorizedSince" | "revokedAt" | "nextNonce",
  ) =>
    chain.readContract({
      address: target.contract,
      abi: resultsV4Abi,
      functionName,
      args: [learner],
      blockNumber,
    });
  const [since, revokedAt, nonce] = await Promise.all([
    readAt("authorizedSince"),
    readAt("revokedAt"),
    readAt("nextNonce"),
  ]);
  // Current readiness may be restored by a later sign-in. The historical
  // cutoff/nonce is still a withdrawal signal; proof/discovery is independent.
  if (store && revokedAt > 0n) {
    check(store.durableStudyWrite, "study_binding_wake_unconfigured");
    const scope = { communityId: env.COMMUNITY_ID, target, learner };
    await store.durableStudyWrite(() =>
      stageLinkedWithdrawal(store, {
        id: digest(["observed", scope, String(revokedAt), String(nonce)]),
        scope,
        kind: "observed",
        identity: { cutoff: String(revokedAt), nonce: String(nonce) },
      }),
    );
  }
  const revocations = `revocationIntent:4:${target.contract.toLowerCase()}:${learner.toLowerCase()}:`;
  const pending = store
    // Durable Object SQLite limits LIKE patterns to 50 bytes. The full
    // contract/account prefix is longer; apply its exact match in memory.
    ?.entries("revocationIntent:4:")
    .some(({ key, value }) => {
      if (!key.startsWith(revocations)) return false;
      const job = value as RevocationJobV4;
      if (job.pending) return true;
      const intent = intentOf(store!, "record_revoke", job.grantId);
      const row =
        intent?.nonce == null ? undefined : txRow(store!, intent.nonce);
      // A revocation may confirm during the pinned reads. Do not report the
      // older snapshot as ready for turn-on until it includes that receipt.
      return row?.mined?.status === "success" && nonce <= BigInt(job.nonce);
    });
  let linkedPending = false;
  if (store) {
    try {
      guardLinkedWithdrawal(store, {
        communityId: env.COMMUNITY_ID,
        target,
        learner,
      });
    } catch {
      linkedPending = true;
    }
  }
  return {
    since: Number(since),
    revokedAt: Number(revokedAt),
    revocationNonce: String(nonce),
    ...(pending ? { pendingWithdrawal: true } : {}),
    ...(linkedPending ? { linkedWithdrawalPending: true } : {}),
  };
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
  destination: ResultsTarget = resultsTarget(env, 4),
) {
  // This optional destination is internal recovery input. Public requests use
  // resultsTarget above; a retained job must never inherit a newer default.
  const target = destination;
  check(
    target.version === 4 &&
      target.chainId === Number(env.PAYMENT_CHAIN_ID) &&
      [31337, 6343].includes(target.chainId) &&
      /^0x[0-9a-f]{40}$/i.test(target.contract) &&
      BigInt(target.contract) > 0n,
    "unsupported_results_version",
  );
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
  }
  check(store.durableStudyWrite, "study_binding_wake_unconfigured");
  // The simulation awaited above is not a lock. Reread the immutable job in
  // the same durable transaction as the temporary linked fence and wake.
  job = await store.durableStudyWrite(() => {
    const candidate: RevocationJobV4 = {
      target,
      learner,
      nonce: String(nonce),
      signature,
      data,
      grantId: revocationIdV4(target, learner, nonce),
      pending: true,
    };
    const retained = store.get<RevocationJobV4>(key);
    check(
      !retained ||
        (retained.data === data &&
          retained.signature === signature &&
          retained.learner.toLowerCase() === learner.toLowerCase() &&
          retained.nonce === String(nonce) &&
          retained.grantId === candidate.grantId &&
          sameResultsTarget(retained.target, target)),
      "revocation_payload_changed",
    );
    const original = retained ?? candidate;
    if (!retained) store.set(key, original);
    stageLinkedWithdrawal(store, {
      id: "signed:" + original.grantId,
      scope: {
        communityId: env.COMMUNITY_ID,
        learner: original.learner,
        target: original.target,
      },
      kind: "signed",
      identity: {
        target: original.target,
        learner: original.learner,
        nonce: original.nonce,
        signature: original.signature,
        data: original.data,
        grantId: original.grantId,
      },
    });
    // The withdrawal also stops this learner's earlier-version results that
    // are not yet sent, before the revoke is even mined.
    if (!legacyResultsWithheld(store, learner))
      store.set(legacyResultsWithheldKey(learner), {
        at: store.now(),
        nonce: original.nonce,
      });
    return original;
  });
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
    return Response.json(
      await authorizationState(env, learner[1] as Address, store),
    );
  return null;
}
