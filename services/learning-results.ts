import { encodeFunctionData, zeroHash, type Address, type Hex } from "viem";
import { check, type Signed, type Ticket } from "../packages/protocol/index.ts";
import {
  orderedExercisesHash,
  packOutcomes,
  resultPeriod,
  resultCommitment,
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
  intentOf,
  recheckSuperseded,
  txRow,
  withheldUnpublished,
} from "./operator-tx.ts";

/** How often a private, withheld Karaoke result is re-read from chain. */
const WITHHELD_RECHECK_S = 600;
import {
  releaseSponsorship,
  reserveSponsorship,
  sponsorLimits,
} from "./sponsor-budget.ts";
import type { Env } from "./runtime.ts";
import {
  activeEnrollment,
  checkLearningDisclosure,
  type BoundEnrollment,
} from "./learning-enrollment.ts";
import {
  resultUnsent,
  submitResultTransaction,
  withdrawUnsentResult,
  type ResultStore,
} from "./learning-transactions.ts";
import {
  resultClient as client,
  readResultContract as read,
  contractAbi,
  enrollmentResultsTarget,
  legacyResultsWithdrawn,
  retainedTarget,
  resultsTarget,
  sameResultsTarget,
  resultPolicyAt,
  type ResultsTarget,
} from "./learning-contract.ts";
import {
  studyAuthorizationPermits,
  studyAuthorizationState,
  type BoundAuthorization,
} from "./study-authorization.ts";
export {
  learningEnrollments,
  activeEnrollment,
  enrollmentRequest,
  acceptEnrollment,
  resumeEnrollments,
  revocationRequest,
  acceptRevocation,
  type BoundEnrollment,
} from "./learning-enrollment.ts";
export { submitResultTransaction } from "./learning-transactions.ts";

function enrollmentTarget(
  env: Env,
  store: ResultStore,
  bound: BoundEnrollment,
) {
  const destination = retainedTarget(env, bound.target);
  const enrolled = intentOf(store, "record_enroll", bound.id);
  check(
    !enrolled || enrolled.to.toLowerCase() === destination.contract,
    "results_target_changed",
  );
  return destination;
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
  const previous = store.get<BoundEnrollment>(`enrollment:${ticketId}`);
  const destination = previous
    ? enrollmentTarget(env, store, previous)
    : enrollmentResultsTarget(env);
  await checkLearningDisclosure(env, destination);
  const grant = await activeEnrollment(env, learner, destination);
  check(store.now() >= grant.issuedAt, "enrollment_not_active_yet");
  check(!previous || previous.id === grant.id, "enrollment_changed");
  store.transaction(() => {
    reserveSponsorship(
      store,
      sponsorLimits(env),
      `record_result:${ticketId}:1`,
    );
    reserveSponsorship(
      store,
      sponsorLimits(env),
      `record_result:${ticketId}:2`,
    );
    store.set(`enrollment:${ticketId}`, grant);
  });
}
/** A V4 run's binding: the sign-in authorization its ticket named. */
export const ticketAuthorization = (store: ResultStore, ticketId: string) =>
  store.get<BoundAuthorization>(`ticketAuthorization:${ticketId}`);
/**
 * V4: binds the sign-in authorization the community's signed ticket names, in
 * place of a V3 enrollment. It must be the learner's and already issued, and
 * permission must be unbroken since; the run starts after this, so the
 * contract's `issuedAt <= startedAt` holds. Called again at the run's start,
 * it re-checks the same authorization. Later sign-ins never move it.
 */
