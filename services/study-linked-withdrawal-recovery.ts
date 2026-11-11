import { check, digest } from "../packages/protocol/index.ts";
import { legacyResultsWithheldKey } from "./learning-contract.ts";
import type { ResultStore } from "./learning-transactions.ts";
import {
  bootstrap,
  bootstrapKey,
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
  type LinkedScope,
  type LinkedStore,
  type WithdrawalHead,
  type WithdrawalOperation,
  type WithdrawalPorts,
  type WithdrawalProof,
} from "./study-linked-withdrawal-contract.ts";
import {
  discoverLinkedWithdrawal,
  linkedBindingScope,
  stageLinkedWithdrawal,
  validateLinkedBinding,
} from "./study-linked-withdrawal.ts";

/** Unknown proofs never mutate authority. This checks the required proof
 * contract, not chain truth; only the coordinator's verified port supplies it. */
function verifyProof(op: WithdrawalOperation, proof: WithdrawalProof) {
  const { proofHash, ...body } = proof;
  check(
    proof.schema === "pirate.study.linked-withdrawal-proof/1" &&
      digest(body) === proofHash &&
      digest(proof.source) === digest(op.source) &&
      proof.learner.toLowerCase() === op.scope.learner &&
      [proof.revokedAtS, proof.issuanceFloorS, proof.anchor.timestampS].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) &&
      proof.revokedAtS <= proof.issuanceFloorS &&
      proof.issuanceFloorS <= proof.anchor.timestampS &&
      /^(0|[1-9][0-9]{0,19})$/.test(proof.nextNonce) &&
      BigInt(proof.nextNonce) < 1n << 64n,
    "study_withdrawal_proof_changed",
  );
  if (op.original)
    check(
      proof.kind !== "observed" &&
        proof.original?.nonce === op.original.nonce &&
        proof.original.transactionHash === op.original.transaction.hash &&
        (proof.kind === "authority_covered"
          ? BigInt(proof.nextNonce) > BigInt(op.original.nonce)
          : proof.original.receipt?.status === proof.kind),
      "study_withdrawal_original_changed",
    );
  else
    check(
      proof.kind === "observed" && proof.revokedAtS > 0,
      "study_withdrawal_original_changed",
    );
}
export function mergeLinkedProof(
  store: ResultStore,
  id: string,
  proof: WithdrawalProof,
) {
  return store.transaction(() => {
    const op = store.get<WithdrawalOperation>(opKey(id));
    check(op, "study_withdrawal_operation_missing");
    verifyProof(op, proof);
    if (op.proof) return; // Immutable terminal outcome; never relabel a revert.
    const head =
      store.get<WithdrawalHead>(headKey(op.scope)) ?? newHead(op.scope);
    pending(head.openProofs > 0);
    const cutoffS = Math.max(head.cutoffS, proof.revokedAtS),
      recoveryFloorS = Math.max(head.recoveryFloorS, proof.issuanceFloorS);
    const advanced =
      cutoffS > head.cutoffS ||
      recoveryFloorS > head.recoveryFloorS ||
      BigInt(proof.nextNonce) > BigInt(head.nextNonce);
    const marker = store.get(legacyResultsWithheldKey(op.scope.learner));
    store.set(opKey(id), { ...op, proof });
    store.set(headKey(op.scope), {
      ...head,
      cutoffS,
      recoveryFloorS,
      nextNonce:
        BigInt(head.nextNonce) > BigInt(proof.nextNonce)
          ? head.nextNonce
          : proof.nextNonce,
      revision: head.revision + Number(advanced),
      openProofs: head.openProofs - 1,
      sealed: false,
      cursor: "studyBinding:",
      ...(op.kind === "legacy" &&
      marker &&
      digest(marker) === digest(op.identity)
        ? { legacyFingerprint: digest(marker) }
        : {}),
    });
    store.delete(workKey(id));
    store.set(watchKey(op.scope), { scope: op.scope, due: store.now() + 60 });
  });
}

/** Both bootstrap passes are durable and bounded. A malformed row retains its
 * cursor and diagnostic; it cannot disappear behind a catch-and-advance. */
