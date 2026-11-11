import { TelegramManagedPublication } from "../services/telegram-managed-publication.ts";
import { managedFixture } from "./telegram-managed-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { ensureCommunityIdentity } from "../packages/community/accounts.ts";
import { bytes32 } from "../packages/community/common.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  resolveTelegramStudyFence,
  telegramStudyFacts,
  type TelegramStudyContext,
} from "../packages/study/telegram-publication.ts";
import { accounts, keys } from "../harness/runtime.ts";
import type { ResultStore } from "../services/learning-transactions.ts";
import type { Env } from "../services/runtime.ts";
import { studyOperatorRoute } from "../services/study-operator.ts";
import type { StudyOperatorPorts } from "../services/study-operator-client.ts";
import { telegramStudyDenied } from "../services/study-telegram-publication.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import { telegramCommunityRoutes } from "../services/telegram-http.ts";
import {
  configureTelegramPublicationScope,
  telegramPublicationAuthority,
} from "../services/telegram-publication-authority.ts";
import { communityRuntime } from "./community-runtime.ts";
import { account, actor, linkFixture } from "./telegram-fixture.ts";

const communityId = bytes32(actor.communityId);
const contract = `0x${"c4".repeat(20)}` as Address;

function operatorJournal(now: () => number): ResultStore {
  const data = new Map<string, unknown>();
  return {
    now,
    get: <T>(key: string) => data.get(key) as T | undefined,
    set: (key, value) => void data.set(key, value),
    delete: (key) => void data.delete(key),
    entries: (prefix) =>
      [...data]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    transaction: (fn) => fn(),
  };
}
function boundFence(
  grantId: string,
  authorityVersion = account.authorityVersion,
  generation = actor.generation,
) {
  const facts = telegramStudyFacts({
    schema: "pirate.study.telegram-publication-fence/1",
    version: 1,
    grantId,
    accountId: account.accountId,
    authorityVersion,
    actor: { ...actor, generation },
  });
  return { facts, hash: digest(facts) as Hex };
}

test("unlink waits for a signed operator denial and failed acknowledgments leave the grant in place", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    grant = await f.complete(flow, await f.verify(flow));
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const now = () => Math.floor(f.now() / 1000);
  const store = operatorJournal(now);
  const env = {
    COMMUNITY_ID: communityId,
    PAYMENT_CHAIN_ID: "6343",
    RESULTS_V4_CONTRACT: contract,
    OPERATOR_ADDRESS: accounts[2].address,
    ISSUER: accounts[1].address,
  } as Env;
  let outage = true,
    wait = true;
  const ports: StudyOperatorPorts = {
    authority: {
      chainId: 6343,
      communityId,
      operator: env.OPERATOR_ADDRESS,
      contract,
    },
    issuerKey: keys[1],
    now: f.now,
    binding: {
      async fetch(url, init) {
        if (outage)
          return Response.json(
            { error: "fixture_unavailable" },
            { status: 503 },
          );
        if (wait) {
          entered.resolve();
          await release.promise;
        }
        return (await studyOperatorRoute(new Request(url, init), env, store))!;
      },
    } as Fetcher,
  };
  const publication = TelegramManagedPublication.create({
    grants: f.grants,
    registration: { ...actor, enabled: true },
    ports,
    scheduleWork: async () => {},
  });
  await publication.ready();
  const routes = telegramCommunityRoutes(
    f.linking,
    {
      origin: "https://community.example",
      scope: actor,
      account: async () => account,
      csrf: async () => true,
    },
    publication,
  );
  const unlink = () =>
    routes(
      new Request("https://community.example/api/telegram/connection", {
        method: "DELETE",
        body: JSON.stringify({
          operationId: "fixture_original_unlink_001",
          expectedGrantId: grant.id,
        }),
        headers: {
          origin: "https://community.example",
          "x-telegram-account": account.accountId,
        },
      }),
    );
  assert.equal((await unlink()).status, 503);
  assert.notEqual(f.grants.read(actor)?.revokedAt, null);
  assert.equal(telegramStudyDenied(store, boundFence(grant.id)), false);
  outage = false;
  f.advance(2000);
  const action = unlink();
  await entered.promise;
  assert.notEqual(f.grants.read(actor)?.revokedAt, null);
  release.resolve();
  assert.deepEqual(await (await action).json(), { unlinked: true });
  assert.notEqual(f.grants.read(actor)?.revokedAt, null);
  assert.equal(telegramStudyDenied(store, boundFence(grant.id)), true);
  assert.equal(
    telegramStudyDenied(store, boundFence(grant.id, "authority-2")),
    true,
  );
  assert.equal(
    telegramStudyDenied(store, boundFence("different_grant")),
    false,
  );

  wait = false;
  await configureTelegramPublicationScope(
    f.grants,
    { ...actor, enabled: true, generation: actor.generation + 1 },
    TelegramManagedPublication.create({
      grants: f.grants,
      registration: {
        ...actor,
        enabled: true,
        generation: actor.generation + 1,
      },
      ports,
      scheduleWork: async () => {},
    }),
  );
  assert.equal(telegramStudyDenied(store, boundFence("different_grant")), true);
  assert.equal(
    telegramStudyDenied(
      store,
      boundFence("different_grant", "authority-2", actor.generation + 1),
    ),
    false,
  );
});

