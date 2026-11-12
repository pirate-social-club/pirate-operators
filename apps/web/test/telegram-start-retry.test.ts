import { test } from "node:test";
import assert from "node:assert/strict";
import {
  telegramConnectionClient,
  TelegramRequestError,
} from "../src/telegram/client.ts";

const reference = "r".repeat(43),
  id = "t".repeat(43),
  otherId = "u".repeat(43);
const ready = {
  transactionId: id,
  navigationUrl: "https://login.example/telegram/authorize",
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("server-reserved ID survives a start error and explicit retries keep the same transaction across a lost acknowledgement", async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const client = telegramConnectionClient({
    account: () => "account-a",
    generation: () => 1,
    csrf: () => "csrf",
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      assert.equal(init?.credentials, "same-origin");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("x-telegram-account"),
        "account-a",
      );
      assert.equal(new Headers(init?.headers).get("x-csrf-token"), "csrf");
      if (++calls === 1)
        return Response.json(
          { transactionId: id, error: "telegram_unavailable" },
          { status: 503 },
        );
      if (calls === 2) throw Error("fixture_lost_open_ack");
      return Response.json(ready);
    }) as typeof fetch,
  });
  await assert.rejects(
    client.start(reference),
    (e) =>
      e instanceof TelegramRequestError &&
      e.transactionId === id &&
      e.status === 503,
  );
  assert.deepEqual(client.pendingStart(), {
    transactionId: id,
    phase: "resumable",
  });
  await assert.rejects(client.start(reference), /Resume or cancel/);
  await assert.rejects(client.retryStart(otherId), /No matching/);
  assert.equal(calls, 1, "no automatic reserve or foreign transaction retry");
  await assert.rejects(client.retryStart(id), /lost_open_ack/);
  assert.equal(client.pendingStart()?.transactionId, id);
  assert.deepEqual(await client.retryStart(), ready);
  assert.deepEqual(bodies, [
    { reference },
    { transactionId: id },
    { transactionId: id },
  ]);
});

for (const candidate of [
  null,
  "",
  "short",
  "t".repeat(42),
  "t".repeat(44),
  "t".repeat(42) + "/",
  3,
  {},
  [],
])
  test(`malformed start ID ${JSON.stringify(candidate)} cannot become retry state`, async () => {
    let calls = 0;
    const client = telegramConnectionClient({
      account: () => "account-a",
      generation: () => 1,
      csrf: () => "csrf",
      fetch: (async () => {
        calls++;
        return Response.json(
          { transactionId: candidate, error: "telegram_unavailable" },
          { status: 503 },
        );
      }) as typeof fetch,
    });
    await assert.rejects(
      client.start(reference),
      (e) => e instanceof TelegramRequestError && e.transactionId === null,
    );
    assert.equal(client.pendingStart()?.transactionId, null);
    await assert.rejects(client.retryStart(id), /No matching/);
    assert.equal(calls, 1);
    await assert.rejects(client.start(reference), /Resume or cancel/);
    assert.equal(calls, 1);
  });

for (const status of [401, 403, 404, 410])
  test(`definite start failure ${status} invalidates a previously retained transaction`, async () => {
    let calls = 0;
    const client = telegramConnectionClient({
      account: () => "account-a",
      generation: () => 1,
      csrf: () => "csrf",
      fetch: (async () =>
        ++calls === 1
          ? Response.json(
              { error: "telegram_unavailable", transactionId: id },
              { status: 503 },
            )
          : Response.json(
              { error: "telegram_session_required", transactionId: otherId },
              { status },
            )) as typeof fetch,
    });
    await assert.rejects(client.start(reference));
    await assert.rejects(
      client.retryStart(),
      (e) => e instanceof TelegramRequestError && e.transactionId === null,
    );
    assert.deepEqual(client.pendingStart(), {
      transactionId: null,
      phase: "invalid",
    });
    await assert.rejects(client.retryStart(id), /No matching/);
    assert.equal(calls, 2);
  });

