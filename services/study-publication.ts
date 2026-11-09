// Durable Study publication. Only the compact public bundle survives validation;
// private lesson state and transcripts never enter transaction calldata.
import { encodeFunctionData, zeroHash, type Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import {
  resultCommitment,
  resultPeriod,
  unpackStudyOutcomes,
  type TerminalResult,
} from "../packages/protocol/learning-results-v3.ts";
import { studyFactsBundle } from "../packages/study/terminal-facts.ts";
import type {
  StudyTerminalRequest,
  StudyPublicationReceipt,
} from "../packages/study/publication.ts";
import { studyId } from "../packages/study/operator-contract.ts";
import type { StudyBinding } from "./study-operator.ts";
import { studyAuthorizationState } from "./study-authorization.ts";
import {
  contractAbi,
  legacyResultsWithdrawn,
  resultClient,
  readResultContract,
  resultPolicyAt,
  retainedTarget,
  sameResultsTarget,
  type ResultsTarget,
} from "./learning-contract.ts";
import {
  resultUnsent,
  submitResultTransaction,
  withdrawUnsentResult,
  type ResultStore,
} from "./learning-transactions.ts";
import {
  intentOf,
  provenUnsent,
  recheckSuperseded,
  txRow,
  withheldUnpublished,
  type TxRow,
} from "./operator-tx.ts";
import { releaseSponsorship, sponsorLimits } from "./sponsor-budget.ts";
import type { Env } from "./runtime.ts";
import {
  readStudyRevision,
  type StudyRevisionSearch,
} from "./study-revision-reader.ts";
import type { StudyRevisionEvidence } from "./study-revisions.ts";
import { studyRevisionRecovery } from "../packages/study/publication-view.ts";
import {
  closedStudyPublication,
  eraseNeverSubmittedStudy,
  proveNeverSubmittedStudy,
  studyNativeEvidence,
  STUDY_PRIVATE_RETENTION_SECONDS,
} from "./study-private-publication.ts";

export interface PublicationJob {
  // Absent on earlier rows. Receipt bytes alone do not version cursor progress.
  observationRevision?: number;
  requestHash: Hex;
  target: ResultsTarget;
  result: TerminalResult;
  outcomes: Hex;
  data: Hex;
  receipt: StudyPublicationReceipt;
  lastTriedAt: number;
  privateHistoryExpiresAt: number;
}
const key = (id: string) => "studyPublication:" + id;
const reference = (id: string) => "study:" + id + ":1";
const proofKey = (id: string) => "studyRevisionProof:" + id;
const searchKey = (id: string) => "studyRevisionSearch:" + id;
interface RevisionUpdate {
  proof?: StudyRevisionEvidence;
  search?: StudyRevisionSearch;
}
const restore = (result: TerminalResult): TerminalResult => ({
  ...result,
  song: { ...result.song, chainId: BigInt(result.song.chainId) },
  startedAt: BigInt(result.startedAt),
  completedAt: BigInt(result.completedAt),
});
const durable = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? String(item) : item,
    ),
  );
export const studyPublication = (store: ResultStore, id: string) =>
  store.get<PublicationJob>(key(id))?.receipt ??
  closedStudyPublication(store, id)?.receipt;

