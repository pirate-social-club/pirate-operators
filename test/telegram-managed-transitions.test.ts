import { guardedPaginationFixture } from "./telegram-guarded-pagination-fixture.ts";
import { CommunityAuthorityPending } from "../packages/community-setup/authority-ledger.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { digest } from "../packages/protocol/index.ts";
import { actorKey } from "../packages/telegram/contracts.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import { TelegramSqlJournal } from "../services/telegram-store.ts";
import { TelegramOutbox } from "../services/telegram-outbox.ts";
import { TelegramDeliveryError } from "../packages/telegram/messages.ts";
import { telegramRuntime } from "../services/telegram-runtime.ts";
import { telegramCommunityRoutes } from "../services/telegram-http.ts";
import { account, actor, linkFixture } from "./telegram-fixture.ts";
import { botFixture } from "./telegram-bot-fixture.ts";
import { barrier } from "./telegram-repair1-fixture.ts";
import { managedFixture } from "./telegram-managed-fixture.ts";
import type { TelegramTransition } from "../packages/telegram/transitions.ts";

async function linked(t: import("node:test").TestContext) {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    grant = await f.complete(flow, await f.verify(flow));
  const managed = managedFixture(f.grants);
  await managed.publication.ready();
  return { ...f, ...managed, grant };
}
const operationId = "fixture_unlink_operation_001";
const requestFor = (grantId: string | null) => ({
  operationId,
  expectedGrantId: grantId,
});

test("HTTP unlink authenticates the existing account and retains a completed predecessor through no-grant retries", async (t) => {
  const f = await linked(t);
  const route = telegramCommunityRoutes(
    f.linking,
    {
      origin: "https://community.example",
      scope: actor,
      account: async () => account,
      csrf: async (request) =>
        request.headers.get("x-csrf-token") === "fixture-csrf",
    },
    f.publication,
  );
  const unlink = (
    body: unknown,
    origin = "https://community.example",
    csrf = "fixture-csrf",
  ) =>
    route(
      new Request("https://community.example/api/telegram/connection", {
        method: "DELETE",
        headers: {
          origin,
          "x-csrf-token": csrf,
          "x-telegram-account": account.accountId,
        },
        body: JSON.stringify(body),
      }),
    );
  const request = requestFor(f.grant.id);
  assert.equal((await unlink(request, "https://attacker.example")).status, 403);
  assert.equal((await unlink(request, undefined, "wrong")).status, 403);
  assert.equal(f.denials.size, 0);
  f.lost();
  assert.equal((await unlink(request)).status, 503);
  const status: unknown = await (
    await route(
      new Request("https://community.example/api/telegram/connection"),
    )
  ).json();
  assert.ok(
    status &&
      typeof status === "object" &&
      "grantId" in status &&
      "unlinkOperation" in status,
  );
  assert.equal(status.grantId, null);
  assert.deepEqual(status.unlinkOperation, { ...request, complete: false });
  f.advance(2000);
  assert.deepEqual(await (await unlink(request)).json(), { unlinked: true });
  assert.deepEqual(await (await unlink(request)).json(), { unlinked: true });
  const replacement = f.grants.commit(
    actor,
    account,
    "replacement_grant_http",
    f.grants.linkFence(actor, account.accountId),
  );
  assert.deepEqual(await (await unlink(request)).json(), { unlinked: true });
  assert.equal(
    (
      await unlink({
        operationId: "stale_new_operation_001",
        expectedGrantId: null,
      })
    ).status,
    409,
  );
  assert.equal(f.grants.read(actor)?.id, replacement.id);
  assert.equal(f.grants.read(actor)?.revokedAt, null);
});

for (const failure of ["offline", "lost", "wrong"] as const)
  test(`managed unlink keeps its exact pending identity across ${failure} and SQLite restart`, async (t) => {
    const f = await linked(t),
      stale = await f.begin();
    const request = requestFor(f.grant.id),
      before = f.grants.linkFence(actor, account.accountId);
    if (failure === "offline") f.offline(true);
    if (failure === "lost") f.lost();
    if (failure === "wrong") f.wrong(true);
    await assert.rejects(
      f.publication.unlink(actor, account.accountId, request),
    );
    assert.notEqual(f.grants.read(actor)?.revokedAt, null);
    const fence = f.grants.linkFence(actor, account.accountId);
    assert.equal(fence.userUnlink, before.userUnlink + 1);
    assert.equal(fence.accountUnlink, before.accountUnlink + 1);
    f.grants.start(actor);
    await assert.rejects(
      f.grants.assert(actor),
      /publication_pending|connection_required/,
    );
    await assert.rejects(
      f.complete(stale, await f.verify(stale)),
      /publication_pending|link_revoked/,
    );
    const grants = new TelegramGrants(
      new TelegramSqlJournal(f.storage),
      f.grants.accounts,
      f.now,
    );
    const restarted = f.create(undefined, grants);
    f.offline(false);
    f.wrong(false);
    f.advance(2000);
    await restarted.recover();
    assert.deepEqual(
      await restarted.unlink(actor, account.accountId, request),
      { unlinked: true },
    );
    assert.deepEqual(grants.linkFence(actor, account.accountId), fence);
    assert.equal(f.denials.size, 1);
    assert.equal(new Set(f.requests).size, 1);
    assert.ok(f.alarms.length > 0);
    const replacement = grants.commit(
      actor,
      account,
      "replacement_grant_001",
      grants.linkFence(actor, account.accountId),
    );
    assert.deepEqual(
      await restarted.unlink(actor, account.accountId, request),
      { unlinked: true },
    );
    assert.equal(grants.read(actor)?.id, replacement.id);
    assert.equal(grants.read(actor)?.revokedAt, null);
  });

