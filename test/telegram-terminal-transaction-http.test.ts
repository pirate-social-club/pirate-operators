import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramLinking } from "../services/telegram-linking.ts";
import {
  TelegramRequestError,
  telegramConnectionClient,
} from "../apps/web/src/telegram/client.ts";
import type { CommunityLinkTransaction } from "../packages/telegram/link-contracts.ts";
import { sha256 } from "../packages/telegram/security.ts";
import { connectedFactoryFixture } from "./telegram-connected-factory-fixture.ts";

// UNRUN. Requires the coordinator's clock-aligned combined fixture at 1fe7d771
// or its admitted successor. Real community routes, account/session, CSRF,
// cookie and linking journal; only the initial unavailable broker is a test
// transport. No production expiry override, fake session or provider request.
for (const mode of ["expiry", "missing"] as const)
  test(
    `actual community ${mode} terminates the original transaction before broker and sends no replacement`,
    { timeout: 90000 },
    async () => {
      const f = await connectedFactoryFixture(
        mode === "expiry" ? 20353 : 20354,
      );
      try {
        let brokerCalls = 0,
          browserCookie = "";
        f.options.broker.request = async () => {
          brokerCalls++;
          throw Error("fixture_broker_transport_unavailable");
        };
        f.restart();
        const linking = new TelegramLinking(
          f.factory.transitions.grants,
          f.options.broker,
          f.options.brokerClientId,
          f.options.origin + "/telegram/connect/return",
        );
        const reference = await linking.pending(f.actor);
        const sent: unknown[] = [],
          replies: { status: number; body: unknown }[] = [];
        const headers = (input?: HeadersInit) => {
          const result = new Headers(input);
          result.set("origin", f.options.origin);
          result.set(
            "cookie",
            f.auth.cookie + (browserCookie ? "; " + browserCookie : ""),
          );
          return result;
        };
        const client = telegramConnectionClient({
          account: () => f.session.account_id,
          generation: () => 1,
          csrf: () => f.auth["x-csrf-token"],
          fetch: (async (path, init) => {
            sent.push(JSON.parse(String(init?.body)));
            const response = await f.factory.routes(
              new Request(new URL(String(path), f.options.origin), {
                ...init,
                headers: headers(init?.headers),
              }),
            );
            browserCookie =
              response.headers.get("set-cookie")?.split(";")[0] ??
              browserCookie;
            replies.push({
              status: response.status,
              body: await response.clone().json(),
            });
            return response;
          }) as typeof fetch,
        });
        let id = "";
        await assert.rejects(client.start(reference), (error) => {
          assert.ok(error instanceof TelegramRequestError);
          assert.equal(error.status, 503);
          assert.ok(error.transactionId);
          assert.equal(error.transactionTerminated, false);
          id = error.transactionId;
          return true;
        });
        const original = f.journal.store.get<CommunityLinkTransaction>(
          "link:" + id,
        );
        assert.ok(original);
        assert.equal(brokerCalls, 1);
        if (mode === "expiry")
          f.shared.advance(original.expiresAt - f.shared.clock());
        else f.journal.store.delete("link:" + id); // task-owned in-memory test journal only
        const status = mode === "expiry" ? 410 : 404;
        const code =
          mode === "expiry"
            ? "telegram_connection_expired"
            : "telegram_connection_not_found";
        await assert.rejects(
          client.retryStart(id),
          (error) =>
            error instanceof TelegramRequestError &&
            error.status === status &&
            error.code === code &&
            error.transactionId === null &&
            error.transactionTerminated,
        );
        assert.deepEqual(replies[1], {
          status,
          body: { transactionId: id, error: code },
        });
        assert.deepEqual(client.pendingStart(), {
          transactionId: null,
          phase: "invalid",
        });
        assert.equal(
          brokerCalls,
          1,
          "authoritative terminal check occurs before broker request",
        );
        await assert.rejects(client.retryStart(), /No matching/);
        await assert.rejects(client.start(reference), /Resume or cancel/);
        await assert.rejects(client.start("n".repeat(43)), /Resume or cancel/);
        assert.deepEqual(sent, [{ reference }, { transactionId: id }]);
        assert.equal(
          f.journal.store.get<{ consumedBy: string }>(
            "pending:" + (await sha256(reference)),
          )?.consumedBy,
          id,
        );
        const replay = await f.factory.routes(
          new Request(f.options.origin + "/api/telegram/connect/start", {
            method: "POST",
            headers: headers({
              ...f.auth,
              "content-type": "application/json",
              "x-telegram-account": f.session.account_id,
            }),
            body: JSON.stringify({ reference }),
          }),
        );
        assert.equal(replay.status, mode === "expiry" ? 410 : 409);
        assert.equal(
          ((await replay.json()) as { error: string }).error,
          mode === "expiry"
            ? "telegram_connection_expired"
            : "telegram_connection_used",
        );
        const links =
          f.journal.store.entries<CommunityLinkTransaction>("link:");
        assert.equal(links.length, mode === "expiry" ? 1 : 0);
        if (mode === "expiry") assert.equal(links[0].value.id, id);
        assert.equal(brokerCalls, 1);
        assert.equal(f.shared.counts().calls, 0);
      } finally {
        await f.dispose();
      }
    },
  );