export function saveReceipt(
  store: ResultStore,
  id: string,
  job: PublicationJob,
  receipt: StudyPublicationReceipt,
  revision?: RevisionUpdate,
) {
  return store.transaction(() => {
    const current = store.get<PublicationJob>(key(id))!;
    check(current.requestHash === job.requestHash, "study_terminal_changed");
    const observation = current.observationRevision ?? 0;
    check(
      Number.isSafeInteger(observation) &&
        observation >= 0 &&
        observation < Number.MAX_SAFE_INTEGER,
      "invalid_study_observation_revision",
    );
    // A slow observation cannot overwrite a concurrent publisher's newer state.
    if (
      observation !== (job.observationRevision ?? 0) ||
      canonical(current.receipt) !== canonical(job.receipt)
    )
      return current.receipt;
    const saved = durable(receipt);
    if (revision) {
      if (revision.proof) store.set(proofKey(id), durable(revision.proof));
      else store.delete(proofKey(id));
      if (revision.search) store.set(searchKey(id), durable(revision.search));
      else store.delete(searchKey(id));
    }
    store.set(key(id), {
      ...current,
      observationRevision: observation + 1,
      receipt: saved,
    });
    return saved;
  });
}
async function freeze(
  env: Env,
  store: ResultStore,
  input: StudyTerminalRequest,
) {
  check(
    input &&
      studyId(input.lessonId) &&
      Object.keys(input).sort().join() ===
        ["lessonId", "source", "terminal"].sort().join(),
    "invalid_study_terminal",
  );
  const hash = digest(input) as Hex;
  const old = store.get<PublicationJob>(key(input.lessonId));
  if (old) {
    retainedTarget(env, old.target);
    check(old.requestHash === hash, "study_terminal_changed");
    return;
  }
  const binding = store.get<StudyBinding>("studyBinding:" + input.lessonId);
  check(binding, "study_lesson_not_bound");
  const target = retainedTarget(env, binding.target);
  if (binding.authorization)
    check(
      target.version === 4 &&
        sameResultsTarget(binding.authorization.target, target),
      "study_authorization_mismatch",
    );
  else
    check(
      target.version === 3 && binding.enrollment.activities! & 2,
      "study_enrollment_mismatch",
    );
  check(
    input.terminal.startedAt === binding.offer.startedAt &&
      input.terminal.expiresAt === binding.offer.expiresAt &&
      input.terminal.completedAt <= store.now() * 1000 + 999 &&
      digest(input.source) === binding.offer.sourceDigest &&
      input.source.communityId === env.COMMUNITY_ID,
    "study_terminal_binding_changed",
  );
  const facts = {
    ...input,
    learner: binding.offer.learner,
    grader: env.OPERATOR_ADDRESS,
    qualificationPolicy: zeroHash,
  };
  // V4: the authorization id is the result's enrollmentId and its session's.
  const bundle = binding.authorization
    ? studyFactsBundle({
        ...facts,
        authorization: {
          id: binding.authorization.id,
          issuedAt: binding.authorization.issuedAt,
        },
      })
    : studyFactsBundle({ ...facts, enrollment: binding.enrollment });
  check(
    bundle.result.exercisesHash === binding.exercisesHash &&
      canonical(
        unpackStudyOutcomes(bundle.outcomes, bundle.result.linesTotal).map(
          (item) => ({
            lineId: input.source.lines[item.sourceOrdinal - 1].lineId,
            language: input.source.language,
          }),
        ),
      ) ===
        canonical(
          binding.offer.exercises.map(({ lineId, language }) => ({
            lineId,
            language,
          })),
        ),
    "study_terminal_binding_changed",
  );
  bundle.result.qualificationPolicy = await resultPolicyAt(
    env,
    target,
    2,
    resultPeriod(bundle.result.completedAt),
  );
  const data = encodeFunctionData({
    abi: contractAbi(target),
    functionName: "publish",
    args: [bundle.result, bundle.outcomes],
  });
  const receipt: StudyPublicationReceipt = {
    state: "pending",
    sessionId: bundle.result.sessionId,
    chainId: target.chainId,
    contract: target.contract,
    commitment: resultCommitment(bundle.result, bundle.outcomes),
    transactionHash: null,
    confirmed: false,
    checkedAt: store.now(),
  };
  store.transaction(() => {
    if (closedStudyPublication(store, input.lessonId)) return;
    const concurrent = store.get<PublicationJob>(key(input.lessonId));
    check(
      !concurrent || concurrent.requestHash === hash,
      "study_terminal_changed",
    );
    if (!concurrent)
      store.set(
        key(input.lessonId),
        durable({
          requestHash: hash,
          target,
          ...bundle,
          data,
          receipt,
          lastTriedAt: store.now(),
          privateHistoryExpiresAt:
            input.terminal.completedAt + STUDY_PRIVATE_RETENTION_SECONDS * 1000,
        }),
      );
  });
}

