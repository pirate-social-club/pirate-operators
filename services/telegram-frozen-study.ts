import { digest } from "../packages/protocol/index.ts";
import {
  telegramStudyFacts,
  type TelegramStudyFence,
} from "../packages/study/telegram-publication.ts";
import { telegramCheck } from "../packages/telegram/contracts.ts";
import { liveStudy, type StudyCommunityPorts } from "./study-community.ts";
import type { TelegramPublicationFence } from "./telegram-linked-study.ts";

/** Source composition only. The coordinator supplies the private DB and
 * real trusted authority. This function provides no connected capability
 * marker: all ordered invalidation and runtime gates still apply. */
export function frozenTelegramStudy(
  ports: Omit<StudyCommunityPorts, "db">,
  session: { account_id: string; wallet: string },
  channel: "telegram-linked",
  context: TelegramPublicationFence,
  db: D1Database,
) {
  telegramCheck(
    channel === "telegram-linked",
    "telegram_linked_channel_required",
    503,
  );
  const facts = telegramStudyFacts({
    schema: "pirate.study.telegram-publication-fence/1",
    version: 1,
    grantId: context.grantId,
    actor: context.actor,
    accountId: context.accountId,
    authorityVersion: context.authorityVersion,
  });
  const fence: TelegramStudyFence = {
    facts,
    hash: digest(facts) as `0x${string}`,
  };
  return liveStudy({ ...ports, db }, session, {
    fence,
    authorizationId: context.authorizationId,
    startedAt: context.startedAt,
    check: () => context.check(),
  });
}
