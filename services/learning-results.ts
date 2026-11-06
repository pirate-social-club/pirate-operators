import {
  createPublicClient,
  encodeFunctionData,
  http,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { check, type Signed, type Ticket } from "../packages/protocol/index.ts";
import {
  enrollmentIdOf,
  enrollmentTypes,
  orderedExercisesHash,
  packOutcomes,
  resultPeriod,
  resultCommitment,
  revocationTypes,
  resultsAbi,
  resultsDomain,
  type Enrollment,
  type TerminalResult,
} from "../packages/protocol/learning-results.ts";
import {
  COMPLETION_STATUS_CODES,
  textKey,
} from "../packages/protocol/records.ts";
import type {
  KaraokeManifest,
  KaraokeResultBody,
} from "../packages/protocol/payments.ts";
import {
  dispatch,
  enqueue,
  intentOf,
  txRow,
  type TxKind,
  type TxStore,
} from "./operator-tx.ts";
import {
  acceptedByAccount,
  activationOf,
  checkActivation,
  codeOf,
  nonceOf,
} from "./accounts.ts";
import {
  chargeSponsorship,
  releaseSponsorship,
  reserveSponsorship,
  sponsorLimits,
} from "./sponsor-budget.ts";
import type { Env, Store } from "./runtime.ts";

type ResultStore = TxStore & Pick<Store, "now">;

const target = (env: Env) => env.RESULTS_V2_CONTRACT as Address;
const client = (env: Env) =>
  createPublicClient({ transport: http(env.RPC_URL) });
const read = <T>(env: Env, functionName: string, args: unknown[] = []) =>
  client(env).readContract({
    address: target(env),
    abi: resultsAbi,
    functionName,
    args,
  } as never) as Promise<T>;
export interface BoundEnrollment {
  id: Hex;
  issuedAt: number;
  expiresAt: number;
}
export async function activeEnrollment(
  env: Env,
  learner: Address,
): Promise<BoundEnrollment> {
  const [id, activities, issuedAt, expiresAt] = await read<
    readonly [Hex, bigint, bigint, bigint]
  >(env, "enrollments", [learner]);
  check(
    id !== zeroHash &&
      (activities & 1n) !== 0n &&
      expiresAt > BigInt(Math.floor(Date.now() / 1000)),
    "enrollment_required",
  );
  return { id, issuedAt: Number(issuedAt), expiresAt: Number(expiresAt) };
}
export async function enrollmentRequest(
  env: Env,
  learner: Address,
  now: number,
) {
  const [nonce, publicityPolicy, communityId] = await Promise.all([
    read<bigint>(env, "nextNonce", [learner]),
    read<Hex>(env, "publicityPolicy"),
    read<Hex>(env, "communityId"),
  ]);
  const message = {
    learner,
    communityId,
    activities: "1",
    publicityPolicy,
    expiresAt: String(now + 30 * 86400),
    nonce: String(nonce),
  };
  return {
    domain: resultsDomain(Number(env.PAYMENT_CHAIN_ID), target(env)),
    types: enrollmentTypes,
    primaryType: "Enrollment",
    message,
  };
}
export async function submitResultTransaction(
  env: Env,
  store: ResultStore,
  kind: TxKind,
  ref: string,
  data: Hex,
  destination: Address = target(env),
  authorizationList?: Parameters<typeof enqueue>[6],
) {
  const limits = sponsorLimits(env);
  reserveSponsorship(store, limits, `${kind}:${ref}`);
  enqueue(store, kind, ref, destination, data, limits.gas, authorizationList);
  // Keep the full maximum charged across unknown/reverted results and restarts.
  chargeSponsorship(store, limits, `${kind}:${ref}`);
  return dispatch(env, store, kind, ref, {
    maxFeePerGas: limits.gasPrice,
    maxTotalFee: limits.cap,
  });
}
export async function acceptEnrollment(
  env: Env,
  store: ResultStore,
  e: Enrollment,
  signature: Hex,
) {
  check(
    e.communityId.toLowerCase() === env.COMMUNITY_ID.toLowerCase(),
    "wrong_community",
  );
  const id = enrollmentIdOf(Number(env.PAYMENT_CHAIN_ID), target(env), e);
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
      domain: resultsDomain(Number(env.PAYMENT_CHAIN_ID), target(env)),
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
      reserveSponsorship(store, sponsorLimits(env), `record_activate:${id}`);
      reserveSponsorship(store, sponsorLimits(env), `record_enroll:${id}`);
      store.set(`pendingEnrollment:${e.learner.toLowerCase()}`, {
        enrollment: {
          ...e,
          activities: String(e.activities),
          expiresAt: String(e.expiresAt),
          nonce: String(e.nonce),
        },
        signature,
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
    abi: resultsAbi,
    functionName: "enroll",
    args: [e, activation?.inner ?? signature],
  });
  // Simulation rejects invalid consent before reserving/signing any transaction.
  if (!intentOf(store, "record_enroll", id))
    await client(env).call({ to: target(env), data });
  reserveSponsorship(store, sponsorLimits(env), `record_revoke:${id}`);
  store.set(`pendingEnrollment:${e.learner.toLowerCase()}`, {
    enrollment: {
      ...e,
      activities: String(e.activities),
      expiresAt: String(e.expiresAt),
      nonce: String(e.nonce),
    },
    signature,
  });
  const row = await submitResultTransaction(
    env,
    store,
    "record_enroll",
    id,
    data,
  );
  if (row?.mined) store.delete(`pendingEnrollment:${e.learner.toLowerCase()}`);
  return row;
}
export const publicationV2 = (store: ResultStore, ticketId: string) =>
  store.get<{
    state: "pending" | "published" | "private" | "failed";
    revision: number;
    reason?: string;
    confirmed?: boolean;
    checkedAt?: number;
  }>(`publicationV2:${ticketId}`);
export async function bindEnrollment(
  env: Env,
  store: ResultStore,
  ticketId: string,
  learner: Address,
) {
  const grant = await activeEnrollment(env, learner);
  check(store.now() >= grant.issuedAt, "enrollment_not_active_yet");
  const previous = store.get<BoundEnrollment>(`enrollment:${ticketId}`);
  check(!previous || previous.id === grant.id, "enrollment_changed");
  store.transaction(() => {
    reserveSponsorship(store, sponsorLimits(env), `record_result:${ticketId}:1`);
    reserveSponsorship(store, sponsorLimits(env), `record_result:${ticketId}:2`);
    store.set(`enrollment:${ticketId}`, grant);
  });
}
type FrozenBundle = { result: TerminalResult; outcomes: Hex; data: Hex };
const restoreHeader = (r: TerminalResult): TerminalResult => ({
  ...r,
  song: { ...r.song, chainId: BigInt(r.song.chainId) },
  startedAt: BigInt(r.startedAt),
  completedAt: BigInt(r.completedAt),
});
const durableValue = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v)),
  );