test("a failed durable wake permits no local retirement or remote denial", async (t) => {
  const f = await linked(t),
    fence = f.grants.linkFence(actor, account.accountId);
  f.scheduleFails(true);
  await assert.rejects(
    f.publication.unlink(actor, account.accountId, requestFor(f.grant.id)),
    /wake_unavailable/,
  );
  assert.equal(f.grants.read(actor)?.revokedAt, null);
  assert.deepEqual(f.grants.linkFence(actor, account.accountId), fence);
  assert.equal(f.denials.size, 0);
});

test("managed HTTP and runtime entry points reject a missing lifecycle capability", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const managed = managedFixture(f.grants);
  await managed.publication.ready();
  const routes = telegramCommunityRoutes(f.linking, {
    origin: "https://community.example",
    scope: actor,
    account: async () => account,
    csrf: async () => true,
  });
  assert.equal(
    (
      await routes(
        new Request("https://community.example/api/telegram/connection"),
      )
    ).status,
    503,
  );
  const runtime = telegramRuntime(f.bot, managed.scheduleWork, f.now);
  assert.equal(
    (
      await runtime.webhook(
        new Request("https://community.example", { method: "POST" }),
      )
    ).status,
    503,
  );
  await assert.rejects(runtime.tick(), /managed_publication_required/);
  assert.equal(f.speechCalls(), 0);
});

test("scope recovery adopts staged validation before ordinary readiness, including disabled settings", async (t) => {
  const f = await linked(t),
    next = { ...actor, enabled: false };
  const changed = f.create(next);
  f.lost();
  await assert.rejects(changed.ready(), /publication_pending/);
  assert.throws(() => f.grants.current(actor), /scope_pending/);
  const grants = new TelegramGrants(
    new TelegramSqlJournal(f.storage),
    f.grants.accounts,
    f.now,
  );
  f.advance(2000);
  const restarted = f.create(next, grants);
  await restarted.ready();
  assert.equal(
    grants.store.get<{ enabled: boolean }>(`bot:${actor.communityId}`)?.enabled,
    false,
  );
  assert.throws(() => grants.current(actor), /bot_changed/);
  const routes = telegramCommunityRoutes(
    f.linking,
    {
      scope: actor,
      origin: "https://community.example",
      account: async () => account,
      csrf: async () => true,
    },
    f.create(next),
  );
  assert.equal(
    (
      await routes(
        new Request("https://community.example/api/telegram/connection"),
      )
    ).status,
    200,
  );
  await assert.rejects(
    f.create({ ...actor, enabled: true }).ready(),
    /reenable_requires_generation/,
  );
  await f.create({ ...actor, enabled: true, generation: 2 }).ready();
  assert.equal(f.denials.size, 1);
});

test("invalid scope requests never create an operator denial", async (t) => {
  const f = await linked(t);
  for (const next of [
    { ...actor, enabled: false, generation: 0 },
    { ...actor, enabled: true, botId: "90002" },
  ])
    await assert.rejects(
      f.create(next).ready(),
      /generation_invalid|bot_change_requires_generation/,
    );
  assert.equal(f.denials.size, 0);
  assert.equal(f.grants.current(actor).enabled, true);
});

test("blocking atomically retires the captured grant; start and a late callback cannot revive or retire a replacement", async (t) => {
  const f = await linked(t),
    gate = barrier();
  const outbox = new TelegramOutbox(
    f.grants,
    {
      async send() {
        await gate.pause();
        throw new TelegramDeliveryError("blocked", "known_failed", 1000, true);
      },
    },
    undefined,
    f.publication,
  );
  outbox.enqueue(actor, "fixture_delivery", { kind: "text", text: "Fixture" });
  const draining = outbox.drain(actor);
  await gate.waiting;
  gate.release();
  await draining;
  assert.notEqual(f.grants.read(actor)?.revokedAt, null);
  const op = f.store
    .entries<TelegramTransition>("publication-transition:")
    .find((row) => row.value.kind === "block")!;
  assert.equal(op.value.complete, false);
  f.grants.start(actor);
  await assert.rejects(f.grants.assert(actor), /publication_pending/);
  await f.publication.recover();
  await assert.rejects(f.grants.assert(actor), /connection_required/);
  const captured = { grant: f.grant, revision: 1 };
  const replacement = f.grants.commit(
    actor,
    account,
    "replacement_grant_002",
    f.grants.linkFence(actor, account.accountId),
  );
  f.publication.block(actor, "late_fixture_delivery", captured);
  assert.equal(f.grants.read(actor)?.id, replacement.id);
  assert.equal(f.grants.read(actor)?.revokedAt, null);
  assert.equal(f.store.get(`publication-user:${actorKey(actor)}`), undefined);
});

