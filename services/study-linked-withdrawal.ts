import type { Hex } from "viem";
import { check, digest } from "../packages/protocol/index.ts";
import { validateStudyOffer } from "../packages/study/operator-contract.ts";
import {
  legacyResultsWithheldKey,
  sameResultsTarget,
} from "./learning-contract.ts";
import type { ResultStore } from "./learning-transactions.ts";
import type { StudyAuthorizationBinding } from "./study-authorization.ts";
import {
  studyTelegramPublication,
  persistTelegramStudyDenial,
} from "./study-telegram-publication.ts";
import {
  bootstrap,
  bumpBootstrap,
  checkSource,
  headKey,
  linkedStore,
  newHead,
  opKey,
  pending,
  scopeOf,
  watchKey,
  workKey,
  LinkedWithdrawalPending,
  type LinkedScope,
  type WithdrawalHead,
  type WithdrawalOperation,
} from "./study-linked-withdrawal-contract.ts";

/** Called inside a durable write after authentication/simulation. Exact old
 * identities are retained independently of the monotonic learner head. */
export function stageLinkedWithdrawal(
  store: ResultStore,
  input: Omit<WithdrawalOperation, "proof" | "original" | "source">,
): WithdrawalOperation {
  const operation = { ...input, scope: scopeOf(input.scope) },
    prior = store.get<WithdrawalOperation>(opKey(input.id));
  if (prior) {
    check(
      digest(prior.identity) === digest(input.identity) &&
        digest(prior.scope) === digest(operation.scope) &&
        prior.kind === input.kind,
      "study_withdrawal_operation_changed",
    );
    return prior; // Never restage an old completed operation.
  }
  const head =
    store.get<WithdrawalHead>(headKey(operation.scope)) ??
    newHead(operation.scope);
  pending(Number.isSafeInteger(head.revision + 1));
  store.set(opKey(input.id), operation);
  store.set(headKey(operation.scope), {
    ...head,
    revision: head.revision + 1,
    openProofs: head.openProofs + 1,
    sealed: false,
    cursor: "studyBinding:",
  });
  store.set(workKey(input.id), { operationId: input.id, due: store.now() });
  store.set(watchKey(operation.scope), {
    scope: operation.scope,
    due: store.now(),
  });
  bumpBootstrap(store);
  return operation;
}

export function linkedBindingScope(
  binding: StudyAuthorizationBinding,
): LinkedScope {
  const publication = studyTelegramPublication(
    binding.offer,
    binding.target,
    binding.offer.telegramFence!.facts.actor.communityId,
  );
  check(publication, "study_linked_binding_invalid");
  return scopeOf({
    communityId: publication.context.communityId,
    learner: publication.context.learner,
    target: binding.target,
  });
}
/** Validate the complete captured original before any permanent denial. */
export function validateLinkedBinding(
  value: unknown,
  key: string,
  now: number,
): StudyAuthorizationBinding {
  const b = value as StudyAuthorizationBinding;
  check(
    b?.offer?.speechChannel === "telegram-linked" &&
      b.offer.telegramFence &&
      b.target?.version === 4 &&
      b.authorization,
    "study_linked_binding_invalid",
  );
  const exercises = validateStudyOffer(b.offer, now, 4);
  check(
    key === "studyBinding:" + b.offer.lessonId &&
      b.offerHash === digest(b.offer) &&
      b.exercisesHash === exercises &&
      b.authorization.id === b.offer.authorizationId &&
      sameResultsTarget(b.authorization.target, b.target) &&
      Number.isSafeInteger(b.authorization.issuedAt) &&
      b.authorization.issuedAt > 0 &&
      b.authorization.issuedAt * 1000 <= b.offer.startedAt,
    "study_linked_binding_invalid",
  );
  linkedBindingScope(b); // Canonical fence/subject/community validation.
  return b;
}

/** No boolean pending result: callers must not convert this into permanent
 * withholding, private status, a receipt replacement, or sponsorship refund. */
export function guardLinkedWithdrawal(
  store: ResultStore,
  scope: LinkedScope,
  issuedAt?: number,
) {
  try {
    const db = linkedStore(store),
      migration = bootstrap(db);
    checkSource(scope, db.linkedWithdrawalSource(scope));
    pending(
      migration?.phase === "ready" &&
        !db.linkedStudyBindings.hasUnclassified() &&
        !db.hasUnclassifiedLegacyWithdrawal(),
    );
    const head = db.get<WithdrawalHead>(headKey(scope));
    const marker = db.get(legacyResultsWithheldKey(scope.learner));
    pending(
      !marker ||
        db.get("linkedWithdrawalLegacy:" + digest(scopeOf(scope))) ===
          digest(marker),
    );
    pending(!head || (head.openProofs === 0 && head.sealed));
    // A floor violation is permanent only for an ORIGINAL authorization; the
    // caller records that exact tombstone after validating its full binding.
    return (
      issuedAt !== undefined &&
      issuedAt <= Math.max(head?.cutoffS ?? 0, head?.recoveryFloorS ?? 0)
    );
  } catch {
    throw new LinkedWithdrawalPending();
  }
}
export function guardLinkedBinding(
  store: ResultStore,
  binding: StudyAuthorizationBinding,
) {
  try {
    const b = validateLinkedBinding(
      binding,
      "studyBinding:" + binding.offer.lessonId,
      store.now(),
    );
    return guardLinkedWithdrawal(
      store,
      linkedBindingScope(b),
      b.authorization.issuedAt,
    );
  } catch {
    throw new LinkedWithdrawalPending();
  }
}
export function guardLinkedPublication(
  store: ResultStore,
  publication: NonNullable<ReturnType<typeof studyTelegramPublication>>,
) {
  const binding = store.get<StudyAuthorizationBinding>(
    "studyBinding:" + publication.context.lessonId,
  );
  pending(
    binding &&
      binding.offer.telegramFence?.hash === publication.fence.hash &&
      binding.authorization?.id === publication.context.authorizationId,
  );
  return guardLinkedBinding(store, binding);
}
/** Pre-bind has no captured binding yet. It may check readiness, but only the
 * later chain read supplies issuance; final commit still requires its capture. */
