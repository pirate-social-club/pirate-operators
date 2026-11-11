import { digest } from "../packages/protocol/index.ts";
import {
  actorKey,
  telegramCheck,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import {
  TelegramDeliveryError,
  type TelegramDelivery,
  type TelegramDeliveryPort,
  type TelegramNativeMessage,
} from "../packages/telegram/messages.ts";
import { TelegramGrants } from "./telegram-grants.ts";
import type { TelegramStudySession } from "../packages/telegram/work.ts";
import {
  telegramNoticeLocal,
  type TelegramNoticeGuard,
} from "./telegram-notifications.ts";
import type { TelegramManagedPublication } from "./telegram-managed-publication.ts";
import type { TelegramGrantCapture } from "../packages/telegram/transitions.ts";

export interface TelegramOutbound {
  effectId: string;
  actor: ChatActor;
  sequence: number;
  payload: TelegramNativeMessage;
  payloadDigest: string;
  grantId: string | null;
  authorityVersion: string | null;
  sessionId: string | null;
  notice: TelegramNoticeGuard | null;
  state: "pending" | "sending" | "unknown" | "sent" | "cancelled";
  tries: number;
  nextAt: number;
  messageId: number | null;
  blockCapture?: TelegramGrantCapture;
}

/** Retire the former native verdict copy while preserving delivery identity. */
export function scrubTelegramVerdict(row: TelegramOutbound): TelegramOutbound {
  if (
    !row.effectId.startsWith("outcome:") ||
    row.payload.kind !== "text" ||
    !row.payload.text.startsWith("Incorrect\nYou said:")
  )
    return row;
  return { ...row, payload: { ...row.payload, text: "Incorrect" } };
}

export class TelegramOutbox {
  readonly grants: TelegramGrants;
  readonly delivery: TelegramDeliveryPort;
  readonly publication?: TelegramManagedPublication;
  readonly noticeCheck?: (
    actor: ChatActor,
    guard: TelegramNoticeGuard,
  ) => Promise<void>;
  constructor(
    grants: TelegramGrants,
    delivery: TelegramDeliveryPort,
    noticeCheck?: (
      actor: ChatActor,
      guard: TelegramNoticeGuard,
    ) => Promise<void>,
    publication?: TelegramManagedPublication,
  ) {
    this.grants = grants;
    this.delivery = delivery;
    this.noticeCheck = noticeCheck;
    this.publication = publication;
  }
  enqueue(
    actor: ChatActor,
    effectId: string,
    payload: TelegramNativeMessage,
    guard?: {
      grantId?: string;
      authorityVersion?: string;
      sessionId?: string;
      notice?: TelegramNoticeGuard;
    },
  ) {
    if (payload.kind === "document" && payload.lessonId) {
      telegramCheck(
        !guard?.sessionId || guard.sessionId === payload.lessonId,
        "telegram_history_lesson_mismatch",
      );
      guard = { ...guard, sessionId: payload.lessonId };
    }
    if (payload.kind === "document" && payload.expiresAt <= this.grants.now())
      payload = { kind: "text", text: "Private history expired." };
    return this.grants.store.transaction(() => {
      const id = digest([actorKey(actor), effectId]),
        indexKey = `outbox-effect:${id}`;
      const oldKey = this.grants.store.get<string>(indexKey),
        previous = oldKey
          ? this.grants.store.get<TelegramOutbound>(oldKey)
          : undefined;
      const payloadDigest = digest({ payload, guard: guard ?? null, actor });
      if (previous) {
        telegramCheck(
          previous.payloadDigest === payloadDigest,
          "telegram_delivery_conflict",
          409,
        );
        return previous;
      }
      const sequenceKey = `outbox-sequence:${actorKey(actor)}`,
        sequence = (this.grants.store.get<number>(sequenceKey) ?? 0) + 1;
      const key = `outbox:${actorKey(actor)}:${String(sequence).padStart(16, "0")}`;
      const row: TelegramOutbound = {
        effectId,
        actor,
        sequence,
        payload,
        payloadDigest,
        grantId: guard?.grantId ?? null,
        authorityVersion: guard?.authorityVersion ?? null,
        sessionId: guard?.sessionId ?? null,
        notice: guard?.notice ?? null,
        state: "pending",
        tries: 0,
        nextAt: this.grants.now(),
        messageId: null,
      };
      this.grants.store.set(sequenceKey, sequence);
      this.grants.store.set(indexKey, key);
      this.grants.store.set(key, row);
      if (row.sessionId)
        this.grants.store.set(
          `lesson-delivery:${actorKey(actor)}:${row.sessionId}:${id}`,
          key,
        );
      this.grants.store.set(`outbox-ready:${actorKey(actor)}`, actor);
      return row;
    });
  }
  private async permitted(row: TelegramOutbound) {
    if (row.payload.kind === "start-required") this.grants.current(row.actor);
    else this.grants.binding(row.actor);
    if (row.notice) {
      telegramCheck(this.noticeCheck, "telegram_notice_guard_required", 503);
      await this.noticeCheck(row.actor, row.notice);
    }
    if (row.grantId) {
      const grant = await this.grants.assert(row.actor, row.grantId);
      telegramCheck(
        grant.authorityVersion === row.authorityVersion,
        "telegram_authority_changed",
        403,
      );
    }
    this.permittedLocal(row);
  }
  private permittedLocal(row: TelegramOutbound) {
    if (row.payload.kind === "start-required") this.grants.current(row.actor);
    else this.grants.binding(row.actor);
    if (row.notice) telegramNoticeLocal(this.grants, row.actor, row.notice);
    if (row.grantId) {
      const grant = this.grants.read(row.actor);
      telegramCheck(
        grant?.id === row.grantId && grant.revokedAt === null,
        "telegram_authority_changed",
        403,
      );
    }
    if (row.payload.kind === "document")
      telegramCheck(
        row.payload.expiresAt > this.grants.now(),
        "telegram_history_expired",
        410,
      );
    if (row.sessionId) {
      telegramCheck(
        this.grants.store.get<string>(
          `active-session:${actorKey(row.actor)}`,
        ) === row.sessionId,
        "telegram_lesson_changed",
        409,
      );
      if (
        (row.payload.kind === "text" || row.payload.kind === "voice") &&
        row.payload.promptKey
      ) {
        const session = this.grants.store.get<TelegramStudySession>(
          `session:${actorKey(row.actor)}:${row.sessionId}`,
        );
        telegramCheck(
          session?.view.prompt?.key === row.payload.promptKey,
          "telegram_prompt_changed",
          409,
        );
      }
    }
  }
  async drain(actor: ChatActor, limit = 20) {
    telegramCheck(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 50,
      "telegram_drain_limit_invalid",
    );
    let sent = 0;
    for (let i = 0; i < limit; i++) {
      const headKey = `outbox-head:${actorKey(actor)}`,
        head = this.grants.store.get<number>(headKey) ?? 1;
      const key = `outbox:${actorKey(actor)}:${String(head).padStart(16, "0")}`,
        stored = this.grants.store.get<TelegramOutbound>(key);
      if (!stored) {
        this.grants.store.delete(`outbox-ready:${actorKey(actor)}`);
        break;
      }
      const value = scrubTelegramVerdict(stored);
      if (value !== stored) this.grants.store.set(key, value);
      if (value.state === "sent" || value.state === "cancelled") {
        this.grants.store.set(headKey, head + 1);
        continue;
      }
      const item = { key, value };
      if (value.nextAt > this.grants.now()) break;
      let row = item.value;
      try {
        await this.permitted(row);
      } catch (error) {
        const status =
          error && typeof error === "object" && "status" in error
            ? Number(error.status)
            : 503;
        if ([403, 409, 410].includes(status)) {
          const current = this.grants.store.get<TelegramOutbound>(item.key)!;
          this.grants.store.set(item.key, { ...current, state: "cancelled" });
          continue;
        }
        break;
      }
      if (row.state === "sending" || row.state === "unknown") {
        const receipt = await this.delivery
          .recover?.(row.effectId)
          .catch(() => null);
        if (!receipt) {
          const current = this.grants.store.get<TelegramOutbound>(item.key)!;
          if (current.state === "sending" || current.state === "unknown")
            this.grants.store.set(item.key, { ...current, state: "unknown" });
          break;
        }
        this.finish(item.key, row, receipt);
        sent++;
        continue;
      }
      // A wake must exist before the call can return a blocking observation.
      if (this.publication) await this.publication.arm();
      else
        telegramCheck(
          !this.grants.store.get(
            `bot-publication-managed:${actor.communityId}`,
          ),
          "telegram_managed_publication_required",
          503,
        );
      const claimed = this.grants.store.transaction(() => {
        const current = this.grants.store.get<TelegramOutbound>(item.key)!;
        if (current.state !== "pending") return false;
        this.permittedLocal(current);
        row = {
          ...current,
          state: "sending",
          tries: current.tries + 1,
          blockCapture: this.grants.publicationCapture(current.actor),
        };
        this.grants.store.set(item.key, row);
        return true;
      });
      if (!claimed) break;
      try {
        const target =
          row.payload.kind === "pin"
            ? this.grants.store.get<number>(
                `delivered:${actorKey(actor)}:${row.payload.targetEffect}`,
              )
            : undefined;
        if (row.payload.kind === "pin")
          telegramCheck(target, "telegram_pin_target_pending", 409);
        this.finish(
          item.key,
          row,
          await this.delivery.send(
            row.actor,
            row.payload,
            target,
            row.effectId,
          ),
        );
        sent++;
      } catch (error) {
        const known =
          error instanceof TelegramDeliveryError &&
          error.outcome === "known_failed";
        this.grants.store.transaction(() => {
          if (error instanceof TelegramDeliveryError && error.blocked) {
            if (this.publication && row.blockCapture)
              this.publication.block(row.actor, row.effectId, row.blockCapture);
            else this.grants.block(row.actor);
          }
          const current = this.grants.store.get<TelegramOutbound>(item.key)!;
          this.grants.store.set(item.key, {
            ...current,
            state: known
              ? row.tries < 3 && !(error as TelegramDeliveryError).blocked
                ? "pending"
                : "cancelled"
              : "unknown",
            nextAt:
              this.grants.now() +
              (error instanceof TelegramDeliveryError
                ? Math.min(3600_000, error.retryAfterMs)
                : 1000),
          });
        });
        break;
      }
    }
    return sent;
  }
  private finish(
    key: string,
    row: TelegramOutbound,
    receipt: TelegramDelivery,
  ) {
    telegramCheck(
      Number.isSafeInteger(receipt.messageId) && receipt.messageId > 0,
      "telegram_delivery_receipt_invalid",
      503,
    );
    this.grants.store.transaction(() => {
      // Retention can scrub a payload while a delivery is in flight. Never
      // restore a stale captured private body when its receipt returns.
      const current = this.grants.store.get<TelegramOutbound>(key)!;
      this.grants.store.set(key, {
        ...current,
        state: "sent",
        messageId: receipt.messageId,
      });
      this.grants.store.set(
        `delivered:${actorKey(row.actor)}:${row.effectId}`,
        receipt.messageId,
      );
      if (row.payload.kind === "text" && row.payload.home)
        this.grants.store.set(
          `home-message:${actorKey(row.actor)}`,
          receipt.messageId,
        );
      if (row.payload.kind === "text")
        for (const button of row.payload.buttons?.flat() ?? [])
          if (button.data)
            this.grants.store.set(
              `button-message:${actorKey(row.actor)}:${button.data}`,
              receipt.messageId,
            );
      if (row.payload.kind === "text")
        this.grants.store.set(
          `button-current:${actorKey(row.actor)}:${receipt.messageId}`,
          row.payload.buttons
            ?.flat()
            .flatMap((button) => (button.data ? [button.data] : [])) ?? [],
        );
      if (
        (row.payload.kind === "text" || row.payload.kind === "voice") &&
        row.payload.promptKey
      )
        this.grants.store.set(
          `prompt-delivery:${actorKey(row.actor)}:${receipt.messageId}`,
          row.payload.promptKey,
        );
    });
  }
}