export async function publishV2(
  env: Env,
  store: ResultStore,
  ticketId: string,
) {
  const signed = store.get<Signed<KaraokeResultBody>>(`result:${ticketId}`);
  const ticket = store.get<Signed<Ticket>>(`ticket:${ticketId}`)?.body;
  const bound = store.get<BoundEnrollment>(`enrollment:${ticketId}`);
  if (!signed || !ticket || !bound) return;
  const result = signed.body,
    revision = result.revision,
    ref = `${ticketId}:${revision}`;
  const oldState = publicationV2(store, ticketId);
  if (
    oldState?.revision === revision &&
    (oldState.state === "private" ||
      oldState.state === "failed" ||
      (oldState.confirmed && (oldState.checkedAt ?? 0) > store.now() - 3600))
  )
    return oldState;
  let job = store.get<FrozenBundle>(`workV2:${ref}`);
  const current = await read<Hex>(env, "commitments", [result.attemptId]);
  if (oldState?.state === "published" && job) {
    if (current === resultCommitment(restoreHeader(job.result), job.outcomes)) {
      const intent = intentOf(store, "record_result", ref),
        row = intent?.nonce == null ? undefined : txRow(store, intent.nonce);
      const head = await client(env).getBlockNumber({ cacheTime: 0 });
      const next = {
        ...oldState,
        confirmed: !!row?.mined && head >= BigInt(row.mined.block + 12),
        checkedAt: store.now(),
      };
      store.set(`publicationV2:${ticketId}`, next);
      return next;
    }
    if (current !== job.result.supersedes) {
      const next = {
        state: "failed" as const,
        revision,
        reason: "canonical_result_changed",
      };
      store.set(`publicationV2:${ticketId}`, next);
      return next;
    }
    // The canonical chain lost this publication. Reuse its original signed intent.
    const intent = intentOf(store, "record_result", ref);
    if (intent?.nonce != null) {
      const row = txRow(store, intent.nonce)!;
      store.set(`tx:${String(row.nonce).padStart(10, "0")}`, {
        ...row,
        mined: null,
      });
    }
  }
  const state = { state: "pending" as const, revision };
  store.set(`publicationV2:${ticketId}`, state);
  if (revision === 1 && !intentOf(store, "record_result", ref)) {
    const [id, , , expires] = await read<
      readonly [Hex, bigint, bigint, bigint]
    >(env, "enrollments", [ticket.participant]);
    if (id !== bound.id || Number(expires) <= store.now()) {
      releaseSponsorship(store, sponsorLimits(env), `record_result:${ref}`);
      releaseSponsorship(store, sponsorLimits(env), `record_result:${ticketId}:2`);
      const next = {
        state: "private" as const,
        revision,
        reason: "enrollment_inactive",
      };
      store.set(`publicationV2:${ticketId}`, next);
      return next;
    }
  }
  if (!job) {
    const manifest = store.get<KaraokeManifest>(
      `manifest:${ticket.manifestSha256}`,
    )!;
    check(manifest.song, "published_song_required");
    const previous = store.get<{ result: TerminalResult; outcomes: Hex }>(
      `bundleV2:${ticketId}`,
    );
    check(
      revision === 1 || previous?.result.revision === revision - 1,
      "missing_prior_bundle",
    );
    const header: TerminalResult = {
      sessionId: result.attemptId,
      learner: ticket.participant,
      enrollmentId: bound.id,
      song: { ...manifest.song, chainId: BigInt(manifest.song.chainId) },
      contentRevision: result.manifestSha256,
      exercisesHash: orderedExercisesHash(result.lines.length),
      linesTotal: result.lines.length,
      activity: 1,
      grader: env.OPERATOR_ADDRESS,
      scoringPolicy: textKey(
        `karaoke-scoring/${result.summary.scoringVersion}`,
      ),
      qualificationPolicy:
        revision > 1
          ? previous!.result.qualificationPolicy
          : await read<Hex>(env, "policyFor", [
              resultPeriod(BigInt(result.performanceEndedAt)),
            ]),
      startedAt: BigInt(result.startedAt),
      completedAt: BigInt(result.performanceEndedAt),
      status: COMPLETION_STATUS_CODES[result.status],
      revision,
      supersedes: revision === 1 ? zeroHash : current,
    };
    const outcomes = packOutcomes(result.lines);
    const data =
      revision === 1
        ? encodeFunctionData({
            abi: resultsAbi,
            functionName: "publish",
            args: [header, outcomes],
          })
        : encodeFunctionData({
            abi: resultsAbi,
            functionName: "correct",
            args: [
              restoreHeader(previous!.result),
              previous!.outcomes,
              outcomes,
              header.status,
            ],
          });
    job = { result: header, outcomes, data };
    store.set(`workV2:${ref}`, durableValue(job));
  }
  const row = await submitResultTransaction(
    env,
    store,
    "record_result",
    ref,
    job.data,
  );
  if (!row?.mined) return state;
  if (
    store.get<Signed<KaraokeResultBody>>(`result:${ticketId}`)?.body
      .revision !== revision
  )
    return state;
  const next = {
    state:
      row.mined.status === "success"
        ? ("published" as const)
        : ("failed" as const),
    revision,
    confirmed: false,
    checkedAt: store.now(),
  };
  if (row.mined.status === "success")
    store.set(
      `bundleV2:${ticketId}`,
      durableValue({ result: job.result, outcomes: job.outcomes }),
    );
  store.set(`publicationV2:${ticketId}`, next);
  return next;
}