test("an authority error does not retain a server ID even when a transport reports 503", async () => {
  const client = telegramConnectionClient({
    account: () => "account-a",
    generation: () => 1,
    csrf: () => "csrf",
    fetch: (async () =>
      Response.json(
        { error: "telegram_authority_changed", transactionId: id },
        { status: 503 },
      )) as typeof fetch,
  });
  await assert.rejects(
    client.start(reference),
    (e) => e instanceof TelegramRequestError && e.transactionId === null,
  );
  assert.deepEqual(client.pendingStart(), {
    transactionId: null,
    phase: "invalid",
  });
  await assert.rejects(client.retryStart(id), /No matching/);
});

for (const status of [200, 503])
  test(`a mismatched ID in retry response ${status} never replaces the original transaction`, async () => {
    let calls = 0;
    const client = telegramConnectionClient({
      account: () => "account-a",
      generation: () => 1,
      csrf: () => "csrf",
      fetch: (async () =>
        ++calls === 1
          ? Response.json(
              { error: "telegram_unavailable", transactionId: id },
              { status: 503 },
            )
          : Response.json(
              status === 200
                ? { ...ready, transactionId: otherId }
                : { error: "telegram_unavailable", transactionId: otherId },
              { status },
            )) as typeof fetch,
    });
    await assert.rejects(client.start(reference));
    await assert.rejects(
      client.retryStart(),
      (e) => !(e instanceof TelegramRequestError) || e.transactionId === null,
    );
    assert.equal(client.pendingStart()?.transactionId, id);
  });

for (const boundary of [
  "account",
  "logout",
  "generation",
  "account-ABA",
  "cancel",
])
  test(`late start-error JSON cannot retain a transaction across ${boundary}`, async () => {
    let account = "account-a",
      generation = 1;
    const entered = gate(),
      finish = gate();
    const client = telegramConnectionClient({
      account: () => account,
      generation: () => generation,
      csrf: () => "csrf",
      fetch: (async () =>
        ({
          ok: false,
          status: 503,
          async json() {
            entered.resolve();
            await finish.promise;
            return { error: "telegram_unavailable", transactionId: id };
          },
        }) as Response) as typeof fetch,
    });
    const pending = client.start(reference);
    await entered.promise;
    if (boundary === "account") account = "account-b";
    if (boundary === "logout") account = "";
    if (boundary === "generation") generation++;
    if (boundary === "account-ABA") {
      account = "account-b";
      generation++;
      account = "account-a";
      generation++;
    }
    if (boundary === "cancel") client.cancel();
    finish.resolve();
    await assert.rejects(pending, /account changed/);
    assert.equal(client.pendingStart(), null);
    await assert.rejects(client.retryStart(id));
  });

test("transport failure without a delivered server ID keeps an unknown intent and does not reserve again", async () => {
  let calls = 0;
  const client = telegramConnectionClient({
    account: () => "account-a",
    generation: () => 1,
    csrf: () => "csrf",
    fetch: (async () => {
      calls++;
      throw Error("fixture_unknown_start");
    }) as typeof fetch,
  });
  await assert.rejects(client.start(reference), /unknown_start/);
  assert.deepEqual(client.pendingStart(), {
    transactionId: null,
    phase: "unknown",
  });
  await assert.rejects(client.start(reference), /Resume or cancel/);
  await assert.rejects(client.retryStart(id), /No matching/);
  assert.equal(calls, 1);
  client.cancel();
  assert.equal(client.pendingStart(), null);
});

test("a callback uses one captured account/generation across inspection, completion and URL acknowledgement", async () => {
  let generation = 1,
    calls = 0,
    replaced = false;
  const entered = gate(),
    release = gate();
  const client = telegramConnectionClient({
    account: () => "account-a",
    generation: () => generation,
    csrf: () => "csrf",
    fetch: (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        async json() {
          entered.resolve();
          await release.promise;
          return { state: "redeeming" };
        },
      } as Response;
    }) as typeof fetch,
  });
  const pending = client.complete(
    new URL(
      `https://community.example/telegram/connect/return?transactionId=${id}&state=s&code=c`,
    ),
    () => {
      replaced = true;
    },
  );
  await entered.promise;
  generation++;
  release.resolve();
  await assert.rejects(pending, /account changed/);
  assert.equal(calls, 1);
  assert.equal(replaced, false);
});
