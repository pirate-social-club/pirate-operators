import { digest } from "../packages/protocol/index.ts";
import {
  telegramStudyDenial,
  type TelegramStudyDenial,
} from "../packages/study/telegram-publication.ts";
import {
  TelegramError,
  telegramCheck,
  validateScope,
} from "../packages/telegram/contracts.ts";
import type {
  TelegramDenialChild,
  TelegramTransition,
} from "../packages/telegram/transitions.ts";
import type { TelegramJournal } from "./telegram-store.ts";

export const transitionKey = (id: string) => `publication-transition:${id}`;
export const transitionReady = (op: TelegramTransition) =>
  `publication-ready:${op.scope.communityId}:${op.id}`;
export const accountPending = (
  community: string,
  bot: string,
  account: string,
) => `publication-account:${community}:${bot}:${account}`;
export const childKey = (id: string, index: number) =>
  `publication-child:${id}:${String(index).padStart(12, "0")}`;

/** The caller stages its local fence in this same SQLite transaction. */
export function saveTransition(
  store: TelegramJournal,
  input: TelegramTransition,
  denials: TelegramStudyDenial[],
) {
  const key = transitionKey(input.id),
    previous = store.get<TelegramTransition>(key);
  if (previous) {
    telegramCheck(
      previous.requestHash === input.requestHash,
      "telegram_transition_conflict",
      409,
    );
    return previous;
  }
  const revisionKey = `publication-revision:${input.scope.communityId}`;
  const op = { ...input, revision: (store.get<number>(revisionKey) ?? 0) + 1 };
  store.set(revisionKey, op.revision);
  for (const denial of denials) appendDenial(store, op, denial);
  store.set(key, op);
  store.set(transitionReady(op), op.id);
  return op;
}
export function appendDenial(
  store: TelegramJournal,
  op: TelegramTransition,
  value: TelegramStudyDenial,
) {
  const denial = telegramStudyDenial(value);
  telegramCheck(
    denial.communityId === op.scope.communityId,
    "telegram_transition_conflict",
    409,
  );
  store.set(childKey(op.id, op.children++), {
    denial,
    hash: digest(denial),
    acknowledged: false,
  } satisfies TelegramDenialChild);
}
export function validateTransition(op: TelegramTransition) {
  telegramCheck(
    op &&
      op.schema === "pirate.telegram.publication-transition/1" &&
      /^0x[0-9a-f]{64}$/.test(op.id) &&
      /^0x[0-9a-f]{64}$/.test(op.requestHash) &&
      ["scope", "unlink", "block", "authority"].includes(op.kind) &&
      op.scope &&
      op.target &&
      op.target.communityId === op.scope.communityId &&
      Number.isSafeInteger(op.revision) &&
      op.revision > 0 &&
      Number.isSafeInteger(op.children) &&
      op.children >= 0 &&
      Number.isSafeInteger(op.acknowledged) &&
      op.acknowledged >= 0 &&
      op.acknowledged <= op.children &&
      typeof op.complete === "boolean" &&
      typeof op.sealed === "boolean" &&
      Number.isFinite(op.nextAt) &&
      Number.isSafeInteger(op.attempts) &&
      op.attempts >= 0 &&
      (!op.complete || (op.sealed && op.acknowledged === op.children)),
    "telegram_transition_invalid",
    503,
  );
  try {
    validateScope(op.scope);
  } catch {
    telegramCheck(false, "telegram_transition_invalid", 503);
  }
  return op;
}

export function validateDenialChild(child: TelegramDenialChild | undefined) {
  try {
    telegramCheck(
      child &&
        typeof child.acknowledged === "boolean" &&
        digest(telegramStudyDenial(child.denial)) === child.hash,
      "telegram_transition_invalid",
      503,
    );
    return child;
  } catch {
    throw new TelegramError("telegram_transition_invalid", 503);
  }
}