export async function resumeEnrollments(env: Env, store: ResultStore) {
  for (const { value } of store.entries("pendingEnrollment:")) {
    const job = value as { enrollment: Record<string, string>; signature: Hex },
      e = job.enrollment;
    try {
      await acceptEnrollment(
        env,
        store,
        {
          learner: e.learner as Address,
          communityId: e.communityId as Hex,
          publicityPolicy: e.publicityPolicy as Hex,
          activities: BigInt(e.activities),
          expiresAt: BigInt(e.expiresAt),
          nonce: BigInt(e.nonce),
        },
        job.signature,
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
      );
    } catch {
      /* Retain authenticated work for bounded recovery. */
    }
  }
}

/** Operator-controlled correction; the testnet HTTP profile exposes no unauthenticated control route. */
export async function correctV2(
  env: Env,
  store: ResultStore,
  input: {
    ticketId: string;
    lineId: string;
    status: import("../packages/protocol/payments.ts").LineStatus;
    scoreBps: number | null;
  },
) {
  const state = publicationV2(store, input.ticketId);
  check(state?.state === "published", "publication_not_complete");
  const signed = store.get<Signed<KaraokeResultBody>>(
    `result:${input.ticketId}`,
  )!;
  const previous = signed.body,
    lines = previous.lines.map((line) =>
      line.lineId === input.lineId
        ? { ...line, status: input.status, scoreBps: input.scoreBps }
        : line,
    );
  check(
    lines.some((line) => line.lineId === input.lineId),
    "unknown_line",
  );
  packOutcomes(lines);
  const { digest, sign } = await import("../packages/protocol/index.ts");
  const { rewardScore } = await import("../packages/protocol/payments.ts");
  check(digest(lines) !== previous.linesHash, "no_change");
  const next = {
    ...previous,
    revision: previous.revision + 1,
    lines,
    linesHash: digest(lines),
    ...rewardScore(lines),
  };
  const result = await sign(
    "result",
    next,
    env.PRIVATE_KEY,
    Number(env.SIGNATURE_CHAIN_ID ?? 31337),
  );
  store.transaction(() => {
    check(
      store.get<Signed<KaraokeResultBody>>(`result:${input.ticketId}`)?.body
        .revision === previous.revision &&
        publicationV2(store, input.ticketId)?.state === "published",
      "correction_conflict",
    );
    store.set(`resultRevision:${input.ticketId}:${previous.revision}`, signed);
    store.set(`result:${input.ticketId}`, result);
    store.set(`publicationV2:${input.ticketId}`, {
      state: "pending",
      revision: next.revision,
    });
  });
  return next;
}

