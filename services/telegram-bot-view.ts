import { digest } from "../packages/protocol/index.ts";
import {
  TELEGRAM_HISTORY_MS,
  actorKey,
  sameActor,
  telegramCheck,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import type {
  TelegramButton,
  TelegramNativeMessage,
} from "../packages/telegram/messages.ts";
import {
  nativeTelegramPresentation,
  publicOfferText,
  type TelegramPresentationPort,
} from "../packages/telegram/presentation.ts";
import type {
  TelegramCatalogPort,
  TelegramLessonView,
  TelegramLinkedStudyPort,
} from "../packages/telegram/study-contracts.ts";
import { httpsOrigin, randomToken } from "../packages/telegram/security.ts";
import type { TelegramLinking } from "./telegram-linking.ts";
import type { TelegramStudyService } from "./telegram-study.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";

export type TelegramAction =
  | { kind: "song"; key: string }
  | { kind: "songs"; page: number }
  | { kind: "resume" }
  | {
      kind: "preferences";
      key: "reminders" | "rewards" | "dance";
      value?: boolean;
    };
interface ActionRecord {
  actor: ChatActor;
  action: TelegramAction;
  expiresAt: number;
}
export class TelegramBotViews {
  readonly linking: TelegramLinking;
  readonly study: TelegramStudyService;
  readonly catalog: TelegramCatalogPort;
  readonly linked: TelegramLinkedStudyPort;
  readonly origin: string;
  readonly presentation: TelegramPresentationPort;
  constructor(options: {
    linking: TelegramLinking;
    study: TelegramStudyService;
    catalog: TelegramCatalogPort;
    linked: TelegramLinkedStudyPort;
    origin: string;
    presentation?: TelegramPresentationPort;
  }) {
    this.linking = options.linking;
    this.study = options.study;
    this.catalog = options.catalog;
    this.linked = options.linked;
    this.origin = httpsOrigin(options.origin);
    this.presentation = options.presentation ?? nativeTelegramPresentation;
  }
  button(
    actor: ChatActor,
    text: string,
    action: TelegramAction,
  ): TelegramButton {
    const token = randomToken();
    this.linking.grants.store.set(`action:${actorKey(actor)}:${token}`, {
      actor,
      action,
      expiresAt: this.linking.grants.now() + TELEGRAM_HISTORY_MS,
    } satisfies ActionRecord);
    return { text, data: token };
  }
  action(actor: ChatActor, token: string, messageId: number) {
    this.linking.grants.binding(actor);
    const record = this.linking.grants.store.get<ActionRecord>(
      `action:${actorKey(actor)}:${token}`,
    );
    telegramCheck(
      record &&
        sameActor(record.actor, actor) &&
        record.expiresAt > this.linking.grants.now() &&
        this.linking.grants.store.get<number>(
          `button-message:${actorKey(actor)}:${token}`,
        ) === messageId &&
        this.linking.grants.store
          .get<string[]>(`button-current:${actorKey(actor)}:${messageId}`)
          ?.includes(token),
      "telegram_button_stale",
      409,
    );
    return record.action;
  }
  async accountButton(actor: ChatActor): Promise<TelegramButton> {
    const grant = this.linking.grants.read(actor);
    if (grant?.revokedAt === null)
      return { text: "Account", url: `${this.origin}/#settings/telegram` };
    const reference = await this.linking.pending(actor);
    return {
      text: "Connect account",
      url: `${this.origin}/telegram/connect?reference=${reference}`,
    };
  }
  async home(actor: ChatActor, page = 0): Promise<TelegramNativeMessage> {
    const remembered = this.linking.grants.read(actor),
      grant =
        remembered?.revokedAt === null
          ? await this.linking.grants.assert(actor, remembered.id)
          : null;
    const result = await this.catalog.list(actor, grant);
    telegramCheck(
      result.songs.every((song) => song.song.communityId === actor.communityId),
      "telegram_wrong_community",
      403,
    );
    const sorted = [...result.songs].sort(
      (a, b) => Number((b.streak ?? 0) > 0) - Number((a.streak ?? 0) > 0),
    );
    telegramCheck(
      Number.isSafeInteger(page) &&
        page >= 0 &&
        page <= Math.ceil(sorted.length / 12),
      "telegram_page_invalid",
    );
    const songs = sorted.slice(page * 12, page * 12 + 12),
      buttons = [
        [await this.accountButton(actor)],
        ...songs.map((song) => [
          this.button(actor, song.title.slice(0, 100), {
            kind: "song",
            key: song.key,
          }),
        ]),
      ];
    if (page > 0)
      buttons.push([
        this.button(actor, "Previous songs", { kind: "songs", page: page - 1 }),
      ]);
    if ((page + 1) * 12 < sorted.length)
      buttons.push([
        this.button(actor, "More songs", { kind: "songs", page: page + 1 }),
      ]);
    const message = this.presentation.home(
      {
        songs,
        drawAt: result.drawAt,
        connected: !!grant,
        readAt: this.linking.grants.now(),
      },
      buttons,
    );
    if (message.kind === "text") {
      const existing = this.linking.grants.store.get<number>(
        `home-message:${actorKey(actor)}`,
      );
      return { ...message, ...(existing ? { editMessageId: existing } : {}) };
    }
    return message;
  }
  async prompt(view: TelegramLessonView): Promise<TelegramNativeMessage[]> {
    if (!view.prompt) return [];
    const audio = await this.catalog
      .referenceAudio(view.prompt.line)
      .catch(() => null);
    return [
      this.presentation.prompt(view),
      ...(audio
        ? [{ kind: "voice" as const, audio, promptKey: view.prompt.key }]
        : []),
    ];
  }
  async selected(actor: ChatActor) {
    const key = this.linking.grants.store.get<string>(
      `active-song:${actorKey(actor)}`,
    );
    telegramCheck(key, "telegram_choose_song", 409);
    const remembered = this.linking.grants.read(actor),
      grant =
        remembered?.revokedAt === null
          ? await this.linking.grants.assert(actor, remembered.id)
          : null;
    return { song: await this.catalog.song(actor, key, grant), grant };
  }
  settings(actor: ChatActor): TelegramNativeMessage {
    const prefs = this.linking.grants.preferences(actor);
    return {
      kind: "text",
      text: "Notifications",
      buttons: (Object.keys(prefs) as (keyof typeof prefs)[]).map((key) => [
        this.button(
          actor,
          `${key[0].toUpperCase() + key.slice(1)}: ${prefs[key] ? "on" : "off"}`,
          { kind: "preferences", key, value: !prefs[key] },
        ),
      ]),
    };
  }
  async outcome(job: TelegramStudyWork): Promise<TelegramNativeMessage[]> {
    const view = job.resultView!;
    if (!job.grade)
      return [
        {
          kind: "text",
          text: "Speech is unavailable. Your progress is saved. Try this line again.",
        },
        ...(await this.prompt(view)),
      ];
    if (
      (job.grade as typeof job.grade & { rerecordReason?: string })
        .rerecordReason
    )
      return [
        {
          kind: "text",
          text: "I didn't catch that recording. Send another voice message to try again.",
        },
        ...(await this.prompt(view)),
      ];
    const messages = [
      this.presentation.verdict(job.grade.correct, job.grade.heardTranscript),
    ];
    if (view.status === "active")
      return [...messages, ...(await this.prompt(view))];
    let facts: {
      streak: number | null;
      participation: "entered" | "pending" | "none" | "unavailable";
    } = { streak: null, participation: "none" };
    if (job.grant) {
      const grant = await this.linking.grants.assert(job.actor, job.grant.id);
      const song = await this.catalog.song(job.actor, job.songKey, grant);
      facts = await this.linked
        .personal(job.actor, grant, song)
        .catch(() => ({ streak: null, participation: "unavailable" as const }));
    }
    const buttons =
      view.mode === "trial"
        ? [[await this.accountButton(job.actor)]]
        : [[this.button(job.actor, "Songs", { kind: "songs", page: 0 })]];
    return [...messages, this.presentation.result(view, facts, buttons)];
  }
  async rewards(actor: ChatActor): Promise<TelegramNativeMessage> {
    const { song, grant } = await this.selected(actor);
    let text = `${song.title}\n\n${publicOfferText(song.offers, this.linking.grants.now())}`;
    if (grant) {
      const personal = await this.linked
        .personal(actor, grant, song)
        .catch(() => null);
      text += personal
        ? `\n\nYour participation: ${personal.participation}.${personal.claimable ? " A claim is available on the website." : ""}`
        : "\n\nYour reward status is unavailable.";
    } else text += "\n\nTrial lessons do not earn rewards.";
    return {
      kind: "text",
      text,
      buttons: [
        [
          {
            text: "Continue on website",
            url: `${this.origin}/#song-${song.song.postId}`,
          },
        ],
      ],
    };
  }
  async history(actor: ChatActor): Promise<TelegramNativeMessage> {
    const session = this.study.session(actor);
    if (session.mode === "linked")
      return {
        kind: "text",
        text: "Download private lesson history from Learning settings.",
        buttons: [
          [
            {
              text: "Continue on website",
              url: `${this.origin}/#settings/learning`,
            },
          ],
        ],
      };
    const history = this.study.options.trial.history(actor, session.view.id);
    return {
      kind: "document",
      lessonId: session.view.id,
      filename: "private-lesson-history.json",
      content: JSON.stringify(history, null, 2),
      expiresAt:
        history.lesson.completedAt === null
          ? this.linking.grants.now() + 300_000
          : history.lesson.completedAt + TELEGRAM_HISTORY_MS,
    };
  }
}
