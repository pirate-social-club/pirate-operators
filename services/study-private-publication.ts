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
interface ClosedStudyPublication {
  target: ResultsTarget;
  receipt: StudyPublicationReceipt;
}
const closedKey = (id: string) => "studyPublicationClosed:" + id;
export const closedStudyPublication = (store: ResultStore, id: string) =>
  store.get<ClosedStudyPublication>(closedKey(id));

/**
 * Any queued work, orphan transaction or charged allowance is retained. The
 * one exception is the first revision's own transaction once it was withheld,
 * proven never sent, and its nonce is consumed on chain by its cancellation
 * or another transaction: that intent, row and charge prove the result can
 * never be published. A cancellation not yet mined is not enough.
 */
export function studyNativeEvidence(store: ResultStore, id: string) {
  const ref = "study:" + id + ":",
    first = ref + "1";
  const nonce = store.get<{ nonce: number | null }>(
    "intent:record_result:" + first,
  )?.nonce;
  const own =
    nonce == null ? undefined : store.get<TxRow>(`tx:${String(nonce).padStart(10, "0")}`);
  const cancelled =
    own?.ref === first &&
    own.kind === "record_result" &&
    provenUnsent(own) &&
    !!own.withheld &&
    (own.mined?.status === "cancelled" || own.mined?.status === "superseded");
  return (
    store
      .entries("intent:record_result:" + ref)
      .some(({ key }) => !(cancelled && key === "intent:record_result:" + first)) ||
    store.entries("tx:").some(({ value }) => {
      const row = value as TxRow;
      return row.ref?.startsWith(ref) && !(cancelled && row.nonce === nonce);
    }) ||
    store
      .entries("sponsor:reservation:record_result:" + ref)
      .some(
        ({ key, value }) =>
          !(cancelled && key === "sponsor:reservation:record_result:" + first) &&
          !["reserved", "released"].includes(
            (value as { state: string }).state,
          ),
      )
  );
}

export async function proveNeverSubmittedStudy(
  env: Env,
  store: ResultStore,
  id: string,
  job: PublicationJob,
) {
  if (studyNativeEvidence(store, id)) return false;
  retainedTarget(env, job.target);
  const client = resultClient(env),
    head = await client.getBlock({ blockTag: "latest" });
  check(
    (await client.getChainId()) === job.target.chainId,
    "study_publication_chain_changed",
  );
  const commitment = await client.readContract({
    address: job.target.contract,
    abi: contractAbi(job.target),
    functionName: "commitments",
    args: [job.result.sessionId],
    blockNumber: head.number,
  });
  check(
    (await client.getBlock({ blockNumber: head.number })).hash === head.hash,
    "study_publication_chain_changed",
  );
  return commitment === zeroHash && !studyNativeEvidence(store, id);
}

export async function eraseNeverSubmittedStudy(
  env: Env,
  store: ResultStore,
  id: string,
  job: PublicationJob,
) {
  const closed = closedStudyPublication(store, id);
  if (closed) return closed.receipt;
  if (
    !["private", "failed"].includes(job.receipt.state) ||
    !Number.isSafeInteger(job.privateHistoryExpiresAt) ||
    job.privateHistoryExpiresAt > store.now() * 1000 ||
    !(await proveNeverSubmittedStudy(env, store, id, job))
  )
    return null;
  return store.transaction(() => {
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
    for (const revision of [1, 2])
      releaseSponsorship(
        store,
        sponsorLimits(env),
        `record_result:study:${id}:${revision}`,
      );
    store.delete("studyPublication:" + id);
    store.delete("studyBinding:" + id);
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
