import type { StudyOperatorAuthority } from "../study/operator-auth.ts";
import type { TelegramStudyDenial } from "../study/telegram-publication.ts";
import type {
  BotRegistration,
  BotScope,
  ChatActor,
  TelegramGrant,
} from "./contracts.ts";

export interface TelegramGrantCapture {
  grant: TelegramGrant | null;
  revision: number;
}
export interface TelegramUnlinkRequest {
  operationId: string;
  expectedGrantId: string | null;
}
export interface TelegramTransition {
  schema: "pirate.telegram.publication-transition/1";
  id: string;
  requestHash: string;
  revision: number;
  target: StudyOperatorAuthority;
  kind: "unlink" | "block" | "scope" | "authority";
  scope: BotScope;
  accountId: string | null;
  captured: TelegramGrant | null;
  change: { from: BotRegistration; to: BotRegistration } | null;
  actor: ChatActor | null;
  complete: boolean;
  sealed: boolean;
  cursor: string | null;
  children: number;
  acknowledged: number;
  nextAt: number;
  attempts: number;
}
export interface TelegramDenialChild {
  denial: TelegramStudyDenial;
  hash: string;
  acknowledged: boolean;
}
