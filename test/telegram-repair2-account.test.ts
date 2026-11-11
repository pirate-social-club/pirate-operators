import { test } from "node:test";
import assert from "node:assert/strict";
import { actor, account, linkFixture } from "./telegram-fixture.ts";
import {
  TelegramError,
  type WebAccount,
} from "../packages/telegram/contracts.ts";
import {
  telegramCommunityRoutes,
  TELEGRAM_CONNECT_COOKIE,
} from "../services/telegram-http.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import { TelegramLinking } from "../services/telegram-linking.ts";
import { TelegramSqlJournal } from "../services/telegram-store.ts";
import { managedFixture } from "./telegram-managed-fixture.ts";

async function jsonObject(response: Response) {
  const value: unknown = await response.json();
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Existing-session and CSRF ports are explicit simulations. The requests run
 * through actual linking, signed broker proof, HTTP routes and SQLite storage. */
async function httpFixture() {
  const f = await linkFixture(),
    second: WebAccount = {
      ...account,
      accountId: "account-b",
      wallet: "0x" + "2".repeat(40),
      sessionId: "session-b",
    };
  const identities = [account, second];
  f.grants.accounts.current = async (community, id, wallet) => {
    const owner = identities.find(
      (value) =>
        value.communityId === community &&
        value.accountId === id &&
        (!wallet || value.wallet === wallet),
    );
    if (!owner) throw new TelegramError("fixture_account_mismatch", 403);
    return owner;
  };
  let enabled = true;
  const mount = (linking: TelegramLinking) =>
    telegramCommunityRoutes(
      linking,
      {
        origin: "https://community.example",
        scope: actor,
        async account(request) {
          const session = request.headers
            .get("cookie")
            ?.split(";")
            .map((value) => value.trim())
            .find((value) => value.startsWith("fixture-session="))
            ?.slice("fixture-session=".length);
          const owner = identities.find((value) => value.sessionId === session);
          if (!owner) throw new TelegramError("fixture_session_required", 401);
          return owner;
        },
        async csrf(request, owner) {
          return (
            request.headers.get("x-csrf-token") === `csrf-${owner.accountId}`
          );
        },
      },
      managedFixture(linking.grants, { ...actor, enabled }).publication,
    );
  let routes = mount(f.linking);
  const http = (
    owner: WebAccount,
    path: string,
    method = "GET",
    body?: unknown,
    browser?: string,
  ) =>
    routes(
      new Request(`https://community.example${path}`, {
        method,
        headers: {
          cookie: `fixture-session=${owner.sessionId}${browser ? `; ${TELEGRAM_CONNECT_COOKIE}=${browser}` : ""}`,
          origin: "https://community.example",
          "x-telegram-account": owner.accountId,
          "x-csrf-token": `csrf-${owner.accountId}`,
          "content-type": "application/json",
        },
        ...(body === undefined && method !== "DELETE"
          ? {}
          : {
              body: JSON.stringify(
                body ?? {
                  operationId: crypto.randomUUID(),
                  expectedGrantId:
                    f.grants.forAccount(actor, owner.accountId)?.id ?? null,
                },
              ),
            }),
      }),
    );
  async function link(owner: WebAccount, who = actor) {
    f.claims({ id: Number(who.userId) });
    const flow = await f.begin(who, owner),
      returned = await f.verify(flow);
    const response = await http(
      owner,
      "/api/telegram/connect/complete",
      "POST",
      {
        transactionId: flow.transaction.id,
        state: returned.searchParams.get("state"),
        code: returned.searchParams.get("code"),
      },
      flow.browser,
    );
    assert.equal(response.status, 200);
    assert.equal((await jsonObject(response)).connected, true);
  }
  return {
    ...f,
    second,
    http,
    link,
    async disable() {
      enabled = false;
      await managedFixture(f.grants, { ...actor, enabled }).publication.ready();
      routes = mount(f.linking);
    },
    restart() {
      const grants = new TelegramGrants(
        new TelegramSqlJournal(f.storage),
        f.grants.accounts,
        f.now,
      );
      routes = mount(
        new TelegramLinking(
          grants,
          f.brokerPort,
          f.linking.clientId,
          f.linking.returnUrl,
        ),
      );
    },
  };
}

for (const stale of ["none", "before-relink", "after-relink", "disabled-bot"])
  test(`HTTP account A cannot read or change B after sender unlink/relink (${stale})`, async (t) => {
    const f = await httpFixture();
    t.after(f.dispose);
    const indexA = `account-grant:${actor.communityId}:${actor.botId}:${account.accountId}`,
      senderKey = `grant:${actor.communityId}:${actor.botId}:${actor.userId}`;
    await f.link(account);
    const unlink = await f.http(account, "/api/telegram/connection", "DELETE");
    assert.equal(unlink.status, 200);
    assert.deepEqual(await jsonObject(unlink), { unlinked: true });
    if (stale === "before-relink") f.store.set(indexA, senderKey);
    await f.link(f.second);
    const indexAfterRelink = f.store.get(indexA);
    if (stale === "after-relink" || stale === "disabled-bot")
      f.store.set(indexA, senderKey); // Previously preserved stale-index state.
    if (stale === "disabled-bot") await f.disable();
    f.restart();
    const grantB = f.grants.read(actor)!;
    const statusA = await f.http(account, "/api/telegram/connection");
    const statusBodyA = await jsonObject(statusA),
      indexAfterRead = f.store.get(indexA);
    const prefsBefore = f.grants.preferences(actor);
    f.store.set(indexA, senderKey);
    const patchA = await f.http(
      account,
      "/api/telegram/notifications",
      "PATCH",
      { reminders: true, rewards: true, dance: true },
    );
    const patchBodyA = await jsonObject(patchA),
      prefsAfterA = f.grants.preferences(actor);
    f.store.set(indexA, senderKey);
    const deleteA = await f.http(account, "/api/telegram/connection", "DELETE");
    const deleteBodyA = await jsonObject(deleteA);
    assert.deepEqual(
      {
        status: statusA.status,
        connected: statusBodyA.connected,
        patch: patchA.status,
        delete: deleteA.status,
        unlinked: deleteBodyA.unlinked,
      },
      {
        status: 200,
        connected: false,
        patch: 403,
        delete: 200,
        unlinked: false,
      },
    );
    assert.deepEqual(
      {
        connected: statusBodyA.connected,
        linkedAt: statusBodyA.linkedAt,
        preferences: statusBodyA.preferences,
        grantId: statusBodyA.grantId,
      },
      {
        connected: false,
        linkedAt: null,
        preferences: null,
        grantId: null,
      },
    );
    assert.equal(patchBodyA.error, "telegram_connection_required");
    assert.deepEqual(prefsAfterA, prefsBefore);
    if (stale === "none" || stale === "before-relink")
      assert.equal(
        indexAfterRelink,
        undefined,
        "retire old index on unlink/relink",
      );
    assert.equal(
      indexAfterRead,
      undefined,
      "invalid index is retired during lookup",
    );
    assert.equal(f.grants.read(actor)?.id, grantB.id);
    assert.equal(f.grants.read(actor)?.revokedAt, null);
    const statusB = await f.http(f.second, "/api/telegram/connection");
    assert.equal((await jsonObject(statusB)).connected, true);
    const patchB = await f.http(
      f.second,
      "/api/telegram/notifications",
      "PATCH",
      { reminders: false, rewards: true, dance: false },
    );
    assert.equal(patchB.status, 200);
    assert.deepEqual(f.grants.preferences(actor), {
      reminders: false,
      rewards: true,
      dance: false,
    });
  });

test("an account index must match community, bot and canonical sender row as well as account", async (t) => {
  const f = await httpFixture();
  t.after(f.dispose);
  await f.link(account);
  const grant = f.grants.read(actor)!,
    index = `account-grant:${actor.communityId}:${actor.botId}:${account.accountId}`;
  for (const change of [
    { communityId: "0x" + "c".repeat(64) },
    { botId: "90002" },
    {},
  ]) {
    f.store.set("fixture-wrong-grant-row", { ...grant, ...change });
    f.store.set(index, "fixture-wrong-grant-row");
    const response = await f.http(account, "/api/telegram/connection");
    assert.equal((await jsonObject(response)).connected, false);
    assert.equal(f.store.get(index), undefined);
  }
  assert.equal(
    f.grants.read(actor)?.revokedAt,
    null,
    "lookup must not revoke the unrelated row",
  );
});

test("reusing an unlinked sender row preserves the former account's new sender index", async (t) => {
  const f = await httpFixture();
  t.after(f.dispose);
  await f.link(account);
  assert.deepEqual(
    await jsonObject(
      await f.http(account, "/api/telegram/connection", "DELETE"),
    ),
    { unlinked: true },
  );
  const other = { ...actor, userId: "70002", chatId: "70002" };
  await f.link(account, other);
  const index = `account-grant:${actor.communityId}:${actor.botId}:${account.accountId}`,
    pointer = f.store.get(index);
  await f.link(f.second);
  assert.equal(f.store.get(index), pointer);
  assert.equal(
    f.grants.forAccount(actor, account.accountId)?.userId,
    other.userId,
  );
  assert.equal(
    f.grants.forAccount(actor, f.second.accountId)?.userId,
    actor.userId,
  );
});
