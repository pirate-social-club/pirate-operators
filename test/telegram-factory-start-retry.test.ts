import { test } from "node:test";
import assert from "node:assert/strict";
import {
  telegramConnectionClient,
  TelegramRequestError,
} from "../apps/web/src/telegram/client.ts";
import { TelegramLinking } from "../services/telegram-linking.ts";
import { TELEGRAM_CONNECT_COOKIE } from "../services/telegram-http.ts";
import { sha256 } from "../packages/telegram/security.ts";
import {
  connectedFactoryFixture,
  deferred,
} from "./telegram-connected-factory-fixture.ts";

// UNRUN: actual factory, native HTTP/linking and SQL account/CSRF/cookie paths;
// explicit broker transport failure only. No identity provider is contacted.
test(
  "actual start error retains the consumed reference's transaction and explicitly resumes it after broker failure and lost HTTP acknowledgement",
  { timeout: 90000 },
  async () => {
    const f = await connectedFactoryFixture(20345);
    try {
      let failBroker = true,
        loseAck = false,
        browserCookie = "";
      const brokerIds: string[] = [],
        requests: Record<string, string>[] = [];
      f.options.broker.request = async (input) => {
        brokerIds.push(input.id);
        if (failBroker) throw Error("fixture_broker_unavailable");
        return {
          navigationUrl:
            "https://login.example/telegram/authorize?request=" + input.id,
        };
      };
      f.restart();
      const linking = new TelegramLinking(
        f.factory.transitions.grants,
        f.options.broker,
        f.options.brokerClientId,
        f.options.origin + "/telegram/connect/return",
      );
      const reference = await linking.pending(f.actor);
      const client = telegramConnectionClient({
        account: () => f.session.account_id,
        generation: () => 1,
        csrf: () => f.auth["x-csrf-token"],
        fetch: (async (path, init) => {
          const headers = new Headers(init?.headers);
          headers.set(
            "cookie",
            f.auth.cookie + (browserCookie ? "; " + browserCookie : ""),
          );
          headers.set("origin", f.options.origin);
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
            throw Error("fixture_lost_start_ack");
          }
          return response;
        }) as typeof fetch,
      });
      let id = "";
      await assert.rejects(client.start(reference), (error) => {
        assert.ok(error instanceof TelegramRequestError);
        assert.equal(error.status, 503);
        assert.ok(error.transactionId);
        id = error.transactionId;
        return true;
      });
      const consumed = f.journal.store.get<{ consumedBy: string }>(
        "pending:" + (await sha256(reference)),
      );
      assert.equal(consumed?.consumedBy, id);
      assert.ok(browserCookie.startsWith(TELEGRAM_CONNECT_COOKIE + "="));
      failBroker = false;
      loseAck = true;
      await assert.rejects(client.retryStart(id), /lost_start_ack/);
      assert.equal(client.pendingStart()?.transactionId, id);
      const result = await client.retryStart();
      assert.equal(result.transactionId, id);
      assert.deepEqual(requests, [
        { reference },
        { transactionId: id },
        { transactionId: id },
      ]);
      assert.deepEqual(brokerIds, [id, id, id]);
      assert.equal(f.journal.store.entries("link:").length, 1);
      const wrongBrowser = await f.factory.routes(
        new Request(f.options.origin + "/api/telegram/connect/start", {
          method: "POST",
          headers: {
            ...f.auth,
            origin: f.options.origin,
            "content-type": "application/json",
            "x-telegram-account": f.session.account_id,
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
      assert.equal(wrongBrowser.status, 403);
      assert.equal(f.journal.store.entries("link:").length, 1);
      assert.equal(f.shared.counts().calls, 0);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a real reserved start-error body arriving after account generation changes creates no client retry authority",
  { timeout: 90000 },
  async () => {
    const f = await connectedFactoryFixture(20346);
    try {
      let generation = 1;
      const bodyEntered = deferred(),
        bodyReleased = deferred();
      const linking = new TelegramLinking(
        f.factory.transitions.grants,
        f.options.broker,
        f.options.brokerClientId,
        f.options.origin + "/telegram/connect/return",
      );
      const reference = await linking.pending(f.actor);
      const client = telegramConnectionClient({
        account: () => f.session.account_id,
        generation: () => generation,
        csrf: () => f.auth["x-csrf-token"],
        fetch: (async (path, init) => {
          const response = await f.factory.routes(
            new Request(new URL(String(path), f.options.origin), {
              ...init,
              headers: {
                ...Object.fromEntries(new Headers(init?.headers)),
                origin: f.options.origin,
                cookie: f.auth.cookie,
              },
            }),
          );
          assert.equal(response.status, 503);
          const read = response.json.bind(response);
          response.json = async () => {
            bodyEntered.resolve();
            await bodyReleased.promise;
            return read();
          };
          return response;
        }) as typeof fetch,
      });
      const pending = client.start(reference);
      await bodyEntered.promise;
      generation++;
      bodyReleased.resolve();
      await assert.rejects(pending, /account changed/);
      assert.equal(client.pendingStart(), null);
      await assert.rejects(client.retryStart());
      assert.equal(
        f.journal.store.entries("link:").length,
        1,
        "server evidence is retained despite client context loss",
      );
    } finally {
      await f.dispose();
    }
  },
);