export async function bootstrapLinkedWithdrawals(
  store: ResultStore,
  limit = 50,
) {
  const db = linkedStore(store);
  return db.durableStudyWrite(() => {
    if (!bootstrap(db)) bumpBootstrap(db);
    const migration = bootstrap(db)!;
    if (migration.phase === "ready") return;
    const prefix =
      migration.phase === "markers"
        ? "legacyResultsWithheld:"
        : "studyBinding:";
    const rows = db.page(prefix, migration.cursor, limit);
    try {
      for (const row of rows) {
        if (migration.phase === "markers") {
          const marker = row.value as {
            at: number;
            nonce?: string;
            revokedAt?: string;
          };
          check(
            /^legacyResultsWithheld:0x[0-9a-f]{40}$/.test(row.key) &&
              marker &&
              Number.isSafeInteger(marker.at) &&
              marker.at >= 0 &&
              ((typeof marker.nonce === "string" &&
                /^(0|[1-9][0-9]{0,19})$/.test(marker.nonce)) ||
                (typeof marker.revokedAt === "string" &&
                  /^[1-9][0-9]{0,19}$/.test(marker.revokedAt))),
            "study_withdrawal_legacy_unresolved",
          );
          // Legacy evidence is permanent. Bindings pass supplies ORIGINAL
          // targets; never assign current defaults to a legacy marker.
          db.set(
            "linkedWithdrawalLegacyCatalog:" + row.key.slice(prefix.length),
            { fingerprint: digest(row.value) },
          );
        } else {
          const value = row.value as {
            offer?: {
              speechChannel?: unknown;
              telegramFence?: unknown;
              privateSpeechSource?: unknown;
            };
          };
          check(
            value?.offer && typeof value.offer === "object",
            "study_linked_binding_unclassified",
          );
          if (
            !["speechChannel", "telegramFence", "privateSpeechSource"].some(
              (field) => Object.hasOwn(value.offer!, field),
            )
          )
            continue;
          const b = validateLinkedBinding(row.value, row.key, db.now()),
            scope = linkedBindingScope(b);
          db.set(watchKey(scope), { scope, due: db.now() });
          const marker = db.get(legacyResultsWithheldKey(scope.learner));
          if (marker)
            stageLinkedWithdrawal(db, {
              id: digest(["legacy", scope, marker]),
              scope,
              kind: "legacy",
              identity: marker,
            });
        }
      }
      if (migration.phase === "bindings")
        pending(
          !db.linkedStudyBindings.hasUnclassified() &&
            !db.hasUnclassifiedLegacyWithdrawal(),
        );
      const latest = bootstrap(db)!;
      db.set(bootstrapKey, {
        ...latest,
        phase:
          rows.length === limit
            ? migration.phase
            : migration.phase === "markers"
              ? "bindings"
              : "ready",
        cursor: rows.length === limit ? rows.at(-1)!.key : "studyBinding:",
        error: undefined,
      });
    } catch (error) {
      // Writes before this row remain idempotent. The cursor does not move.
      db.set(bootstrapKey, { ...bootstrap(db)!, error: String(error) });
    }
  });
}