export async function bindAuthorization(
  env: Env,
  store: ResultStore,
  ticketId: string,
  learner: Address,
  authorizationId: Hex,
) {
  check(
    typeof authorizationId === "string" &&
      /^0x[0-9a-f]{64}$/.test(authorizationId) &&
      !/^0x0+$/.test(authorizationId),
    "karaoke_authorization_mismatch",
  );
  const previous = ticketAuthorization(store, ticketId);
  check(
    !previous || previous.id === authorizationId,
    "karaoke_authorization_mismatch",
  );
  const target = previous
    ? retainedTarget(env, previous.target)
    : resultsTarget(env, 4);
  check(target.version === 4, "unsupported_results_version");
  const state = await studyAuthorizationState(
    env,
    target,
    learner,
    authorizationId,
  );
  check(state.ownedBy, "karaoke_authorization_mismatch");
  check(state.unbroken, "karaoke_authorization_required");
  // Issued after this operator's clock: in force shortly, so retryable.
  check(state.issuedAt <= store.now(), "karaoke_authorization_pending");
  if (previous) return previous;
  return store.transaction(() => {
    const concurrent = ticketAuthorization(store, ticketId);
    if (concurrent) {
      check(concurrent.id === authorizationId, "karaoke_authorization_mismatch");
      return concurrent;
    }
    reserveSponsorship(
      store,
      sponsorLimits(env),
      `record_result:${ticketId}:1`,
    );
    reserveSponsorship(
      store,
      sponsorLimits(env),
      `record_result:${ticketId}:2`,
    );
    const bound: BoundAuthorization = {
      id: authorizationId,
      issuedAt: state.issuedAt,
      target,
    };
    store.set(`ticketAuthorization:${ticketId}`, bound);
    return bound;
  });
}
type FrozenBundle = {
  target?: ResultsTarget;
  result: TerminalResult;
  outcomes: Hex;
  data: Hex;
};
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
  // A V4 run binds its sign-in authorization instead of an enrollment.
  const authorization = ticketAuthorization(store, ticketId);
  if (!signed || !ticket || (!bound && !authorization)) return;
  const destination = authorization
    ? retainedTarget(env, authorization.target)
    : enrollmentTarget(env, store, bound!);
  const result = signed.body,
    revision = result.revision,
    ref = `${ticketId}:${revision}`;
  const oldState = publicationV2(store, ticketId);
  // The run's own result transaction, once a nonce is allocated.
  const ownRow = () => {
    const nonce = intentOf(store, "record_result", ref)?.nonce;
    return nonce == null ? undefined : txRow(store, nonce);
  };
  // A private result whose transaction was allocated and then withheld is
  // re-read from chain, at most every WITHHELD_RECHECK_S: if its commitment
  // is on V3 after all, it is reported published.
  const recheck =
    oldState?.state === "private" &&
    revision === 1 &&
    !!ownRow()?.withheld &&
    (oldState.checkedAt ?? 0) <= store.now() - WITHHELD_RECHECK_S;
  if (
    oldState?.revision === revision &&
    ((oldState.state === "private" && !recheck) ||
      oldState.state === "failed" ||
      (oldState.confirmed && (oldState.checkedAt ?? 0) > store.now() - 3600))
  )
    return oldState;
  let job = store.get<FrozenBundle>(`workV2:${ref}`);
  check(
    !job?.target || sameResultsTarget(job.target, destination),
    "results_target_changed",
  );
  const existingIntent = intentOf(store, "record_result", ref);
  check(
    !existingIntent || existingIntent.to.toLowerCase() === destination.contract,
    "results_target_changed",
  );
  const current = await read<Hex>(env, destination, "commitments", [
    result.attemptId,
  ]);
  if (oldState?.state === "published" && job) {
    if (current === resultCommitment(restoreHeader(job.result), job.outcomes)) {
      let row = ownRow();
      // A withheld row inferred superseded while its result is on chain:
      // its own receipt corrects it.
      if (row?.mined?.status === "superseded")
        row = await recheckSuperseded(env, store, row.nonce, true);
      const head = await client(env).getBlockNumber({ cacheTime: 0 });
      const next = {
        ...oldState,
        confirmed:
          row?.mined?.status === "success" &&
          head >= BigInt(row.mined.block + 12),
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
  // A withheld result transaction is never reported private while its
  // commitment is on chain: the chain decides, read now or passed in.
  const chainTruth = async (known?: Hex) => {
    const own = ownRow();
    if (!own?.withheld || !job || revision !== 1) return undefined;
    const onChain =
      known ??
      (await read<Hex>(env, destination, "commitments", [result.attemptId]));
    if (onChain !== zeroHash) {
      const published =
        onChain === resultCommitment(restoreHeader(job.result), job.outcomes);
      if (published) {
        if (own.mined?.status === "superseded")
          await recheckSuperseded(env, store, own.nonce, true);
        store.set(
          `bundleV2:${ticketId}`,
          durableValue({ result: job.result, outcomes: job.outcomes }),
        );
      }
      const next = published
        ? {
            state: "published" as const,
            revision,
            confirmed: false,
            checkedAt: store.now(),
          }
        : {
            state: "failed" as const,
            revision,
            reason: "canonical_result_changed",
          };
      store.set(`publicationV2:${ticketId}`, next);
      return next;
    }
    if (!withheldUnpublished(own)) return undefined;
    const next = {
      state: "private" as const,
      revision,
      reason: own.withheld.reason,
      checkedAt: store.now(),
    };
    store.set(`publicationV2:${ticketId}`, next);
    return next;
  };
  const truth = await chainTruth(current);
  if (truth) return truth;
  const state = { state: "pending" as const, revision };
  store.set(`publicationV2:${ticketId}`, state);
  const keepPrivate = (reason: string) => {
    // A transaction queued without a nonce is withdrawn so that nothing can
    // send it later; one that has a nonce may be on its way and is tracked.
    if (!withdrawUnsentResult(env, store, "record_result", ref)) return state;
    releaseSponsorship(store, sponsorLimits(env), `record_result:${ref}`);
    releaseSponsorship(
      store,
      sponsorLimits(env),
      `record_result:${ticketId}:2`,
    );
    const next = { state: "private" as const, revision, reason };
    store.set(`publicationV2:${ticketId}`, next);
    return next;
  };
  // An enrollment-bound run not yet sent stays private once the learner has
  // withdrawn under V4 in this community, by settings or directly on the V4
  // contract; V4 is the records now. Not yet sent means no nonce allocated:
  // a dispatch that failed before allocating leaves a queued intent, and the
  // checks still run. A failed chain read throws, leaving the run pending for
  // the next tick.
  const unsent = () => resultUnsent(store, "record_result", ref);
  const withheld = async () =>
    !authorization &&
    revision === 1 &&
    unsent() &&
    (await legacyResultsWithdrawn(env, store, ticket.participant));
  if (await withheld()) return keepPrivate("authorization_withdrawn");
  if (revision === 1 && unsent()) {
    let permitted: boolean;
    if (authorization)
      // V4 re-reads the contract's rule: a withdrawal since the run's start
      // keeps it private. Every run's final result is otherwise published.
      permitted = await studyAuthorizationPermits(
        env,
        authorization,
        ticket.participant,
        result.startedAt * 1000,
      );
    else {
      const [id, , , expires] = await read<
        readonly [Hex, bigint, bigint, bigint]
      >(env, destination, "enrollments", [ticket.participant]);
      permitted = id === bound!.id && Number(expires) > store.now();
    }
    if (!permitted)
      return keepPrivate(
        authorization ? "authorization_withdrawn" : "enrollment_inactive",
      );
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
      // V4: the sign-in authorization the run started under.
      enrollmentId: authorization ? authorization.id : bound!.id,
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
          : await resultPolicyAt(
              env,
              destination,
              1,
              resultPeriod(BigInt(result.performanceEndedAt)),
            ),
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
            abi: contractAbi(destination),
            functionName: "publish",
            args: [header, outcomes],
          })
        : encodeFunctionData({
            abi: contractAbi(destination),
            functionName: "correct",
            args: [
              restoreHeader(previous!.result),
              previous!.outcomes,
              outcomes,
              header.status,
            ],
          });
    job = { target: destination, result: header, outcomes, data };
    store.set(`workV2:${ref}`, durableValue(job));
  }
  // Withheld after its nonce was allocated: private only while the chain
  // holds no commitment for it (chainTruth). Proven never sent, a
  // cancellation consumes the nonce, here, in the alarm or in recovery. A row
  // that may have been sent is never sent again: its receipt decides, or its
  // nonce is inferred superseded.
  const before = await chainTruth();
  if (before) return before;
  // A withdrawal accepted or mined during the reads above still stops it.
  // The transaction path checks again where the nonce is allocated and
  // before every send, including recovery's (legacyResultGate).
  if (await withheld()) return keepPrivate("authorization_withdrawn");
  const row = await submitResultTransaction(
    env,
    store,
    "record_result",
    ref,
    job.data,
    destination.contract,
  );
  const after = await chainTruth();
  if (after) return after;
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