test("authority discovery pages are immutable, bounded and unsealed until the shared writer exhausts discovery", async (t) => {
  const f = await guardedPaginationFixture(t);
  const id = await f.publication.beginAuthorityTransition(
    f.action.scope,
    f.accountId,
    { operationId: f.op.operation_id, expectedGrantId: f.grant.id },
  );
  assert.equal(id, f.transitionId);
  const ids = [...f.ids].sort();
  assert.equal(ids.length, 65);
  const first = {
    cursor: null,
    next: "page-1",
    authorizationIds: ids.slice(0, 40),
    exhausted: false,
  };
  f.publication.appendAuthorizations(id, first);
  f.publication.appendAuthorizations(id, first);
  assert.throws(
    () =>
      f.publication.appendAuthorizations(id, {
        ...first,
        authorizationIds: ids.slice(0, 1),
      }),
    /conflict/,
  );
  await f.persistPage(first);
  await assert.rejects(
    f.publication.finishAuthorityTransition(id),
    CommunityAuthorityPending,
  );
  assert.equal(f.denials.size, 0);
  const last = {
    cursor: "page-1",
    next: null,
    authorizationIds: ids.slice(40),
    exhausted: true,
  };
  f.publication.appendAuthorizations(id, last);
  await f.persistPage(last);
  for (let i = 0; i < 70; i++) {
    f.advance();
    await f.publication.recover();
  }
  await f.publication.finishAuthorityTransition(id);
  assert.equal(f.denials.size, 66);
  assert.equal(new Set(f.requests).size, 66);
});

test("fair recovery visits later operations while a first grant denial is unavailable", async (t) => {
  const f = await linked(t);
  const request = requestFor(f.grant.id);
  f.offline(true);
  await assert.rejects(f.publication.unlink(actor, account.accountId, request));
  const blocked = f.store.entries<TelegramTransition>(
    "publication-transition:",
  )[0].value;
  const secondAccount = "fixture_second_account",
    secondActor = { ...actor, userId: "70002", chatId: "70002" };
  f.grants.start(secondActor);
  const second = f.grants.commit(
    secondActor,
    { ...account, accountId: secondAccount },
    "second_grant_001",
    f.grants.linkFence(secondActor, secondAccount),
  );
  f.offline(false);
  f.holdGrant(f.grant.id);
  f.offline(true);
  await assert.rejects(
    f.publication.unlink(actor, secondAccount, {
      operationId: "fixture_second_unlink_001",
      expectedGrantId: second.id,
    }),
  );
  f.offline(false);
  f.advance(2000);
  for (let i = 0; i < 4; i++) await f.publication.recover(1);
  assert.equal(
    f.store.get<TelegramTransition>(`publication-transition:${blocked.id}`)
      ?.complete,
    false,
  );
  assert.equal(f.denials.size, 1);
});

test("runtime recovers scope invalidation while ordinary readiness is failing", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const managed = managedFixture(f.grants, {
    ...actor,
    enabled: true,
    generation: 2,
  });
  const runtime = telegramRuntime(
    f.bot,
    managed.scheduleWork,
    f.now,
    managed.publication,
  );
  managed.offline(true);
  assert.equal(
    (
      await runtime.webhook(
        new Request("https://community.example", { method: "POST" }),
      )
    ).status,
    503,
  );
  assert.equal(f.speechCalls(), 0);
  managed.offline(false);
  f.advance(2000);
  await runtime.tick();
  assert.equal(
    f.grants.store.get<{ generation: number }>(`bot:${actor.communityId}`)
      ?.generation,
    2,
  );
  assert.equal(managed.denials.size, 1);
});

test("a malformed persisted denial child holds its exact operation and ordinary readiness", async (t) => {
  const f = await linked(t);
  f.offline(true);
  await assert.rejects(
    f.publication.unlink(actor, account.accountId, requestFor(f.grant.id)),
  );
  const child = f.store.entries("publication-child:")[0];
  f.store.set(child.key, {
    denial: { kind: "grant" },
    hash: digest("malformed"),
    acknowledged: false,
  });
  f.offline(false);
  f.advance(2000);
  await f.publication.recover();
  await assert.rejects(f.publication.ready(), /publication_pending/);
  assert.equal(f.grants.read(actor)?.revokedAt, f.now() - 2000);
  assert.equal(f.denials.size, 0);
});
