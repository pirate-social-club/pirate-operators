import type { Hex } from "viem";
import { check, digest, canonical } from "../packages/protocol/index.ts";
import { studyCloseBound } from "../packages/study/lesson.ts";
import { studyId } from "../packages/study/operator-contract.ts";
import { sameResultsTarget } from "./learning-contract.ts";
import type { StudyBinding } from "./study-operator.ts";
import { provenUnsent, type TxRow } from "./operator-tx.ts";
import type { Env, Store } from "./runtime.ts";
import type { ResultStore } from "./learning-transactions.ts";
import {
  closedStudyPublication,
  closeOrphanStudyBinding,
  proveStudyCleanupIdentity,
  STUDY_PRIVATE_RETENTION_SECONDS,
  type StudyCleanupIdentity,
} from "./study-private-publication.ts";

type CleanupStore = ResultStore &
  Pick<
    Store,
    | "page"
    | "rangeExists"
    | "studyTransactionExists"
    | "studyChargedSponsorExists"
    | "studySpeechExists"
    | "hasLinkedStudyBinding"
  >;
const prefix = "studyBinding:";
const cursorKey = "studyBindingCleanupCursor:1";

export function boundedStudyNativeEvidence(store: CleanupStore, id: string) {
  const ref = "study:" + id + ":",
    first = ref + "1";
  const nonce = store.get<{ nonce: number | null }>(
    "intent:record_result:" + first,
  )?.nonce;
  const ownKey = nonce == null ? null : `tx:${String(nonce).padStart(10, "0")}`;
  const own = ownKey ? store.get<TxRow>(ownKey) : undefined;
  const cancelled =
    own?.ref === first &&
    own.kind === "record_result" &&
    provenUnsent(own) &&
    !!own.withheld &&
    (own.mined?.status === "cancelled" || own.mined?.status === "superseded");
  return (
    store.rangeExists(
      "intent:record_result:" + ref,
      cancelled ? "intent:record_result:" + first : null,
    ) ||
    store.studyTransactionExists(ref, cancelled ? ownKey : null) ||
    store.studyChargedSponsorExists(
      "sponsor:reservation:record_result:" + ref,
      cancelled ? "sponsor:reservation:record_result:" + first : null,
    )
  );
}
export function bindingEraseAfter(binding: StudyBinding, id: string) {
  check(
    studyId(id) &&
      binding.target.version === 4 &&
      binding.authorization &&
      sameResultsTarget(binding.authorization.target, binding.target) &&
      /^0x[0-9a-f]{64}$/.test(binding.authorization.id) &&
      BigInt(binding.authorization.id) > 0n &&
      binding.offer.authorizationId === binding.authorization.id &&
      binding.offer.speechChannel === "telegram-linked" &&
      binding.offer.lessonId === id &&
      digest(binding.offer) === binding.offerHash &&
      Number.isSafeInteger(binding.offer.startedAt) &&
      binding.offer.startedAt > 0,
    "study_binding_cleanup_changed",
  );
  const due =
    studyCloseBound(binding.offer, Infinity).at +
    STUDY_PRIVATE_RETENTION_SECONDS * 1000;
  check(Number.isSafeInteger(due), "study_binding_cleanup_changed");
  return due;
}
/** One fair keyset page, with proof and a final synchronous evidence guard.
 * This branch does not delete or resolve any speech/native transaction work. */
export async function sweepLinkedStudyBindings(
  env: Env,
  store: CleanupStore,
  limit = 20,
  proof: (
    id: string,
    identity: StudyCleanupIdentity,
    native: () => boolean,
  ) => Promise<boolean> = (id, identity, native) =>
    proveStudyCleanupIdentity(env, store, id, identity, native),
) {
  check(
    Number.isSafeInteger(limit) && limit > 0 && limit <= 100,
    "invalid_store_page",
  );
  let after = store.get<string>(cursorKey) ?? prefix;
  if (!(after >= prefix && after < prefix + "\uffff")) after = prefix;
  let rows = store.page(prefix, after, limit);
  if (!rows.length && after !== prefix)
    rows = store.page(prefix, prefix, limit);
  for (const { key, value } of rows) {
    try {
      const id = key.slice(prefix.length);
      const binding = value as StudyBinding;
      if (binding.offer?.speechChannel !== "telegram-linked") continue;
      const due = bindingEraseAfter(binding, id);
      if (
        due > store.now() * 1000 ||
        closedStudyPublication(store, id) ||
        store.get("studyPublication:" + id) ||
        store.studySpeechExists(id) ||
        boundedStudyNativeEvidence(store, id)
      )
        continue;
      const identity = {
        target: binding.target,
        sessionId: digest({
          schema: "pirate.study-result-id/1",
          enrollmentId: binding.authorization!.id,
          lessonId: id,
        }) as Hex,
      };
      if (
        !(await proof(id, identity, () =>
          boundedStudyNativeEvidence(store, id),
        ))
      )
        continue;
      store.transaction(() => {
        const current = store.get<StudyBinding>(key);
        if (
          !current ||
          canonical(current) !== canonical(binding) ||
          bindingEraseAfter(current, id) > store.now() * 1000 ||
          closedStudyPublication(store, id) ||
          store.get("studyPublication:" + id) ||
          store.studySpeechExists(id) ||
          boundedStudyNativeEvidence(store, id)
        )
          return;
        closeOrphanStudyBinding(env, store, id, current.target);
      });
    } catch {
      // Invalid rows, chain outages and unrelated jobs do not starve the page.
    } finally {
      store.set(cursorKey, key);
    }
  }
  if (!rows.length) store.delete(cursorKey);
  return rows.length;
}
export const linkedBindingCleanupAlarm = (store: CleanupStore) =>
  store.hasLinkedStudyBinding() ? (store.now() + 30) * 1000 : Infinity;