// Scope validation/lost-ack/restart coverage is now in telegram-managed-transitions.test.ts.

test("the internal resolver accepts only the current grant and exact original V4 authorization", async () => {
  const linked = await linkFixture(),
    f = await communityRuntime({ v4: true });
  try {
    const flow = await linked.begin(),
      grant = await linked.complete(flow, await linked.verify(flow));
    linked.advance(3000);
    await ensureCommunityIdentity(f.db, {
      communityId,
      origin: "https://community.example",
    });
    const learner = account.wallet as Address,
      authorizationId = `0x${"66".repeat(32)}` as Hex;
    await f.db.batch([
      f.db
        .prepare(
          "INSERT INTO community_accounts(account_id,author_id,created_at) VALUES(?,?,0)",
        )
        .bind(account.accountId, authorizationId),
      f.db
        .prepare(
          "INSERT INTO credential_bindings(binding_id,account_id,namespace,network,subject,created_at) VALUES(?,?,'moss',6343,?,0)",
        )
        .bind("fixture_binding", account.accountId, learner),
      f.db
        .prepare(
          `INSERT INTO learning_authorizations
        (authorization_id,account_id,subject,sign_in_json,message,signature,policy_hash,policy_version,issued_at,state,created_at,updated_at)
        VALUES(?,?,?,'{}','fixture','fixture',?,1,?,'recorded',0,0)`,
        )
        .bind(
          authorizationId,
          account.accountId,
          learner,
          authorizationId,
          Math.floor(linked.now() / 1000) - 1,
        ),
    ]);
    let rotateDuring = false;
    const handler = telegramPublicationAuthority({
      db: f.db,
      grants: linked.grants,
      publication: managedFixture(linked.grants, undefined, { contract })
        .publication,
      communityId,
      contract,
      env: {
        KARAOKE_OPERATOR: {
          async fetch() {
            if (rotateDuring) linked.authority("authority-2");
            return Response.json({
              since: Math.floor(linked.now() / 1000) - 5,
              revokedAt: 0,
              revocationNonce: "0",
            });
          },
        } as unknown as Fetcher,
      },
    });
    const transport = {
      fetch: (url: string, init?: RequestInit) =>
        handler(new Request(url, init)),
    };
    const context: TelegramStudyContext = {
      communityId,
      contract,
      learner,
      authorizationId,
      lessonId: "linked_lesson_fixture_1",
      startedAt: linked.now(),
    };
    const fence = boundFence(grant.id);
    assert.equal(
      await resolveTelegramStudyFence(transport, fence, context),
      true,
    );
    assert.equal(
      await resolveTelegramStudyFence(transport, fence, {
        ...context,
        authorizationId: `0x${"77".repeat(32)}`,
      }),
      false,
    );
    rotateDuring = true;
    assert.equal(
      await resolveTelegramStudyFence(transport, fence, context),
      false,
    );
    rotateDuring = false;
    assert.equal(
      await resolveTelegramStudyFence(
        transport,
        boundFence(grant.id, "authority-2"),
        context,
      ),
      true,
    );
  } finally {
    linked.dispose();
    await f.dispose();
  }
});
