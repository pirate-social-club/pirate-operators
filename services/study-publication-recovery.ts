import { check } from "../packages/protocol/index.ts";
import { resultClient, retainedTarget } from "./learning-contract.ts";
import {
  legacyResultGate,
  type ResultStore,
} from "./learning-transactions.ts";
import {
  recoverTransactions,
  settleWithheldTransactions,
  type TxRow,
} from "./operator-tx.ts";
import type { Env } from "./runtime.ts";
import { studyRevisionRecovery } from "../packages/study/publication-view.ts";
import {
  resumeStudyPublication,
  type PublicationJob,
} from "./study-publication.ts";
/** Every send, including a rebroadcast, passes the earlier-version withdrawal gate. */
export const recoverLearningTransactions = (env: Env, store: ResultStore) =>
  recoverTransactions(
    env,
    store,
    (row) => studyTransactionReady(env, store, row),
    legacyResultGate(env, store),
  );

/** The alarm's part: settles withheld earlier-version results only (no other send). */
export const settleWithheldLearningTransactions = (
  env: Env,
  store: ResultStore,
) => settleWithheldTransactions(env, store, legacyResultGate(env, store));

/** The public general recovery endpoint must honor Study's chain-time wait too. */
export async function studyTransactionReady(
  env: Env,
  store: ResultStore,
  row: TxRow,
) {
  if (row.kind !== "record_result" || !row.ref.startsWith("study:"))
    return true;
  const match = /^study:([a-zA-Z0-9_-]{16,128}):1$/.exec(row.ref);
  check(match, "unsupported_study_revision");
  const job = store.get<PublicationJob>("studyPublication:" + match[1]);
  check(
    job &&
      row.data === job.data &&
      row.to.toLowerCase() === job.target.contract.toLowerCase(),
    "study_publication_changed",
  );
  retainedTarget(env, job.target);
  return (
    (await resultClient(env).getBlock({ blockTag: "latest" })).timestamp >=
    BigInt(job.result.completedAt)
  );
}

export async function resumeStudyPublications(
  env: Env,
  store: ResultStore,
  limit = 20,
) {
  const due = store
    .entries("studyPublication:")
    .filter(({ value }) => {
      const job = value as PublicationJob,
        receipt = job.receipt;
      return (
        receipt.state === "pending" ||
        studyRevisionRecovery(receipt) ||
        (receipt.state === "published" &&
          (!receipt.confirmed || receipt.checkedAt <= store.now() - 3600)) ||
        (["private", "failed"].includes(receipt.state) &&
          job.privateHistoryExpiresAt <= store.now() * 1000)
      );
    })
    .sort(
      (a, b) =>
        (a.value as PublicationJob).lastTriedAt -
        (b.value as PublicationJob).lastTriedAt,
    )
    .slice(0, limit);
  for (const row of due)
    await resumeStudyPublication(
      env,
      store,
      row.key.slice("studyPublication:".length),
    ).catch(() => undefined); // One RPC/job failure cannot suppress other recovery.
  return due.length;
}
export function studyPublicationAlarm(store: ResultStore) {
  return store.entries("studyPublication:").map(({ value }) => {
    const { receipt, privateHistoryExpiresAt, lastTriedAt } =
      value as PublicationJob;
    return receipt.state === "pending" ||
      studyRevisionRecovery(receipt) ||
      (receipt.state === "published" && !receipt.confirmed)
      ? (store.now() + 30) * 1000
      : receipt.state === "published"
        ? (receipt.checkedAt + 3600) * 1000
        : ["private", "failed"].includes(receipt.state)
          ? Math.max(privateHistoryExpiresAt, (lastTriedAt + 30) * 1000)
          : Infinity;
  });
}
