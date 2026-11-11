import type { ChatActor, TelegramGrant } from "./contracts.ts";
import type { TelegramLessonView } from "./study-contracts.ts";
import type { TelegramSpeechJob } from "../../services/telegram-speech.ts";

export interface TelegramStudySession {
  actor: ChatActor;
  mode: "trial" | "linked";
  grant: TelegramGrant | null;
  view: TelegramLessonView;
}
export interface TelegramStudyWork extends TelegramSpeechJob {
  mode: "trial" | "linked";
  grant: TelegramGrant | null;
  songKey: string;
  expected: NonNullable<TelegramLessonView["prompt"]>;
  resultView: TelegramLessonView | null;
  rendered: boolean;
  voiceFingerprint: string;
}
