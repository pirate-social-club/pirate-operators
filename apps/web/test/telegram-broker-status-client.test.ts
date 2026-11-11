import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TelegramRequestError,
  telegramConnectionClient,
} from "../src/telegram/client.ts";

const reference = "r".repeat(43),
  id = "t".repeat(43),
  other = "u".repeat(43);
const ready = {
  transactionId: id,
  navigationUrl: "https://login.example/telegram/oidc/start?handle=fixture",
};
const unavailable = () =>
  Response.json(
    { error: "telegram_unavailable", transactionId: id },
    { status: 503 },
  );
const broker403 = (transactionId: unknown = id) =>
  Response.json(
    { error: "telegram_broker_client_required", transactionId },
    { status: 403 },
  );
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("broker 403 can introduce its reserved ID and preserve it through explicit retry and a lost acknowledgement", async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const client = telegramConnectionClient({
    account: () => "account-a",
    generation: () => 1,
    csrf: () => "csrf",
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      calls++;
      if (calls <= 2) return broker403();
      if (calls === 3) throw Error("fixture_lost_broker_ack");
      return Response.json(ready);
    }) as typeof fetch,
  });
  for (const operation of [
    () => client.start(reference),
    () => client.retryStart(),
  ]) {
    await assert.rejects(
      operation(),
      (error) =>
        error instanceof TelegramRequestError &&
        error.status === 403 &&
        error.code === "telegram_broker_client_required" &&
        error.transactionId === id,
    );
    assert.deepEqual(client.pendingStart(), {
      transactionId: id,
      phase: "resumable",
    });
  }
  assert.equal(calls, 2, "broker errors never trigger an automatic request");
  await assert.rejects(client.start(reference), /Resume or cancel/);
  await assert.rejects(client.retryStart(other), /No matching/);
  assert.equal(calls, 2);
  await assert.rejects(client.retryStart(id), /lost_broker_ack/);
  assert.equal(client.pendingStart()?.transactionId, id);
  assert.deepEqual(await client.retryStart(), ready);
  assert.deepEqual(bodies, [
    { reference },
    { transactionId: id },
    { transactionId: id },
    { transactionId: id },
  ]);
});

test("the same 403 status terminates only a proven community session failure", async () => {
  let calls = 0;
  const client = telegramConnectionClient({
    account: () => "account-a",
    generation: () => 1,
    csrf: () => "csrf",
    fetch: (async () =>
      ++calls === 1
        ? broker403()
        : Response.json(
            { error: "telegram_session_required", transactionId: id },
            { status: 403 },
          )) as typeof fetch,
  });
  await assert.rejects(client.start(reference));
  await assert.rejects(
    client.retryStart(),
    (error) =>
      error instanceof TelegramRequestError && error.transactionId === null,
  );
  assert.deepEqual(client.pendingStart(), {
    transactionId: null,
    phase: "invalid",
  });
  await assert.rejects(client.retryStart(id), /No matching/);
  assert.equal(calls, 2);
});

test("broker failure without a delivered transaction ID cannot create a resumable identity", async () => {
  let calls = 0;
  const client = telegramConnectionClient({
    account: () => "account-a",
    generation: () => 1,
    csrf: () => "csrf",
    fetch: (async () => {
      calls++;
      return Response.json(
        { error: "telegram_broker_client_required" },
        { status: 403 },
      );
    }) as typeof fetch,
  });
  await assert.rejects(
    client.start(reference),
    (error) =>
      error instanceof TelegramRequestError && error.transactionId === null,
  );
  assert.deepEqual(client.pendingStart(), {
    transactionId: null,
    phase: "unknown",
  });
  await assert.rejects(client.retryStart(id), /No matching/);
  assert.equal(calls, 1);
});

for (const candidate of [
  null,
  [id, other],
  { transactionId: id },
  "short",
  other,
])
  test(`broker 403 with ambiguous or foreign retry identity ${JSON.stringify(candidate)} cannot replace the original`, async () => {
    let calls = 0;
    const client = telegramConnectionClient({
      account: () => "account-a",
      generation: () => 1,
      csrf: () => "csrf",
      fetch: (async () =>
        ++calls === 1 ? unavailable() : broker403(candidate)) as typeof fetch,
    });
    await assert.rejects(client.start(reference));
    await assert.rejects(
      client.retryStart(),
      (error) =>
        error instanceof TelegramRequestError && error.transactionId === null,
    );
    assert.equal(client.pendingStart()?.transactionId, id);
    await assert.rejects(client.retryStart(other), /No matching/);
    assert.equal(calls, 2);
  });

for (const candidate of [null, [id, other], { transactionId: id }, "short"])
  test(`ambiguous initial broker ID ${JSON.stringify(candidate)} grants no resumable client identity`, async () => {
    let calls = 0;
    const client = telegramConnectionClient({
      account: () => "account-a",
      generation: () => 1,
      csrf: () => "csrf",
      fetch: (async () => {
        calls++;
        return broker403(candidate);
      }) as typeof fetch,
    });
    await assert.rejects(
      client.start(reference),
      (error) =>
        error instanceof TelegramRequestError && error.transactionId === null,
    );
    assert.deepEqual(client.pendingStart(), {
      transactionId: null,
      phase: "unknown",
    });
    await assert.rejects(client.retryStart(id), /No matching/);
    assert.equal(calls, 1);
  });

for (const boundary of ["account", "generation", "logout", "cancel"])
  test(`late broker 403 identity cannot cross ${boundary}`, async () => {
    let account = "account-a",
      generation = 1,
      calls = 0;
    const entered = gate(),
      release = gate();
    const client = telegramConnectionClient({
      account: () => account,
      generation: () => generation,
      csrf: () => "csrf",
      fetch: (async () => {
        calls++;
        return {
          ok: false,
          status: 403,
          async json() {
            entered.resolve();
            await release.promise;
            return {
              error: "telegram_broker_client_required",
              transactionId: id,
            };
          },
        } as Response;
      }) as typeof fetch,
    });
    const pending = client.start(reference);
    await entered.promise;
    if (boundary === "account") account = "account-b";
    if (boundary === "generation") generation++;
    if (boundary === "logout") account = "";
    if (boundary === "cancel") client.cancel();
    release.resolve();
    await assert.rejects(pending, /account changed/);
    assert.equal(client.pendingStart(), null);
    await assert.rejects(client.retryStart(id));
    assert.equal(calls, 1);
  });
