import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TelegramLoginBroker,
  type TelegramBrokerClient,
} from "../services/telegram-broker.ts";
import { telegramBrokerClient } from "../services/telegram-broker-client.ts";
import {
  telegramBrokerRoutes,
  TELEGRAM_CONNECT_COOKIE,
} from "../services/telegram-http.ts";
import { TelegramLinking } from "../services/telegram-linking.ts";
import {
  TelegramRequestError,
  telegramConnectionClient,
} from "../apps/web/src/telegram/client.ts";
import { sha256 } from "../packages/telegram/security.ts";
import { journalFixture } from "./telegram-fixture.ts";
import {
  connectedFactoryFixture,
  deferred,
} from "./telegram-connected-factory-fixture.ts";

// UNRUN. Requires the coordinator's clock-aligned successor of 241b577 and its
// actual connected fixture. No fake account/session or expiry override. These
// are in-process real HTTP/broker/client handlers, never live provider calls.
async function fixture(port: number) {
  const f = await connectedFactoryFixture(port),
    brokerJournal = journalFixture();
  const clients: TelegramBrokerClient[] = [];
  const secret = "public_fixture_broker_channel_secret";
  const broker = new TelegramLoginBroker(
    brokerJournal.store,
    {
      origin: "https://login.example",
      redirectUri: "https://login.example/telegram/oidc/callback",
      oidcClientId: "fixture_oidc_client",
      clients,
    },
    {
      async exchange() {
        throw Error("fixture_unexpected_oidc_exchange");
      },
      async recover() {
        throw Error("fixture_unexpected_oidc_recovery");
      },
      async jwks() {
        throw Error("fixture_unexpected_oidc_jwks");
      },
    },
    f.shared.clock,
  );
  const routes = telegramBrokerRoutes(broker);
  let transportDown = false;
  const brokerIds: string[] = [],
    statuses: number[] = [];
  const portAdapter = telegramBrokerClient(
    {
      origin: broker.origin,
      clientId: f.options.brokerClientId,
      clientSecret: secret,
    },
    (async (url, init) => {
      if (transportDown) throw Error("fixture_broker_transport_down");
      const request = new Request(url, init);
      brokerIds.push(((await request.clone().json()) as { id: string }).id);
      const response = await routes(request);
      statuses.push(response.status);
      return response;
    }) as typeof fetch,
  );
  Object.assign(f.options.broker, portAdapter);
  f.restart();
  const linking = new TelegramLinking(
    f.factory.transitions.grants,
    f.options.broker,
    f.options.brokerClientId,
    f.options.origin + "/telegram/connect/return",
  );
  return {
    f,
    linking,
    brokerIds,
    statuses,
    brokerJournal,
    offline(value: boolean) {
      transportDown = value;
    },
    async configure() {
      clients.push({
        id: f.options.brokerClientId,
        communityId: f.actor.communityId,
        returnUrl: linking.returnUrl,
        secretHash: await sha256(secret),
      });
    },
    async dispose() {
      brokerJournal.close();
      await f.dispose();
    },
  };
}

