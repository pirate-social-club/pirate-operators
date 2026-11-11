import type { Hex } from "viem";
import { digest } from "../packages/protocol/index.ts";
import { type TelegramStudyDenial } from "../packages/study/telegram-publication.ts";
import {
  actorKey,
  sameScope,
  telegramCheck,
  validateScope,
  type BotRegistration,
  type BotScope,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import type {
  TelegramDenialChild,
  TelegramGrantCapture,
  TelegramTransition,
  TelegramUnlinkRequest,
} from "../packages/telegram/transitions.ts";
import {
  denyManagedStudyPublication,
  type StudyOperatorPorts,
} from "./study-operator-client.ts";
import type { TelegramGrants } from "./telegram-grants.ts";
import { telegramScan } from "./telegram-store.ts";
import {
  accountPending,
  appendDenial,
  childKey,
  saveTransition,
  transitionKey,
  transitionReady,
  validateTransition,
  validateDenialChild,
} from "./telegram-transition-store.ts";

const operationId = (value: string) => {
  telegramCheck(
    typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value),
    "telegram_operation_invalid",
  );
  return value;
};

/** Concrete signed lifecycle capability. It accepts the existing operator
 * signer/target, never an arbitrary before-unlink or denial callback. */
export class TelegramManagedPublication {
  readonly grants: TelegramGrants;
  private readonly registration: BotRegistration;
  private readonly ports: StudyOperatorPorts;
  private readonly schedule: (at: number) => Promise<void>;
  private constructor(
    grants: TelegramGrants,
    registration: BotRegistration,
    ports: StudyOperatorPorts,
    schedule: (at: number) => Promise<void>,
  ) {
    this.grants = grants;
    this.registration = registration;
    this.ports = { ...ports, authority: { ...ports.authority } };
    this.schedule = schedule;
  }
  static create(input: {
    grants: TelegramGrants;
    registration: BotRegistration;
    ports: StudyOperatorPorts;
    scheduleWork(at: number): Promise<void>;
  }) {
    telegramCheck(
      input.ports?.authority?.communityId === input.registration.communityId &&
        input.ports.binding &&
        input.ports.issuerKey &&
        typeof input.scheduleWork === "function",
      "telegram_managed_publication_required",
      503,
    );
    const pinned = input.grants.store.get<string>(
      `publication-target:${input.registration.communityId}`,
    );
    telegramCheck(
      !pinned || pinned === digest(input.ports.authority),
      "telegram_transition_target_changed",
      503,
    );
    return new TelegramManagedPublication(
      input.grants,
      { ...input.registration },
      input.ports,
      input.scheduleWork,
    );
  }
  async arm() {
    await this.schedule(this.grants.now() + 1000);
  }
  assertTarget(communityId: string, contract: string) {
    telegramCheck(
      communityId === this.ports.authority.communityId &&
        contract.toLowerCase() === this.ports.authority.contract.toLowerCase(),
      "telegram_transition_target_changed",
      503,
    );
  }
  private needsInitialization() {
    const actual = this.grants.store.get<BotRegistration>(
      `bot:${this.registration.communityId}`,
    );
    return (
      !actual ||
      !sameScope(actual, this.registration) ||
      actual.enabled !== this.registration.enabled ||
      !this.grants.store.get(
        `bot-publication-managed:${this.registration.communityId}`,
      ) ||
      !this.grants.store.get(
        `publication-target:${this.registration.communityId}`,
      ) ||
      !!this.grants.pendingPublicationScope(this.registration.communityId)
    );
  }
  pending() {
    return (
      this.needsInitialization() ||
      !!this.grants.pendingPublicationScope(this.registration.communityId) ||
      this.grants.store.entries(
        `publication-ready:${this.registration.communityId}:`,
        1,
      ).length > 0
    );
  }
  private base(
    scope: BotScope,
  ): Pick<TelegramStudyDenial, "schema" | "communityId"> {
    return {
      schema: "pirate.study.telegram-publication-denial/1",
      communityId: scope.communityId as Hex,
    };
  }
  private input(
    kind: TelegramTransition["kind"],
    scope: BotScope,
    id: string,
    request: unknown,
  ): TelegramTransition {
    validateScope(scope);
    telegramCheck(
      scope.communityId === this.ports.authority.communityId,
      "telegram_transition_target_changed",
      503,
    );
    return {
      schema: "pirate.telegram.publication-transition/1",
      id,
      requestHash: digest(request),
      revision: 0,
      target: { ...this.ports.authority },
      kind,
      scope: { ...scope },
      accountId: null,
      captured: null,
      change: null,
      actor: null,
      complete: false,
      sealed: true,
      cursor: null,
      children: 0,
      acknowledged: 0,
      nextAt: this.grants.now(),
      attempts: 0,
    };
  }
  private initialize() {
    const grants = this.grants,
      store = grants.store;
    return store.transaction(() => {
      const pin = `publication-target:${this.registration.communityId}`,
        target = digest(this.ports.authority);
      telegramCheck(
        !store.get(pin) || store.get(pin) === target,
        "telegram_transition_target_changed",
        503,
      );
      store.set(pin, target);
      // Adopt the already validated predecessor after restart, even when the
      // newly requested registration cannot yet become ready.
      const existing = grants.pendingPublicationScope(
        this.registration.communityId,
      );
      const staged = grants.stagePublicationScope(
        existing?.to ?? this.registration,
      );
      if (!staged.pending) return;
      const change = staged.pending,
        id = digest(["scope", change]);
      const input = { ...this.input("scope", change.to, id, change), change };
      const op = saveTransition(store, input, [
        {
          ...this.base(change.from),
          kind: "scope",
          botId: change.from.botId,
          generation: change.from.generation,
        },
      ]);
      telegramCheck(!op.complete, "telegram_transition_invalid", 503);
    });
  }
  async ready() {
    await this.recover();
    if (this.needsInitialization()) {
      await this.arm();
      this.initialize();
    }
    const actual = this.grants.store.get<BotRegistration>(
      `bot:${this.registration.communityId}`,
    );
    telegramCheck(
      this.grants.store.get(
        `publication-target:${this.registration.communityId}`,
      ) === digest(this.ports.authority) &&
        actual &&
        sameScope(actual, this.registration) &&
        actual.enabled === this.registration.enabled &&
        !this.grants.pendingPublicationScope(this.registration.communityId) &&
        !this.grants.store.entries(
          `publication-corrupt:${this.registration.communityId}:`,
          1,
        ).length,
      "telegram_publication_pending",
      503,
    );
  }
  async configure(next: BotRegistration) {
    validateScope(next);
    telegramCheck(
      sameScope(next, this.registration) &&
        next.enabled === this.registration.enabled,
      "telegram_publication_scope_changed",
      409,
    );
    await this.ready();
    return this.grants.store.get<BotRegistration>(`bot:${next.communityId}`)!;
  }
  private accountFence(op: TelegramTransition) {
    const store = this.grants.store,
      account = op.accountId!;
    const key = accountPending(op.scope.communityId, op.scope.botId, account);
    telegramCheck(!store.get(key), "telegram_publication_pending", 503);
    const senderKey = op.captured
      ? `publication-user:${actorKey({ ...op.scope, userId: op.captured.userId, chatId: op.captured.userId })}`
      : null;
    if (senderKey)
      telegramCheck(
        !store.get(senderKey) || store.get(senderKey) === op.id,
        "telegram_publication_pending",
        503,
      );
    if (op.captured)
      this.grants.retireCapturedPublicationGrant(op.scope, op.captured);
    else this.grants.retirePublicationGrant(op.scope, account, null);
    store.set(key, op.id);
    if (senderKey) store.set(senderKey, op.id);
  }
  private stageAccount(
    kind: "unlink" | "authority",
    scope: BotScope,
    accountId: string,
    request: TelegramUnlinkRequest,
  ) {
    const id = digest([
      kind,
      scope.communityId,
      scope.botId,
      accountId,
      operationId(request.operationId),
    ]);
    const input = this.input(kind, scope, id, {
      kind,
      communityId: scope.communityId,
      botId: scope.botId,
      accountId,
      ...request,
    });
    return this.grants.store.transaction(() => {
      const store = this.grants.store,
        previous = store.get<TelegramTransition>(transitionKey(id));
      if (previous) {
        telegramCheck(
          previous.requestHash === input.requestHash,
          "telegram_transition_conflict",
          409,
        );
        return previous;
      }
      const captured = this.grants.forAccount(scope, accountId);
      telegramCheck(
        (captured?.id ?? null) === request.expectedGrantId,
        "telegram_unlink_predecessor_changed",
        409,
      );
      const op = { ...input, accountId, captured, sealed: kind === "unlink" };
      this.accountFence(op);
      const result = saveTransition(
        store,
        op,
        captured
          ? [
              {
                ...this.base(scope),
                kind: "grant",
                botId: captured.botId,
                grantId: captured.id,
              },
            ]
          : [],
      );
      store.set(
        `publication-unlink:${scope.communityId}:${scope.botId}:${accountId}`,
        { ...request, transitionId: id, kind },
      );
      return result;
    });
  }
  unlinkStatus(scope: BotScope, accountId: string) {
    const status = this.grants.store.get<
      TelegramUnlinkRequest & { transitionId: string; kind: string }
    >(`publication-unlink:${scope.communityId}:${scope.botId}:${accountId}`);
    if (!status || status.kind !== "unlink") return null;
    const op = this.grants.store.get<TelegramTransition>(
      transitionKey(status.transitionId),
    );
    telegramCheck(op, "telegram_transition_invalid", 503);
    return {
      operationId: status.operationId,
      expectedGrantId: status.expectedGrantId,
      complete: op.complete,
    };
  }
  async unlink(
    scope: BotScope,
    accountId: string,
    request: TelegramUnlinkRequest,
  ) {
    await this.arm();
    const op = this.stageAccount("unlink", scope, accountId, request);
    await this.progress(op.id, 1);
    const current = this.grants.store.get<TelegramTransition>(
      transitionKey(op.id),
    )!;
    telegramCheck(current.complete, "telegram_publication_pending", 503);
    return { unlinked: current.captured !== null };
  }
  /** Called in the delivery-error transaction; arm() precedes the actual send. */
  block(actor: ChatActor, effectId: string, capture: TelegramGrantCapture) {
    const store = this.grants.store;
    return store.transaction(() => {
      const registration = store.get<BotRegistration>(
          `bot:${actor.communityId}`,
        ),
        current = this.grants.publicationCapture(actor);
      if (
        !registration ||
        !sameScope(registration, actor) ||
        current.revision !== capture.revision ||
        (current.grant?.id ?? null) !== (capture.grant?.id ?? null)
      )
        return;
      const binding = store.get<{ blocked: boolean }>(
        `chat:${actorKey(actor)}`,
      );
      const grant = capture.grant?.revokedAt === null ? capture.grant : null;
      if (!grant) {
        if (binding)
          store.set(`chat:${actorKey(actor)}`, { ...binding, blocked: true });
        return;
      }
      const id = digest(["block", actor, effectId, capture.revision, grant.id]);
      if (store.get(transitionKey(id))) return;
      const op = {
        ...this.input("block", actor, id, { actor, effectId, capture }),
        captured: grant,
        accountId: grant.accountId,
        actor,
      };
      this.accountFence(op);
      if (binding)
        store.set(`chat:${actorKey(actor)}`, { ...binding, blocked: true });
      saveTransition(store, op, [
        {
          ...this.base(actor),
          kind: "grant",
          botId: grant.botId,
          grantId: grant.id,
        },
      ]);
    });
  }
  /** Internal port for an admitted shared writer. It owns epoch capture and
   * complete indexed discovery; no account administration API is introduced. */
  async beginAuthorityTransition(
    scope: BotScope,
    accountId: string,
    request: TelegramUnlinkRequest,
  ) {
    await this.arm();
    return this.stageAccount("authority", scope, accountId, request).id;
  }
  appendAuthorizations(
    id: string,
    page: {
      cursor: string | null;
      next: string | null;
      authorizationIds: Hex[];
      exhausted: boolean;
    },
  ) {
    telegramCheck(
      page.authorizationIds.length <= 50 &&
        typeof page.exhausted === "boolean" &&
        (page.exhausted ||
          (typeof page.next === "string" && page.next > (page.cursor ?? ""))),
      "telegram_transition_page_invalid",
    );
    return this.grants.store.transaction(() => {
      const store = this.grants.store,
        op = validateTransition(
          store.get<TelegramTransition>(transitionKey(id))!,
        );
      const key = `publication-page:${id}:${digest(page.cursor)}`,
        hash = digest(page),
        prior = store.get<string>(key);
      if (prior) {
        telegramCheck(prior === hash, "telegram_transition_conflict", 409);
        return;
      }
      telegramCheck(
        op.kind === "authority" &&
          !op.sealed &&
          !op.complete &&
          op.cursor === page.cursor,
        "telegram_transition_conflict",
        409,
      );
      for (const authorizationId of page.authorizationIds)
        appendDenial(store, op, {
          ...this.base(op.scope),
          kind: "authorization",
          authorizationId,
        });
      op.cursor = page.next;
      op.sealed = page.exhausted;
      store.set(key, hash);
      store.set(transitionKey(id), op);
    });
  }
  async finishAuthorityTransition(id: string) {
    await this.arm();
    telegramCheck(
      this.grants.store.get<TelegramTransition>(transitionKey(id))?.kind ===
        "authority",
      "telegram_transition_conflict",
      409,
    );
    await this.progress(id, 10);
    telegramCheck(
      this.grants.store.get<TelegramTransition>(transitionKey(id))?.complete,
      "telegram_publication_pending",
      503,
    );
  }
  async recover(limit = 20) {
    telegramCheck(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 50,
      "telegram_transition_limit_invalid",
    );
    if (this.needsInitialization()) {
      await this.arm();
      try {
        this.initialize();
      } catch {
        /* Ordinary readiness reports the initialization failure after recovery. */
      }
    }
    for (const row of telegramScan<string>(
      this.grants.store,
      `publication-ready:${this.registration.communityId}:`,
      limit,
    )) {
      const held = `publication-corrupt:${this.registration.communityId}:${row.value}`;
      try {
        await this.progress(row.value, 1);
        if (
          this.grants.store.get<TelegramTransition>(transitionKey(row.value))
            ?.complete
        )
          this.grants.store.delete(held);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          /telegram_transition_(invalid|conflict|target_changed)/.test(
            error.message,
          )
        )
          this.grants.store.set(held, true);
      }
    }
    if (this.pending()) await this.arm();
  }
  private async progress(id: string, budget: number) {
    const store = this.grants.store;
    let op = validateTransition(
      store.get<TelegramTransition>(transitionKey(id))!,
    );
    if (op.complete || op.nextAt > this.grants.now()) return;
    await this.arm();
    try {
      telegramCheck(
        digest(op.target) === digest(this.ports.authority),
        "telegram_transition_target_changed",
        503,
      );
      for (let n = 0; n < budget && op.acknowledged < op.children; n++) {
        const index = op.acknowledged,
          key = childKey(id, index),
          child = validateDenialChild(store.get<TelegramDenialChild>(key));
        const receipt = await denyManagedStudyPublication(
          this.ports,
          child.denial,
        );
        store.transaction(() => {
          const current = validateTransition(
            store.get<TelegramTransition>(transitionKey(id))!,
          );
          telegramCheck(
            current.revision === op.revision,
            "telegram_transition_conflict",
            409,
          );
          if (current.complete || current.acknowledged !== index) return;
          telegramCheck(
            receipt.recorded === true && receipt.denialHash === child.hash,
            "telegram_transition_invalid",
            503,
          );
          store.set(key, { ...child, acknowledged: true });
          store.set(transitionKey(id), {
            ...current,
            acknowledged: index + 1,
            attempts: 0,
            nextAt: this.grants.now(),
          });
        });
        op = validateTransition(
          store.get<TelegramTransition>(transitionKey(id))!,
        );
      }
      store.transaction(() => {
        const current = validateTransition(
          store.get<TelegramTransition>(transitionKey(id))!,
        );
        if (
          current.complete ||
          !current.sealed ||
          current.children !== current.acknowledged
        )
          return;
        telegramCheck(
          current.revision === op.revision,
          "telegram_transition_conflict",
          409,
        );
        if (current.change) this.grants.finishPublicationScope(current.change);
        if (current.accountId) {
          const key = accountPending(
            current.scope.communityId,
            current.scope.botId,
            current.accountId,
          );
          telegramCheck(
            store.get(key) === id,
            "telegram_transition_conflict",
            409,
          );
          store.delete(key);
        }
        if (current.captured) {
          const key = `publication-user:${actorKey({ ...current.scope, userId: current.captured.userId, chatId: current.captured.userId })}`;
          telegramCheck(
            store.get(key) === id,
            "telegram_transition_conflict",
            409,
          );
          store.delete(key);
        }
        store.set(transitionKey(id), { ...current, complete: true });
        store.delete(transitionReady(current));
      });
    } catch (error) {
      store.transaction(() => {
        const current = store.get<TelegramTransition>(transitionKey(id));
        if (current && !current.complete)
          store.set(transitionKey(id), {
            ...current,
            attempts: current.attempts + 1,
            nextAt:
              this.grants.now() +
              Math.min(60_000, 1000 * 2 ** Math.min(current.attempts, 6)),
          });
      });
      throw error;
    }
  }
}
