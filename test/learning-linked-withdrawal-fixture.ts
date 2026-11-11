import { keccak256 } from "viem";
// Queued SQLite tests; no checks run by the source actor. The coordinator
// MUST mount its prepared index before importing this fixture.
import { DatabaseSync } from "node:sqlite";
import { digest } from "../packages/protocol/index.ts";
import { telegramStudyFence } from "../packages/study/telegram-publication.ts";
import { STUDY_LESSON_NO_DEADLINE } from "../packages/study/lesson.ts";
import { studyExercisesHash } from "../packages/protocol/learning-results-v3.ts";
import { Store } from "../services/operator-store.ts";
import { linkedStudyBindingIndex } from "../services/study-linked-binding-index.ts";
import type {
  LinkedStore,
  WithdrawalOperation,
  WithdrawalProof,
} from "../services/study-linked-withdrawal-contract.ts";
import {
  bootstrapLinkedWithdrawals,
  mergeLinkedProof,
} from "../services/study-linked-withdrawal-recovery.ts";
import { opKey } from "../services/study-linked-withdrawal-contract.ts";
import type { StudyAuthorizationBinding } from "../services/study-authorization.ts";

export const communityId = digest("linked-withdrawal-community");
export const learner = `0x${"11".repeat(20)}` as const;
export const target = {
  chainId: 31337,
  version: 4,
  contract: `0x${"c4".repeat(20)}`,
} as const;
export const scope = { communityId, learner, target };
export const source = {
  ...scope,
  runtimeCodeHash: keccak256("0x6000"),
};
export function linkedFixture() {
  const sqlite = new DatabaseSync(":memory:");
  let alarm: number | null = null,
    sequence = 0,
    rollback = false;
  const sql = {
    exec(query: string, ...args: (string | number | null)[]) {
      const rows = sqlite.prepare(query).all(...args);
      return { toArray: () => rows };
    },
  };
  const transactionSync = <T>(work: () => T) => {
    const savepoint = "linked_" + sequence++;
    sqlite.exec("SAVEPOINT " + savepoint);
    try {
      const result = work();
      if (rollback) {
        rollback = false;
        throw Error("injected_commit_failure");
      }
      sqlite.exec("RELEASE " + savepoint);
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK TO " + savepoint);
      sqlite.exec("RELEASE " + savepoint);
      throw error;
    }
  };
  const storage = {
    sql,
    transactionSync,
    async transaction<T>(work: () => T | Promise<T>) {
      const savepoint = "linked_" + sequence++,
        prior = alarm;
      sqlite.exec("SAVEPOINT " + savepoint);
      try {
        const result = await work();
        if (rollback) {
          rollback = false;
          throw Error("injected_commit_failure");
        }
        sqlite.exec("RELEASE " + savepoint);
        return result;
      } catch (error) {
        alarm = prior;
        sqlite.exec("ROLLBACK TO " + savepoint);
        sqlite.exec("RELEASE " + savepoint);
        throw error;
      }
    },
    getAlarm: async () => alarm,
    setAlarm: async (due: number) => {
      alarm = due;
    },
  } as unknown as DurableObjectStorage;
  const store = () => {
    const instance = new Store(storage, 1000);
    return Object.assign(instance, {
      linkedStudyBindings: linkedStudyBindingIndex(
        sql as unknown as SqlStorage,
      ),
      linkedWithdrawalSource: () => source,
      entries: (prefix: string) => {
        if (
          prefix.startsWith("studyBinding:") ||
          prefix.startsWith("legacyResultsWithheld:")
        )
          throw Error("entries discovery fallback forbidden");
        return Store.prototype.entries.call(instance, prefix);
      },
    }) as Store & LinkedStore;
  };
  function binding(index: number, issuedAt = 100): StudyAuthorizationBinding {
    const facts = {
      schema: "pirate.study.telegram-publication-fence/1" as const,
      version: 1 as const,
      grantId: "original-grant",
      accountId: "account-a",
      authorityVersion: "epoch-1",
      actor: {
        communityId,
        botId: "123",
        generation: 1,
        userId: "456",
        chatId: "456",
      },
    };
    const offer = {
      lessonId: "linked_lesson_" + String(index).padStart(8, "0"),
      learner,
      sourceDigest: digest("source"),
      startedAt: 900000,
      expiresAt: STUDY_LESSON_NO_DEADLINE,
      speechChannel: "telegram-linked" as const,
      telegramFence: telegramStudyFence({ facts, hash: digest(facts) }),
      authorizationId: digest("original-authorization-" + index),
      exercises: [1, 2, 3, 4].map((ordinal) => ({
        ordinal,
        lineId: digest("line" + ordinal),
        language: "en",
      })),
    };
    return {
      offer,
      offerHash: digest(offer),
      exercisesHash: studyExercisesHash([1, 2, 3, 4]),
      target,
      authorization: { id: offer.authorizationId, issuedAt, target },
    };
  }
  return {
    sqlite,
    store,
    binding,
    alarm: () => alarm,
    failCommit: () => {
      rollback = true;
    },
    close: () => sqlite.close(),
  };
}
export async function boot(store: LinkedStore) {
  for (
    let page = 0;
    page < 10 &&
    store.get<{ phase: string }>("linkedWithdrawalBootstrap:2")?.phase !==
      "ready";
    page++
  )
    await bootstrapLinkedWithdrawals(store);
}
/** Explicit trusted proof-port fixture. Canonical proof qualification belongs
 * to the coordinator's separately reviewed foundation, not this fixture. */
export function proofFor(
  store: LinkedStore,
  id: string,
  cutoff = 500,
  nonce = "1",
  kind: WithdrawalProof["kind"] = "observed",
  floor = cutoff,
) {
  const op = store.get<WithdrawalOperation>(opKey(id))!;
  const original =
    kind === "observed"
      ? undefined
      : {
          nonce: "0",
          data: "0x11" as const,
          transaction: {
            raw: "0x22" as const,
            hash: digest("original-tx"),
            nonce: 4,
            sender: learner,
          },
        };
  store.set(opKey(id), { ...op, source, ...(original ? { original } : {}) });
  const body = {
    schema: "pirate.study.linked-withdrawal-proof/1" as const,
    kind,
    source,
    learner,
    revokedAtS: cutoff,
    issuanceFloorS: floor,
    nextNonce: nonce,
    anchor: { number: "100", hash: digest("safe-anchor"), timestampS: 1000 },
    ...(original
      ? {
          original: {
            nonce: "0",
            transactionHash: original.transaction.hash,
            ...(kind === "authority_covered"
              ? {}
              : {
                  receipt: {
                    blockNumber: "90",
                    blockHash: digest("original-block"),
                    status: kind as "success" | "reverted",
                  },
                }),
          },
        }
      : {}),
  };
  return { ...body, proofHash: digest(body) };
}
export function prove(
  store: LinkedStore,
  id: string,
  cutoff = 500,
  nonce = "1",
  kind: WithdrawalProof["kind"] = "observed",
  floor = cutoff,
) {
  const proof = proofFor(store, id, cutoff, nonce, kind, floor);
  mergeLinkedProof(store, id, proof);
  return proof;
}
