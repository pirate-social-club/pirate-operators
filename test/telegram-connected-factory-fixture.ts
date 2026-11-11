import assert from "node:assert/strict";
import { accountSession } from "../packages/community/accounts.ts";
import { AUTHORITY_LEDGER_SCHEMA } from "../packages/community-setup/authority-schema.ts";
import {
  TelegramError,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import type { TelegramNativeMessage } from "../packages/telegram/messages.ts";
import {
  telegramConnectedCommunity,
  type TelegramConnectedCommunityOptions,
} from "../services/telegram-connected-community.ts";
import { telegramPublishedCatalog } from "../services/telegram-catalog.ts";
import { CommunitySpeechAdmission } from "../services/study-speech-admission.ts";
import { studyCommunityFixture } from "./study-community-fixture.ts";
import { journalFixture } from "./telegram-fixture.ts";
import { boundaryError } from "./telegram-factory-boundary.ts";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const connectedVoice = new Uint8Array([
  79, 103, 103, 83, 0, 0, 0, 0, 0, 0, 0, 1,
]);

/** Integration-only fixture: actual login/relay, shared SQL authority, signed
 * operator routes, frozen Study and native bot handlers. Only transport/media,
 * reachability and optional personal projections are test providers. The alarm
 * emulator here is NOT native-DO evidence; the separate Worker test supplies it.
 * Requires the exact held shared core and protected proposals before running. */
export async function connectedFactoryFixture(port: number) {
  const shared = await studyCommunityFixture(port, {
    v4: true,
    linkedOperator: true,
  });
  const journal = journalFixture(),
    admissionJournal = journalFixture();
  try {
    // Keep trigger bodies intact; D1 prepare accepts one full statement.
    // This is fixture-only application of the exact shared migration proposal.
    let statement = "";
    for (const line of AUTHORITY_LEDGER_SCHEMA.split("\n")) {
      statement += line + "\n";
      const trigger = /^\s*CREATE TRIGGER\b/.test(statement);
      if (trigger ? /END;\s*$/.test(line) : /;\s*$/.test(line)) {
        await shared.db.prepare(statement).run();
        statement = "";
      }
    }
    assert.equal(statement.trim(), "");
    const auth = await shared.login();
    await shared.recordSignIns();
    const origin = shared.config.app.origin;
    // Use the same controlled clock as the actual HTTP challenge and verify.
    const session = await accountSession(
      new Request(origin + "/api/telegram/connection", { headers: auth }),
      shared.db,
      { communityId: shared.config.communityId, origin },
      shared.clock(),
    );
    const actor: ChatActor = {
      communityId: shared.config.communityId,
      botId: "90001",
      generation: 1,
      userId: "70001",
      chatId: "70001",
    };
    const admission = new CommunitySpeechAdmission(
      admissionJournal.storage,
      {
        communityId: actor.communityId,
        keyGeneration: "fixture_generation",
        dailyUnits: 30,
        websiteStudyReservedUnits: 10,
        telegramTrialUnits: 10,
      },
      shared.clock,
    );
    let enabled = true,
      alarm: number | null = null,
      sequence = 100,
      update = 1,
      privateText = "";
    let guardUnavailable = false;
    let afterGuardRead: (() => Promise<void>) | undefined;
    let guardReadCount = 0;
    const assertPrivateBoundary = (value: unknown) => {
      assert.ok(
        !privateText || !(JSON.stringify(value) ?? "").includes(privateText),
        "private transcript reached a persistence boundary",
      );
    };
    const operatorSet = shared.store.set.bind(shared.store);
    shared.store.set = (key, value) => {
      assertPrivateBoundary(value);
      operatorSet(key, value);
    };
    const privateDb = new Proxy(shared.db, {
      get(db, key) {
        if (key === "prepare")
          return (sql: string) => {
            const prepared = db.prepare(sql);
            const wrap = (
              statement: D1PreparedStatement,
            ): D1PreparedStatement =>
              new Proxy(statement, {
                get(target, field) {
                  if (field === "bind")
                    return (...args: unknown[]) => {
                      assertPrivateBoundary(args);
                      return wrap(target.bind(...args));
                    };
                  if (
                    field === "first" &&
                    /FROM learning_authority_operations WHERE transition_id=\?/.test(
                      sql,
                    )
                  )
                    return async (
                      ...args: Parameters<D1PreparedStatement["first"]>
                    ) => {
                      guardReadCount++;
                      if (guardUnavailable)
                        throw Error("fixture_guard_database_unavailable");
                      const value = await target.first(...args);
                      await afterGuardRead?.();
                      return value;
                    };
                  const value = Reflect.get(target, field);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                },
              });
            return wrap(prepared);
          };
        const value = Reflect.get(db, key);
        return typeof value === "function" ? value.bind(db) : value;
      },
    });
    let tail: Promise<unknown> = Promise.resolve();
    const alarmMethods = {
      getAlarm: async () => alarm,
      setAlarm: async (value: number | Date) => {
        alarm = Number(value);
      },
    };
    const storage = {
      ...journal.storage,
      ...alarmMethods,
      transaction<T>(
        closure: (
          transaction: Pick<DurableObjectTransaction, "getAlarm" | "setAlarm">,
        ) => Promise<T>,
      ) {
        const work = tail.then(() => closure(alarmMethods));
        tail = work.catch(() => {});
        return work;
      },
    } as unknown as TelegramConnectedCommunityOptions["storage"];
    const sent: {
      message: TelegramNativeMessage;
      messageId: number;
      effectId?: string;
    }[] = [];
    const receipts = new Map<string, { messageId: number }>();
    const baseBinding = shared.env.KARAOKE_OPERATOR!;
    const operatorResponses: { path: string; status: number; code?: string }[] =
      [];
    let pausePath: string | null = null;
    let paused = deferred(),
      release = deferred();
    let denialOffline = false;
    const binding = {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = new Request(input, init),
          path = new URL(request.url).pathname;
        if (denialOffline && path === "/study/telegram/deny")
          throw Error("fixture_denial_offline");
        const response = await baseBinding.fetch(request);
        const observation: (typeof operatorResponses)[number] = {
          path,
          status: response.status,
        };
        if (!response.ok) {
          const body: unknown = await response
            .clone()
            .json()
            .catch(() => null);
          if (
            body &&
            typeof body === "object" &&
            "error" in body &&
            typeof body.error === "string"
          )
            observation.code = boundaryError(new Error(body.error));
        }
        operatorResponses.push(observation);
        if (pausePath && path.startsWith(pausePath)) {
          pausePath = null;
          paused.resolve();
          await release.promise;
        }
        return response;
      },
    } as Fetcher;
    const options: TelegramConnectedCommunityOptions = {
      storage,
      db: privateDb,
      origin,
      study: {
        config: shared.config,
        env: { ...shared.env, KARAOKE_OPERATOR: binding },
        reads: shared.ports.publicReads!,
      },
      registration: { ...actor, enabled: true },
      now: shared.clock,
      async assertAccountEnabled(accountId) {
        if (!enabled || accountId !== session.account_id)
          throw new TelegramError("account_disabled", 403);
      },
      broker: {
        async request() {
          throw Error("fixture_browser_provider_not_selected");
        },
        async redeem() {
          throw Error("fixture_browser_provider_not_selected");
        },
      },
      brokerClientId: "fixture_community_client",
      webhookSecret: "fixture_webhook_secret_123456789",
      catalog: telegramPublishedCatalog({
        db: shared.db,
        config: shared.config,
        reads: shared.ports.publicReads!,
        origin,
        now: shared.clock,
        publicOffers: async () => ({ state: "unavailable" }),
        nextDrawAt: async () => null,
        songProgress: async () => {
          throw Error("fixture_personal_projection_unavailable");
        },
        referenceAudio: async () => null,
      }),
      personal: async () => {
        throw Error("fixture_personal_projection_unavailable");
      },
      notices: {
        async read() {
          throw Error("fixture_notice_projection_unavailable");
        },
      },
      speech: {
        admission,
        keyGeneration: "fixture_generation",
        transcriber: {
          providerRetention: "stored",
          async transcribe() {
            throw Error("fixture_unexpected_trial_speech");
          },
        },
      },
      trialLimits: { perUserDailySpeech: 5, maxOpenLessons: 2 },
      files: {
        async read() {
          return new Request(origin + "/fixture/audio", {
            method: "PUT",
            headers: {
              "content-type": "audio/ogg",
              "x-study-duration-ms": "4000",
            },
            body: connectedVoice,
          });
        },
      },
      delivery: {
        async send(_actor, message, target, effectId) {
          const messageId =
            message.kind === "pin"
              ? target!
              : message.kind === "text" && message.editMessageId
                ? message.editMessageId
                : ++sequence;
          sent.push({ message: structuredClone(message), messageId, effectId });
          if (effectId) receipts.set(effectId, { messageId });
          return { messageId };
        },
        recover: async (effectId) => receipts.get(effectId) ?? null,
      },
    };
    let factory = telegramConnectedCommunity(options);
    const mountAuthority = () => {
      // Existing operator binding, transported to the ACTUAL production handler.
      shared.operatorEnv.STUDY_TELEGRAM_AUTHORITY = {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          factory.publicationAuthority(new Request(input, init)),
      } as Fetcher;
    };
    mountAuthority();
    await factory.ready();
    const grants = factory.transitions.grants;
    grants.start(actor);
    const identity = await grants.accounts.current(
      actor.communityId,
      session.account_id,
      session.wallet,
    );
    // Trusted identity-verification boundary only: the cryptographic browser
    // broker is independently qualified. All grant/fence checks here are real.
    const grant = grants.commit(
      actor,
      identity,
      "fixture_verified_grant_0001",
      grants.linkFence(actor, identity.accountId),
    );
    async function webhook(value: unknown) {
      return factory.webhook(
        new Request(origin + "/api/telegram/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": options.webhookSecret,
          },
          body: JSON.stringify(value),
        }),
      );
    }
    async function home() {
      const id = update++;
      assert.equal(
        (
          await webhook({
            update_id: id,
            message: {
              message_id: 1000 + id,
              chat: { id: Number(actor.userId), type: "private" },
              from: { id: Number(actor.userId) },
              text: "/start",
            },
          })
        ).status,
        200,
      );
      await factory.alarm();
      const item = sent.findLast(
        ({ message }) => message.kind === "text" && message.home,
      );
      assert.ok(item && item.message.kind === "text");
      return item;
    }
    async function choose() {
      const item = await home();
      assert.ok(item.message.kind === "text");
      const token = item.message.buttons
        ?.flat()
        .find((button) => button.data)?.data;
      assert.ok(token);
      const id = update++;
      return webhook({
        update_id: id,
        callback_query: {
          id: "fixture_callback_" + id,
          from: { id: Number(actor.userId) },
          data: token,
          message: {
            message_id: item.messageId,
            from: { id: Number(actor.botId), is_bot: true },
            chat: { id: Number(actor.userId), type: "private" },
          },
        },
      });
    }
    async function voice() {
      const item = sent.findLast(
        ({ message }) =>
          (message.kind === "text" || message.kind === "voice") &&
          message.promptKey,
      );
      assert.ok(item);
      const id = update++;
      return webhook({
        update_id: id,
        message: {
          message_id: 1000 + id,
          chat: { id: Number(actor.userId), type: "private" },
          from: { id: Number(actor.userId) },
          reply_to_message: {
            message_id: item.messageId,
            from: { id: Number(actor.botId), is_bot: true },
          },
          voice: {
            file_id: "fixture_voice_" + id,
            file_unique_id: "fixture_unique_" + id,
            duration: 4,
            file_size: connectedVoice.length,
            mime_type: "audio/ogg",
          },
        },
      });
    }
    return {
      shared,
      options,
      auth,
      session,
      actor,
      grant,
      journal,
      sent,
      operatorResponses,
      home,
      choose,
      voice,
      webhook,
      get factory() {
        return factory;
      },
      get alarm() {
        return alarm;
      },
      restart(generation = actor.generation) {
        factory = telegramConnectedCommunity({
          ...options,
          registration: { ...options.registration, generation },
        });
        mountAuthority();
      },
      pause(path: string) {
        pausePath = path;
        paused = deferred();
        release = deferred();
        return { entered: paused.promise, release: () => release.resolve() };
      },
      denialOffline(value: boolean) {
        denialOffline = value;
      },
      accountEnabled(value: boolean) {
        enabled = value;
      },
      forbidPersistedText(value: string) {
        privateText = value;
      },
      guardUnavailable(value: boolean) {
        guardUnavailable = value;
      },
      afterGuardRead(value?: () => Promise<void>) {
        afterGuardRead = value;
      },
      guardReads() {
        return guardReadCount;
      },
      async dispose() {
        journal.close();
        admissionJournal.close();
        await shared.dispose();
      },
    };
  } catch (error) {
    journal.close();
    admissionJournal.close();
    await shared.dispose();
    throw error;
  }
}