/** Read a pinned canonical head before interpreting a receipt or allocating work. */
async function observe(
  env: Env,
  store: ResultStore,
  id: string,
  job: PublicationJob,
) {
  const client = resultClient(env),
    head = await client.getBlock({ blockTag: "latest" });
  check(
    (await client.getChainId()) === job.target.chainId,
    "study_publication_chain_changed",
  );
  const current = (await client.readContract({
    address: job.target.contract,
    abi: contractAbi(job.target),
    functionName: "commitments",
    args: [job.result.sessionId],
    blockNumber: head.number,
  })) as Hex;
  const intent = intentOf(store, "record_result", reference(id));
  const row = intent?.nonce == null ? undefined : txRow(store, intent.nonce);
  const proof = store.get<StudyRevisionEvidence>(proofKey(id));
  let projected: StudyPublicationReceipt | undefined;
  let revision: RevisionUpdate | undefined;
  const clean = { ...job.receipt };
  delete clean.reason;
  delete clean.canonicalRevision;
  // A result once held private and found on chain is not "never submitted".
  delete clean.neverSubmitted;
  if (
    job.receipt.canonicalHead &&
    BigInt(job.receipt.canonicalHead.number) > head.number &&
    !(current === zeroHash && row?.raw)
  ) {
    projected = {
      ...clean,
      state: "failed",
      confirmed: false,
      checkedAt: store.now(),
      reason: "canonical_head_behind",
    };
  } else if (
    current !== zeroHash &&
    (current !== job.receipt.commitment || proof)
  ) {
    try {
      check(row?.hash, "study_revision_origin_missing");
      const observed = await readStudyRevision({
        client,
        contract: job.target.contract,
        head,
        currentCommitment: current,
        originalHash: row.hash,
        originalResult: job.result,
        originalOutcomes: job.outcomes,
        proof,
        search: store.get<StudyRevisionSearch>(searchKey(id)),
      });
      projected = {
        ...clean,
        state: observed.complete ? "published" : "pending",
        confirmed:
          observed.complete &&
          head.number >= BigInt(observed.latest.blockNumber) + 12n,
        transactionHash: row.hash,
        checkedAt: store.now(),
        canonicalHead: { number: String(head.number), hash: head.hash },
        ...(observed.complete && observed.latest.result.revision > 1
          ? {
              canonicalRevision: {
                revision: observed.latest.result.revision,
                status: observed.latest.result.status,
                commitment: observed.latest.commitment,
                transactionHash: observed.latest.transactionHash,
                blockNumber: observed.latest.blockNumber,
                blockHash: observed.latest.blockHash,
              },
            }
          : {}),
        ...(!observed.complete ? { reason: "revision_history_pending" } : {}),
      };
      revision = {
        proof: observed.complete ? observed.latest : proof,
        search: observed.search,
      };
    } catch {
      // A known changed canonical result can never reuse favorable old evidence.
      projected = {
        ...clean,
        state: "failed",
        confirmed: false,
        checkedAt: store.now(),
        canonicalHead: { number: String(head.number), hash: head.hash },
        reason: "canonical_revision_unverified",
      };
    }
  }
  let confirmed = false;
  if (!projected && current === job.receipt.commitment && row?.hash) {
    const receipt = await client
      .getTransactionReceipt({ hash: row.hash })
      .catch((error: { name?: string }) => {
        if (error.name === "TransactionReceiptNotFoundError") return null;
        throw error;
      });
    confirmed =
      !!receipt &&
      receipt.status === "success" &&
      head.number >= receipt.blockNumber + 12n &&
      (await client.getBlock({ blockNumber: receipt.blockNumber })).hash ===
        receipt.blockHash;
  }
  check(
    (await client.getBlock({ blockNumber: head.number })).hash === head.hash,
    "study_publication_chain_changed",
  );
  const state =
    current === job.receipt.commitment
      ? "published"
      : current !== zeroHash
        ? "failed"
        : null;
  return {
    row,
    current,
    blockNumber: head.number,
    timestamp: head.timestamp,
    revision,
    receipt:
      projected ??
      (state
        ? ({
            ...clean,
            state,
            confirmed,
            transactionHash: row?.hash ?? null,
            checkedAt: store.now(),
            canonicalHead: { number: String(head.number), hash: head.hash },
            ...(state === "failed"
              ? { reason: "canonical_result_changed" }
              : {}),
          } as StudyPublicationReceipt)
        : null),
  };
}

