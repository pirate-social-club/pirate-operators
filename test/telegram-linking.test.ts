import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actor,
  account,
  journalFixture,
  linkFixture,
} from "./telegram-fixture.ts";
import { randomToken, sha256 } from "../packages/telegram/security.ts";
import { verifyTelegramIdToken } from "../services/telegram-oidc.ts";
import { TelegramLinking } from "../services/telegram-linking.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import {
  telegramCommunityRoutes,
  telegramBrokerRoutes,
  TELEGRAM_CONNECT_COOKIE,
} from "../services/telegram-http.ts";
import { telegramBrokerClient } from "../services/telegram-broker-client.ts";
import { managedFixture } from "./telegram-managed-fixture.ts";

test("independent signed Telegram proof creates one durable narrow grant; browser logout is not bot logout", async (t) => {
  const f = await linkFixture();
  t.after(() => f.brokerJournal.close());
  const flow = await f.begin(),
    returned = await f.verify(flow);
  assert.equal(f.grants.read(actor), undefined);
  await f.linking.inspect(
    flow.transaction.id,
    returned.searchParams.get("state")!,
    account,
    flow.browser,
  );
  assert.equal(
    f.grants.read(actor),
    undefined,
    "return GET cannot grant access",
  );
  const grant = await f.complete(flow, returned);
  assert.deepEqual(grant.capabilities, [
    "study",
    "progress",
    "reward-status",
    "notifications",
  ]);
  assert.equal((await f.complete(flow, returned)).id, grant.id);
  const snapshot = f.database
    .prepare("SELECT key,value FROM telegram_journal")
    .all() as { key: string; value: string }[];
  f.close();
  const reopened = journalFixture();
  for (const row of snapshot)
    reopened.store.set(row.key, JSON.parse(row.value));
  t.after(reopened.close);
  const grants = new TelegramGrants(reopened.store, f.grants.accounts, f.now);
  assert.equal((await grants.assert(actor)).id, grant.id);
  f.advance(31 * 86400_000);
  assert.equal(
    (await grants.assert(actor)).id,
    grant.id,
    "grant is not a 30-day website session",
  );
});
test("wrong browser/account/session/state/community cannot attach a forwarded pending link", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    returned = await f.verify(flow);
  const args = [
    flow.transaction.id,
    returned.searchParams.get("state")!,
    returned.searchParams.get("code")!,
  ] as const;
  await assert.rejects(
    f.linking.complete(...args, account, randomToken()),
    /browser_mismatch/,
  );
  await assert.rejects(
    f.linking.complete(
      ...args,
      { ...account, accountId: "other" },
      flow.browser,
    ),
    /account_mismatch/,
  );
  await assert.rejects(
    f.linking.complete(
      ...args,
      { ...account, sessionId: "switched" },
      flow.browser,
    ),
    /account_mismatch/,
  );
  await assert.rejects(
    f.linking.complete(
      ...args,
      { ...account, communityId: "0x" + "b".repeat(64) },
      flow.browser,
    ),
    /account_mismatch/,
  );
  await assert.rejects(
    f.linking.complete(args[0], "wrong", args[2], account, flow.browser),
    /state_mismatch/,
  );
  assert.equal(f.grants.read(actor), undefined);
  assert.equal((await f.complete(flow, returned)).userId, actor.userId);
});
test("OIDC requires state, same broker browser, S256 and nonce; unknown exchange reconciles once", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin();
  assert.equal(flow.authorization.searchParams.get("scope"), "openid profile");
  assert.equal(
    flow.authorization.searchParams.get("code_challenge_method"),
    "S256",
  );
  await assert.rejects(
    f.broker.callback("bad-state", "code", flow.brokerBrowser),
    /state_mismatch/,
  );
  await assert.rejects(
    f.broker.callback(flow.state, "code", randomToken()),
    /browser_mismatch/,
  );
  assert.equal(f.exchangeCalls(), 0);
  f.unknown();
  await assert.rejects(f.verify(flow), /unknown_exchange/);
  const returned = await f.verify(flow);
  assert.equal(f.exchangeCalls(), 1);
  await f.complete(flow, returned);
  assert.equal(f.exchangeCalls(), 1);
});
test("wrong signed numeric sender and missing nonce fail even if sub resembles the requested user", async (t) => {
  for (const claims of [
    { id: Number(actor.userId) + 1 },
    { nonce: undefined, sub: actor.userId },
    { id: undefined, sub: actor.userId },
  ]) {
    const f = await linkFixture();
    t.after(f.dispose);
    const flow = await f.begin();
    f.claims(claims);
    await assert.rejects(f.verify(flow));
    assert.equal(f.grants.read(actor), undefined);
  }
});
test("JWT verification refuses changed signature, algorithm, issuer, audience and expiry", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    nonce = flow.authorization.searchParams.get("nonce")!;
  const verify = (token: string) =>
    verifyTelegramIdToken({
      token,
      nonce,
      clientId: "telegram-login-client",
      now: f.now(),
      keys: [f.publicKey],
    });
  for (const changes of [
    { iss: "https://attacker.example" },
    { aud: "other" },
    { exp: Math.floor(f.now() / 1000) },
    { aud: ["telegram-login-client", "other"] },
  ])
    await assert.rejects(verify(await f.token(changes)));
  await assert.rejects(
    verify(await f.token({}, { alg: "HS256" })),
    /algorithm/,
  );
  const signed = await f.token();
  await assert.rejects(verify(signed.slice(0, -8) + "AAAAAAAA"), /signature/);
  assert.equal((await verify(signed)).telegramId, actor.userId);
});
test("one-use redemption permits only the same durable receipt and exact registered client/request", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    returned = await f.verify(flow);
  const code = returned.searchParams.get("code")!,
    input = {
      code,
      requestId: flow.transaction.id,
      requestDigest: flow.transaction.requestDigest,
      redemptionId: randomToken(),
    };
  const first = await f.broker.redeem("community-client", input);
  assert.deepEqual(await f.broker.redeem("community-client", input), first);
  await assert.rejects(
    f.broker.redeem("community-client", {
      ...input,
      redemptionId: randomToken(),
    }),
    /redemption_used/,
  );
  await assert.rejects(
    f.broker.redeem("community-client", {
      ...input,
      requestDigest: "0x" + "0".repeat(64),
    }),
    /redemption_mismatch/,
  );
  await assert.rejects(
    f.broker.redeem("other-client", input),
    /client_required/,
  );
});
test("lost redemption response reconciles the same grant without a second provider exchange", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    returned = await f.verify(flow);
  let lost = true;
  const linking = new TelegramLinking(
    f.grants,
    {
      request: f.brokerPort.request,
      async redeem(input) {
        const result = await f.brokerPort.redeem(input);
        if (lost) {
          lost = false;
          throw new Error("simulated_lost_response");
        }
        return result;
      },
    },
    "community-client",
    f.linking.returnUrl,
  );
  const complete = () =>
    linking.complete(
      flow.transaction.id,
      returned.searchParams.get("state")!,
      returned.searchParams.get("code")!,
      account,
      flow.browser,
    );
  await assert.rejects(complete(), /lost_response/);
  assert.equal(f.grants.read(actor), undefined);
  assert.equal((await complete()).id, flow.transaction.id);
  assert.equal(f.exchangeCalls(), 1);
});
test("revocation during backchannel redemption prevents completion", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    returned = await f.verify(flow);
  const linking = new TelegramLinking(
    f.grants,
    {
      request: f.brokerPort.request,
      async redeem(input) {
        const receipt = await f.brokerPort.redeem(input);
        f.enabled(false);
        return receipt;
      },
    },
    "community-client",
    f.linking.returnUrl,
  );
  await assert.rejects(
    linking.complete(
      flow.transaction.id,
      returned.searchParams.get("state")!,
      returned.searchParams.get("code")!,
      account,
      flow.browser,
    ),
    /account_disabled/,
  );
  assert.equal(f.grants.read(actor), undefined);
});
test("same-bot rotation retains completed grant, fences pending work and requires a new start; replacement revokes", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    returned = await f.verify(flow),
    grant = await f.complete(flow, returned);
  const pending = await f.begin();
  f.grants.configure({ ...actor, generation: 2, enabled: true });
  await assert.rejects(f.grants.assert(actor), /bot_changed/);
  await assert.rejects(
    f.linking.open(pending.transaction.id, account, pending.browser),
    /bot_changed/,
  );
  const rotated = { ...actor, generation: 2 };
  await assert.rejects(f.grants.assert(rotated), /start_required/);
  f.grants.start(rotated);
  assert.equal((await f.grants.assert(rotated)).id, grant.id);
  f.grants.configure({
    ...rotated,
    botId: "90002",
    generation: 3,
    enabled: true,
  });
  assert.ok(f.grants.read(actor)?.revokedAt);
});
test("unlink blocks old completion replays and concurrent retry cannot resurrect it", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    returned = await f.verify(flow);
  await Promise.all([f.complete(flow, returned), f.complete(flow, returned)]);
  assert.equal(f.grants.unlink(actor, account.accountId), true);
  await assert.rejects(f.complete(flow, returned), /link_revoked/);
  await assert.rejects(f.grants.assert(actor), /connection_required/);
});
test("community HTTP requires existing session and CSRF; signup alone has no link; broker uses confidential backchannel", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const routes = telegramCommunityRoutes(
    f.linking,
    {
      origin: "https://community.example",
      scope: actor,
      account: async () => account,
      csrf: async (request) => request.headers.get("x-csrf") === "fixture-csrf",
    },
    managedFixture(f.grants).publication,
  );
  const status = await routes(
    new Request("https://community.example/api/telegram/connection"),
  );
  assert.equal(
    ((await status.json()) as { connected: boolean }).connected,
    false,
  );
  const reference = await f.linking.pending(actor);
  const start = (headers: Record<string, string>) =>
    routes(
      new Request("https://community.example/api/telegram/connect/start", {
        method: "POST",
        headers,
        body: JSON.stringify({ reference }),
      }),
    );
  assert.equal(
    (
      await start({
        origin: "https://attacker.example",
        "x-csrf": "fixture-csrf",
      })
    ).status,
    403,
  );
  assert.equal(
    (await start({ origin: "https://community.example" })).status,
    403,
  );
  const accepted = await start({
    origin: "https://community.example",
    "x-csrf": "fixture-csrf",
    "x-telegram-account": account.accountId,
  });
  assert.equal(accepted.status, 200);
  assert.match(
    accepted.headers.get("set-cookie")!,
    /Secure; HttpOnly; SameSite=Lax/,
  );
  assert.ok(
    accepted.headers
      .get("set-cookie")!
      .startsWith(TELEGRAM_CONNECT_COOKIE + "="),
  );
  const brokerRoutes = telegramBrokerRoutes(f.broker);
  const transport = (async (url, init) =>
    brokerRoutes(new Request(url, init))) as typeof fetch;
  const invalidClient = telegramBrokerClient(
    {
      origin: f.broker.origin,
      clientId: "community-client",
      clientSecret: "wrong",
    },
    transport,
  );
  const flow = await f.begin();
  await assert.rejects(
    invalidClient.request({
      id: randomToken(),
      clientId: "community-client",
      actor,
      requestDigest: "0x" + "1".repeat(64),
      communityState: randomToken(),
      expiresAt: f.now() + 1000,
      returnUrl: f.linking.returnUrl,
    }),
    /client_required/,
  );
  await assert.rejects(
    f.broker.request("community-client", {
      ...flow.transaction,
      id: randomToken(),
      clientId: "community-client",
      actor,
      communityState: randomToken(),
      requestDigest: "0x" + "1".repeat(64),
      returnUrl: "https://attacker.example/return",
    }),
    /request_invalid/,
  );
});
test("SQL transactions roll back changes and refuse accidentally asynchronous operations", () => {
  const f = journalFixture();
  assert.throws(
    () =>
      f.store.transaction(() => {
        f.store.set("test", 1);
        throw new Error("rollback");
      }),
    /rollback/,
  );
  assert.equal(f.store.get("test"), undefined);
  assert.throws(
    () =>
      f.store.transaction(() => {
        f.store.set("test", 2);
        return Promise.resolve(2);
      }),
    /async_transaction/,
  );
  assert.equal(f.store.get("test"), undefined);
  f.close();
});
test("website unlink and notification preferences remain available when bot delivery is disabled", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin();
  await f.complete(flow, await f.verify(flow));
  f.grants.configure({ ...actor, enabled: false });
  assert.equal(
    f.grants.setAccountPreferences(actor, account.accountId, {
      reminders: false,
      rewards: false,
      dance: false,
    }).reminders,
    false,
  );
  assert.equal(f.grants.unlink(actor, account.accountId), true);
  assert.equal(f.grants.forAccount(actor, account.accountId), null);
});
