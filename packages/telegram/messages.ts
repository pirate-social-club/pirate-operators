import type { ChatActor } from "./contracts.ts";
import type { TelegramPublicAudio } from "./study-contracts.ts";

export interface TelegramButton {
  text: string;
  data?: string;
  url?: string;
}
export type TelegramNativeMessage =
  | { kind: "start-required" }
  | {
      kind: "text";
      text: string;
      buttons?: TelegramButton[][];
      forceReply?: boolean;
      home?: boolean;
      editMessageId?: number;
      promptKey?: string;
    }
  | { kind: "voice"; audio: TelegramPublicAudio; promptKey?: string }
  | { kind: "song"; audio: TelegramPublicAudio; title: string }
  | {
      kind: "document";
      filename: string;
      content: string;
      expiresAt: number;
      lessonId?: string;
    }
  | { kind: "pin"; targetEffect: string };
export interface TelegramDelivery {
  messageId: number;
}
export class TelegramDeliveryError extends Error {
  readonly outcome: "known_failed" | "unknown";
  readonly retryAfterMs: number;
  readonly blocked: boolean;
  constructor(
    code: string,
    outcome: "known_failed" | "unknown",
    retryAfterMs = 1000,
    blocked = false,
  ) {
    super(code);
    this.outcome = outcome;
    this.retryAfterMs = retryAfterMs;
    this.blocked = blocked;
  }
}
export interface TelegramDeliveryPort {
  send(
    actor: ChatActor,
    message: TelegramNativeMessage,
    targetMessageId?: number,
    effectId?: string,
  ): Promise<TelegramDelivery>;
  /** A status lookup or retained response only; Telegram sendMessage has no
   * general idempotency key. Unknown sends must not be blindly repeated. */
  recover?(effectId: string): Promise<TelegramDelivery | null>;
}