export async function revocationRequest(env: Env, learner: Address) {
  return {
    domain: resultsDomain(Number(env.PAYMENT_CHAIN_ID), target(env)),
    types: revocationTypes,
    primaryType: "Revocation",
    message: {
      learner,
      nonce: String(await read<bigint>(env, "nextNonce", [learner])),
    },
  };
}
export async function acceptRevocation(
  env: Env,
  store: ResultStore,
  learner: Address,
  nonce: bigint,
  signature: Hex,
) {
  const data = encodeFunctionData({
    abi: resultsAbi,
    functionName: "revoke",
    args: [learner, nonce, activationOf(signature)?.inner ?? signature],
  });
  const key = `revocationIntent:${learner.toLowerCase()}:${nonce}`;
  let job = store.get<RevocationJob>(key);
  if (!job) {
    await client(env).call({ to: target(env), data });
    const [grantId] = await read<readonly [Hex, bigint, bigint, bigint]>(
      env,
      "enrollments",
      [learner],
    );
    check(grantId !== zeroHash, "enrollment_required");
    job = {
      learner,
      nonce: String(nonce),
      signature,
      data,
      grantId,
      pending: true,
    };
    store.set(key, job);
  }
  check(job.data === data, "revocation_payload_changed");
  const row = await submitResultTransaction(
    env,
    store,
    "record_revoke",
    job.grantId,
    data,
  );
  if (row?.mined) store.set(key, { ...job, pending: false });
  return row;
}
interface RevocationJob {
  learner: Address;
  nonce: string;
  signature: Hex;
  data: Hex;
  grantId: Hex;
  pending: boolean;
}
