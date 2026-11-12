import { guardLinkedPublication } from "./study-linked-withdrawal.ts";
import { telegramResultPublication } from "./study-telegram-publication.ts";
// A private/failed label is not proof that transaction recovery can be erased.
import { zeroHash } from "viem";
import { check } from "../packages/protocol/index.ts";
import type { StudyPublicationReceipt } from "../packages/study/publication.ts";
import {
  contractAbi,
  resultClient,
  retainedTarget,
  type ResultsTarget,
} from "./learning-contract.ts";
import type { ResultStore } from "./learning-transactions.ts";
import { provenUnsent, type TxRow } from "./operator-tx.ts";
import { releaseSponsorship, sponsorLimits } from "./sponsor-budget.ts";
import type { PublicationJob } from "./study-publication.ts";
import type { Env } from "./runtime.ts";

export const STUDY_PRIVATE_RETENTION_SECONDS = 30 * 86400;
export type ClosedStudyPublication =
  | {
      kind?: "publication";
      target: ResultsTarget;
      receipt: StudyPublicationReceipt;
    }
  | {
      kind: "binding";
      target: ResultsTarget;
      reason: "private_history_expired";
    };
export interface StudyCleanupIdentity {
  target: ResultsTarget;
  sessionId: `0x${string}`;
}
const closedKey = (id: string) => "studyPublicationClosed:" + id;
export const closedStudyPublication = (store: ResultStore, id: string) =>
  store.get<ClosedStudyPublication>(closedKey(id));

export function closedStudyReceipt(store: ResultStore, id: string) {
  const closed = closedStudyPublication(store, id);
  if (!closed) return undefined;
  check(closed.kind !== "binding", "study_history_expired");
  return closed.receipt;
}
export function releaseStudyBinding(env: Env, store: ResultStore, id: string) {
  for (const revision of [1, 2])
    releaseSponsorship(
      store,
      sponsorLimits(env),
      `record_result:study:${id}:${revision}`,
    );
  store.delete("studyBinding:" + id);
}
export function closeOrphanStudyBinding(
  env: Env,
  store: ResultStore,
  id: string,
  target: ResultsTarget,
) {
  store.set(closedKey(id), {
    kind: "binding",
    target,
    reason: "private_history_expired",
  } satisfies ClosedStudyPublication);
  releaseStudyBinding(env, store, id);
}

/**
 * Any queued work, orphan transaction or charged allowance is retained. The
 * one exception is the first revision's own transaction once it was withheld,
 * proven never sent, and its nonce is consumed on chain by its cancellation
 * or another transaction: that intent, row and charge prove the result can
 * never be published. A cancellation not yet mined is not enough.
 */
export function studyNativeEvidence(
  store: ResultStore,
  id: string,
  allowUnallocatedFirst = false,
) {
  const ref = "study:" + id + ":",
    first = ref + "1";
  const nonce = store.get<{ nonce: number | null }>(
    "intent:record_result:" + first,
  )?.nonce;
  const unallocatedFirst = allowUnallocatedFirst && nonce === null;
  const own =
    nonce == null
      ? undefined
      : store.get<TxRow>(`tx:${String(nonce).padStart(10, "0")}`);
  const cancelled =
    own?.ref === first &&
    own.kind === "record_result" &&
    provenUnsent(own) &&
    !!own.withheld &&
    (own.mined?.status === "cancelled" || own.mined?.status === "superseded");
  return (
    store
      .entries("intent:record_result:" + ref)
      .some(
        ({ key }) =>
          !(
            (cancelled || unallocatedFirst) &&
            key === "intent:record_result:" + first
          ),
      ) ||
    store.entries("tx:").some(({ value }) => {
      const row = value as TxRow;
      return row.ref?.startsWith(ref) && !(cancelled && row.nonce === nonce);
    }) ||
    store
      .entries("sponsor:reservation:record_result:" + ref)
      .some(
        ({ key, value }) =>
          !(
            (cancelled || unallocatedFirst) &&
            key === "sponsor:reservation:record_result:" + first
          ) &&
          !["reserved", "released"].includes(
            (value as { state: string }).state,
          ),
      )
  );
}

export async function proveStudyCleanupIdentity(
  env: Env,
  store: ResultStore,
  id: string,
  identity: StudyCleanupIdentity,
  nativeEvidence = () => studyNativeEvidence(store, id),
) {
  if (nativeEvidence()) return false;
  retainedTarget(env, identity.target);
  const client = resultClient(env),
    head = await client.getBlock({ blockTag: "latest" });
  check(
    (await client.getChainId()) === identity.target.chainId,
    "study_publication_chain_changed",
  );
  const commitment = await client.readContract({
    address: identity.target.contract,
    abi: contractAbi(identity.target),
    functionName: "commitments",
    args: [identity.sessionId],
    blockNumber: head.number,
  });
  check(
    (await client.getBlock({ blockNumber: head.number })).hash === head.hash,
    "study_publication_chain_changed",
  );
  return commitment === zeroHash && !nativeEvidence();
}
export const proveNeverSubmittedStudy = (
  env: Env,
  store: ResultStore,
  id: string,
  job: PublicationJob,
  allowUnallocatedFirst = false,
) =>
  proveStudyCleanupIdentity(
    env,
    store,
    id,
    {
      target: job.target,
      sessionId: job.result.sessionId,
    },
    () => studyNativeEvidence(store, id, allowUnallocatedFirst),
  );

export async function eraseNeverSubmittedStudy(
  env: Env,
  store: ResultStore,
  id: string,
  job: PublicationJob,
) {
  const closed = closedStudyPublication(store, id);
  if (closed) return closedStudyReceipt(store, id)!;
  const guard = () => {
    const linked = telegramResultPublication(env, store, "study:" + id + ":1");
    if (linked) guardLinkedPublication(store, linked);
  };
  guard();
  if (
    !["private", "failed"].includes(job.receipt.state) ||
    !Number.isSafeInteger(job.privateHistoryExpiresAt) ||
    job.privateHistoryExpiresAt > store.now() * 1000
  )
    return null;
  const absent = await proveNeverSubmittedStudy(env, store, id, job);
  guard();
  if (!absent) return null;
  return store.transaction(() => {
    guard();
    const current = store.get<PublicationJob>("studyPublication:" + id);
    if (
      !current ||
      current.requestHash !== job.requestHash ||
      !["private", "failed"].includes(current.receipt.state) ||
      studyNativeEvidence(store, id)
    )
      return null;
    const receipt: StudyPublicationReceipt = {
      state: "private",
      sessionId: current.receipt.sessionId,
      chainId: current.target.chainId,
      contract: current.target.contract,
      commitment: zeroHash,
      transactionHash: null,
      confirmed: false,
      checkedAt: store.now(),
      reason: "private_history_expired",
      neverSubmitted: true,
      privateHistoryErased: true,
    };
    // This marker precedes deletion and permanently refuses new bind/dispatch.
    store.set(closedKey(id), { target: current.target, receipt });
    releaseStudyBinding(env, store, id);
    store.delete("studyPublication:" + id);
    for (const { key } of store.entries("studySpeechSlot:" + id + ":"))
      store.delete(key);
    for (const { key, value } of store.entries("studySpeech:"))
      if (
        (value as { parameters: { lessonId: string } }).parameters.lessonId ===
        id
      )
        store.delete(key);
    return receipt;
  });
}
