import { digest } from "../packages/protocol/index.ts";
import {
  telegramStudyFacts,
  type TelegramStudyFence,
} from "../packages/study/telegram-publication.ts";
import { telegramCheck } from "../packages/telegram/contracts.ts";
import { address, chain } from "../packages/community/manifest-core.ts";
import {
  liveStudy,
  studyVersion,
  type StudyCommunityPorts,
} from "./study-community.ts";
import { TelegramManagedPublication } from "./telegram-managed-publication.ts";
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
  publication: TelegramManagedPublication,
) {
  telegramCheck(
    channel === "telegram-linked",
    "telegram_linked_channel_required",
    503,
  );
  telegramCheck(
    publication instanceof TelegramManagedPublication &&
      context.publication === publication,
    "telegram_managed_publication_required",
    503,
  );
  const pinned = {
    ...ports,
    config: structuredClone(ports.config),
    env: { ...ports.env },
  };
  telegramCheck(
    studyVersion(pinned.env, pinned.config) === 4 &&
      context.actor.communityId === pinned.config.communityId &&
      session.account_id === context.accountId,
    "telegram_study_target_changed",
    503,
  );
  const target = {
    communityId: pinned.config.communityId,
    chainId: chain(Number(pinned.env.KARAOKE_PAYMENT_CHAIN_ID)),
    operator: address(pinned.env.KARAOKE_OPERATOR_ADDRESS?.toLowerCase()),
    contract: address(pinned.config.learningRecords),
  };
  publication.assertAuthority(target);
  async function current() {
    const grant = await publication.grants.assert(
      context.actor,
      context.grantId,
    );
    telegramCheck(
      grant.accountId === session.account_id &&
        grant.accountId === context.accountId &&
        grant.wallet.toLowerCase() === session.wallet.toLowerCase() &&
        grant.authorityVersion === context.authorityVersion &&
        context.startedAt >= grant.linkedAt,
      "telegram_authority_changed",
      403,
    );
  }
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
  return liveStudy({ ...pinned, db }, session, {
    fence,
    authorizationId: context.authorizationId,
    startedAt: context.startedAt,
    async check() {
      // Used by admission AND saved-work recovery, before any provider request.
      publication.assertAuthority(target);
      await publication.ready();
      await current();
      await context.check();
      await publication.ready();
      await current();
    },
  });
}
