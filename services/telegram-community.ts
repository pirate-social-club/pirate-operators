import type {
  BotRegistration,
  TelegramAccountPort,
} from "../packages/telegram/contracts.ts";
import type { TelegramBrokerPort } from "../packages/telegram/link-contracts.ts";
import type { TelegramDeliveryPort } from "../packages/telegram/messages.ts";
import type { TelegramPresentationPort } from "../packages/telegram/presentation.ts";
import type {
  TelegramCatalogPort,
  TelegramLinkedStudyPort,
} from "../packages/telegram/study-contracts.ts";
import type { StudyTranscriber } from "../packages/study/speech-transcriber.ts";
import { TelegramGrants } from "./telegram-grants.ts";
import { TelegramLinking } from "./telegram-linking.ts";
import { TelegramSqlJournal } from "./telegram-store.ts";
import { TelegramTrialLessons } from "./telegram-trial.ts";
import {
  TelegramTrialSpeech,
  type TelegramSpeechAdmission,
  type TelegramVoiceFiles,
} from "./telegram-speech.ts";
import { TelegramStudyService } from "./telegram-study.ts";
import { TelegramOutbox } from "./telegram-outbox.ts";
import { TelegramBotViews } from "./telegram-bot-view.ts";
import { TelegramBot } from "./telegram-bot.ts";
import {
  TelegramNotifications,
  telegramNoticePermitted,
  type TelegramNoticePort,
} from "./telegram-notifications.ts";
import {
  telegramCommunityRoutes,
  type TelegramWebPorts,
} from "./telegram-http.ts";
import { telegramTrialRetention } from "./telegram-retention.ts";
import { telegramLinkRetention } from "./telegram-link-retention.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";
import type { TelegramTrialGradingPort } from "../packages/telegram/grading.ts";
import { telegramRuntime } from "./telegram-runtime.ts";
import { TelegramManagedPublication } from "./telegram-managed-publication.ts";
import type { StudyOperatorPorts } from "./study-operator-client.ts";

/** Mountable source module. No exported Worker/deployment config, new managed
 * resource or live provider is created. Coordinator-owned mounts supply every
 * account, quota, source, ledger and provider port explicitly. */
export function telegramCommunity(options: {
  storage: Pick<DurableObjectStorage, "sql" | "transactionSync">;
  registration: BotRegistration;
  accounts: TelegramAccountPort;
  /** Existing signed operator target. Required even while activation is held. */
  publication: StudyOperatorPorts;
  web: Omit<TelegramWebPorts, "scope" | "origin">;
  origin: string;
  broker: TelegramBrokerPort;
  brokerClientId: string;
  webhookSecret: string;
  catalog: TelegramCatalogPort;
  createLinkedStudy(
    grants: TelegramGrants,
    publication: TelegramManagedPublication,
  ): TelegramLinkedStudyPort;
  speech: {
    admission: TelegramSpeechAdmission;
    keyGeneration: string;
    transcriber: StudyTranscriber;
  };
  trialLimits: { perUserDailySpeech: number; maxOpenLessons: number };
  files: TelegramVoiceFiles;
  delivery: TelegramDeliveryPort;
  notices: TelegramNoticePort;
  /** Durable earliest-deadline alarm/queue; must survive isolate termination. */
  scheduleWork(atMs: number): Promise<void>;
  presentation?: TelegramPresentationPort;
  trialGrading?: TelegramTrialGradingPort;
  now?: () => number;
}) {
  const journal = new TelegramSqlJournal(options.storage),
    scope = options.registration;
  const grants = new TelegramGrants(journal, options.accounts, options.now);
  const publication = TelegramManagedPublication.create({
    grants,
    registration: scope,
    ports: options.publication,
    scheduleWork: options.scheduleWork,
  });
  const linking = new TelegramLinking(
    grants,
    options.broker,
    options.brokerClientId,
    options.origin + "/telegram/connect/return",
  );
  const trial = new TelegramTrialLessons(
    grants,
    options.catalog,
    options.trialLimits,
    options.trialGrading,
  );
  let connected: TelegramLinkedStudyPort | undefined;
  const connectedStudy = async () => {
    await publication.ready();
    return (connected ??= options.createLinkedStudy(grants, publication));
  };
  const linked: TelegramLinkedStudyPort = {
    start: async (...args) => (await connectedStudy()).start(...args),
    get: async (...args) => (await connectedStudy()).get(...args),
    answer: async (...args) => (await connectedStudy()).answer(...args),
    recover: async (...args) => (await connectedStudy()).recover(...args),
    personal: async (...args) => (await connectedStudy()).personal(...args),
  };
  let study: TelegramStudyService;
  const speech = new TelegramTrialSpeech({
    store: journal,
    config: {
      communityId: scope.communityId,
      keyGeneration: options.speech.keyGeneration,
    },
    admission: options.speech.admission,
    transcriber: options.speech.transcriber,
    files: options.files,
    permit: (job) => study.permit(job as TelegramStudyWork),
    beforeSubmission: (job) => study.beforeSubmission(job as TelegramStudyWork),
    now: grants.now,
    grading: options.trialGrading,
  });
  study = new TelegramStudyService({
    grants,
    trial,
    speech,
    linked,
    files: options.files,
    catalog: options.catalog,
  });
  const outbox = new TelegramOutbox(
    grants,
    options.delivery,
    (actor, guard) =>
      telegramNoticePermitted(grants, options.notices, actor, guard),
    publication,
  );
  const views = new TelegramBotViews({
    linking,
    study,
    catalog: options.catalog,
    linked,
    origin: options.origin,
    presentation: options.presentation,
  });
  const bot = new TelegramBot({
    views,
    outbox,
    scope,
    webhookSecret: options.webhookSecret,
  });
  const notifications = new TelegramNotifications(
    views,
    outbox,
    options.notices,
  );
  const runtime = telegramRuntime(
    bot,
    options.scheduleWork,
    grants.now,
    publication,
  );
  return {
    ready: () => publication.ready(),
    transitions: publication,
    notifications: {
      async account(...args: Parameters<TelegramNotifications["account"]>) {
        await publication.ready();
        // A durable wake before enqueue also recovers a crash just after enqueue.
        await options.scheduleWork(grants.now() + 1000);
        const result = await notifications.account(...args);
        await runtime.wake();
        return result;
      },
      async reminder(...args: Parameters<TelegramNotifications["reminder"]>) {
        await publication.ready();
        await options.scheduleWork(grants.now() + 1000);
        await notifications.reminder(...args);
        await runtime.wake();
      },
    },
    webhook: runtime.webhook,
    routes: telegramCommunityRoutes(
      linking,
      {
        ...options.web,
        origin: options.origin,
        scope,
      },
      publication,
    ),
    tick: runtime.tick,
    retention: async () => {
      await publication.ready();
      return {
        trial: telegramTrialRetention(trial, scope.communityId),
        links: await telegramLinkRetention(journal, grants.now()),
      };
    },
  };
}