function fairPage(db: LinkedStore, prefix: string, limit: number) {
  const cursorKey = "linkedWithdrawalFairCursor:" + prefix;
  const after = db.get<string>(cursorKey) ?? prefix;
  let rows = db.page(prefix, after, limit);
  if (!rows.length && after !== prefix) rows = db.page(prefix, prefix, limit);
  db.set(cursorKey, rows.at(-1)?.key ?? prefix);
  return rows;
}
async function observeBounded(
  ports: WithdrawalPorts,
  op: WithdrawalOperation,
  waitMs: number,
) {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ports.observe(
        {
          source: op.source!,
          learner: op.scope.learner,
          ...(op.original ? { original: op.original } : {}),
        },
        abort.signal,
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve(null);
        }, waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
/** Runs before publication/retention. Durable wake is committed BEFORE each
 * remote read. Fair cursors advance before awaits; an unavailable learner
 * cannot monopolize bounded pages. A read-only late result has no write path. */
export async function recoverLinkedWithdrawals(
  store: ResultStore,
  ports: WithdrawalPorts,
  limit = 10,
  waitMs = 2000,
) {
  const db = linkedStore(store);
  check(
    Number.isInteger(limit) &&
      limit > 0 &&
      limit <= 50 &&
      waitMs > 0 &&
      waitMs <= 5000,
    "study_withdrawal_scan_invalid",
  );
  await bootstrapLinkedWithdrawals(db);
  const work = await db.durableStudyWrite(() =>
    fairPage(db, "linkedWithdrawalWork:", limit),
  );
  for (const row of work) {
    const item = row.value as { operationId: string; due: number };
    if (item.due > db.now()) continue;
    try {
      let op = await db.durableStudyWrite(() => {
        const current = db.get<WithdrawalOperation>(opKey(item.operationId));
        check(current, "study_withdrawal_operation_missing");
        if (current.proof) {
          db.delete(row.key);
          return null;
        }
        const source = current.source ?? ports.source(current.scope);
        checkSource(current.scope, source);
        const next = { ...current, source };
        db.set(opKey(current.id), next);
        db.set(row.key, { ...item, due: db.now() + 5 });
        return next;
      });
      if (!op) continue;
      const candidate = op.original ?? (await ports.original(op));
      if (op.kind === "signed") pending(candidate);
      const captured = op;
      op = await db.durableStudyWrite(() => {
        const current = db.get<WithdrawalOperation>(opKey(captured.id));
        pending(
          current &&
            digest(current.identity) === digest(captured.identity) &&
            digest(current.source) === digest(captured.source),
        );
        if (current.proof) return null;
        if (current.original && candidate)
          check(
            digest(current.original) === digest(candidate),
            "study_withdrawal_original_changed",
          );
        const next = {
          ...current,
          ...(candidate ? { original: candidate } : {}),
        };
        db.set(opKey(current.id), next);
        return next;
      });
      if (!op) continue;
      const proof = await observeBounded(ports, op, waitMs);
      if (proof)
        await db.durableStudyWrite(() => mergeLinkedProof(db, op.id, proof));
    } catch (error) {
      await db.durableStudyWrite(() =>
        db.set(row.key, { ...item, due: db.now() + 5, error: String(error) }),
      );
    }
  }
  const heads = await db.durableStudyWrite(() =>
    fairPage(db, "linkedWithdrawalHead:", limit),
  );
  for (const { value } of heads) {
    const head = value as WithdrawalHead;
    try {
      await db.durableStudyWrite(() => {
        discoverLinkedWithdrawal(db, head.scope, head.revision);
        const latest = db.get<WithdrawalHead>(headKey(head.scope));
        if (
          latest?.revision === head.revision &&
          latest.sealed &&
          !latest.openProofs &&
          latest.legacyFingerprint
        )
          db.set(
            "linkedWithdrawalLegacy:" + digest(scopeOf(head.scope)),
            latest.legacyFingerprint,
          );
      });
    } catch (error) {
      await db.durableStudyWrite(() => {
        const latest = db.get<WithdrawalHead>(headKey(head.scope));
        if (latest?.revision === head.revision)
          db.set(headKey(head.scope), { ...latest, error: String(error) });
      });
    }
  }
  const watches = await db.durableStudyWrite(() =>
    fairPage(db, "linkedWithdrawalWatch:", limit),
  );
  for (const row of watches) {
    const watch = row.value as { scope: LinkedScope; due: number };
    if (watch.due > db.now()) continue;
    try {
      const op = await db.durableStudyWrite(() => {
        const marker = db.get(legacyResultsWithheldKey(watch.scope.learner));
        if (
          marker &&
          db.get("linkedWithdrawalLegacy:" + digest(scopeOf(watch.scope))) !==
            digest(marker)
        )
          stageLinkedWithdrawal(db, {
            id: digest(["legacy", scopeOf(watch.scope), marker]),
            scope: watch.scope,
            kind: "legacy",
            identity: marker,
          });
        const source = ports.source(watch.scope);
        checkSource(watch.scope, source);
        db.set(row.key, { ...watch, due: db.now() + 60 });
        return {
          id: "observation",
          identity: null,
          scope: scopeOf(watch.scope),
          kind: "observed" as const,
          source,
        };
      });
      const proof = await observeBounded(ports, op, waitMs);
      if (!proof) continue;
      await db.durableStudyWrite(() => {
        const current =
          db.get<WithdrawalHead>(headKey(op.scope)) ?? newHead(op.scope);
        if (
          proof.revokedAtS <= current.cutoffS &&
          BigInt(proof.nextNonce) <= BigInt(current.nextNonce)
        )
          return;
        const id = digest([
          "observed",
          op.scope,
          proof.revokedAtS,
          proof.nextNonce,
        ]);
        const stored = stageLinkedWithdrawal(db, {
          ...op,
          id,
          identity: { cutoff: proof.revokedAtS, nonce: proof.nextNonce },
        });
        if (!stored.proof) {
          db.set(opKey(id), { ...stored, source: op.source });
          mergeLinkedProof(db, id, proof);
        }
      });
    } catch (error) {
      await db.durableStudyWrite(() =>
        db.set(row.key, { ...watch, due: db.now() + 60, error: String(error) }),
      );
    }
  }
}

/** Required startup/alarm predicate even with no remaining bindings. */
export function linkedWithdrawalNeedsWake(store: ResultStore) {
  const db = linkedStore(store);
  return (
    bootstrap(db)?.phase !== "ready" ||
    db.page("linkedWithdrawalWork:", "linkedWithdrawalWork:", 1).length > 0 ||
    db.page("linkedWithdrawalWatch:", "linkedWithdrawalWatch:", 1).length > 0 ||
    db.linkedStudyBindings.hasUnclassified() ||
    db.hasUnclassifiedLegacyWithdrawal() ||
    db
      .page("linkedWithdrawalHead:", "linkedWithdrawalHead:", 50)
      .some((row) => !(row.value as WithdrawalHead).sealed)
  );
}
