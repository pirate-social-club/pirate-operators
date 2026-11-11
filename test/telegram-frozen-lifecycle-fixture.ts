import assert from "node:assert/strict";
import { address, chain } from "../packages/community/manifest-core.ts";
import { AUTHORITY_LEDGER_SCHEMA } from "../packages/community-setup/authority-schema.ts";
import { readAuthorityState } from "../packages/community-setup/authority-ledger.ts";
import { validateManagedAuthorityDelivery } from "../packages/community-setup/authority-validation.ts";
import { telegramAccountPort } from "../services/telegram-accounts.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import { TelegramManagedPublication } from "../services/telegram-managed-publication.ts";
import type { TelegramPublicationFence } from "../services/telegram-linked-study.ts";
import type { StudyCommunityPorts } from "../services/study-community.ts";
import { journalFixture } from "./telegram-fixture.ts";

/** Lower-level frozen adapter fixture migration only. Actual grant/account SQL,
 * lifecycle, signed operator and required D1 guard replace the old marker.
 * Existing test-specific authority observations remain explicit lower-level
 * fixtures; they are not production authorization or a native scheduler proof.
 * The separate concrete-factory regressions use the real shared authority. */
export async function frozenLifecycleFixture(
  ports: StudyCommunityPorts,
  session: { account_id: string; wallet: string },
  seed: Omit<TelegramPublicationFence, "publication">,
) {
  const journal = journalFixture();
  try {
    if (
      !(await ports.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='learning_authority_heads'",
        )
        .first())
    ) {
      let statement = "";
      for (const line of AUTHORITY_LEDGER_SCHEMA.split("\n")) {
        statement += line + "\n";
        if (
          /^\s*CREATE TRIGGER\b/.test(statement)
            ? /END;\s*$/.test(line)
            : /;\s*$/.test(line)
        ) {
          await ports.db.prepare(statement).run();
          statement = "";
        }
      }
      assert.equal(statement.trim(), "");
    }
    const accounts = telegramAccountPort({
      db: ports.db,
      async assertAccountEnabled(id) {
        assert.equal(id, session.account_id);
        assert.ok(
          await ports.db
            .prepare("SELECT 1 FROM community_accounts WHERE account_id=?")
            .bind(id)
            .first(),
        );
      },
      authorityState: (id) => readAuthorityState(ports.db, id),
    });
    const grants = new TelegramGrants(journal.store, accounts, ports.now);
    const alarms: number[] = [];
    const publication = TelegramManagedPublication.create({
      grants,
      registration: { ...seed.actor, enabled: true },
      ports: {
        binding: ports.env.KARAOKE_OPERATOR!,
        issuerKey: ports.env.KARAOKE_SIGNER_PRIVATE_KEY as `0x${string}`,
        authority: {
          communityId: ports.config.communityId,
          contract: address(ports.config.learningRecords),
          chainId: chain(Number(ports.env.KARAOKE_PAYMENT_CHAIN_ID)),
          operator: address(ports.env.KARAOKE_OPERATOR_ADDRESS?.toLowerCase()),
        },
        now: ports.now,
      },
      scheduleWork: async (at) => {
        alarms.push(at);
      },
      authorityValidation: (request) =>
        validateManagedAuthorityDelivery(ports.db, request),
    });
    await publication.ready();
    grants.start(seed.actor);
    const identity = await accounts.current(
      seed.actor.communityId,
      session.account_id,
      session.wallet,
    );
    grants.commit(
      seed.actor,
      identity,
      seed.grantId,
      grants.linkFence(seed.actor, session.account_id),
    );
    const context: TelegramPublicationFence = {
      ...seed,
      authorityVersion: identity.authorityVersion,
      publication,
    };
    return { context, publication, alarms, close: journal.close };
  } catch (error) {
    journal.close();
    throw error;
  }
}