test(
  "actual broker client-required 403 retains the same consumed community transaction through configuration recovery and lost acknowledgement",
  { timeout: 90000 },
  async () => {
    const x = await fixture(20351),
      { f } = x;
    try {
      const reference = await x.linking.pending(f.actor);
      let browserCookie = "",
        loseAck = false;
      const requests: unknown[] = [];
      const client = telegramConnectionClient({
        account: () => f.session.account_id,
        generation: () => 1,
        csrf: () => f.auth["x-csrf-token"],
        fetch: (async (path, init) => {
          const headers = new Headers(init?.headers);
          headers.set("origin", f.options.origin);
          headers.set(
            "cookie",
            f.auth.cookie + (browserCookie ? "; " + browserCookie : ""),
          );
          requests.push(JSON.parse(String(init?.body)));
          const response = await f.factory.routes(
            new Request(new URL(String(path), f.options.origin), {
              ...init,
              headers,
            }),
          );
          browserCookie =
            response.headers.get("set-cookie")?.split(";")[0] ?? browserCookie;
          if (loseAck) {
            loseAck = false;
            throw Error("fixture_lost_open_ack");
          }
          return response;
        }) as typeof fetch,
      });
      x.offline(true);
      let id = "";
      await assert.rejects(client.start(reference), (error) => {
        assert.ok(error instanceof TelegramRequestError);
        assert.equal(error.status, 503);
        assert.ok(error.transactionId);
        id = error.transactionId;
        return true;
      });
      x.offline(false);
      await assert.rejects(
        client.retryStart(),
        (error) =>
          error instanceof TelegramRequestError &&
          error.status === 403 &&
          error.code === "telegram_broker_client_required" &&
          error.transactionId === id,
      );
      assert.equal(client.pendingStart()?.transactionId, id);
      assert.deepEqual(x.statuses, [403]);
      assert.equal(requests.length, 2);
      const pending = f.journal.store.get<{ consumedBy: string }>(
        "pending:" + (await sha256(reference)),
      );
      assert.equal(pending?.consumedBy, id);
      await x.configure();
      loseAck = true;
      await assert.rejects(client.retryStart(id), /lost_open_ack/);
      const result = await client.retryStart();
      assert.equal(result.transactionId, id);
      assert.equal(
        new URL(result.navigationUrl).pathname,
        "/telegram/oidc/start",
      );
      assert.deepEqual(requests, [
        { reference },
        { transactionId: id },
        { transactionId: id },
        { transactionId: id },
      ]);
      assert.deepEqual(x.brokerIds, [id, id, id]);
      assert.deepEqual(x.statuses, [403, 200, 200]);
      assert.equal(f.journal.store.entries("link:").length, 1);
      assert.equal(x.brokerJournal.store.entries("broker:").length, 1);
      const wrong = await f.factory.routes(
        new Request(f.options.origin + "/api/telegram/connect/start", {
          method: "POST",
          headers: {
            ...f.auth,
            origin: f.options.origin,
            "x-telegram-account": f.session.account_id,
            "content-type": "application/json",
            cookie:
              f.auth.cookie +
              "; " +
              TELEGRAM_CONNECT_COOKIE +
              "=" +
              "z".repeat(43),
          },
          body: JSON.stringify({ transactionId: id }),
        }),
      );
      assert.equal(wrong.status, 403);
      assert.equal(
        ((await wrong.json()) as { error: string }).error,
        "telegram_browser_mismatch",
      );
      assert.equal(x.brokerIds.length, 3);
      assert.equal(f.shared.counts().calls, 0);
    } finally {
      await x.dispose();
    }
  },
);

test(
  "actual broker 403 body cannot transfer the reservation across a changed account",
  { timeout: 90000 },
  async () => {
    const x = await fixture(20352),
      { f } = x;
    try {
      let account = f.session.account_id;
      const reference = await x.linking.pending(f.actor),
        entered = deferred(),
        release = deferred();
      const client = telegramConnectionClient({
        account: () => account,
        generation: () => 1,
        csrf: () => f.auth["x-csrf-token"],
        fetch: (async (path, init) => {
          const headers = new Headers(init?.headers);
          headers.set("origin", f.options.origin);
          headers.set("cookie", f.auth.cookie);
          const response = await f.factory.routes(
            new Request(new URL(String(path), f.options.origin), {
              ...init,
              headers,
            }),
          );
          assert.equal(response.status, 403);
          const read = response.json.bind(response);
          response.json = async () => {
            entered.resolve();
            await release.promise;
            return read();
          };
          return response;
        }) as typeof fetch,
      });
      const pending = client.start(reference);
      await entered.promise;
      account = "different_account";
      release.resolve();
      await assert.rejects(pending, /account changed/);
      assert.equal(client.pendingStart(), null);
      await assert.rejects(client.retryStart());
      assert.equal(x.brokerIds.length, 1);
      assert.equal(f.journal.store.entries("link:").length, 1);
    } finally {
      await x.dispose();
    }
  },
);