export async function resumeStudyPublication(
  env: Env,
  store: ResultStore,
  id: string,
) {
  const closed = closedStudyPublication(store, id);
  if (closed) return closed.receipt;
  let job = store.get<PublicationJob>(key(id));
  check(job, "study_publication_not_found");
  retainedTarget(env, job.target);
  check(
    job.receipt.commitment ===
      resultCommitment(restore(job.result), job.outcomes) &&
      job.data ===
        encodeFunctionData({
          abi: contractAbi(job.target),
          functionName: "publish",
          args: [restore(job.result), job.outcomes],
        }),
    "study_publication_changed",
  );
  const ref = reference(id),
    intent = intentOf(store, "record_result", ref);
  check(
    !intent ||
      (intent.to.toLowerCase() === job.target.contract.toLowerCase() &&
        intent.data === job.data),
    "result_transaction_changed",
  );
  job = { ...job, lastTriedAt: store.now() };
  store.set(key(id), job);
  // A private result whose transaction was allocated and then withheld is
  // observed again: it is never reported private while its commitment is on
  // chain. Erasure, below, also requires that commitment to be absent.
  const withheldPrivate =
    job.receipt.state === "private" &&
    !!(intent?.nonce != null && txRow(store, intent.nonce)?.withheld);
  if (
    (job.receipt.state === "private" && !withheldPrivate) ||
    (job.receipt.state === "failed" && !studyRevisionRecovery(job.receipt))
  )
    return (await eraseNeverSubmittedStudy(env, store, id, job)) ?? job.receipt;
  const observed = await observe(env, store, id, job);
  if (observed.receipt) {
    if (observed.row?.mined?.status === "superseded")
      await recheckSuperseded(env, store, observed.row.nonce, true);
    return saveReceipt(store, id, job, observed.receipt, observed.revision);
  }
  // Withheld after its nonce was allocated and proven never sent, or whose
  // nonce went to another transaction: it can never publish. A row that may
  // have been sent is never sent again; its commitment, read above, decides.
  if (withheldUnpublished(observed.row))
    return keepCancelled(env, store, id, job, observed.row!);
  // V4: an unfinished lesson earns nothing and is never sent. A finished one
  // is sent only while its sign-in permission is unbroken; withdrawal keeps it
  // private. Both keep the bounded private-history erasure.
  if (job.target.version === 4 && intent?.nonce == null) {
    if (Number(job.result.status) !== 1)
      return keepPrivate(env, store, id, job, "unfinished");
    // The contract's publish rule, re-read just before dispatch.
    const permission = await studyAuthorizationState(
      env,
      job.target,
      job.result.learner,
      job.result.enrollmentId,
    );
    if (
      !permission.ownedBy ||
      !permission.unbroken ||
      BigInt(permission.issuedAt) > BigInt(job.result.startedAt)
    )
      return keepPrivate(env, store, id, job, "authorization_withdrawn");
  }
  // V3: after the learner's V4 withdrawal in this community, by settings or
  // directly on the V4 contract, a result not yet sent stays private,
  // whatever its enrollment says. Not yet sent means no nonce allocated: a
  // dispatch that failed before allocating leaves a queued intent, which the
  // closure withdraws. The chain is read at the observed block; a failed read
  // throws and leaves the result pending for the next retry.
  const legacy = job.target.version !== 4,
    learner = job.result.learner;
  const withheld = async (blockNumber?: bigint) =>
    legacy &&
    resultUnsent(store, "record_result", ref) &&
    (await legacyResultsWithdrawn(env, store, learner, blockNumber));
  if (await withheld(observed.blockNumber))
    return keepPrivate(env, store, id, job, "authorization_withdrawn");
  // Wait for chain time without charging a transaction that would revert.
  if (BigInt(job.result.completedAt) > observed.timestamp)
    return saveReceipt(store, id, job, {
      ...job.receipt,
      state: "pending",
      confirmed: false,
      checkedAt: store.now(),
    });
  if (observed.row?.mined?.status === "reverted")
    return saveReceipt(store, id, job, {
      ...job.receipt,
      state: "failed",
      confirmed: false,
      transactionHash: observed.row.hash ?? null,
      checkedAt: store.now(),
      reason: "transaction_reverted",
    });
  if (observed.row?.mined) {
    // The chain lost this result. Keep its nonce, raw bytes and conservative charge.
    store.set(`tx:${String(observed.row.nonce).padStart(10, "0")}`, {
      ...observed.row,
      mined: null,
    });
  }
  if (intent?.nonce == null && job.target.version !== 4) {
    const [grant, activities, , expires] = await readResultContract<
      readonly [Hex, bigint, bigint, bigint]
    >(env, job.target, "enrollments", [job.result.learner]);
    if (
      grant !== job.result.enrollmentId ||
      !(activities & 2n) ||
      Number(expires) <= store.now()
    )
      return keepPrivate(env, store, id, job, "enrollment_inactive");
  }
  const latest = store.get<PublicationJob>(key(id));
  const final = closedStudyPublication(store, id);
  if (final) return final.receipt;
  if (
    latest?.receipt.state === "private" ||
    (latest?.receipt.state === "failed" &&
      !studyRevisionRecovery(latest.receipt))
  )
    return latest.receipt;
  // A withdrawal accepted or mined during the reads above still stops it.
  if (await withheld())
    return keepPrivate(env, store, id, job, "authorization_withdrawn");
  // The transaction path checks again where the nonce is allocated and
  // before every send, including recovery's (legacyResultGate).
  await submitResultTransaction(
    env,
    store,
    "record_result",
    ref,
    job.data,
    job.target.contract,
  );
  // Reload the current CAS baseline after dispatch. A competing response may
  // already have recorded the same canonical commitment.
  job = store.get<PublicationJob>(key(id))!;
  const after = await observe(env, store, id, job);
  // Withheld during that dispatch: private only if the commitment, read
  // after it, is still absent.
  if (!after.receipt && withheldUnpublished(after.row))
    return keepCancelled(env, store, id, job, after.row!);
  return saveReceipt(
    store,
    id,
    job,
    after.receipt ?? {
      ...job.receipt,
      state: after.row?.mined?.status === "reverted" ? "failed" : "pending",
      confirmed: false,
      transactionHash: after.row?.hash ?? null,
      checkedAt: store.now(),
      ...(after.row?.mined?.status === "reverted"
        ? { reason: "transaction_reverted" }
        : {}),
    },
    after.revision,
  );
}
/**
 * A result whose withheld transaction can never publish: private. It is
 * never submitted only when the transaction was proven never sent; erasure
 * waits until its nonce is consumed on chain (studyNativeEvidence).
 */