export function guardLinkedAdmission(
  store: ResultStore,
  publication: NonNullable<ReturnType<typeof studyTelegramPublication>>,
  target: LinkedScope["target"],
) {
  if (store.get("studyBinding:" + publication.context.lessonId))
    return guardLinkedPublication(store, publication);
  pending(
    target.contract.toLowerCase() === publication.context.contract &&
      target.version === 4,
  );
  return guardLinkedWithdrawal(store, {
    communityId: publication.context.communityId,
    learner: publication.context.learner,
    target,
  });
}

export interface LinkedBindCapture {
  headRevision: number;
  bootstrapRevision: number;
  sourceHash: string;
  scope: LinkedScope;
}
/** Capture BEFORE authorization/provider awaits. Registration itself is a
 * durable write: a legacy marker encountered behind a cursor queues repair. */
export async function prepareLinkedBind(
  store: ResultStore,
  scope: LinkedScope,
): Promise<LinkedBindCapture> {
  const db = linkedStore(store);
  await db.durableStudyWrite(() => {
    if (!bootstrap(db)) bumpBootstrap(db);
    db.set(watchKey(scope), { scope: scopeOf(scope), due: db.now() });
    const marker = db.get(legacyResultsWithheldKey(scope.learner));
    if (
      marker &&
      db.get("linkedWithdrawalLegacy:" + digest(scopeOf(scope))) !==
        digest(marker)
    )
      stageLinkedWithdrawal(db, {
        id: digest(["legacy", scopeOf(scope), marker]),
        scope,
        kind: "legacy",
        identity: marker,
      });
  });
  guardLinkedWithdrawal(db, scope);
  return {
    scope: scopeOf(scope),
    headRevision: db.get<WithdrawalHead>(headKey(scope))?.revision ?? 0,
    bootstrapRevision: bootstrap(db)!.revision,
    sourceHash: digest(db.linkedWithdrawalSource(scope)),
  };
}
export function commitLinkedBind(
  store: ResultStore,
  capture: LinkedBindCapture,
  issuedAt: number,
) {
  const db = linkedStore(store);
  pending(
    bootstrap(db)?.revision === capture.bootstrapRevision &&
      (db.get<WithdrawalHead>(headKey(capture.scope))?.revision ?? 0) ===
        capture.headRevision,
  );
  pending(
    digest(db.linkedWithdrawalSource(capture.scope)) === capture.sourceHash,
  );
  check(
    !guardLinkedWithdrawal(db, capture.scope, issuedAt),
    "study_authorization_required",
  );
  db.set(watchKey(capture.scope), { scope: capture.scope, due: db.now() });
}

/** Must run in the same durable write as relevant source mutation, including
 * writes behind completed bootstrap/discovery cursors. No entries fallback. */
export function linkedWithdrawalBindingWritten(
  store: ResultStore,
  key: string,
  value: unknown,
) {
  const b = validateLinkedBinding(value, key, store.now()),
    scope = linkedBindingScope(b);
  bumpBootstrap(store);
  store.set(watchKey(scope), { scope, due: store.now() });
  const marker = store.get(legacyResultsWithheldKey(scope.learner));
  if (
    marker &&
    store.get("linkedWithdrawalLegacy:" + digest(scope)) !== digest(marker)
  )
    stageLinkedWithdrawal(store, {
      id: digest(["legacy", scope, marker]),
      scope,
      kind: "legacy",
      identity: marker,
    });
}

export function denyOriginal(
  store: ResultStore,
  scope: LinkedScope,
  authorizationId: Hex,
) {
  return persistTelegramStudyDenial(store, scope.communityId, {
    schema: "pirate.study.telegram-publication-denial/1",
    communityId: scope.communityId,
    kind: "authorization",
    authorizationId,
  });
}

/** Indexed page, denials and cursor/seal are one transaction. No await; an
 * erased binding is simply absent from the current index, never recreated. */
export function discoverLinkedWithdrawal(
  store: ResultStore,
  scope: LinkedScope,
  revision: number,
  limit = 50,
) {
  const db = linkedStore(store);
  return db.transaction(() => {
    const head = db.get<WithdrawalHead>(headKey(scope));
    if (!head || head.revision !== revision || head.openProofs || head.sealed)
      return false;
    pending(!db.linkedStudyBindings.hasUnclassified());
    const rows = db.linkedStudyBindings.page({
      ...scope,
      after: head.cursor,
      limit,
    });
    // Validate the entire page before writes. Any malformed original leaves
    // the cursor unchanged; recovery persists a diagnostic obligation.
    const bindings = rows.map((row) =>
      validateLinkedBinding(row.value, row.key, db.now()),
    );
    for (const b of bindings) {
      check(
        digest(linkedBindingScope(b)) === digest(scopeOf(scope)),
        "study_withdrawal_index_changed",
      );
      if (
        b.authorization.issuedAt <= Math.max(head.cutoffS, head.recoveryFloorS)
      )
        denyOriginal(db, scope, b.authorization.id);
    }
    db.set(headKey(scope), {
      ...head,
      cursor: rows.length === limit ? rows.at(-1)!.key : "studyBinding:",
      sealed: rows.length < limit,
      error: undefined,
    });
    return true;
  });
}