async function keepCancelled(
  env: Env,
  store: ResultStore,
  id: string,
  job: PublicationJob,
  row: TxRow,
) {
  const unsent = provenUnsent(row);
  const receipt = saveReceipt(store, id, job, {
    ...job.receipt,
    state: "private",
    confirmed: false,
    reason: row.withheld!.reason as "authorization_withdrawn",
    neverSubmitted: unsent,
    transactionHash: unsent ? null : (row.hash ?? null),
    checkedAt: store.now(),
  });
  return (
    (await eraseNeverSubmittedStudy(env, store, id, { ...job, receipt })) ??
    receipt
  );
}
/**
 * Records a never-submitted result as private, releases its sponsorship and
 * runs the bounded private-history erasure once that is due.
 */
async function keepPrivate(
  env: Env,
  store: ResultStore,
  id: string,
  job: PublicationJob,
  reason: "enrollment_inactive" | "unfinished" | "authorization_withdrawn",
) {
  // Every caller decided before a nonce was allocated. Withdraw the result's
  // own transaction if it is queued without one, so nothing can send it
  // later; if a nonce was allocated meanwhile, it may be on its way.
  if (!withdrawUnsentResult(env, store, "record_result", reference(id)))
    return job.receipt;
  // Re-check after asynchronous grant reads. A competing queued native
  // operation is recovery evidence, even before it receives a nonce.
  if (
    !(await proveNeverSubmittedStudy(env, store, id, job)) ||
    studyNativeEvidence(store, id)
  )
    return job.receipt;
  releaseSponsorship(
    store,
    sponsorLimits(env),
    "record_result:" + reference(id),
  );
  releaseSponsorship(
    store,
    sponsorLimits(env),
    "record_result:study:" + id + ":2",
  );
  const receipt = saveReceipt(store, id, job, {
    ...job.receipt,
    state: "private",
    confirmed: false,
    reason,
    neverSubmitted: true,
    checkedAt: store.now(),
  });
  return (
    (await eraseNeverSubmittedStudy(env, store, id, { ...job, receipt })) ??
    receipt
  );
}
export async function publishStudyTerminal(
  env: Env,
  store: ResultStore,
  input: StudyTerminalRequest,
) {
  check(input && studyId(input.lessonId), "invalid_study_terminal");
  const closed = closedStudyPublication(store, input.lessonId);
  if (closed) return closed.receipt;
  await freeze(env, store, input);
  return resumeStudyPublication(env, store, input.lessonId);
}
