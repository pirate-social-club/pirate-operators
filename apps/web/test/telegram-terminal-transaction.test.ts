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
const reserved = () =>
  Response.json(
    { error: "telegram_unavailable", transactionId: id },
    { status: 503 },
  );
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const [status, code] of [
  [410, "telegram_connection_expired"],
  [404, "telegram_connection_not_found"],
] as const)
  test(`correlated community ${status}/${code} invalidates retry without replaying a consumed reference`, async () => {
    const requests: unknown[] = [];
    const client = telegramConnectionClient({
      account: () => "account-a",
      generation: () => 1,
      csrf: () => "csrf",
      fetch: (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? reserved()
          : Response.json({ error: code, transactionId: id }, { status });
      }) as typeof fetch,
    });
    await assert.rejects(
      client.start(reference),
      (error) =>
        error instanceof TelegramRequestError &&
        error.transactionId === id &&
        !error.transactionTerminated,
    );
    await assert.rejects(
      client.retryStart(),
      (error) =>
        error instanceof TelegramRequestError &&
        error.status === status &&
        error.code === code &&
        error.transactionId === null &&
        error.transactionTerminated,
    );
    assert.deepEqual(client.pendingStart(), {
      transactionId: null,
      phase: "invalid",
    });
    await assert.rejects(client.retryStart(id), /No matching/);
    await assert.rejects(client.start(reference), /Resume or cancel/);
    await assert.rejects(client.start("n".repeat(43)), /Resume or cancel/);
    assert.deepEqual(requests, [{ reference }, { transactionId: id }]);
  });

for (const [status, code] of [
  [503, "telegram_connection_expired"],
  [403, "telegram_connection_expired"],
  [503, "telegram_connection_not_found"],
  [410, "telegram_connection_not_found"],
] as const)
  test(`terminal-looking code with ambiguous ${status}/${code} preserves the original intent`, async () => {
    let calls = 0;
    const requests: unknown[] = [];
    const client = telegramConnectionClient({
      account: () => "account-a",
      generation: () => 1,
      csrf: () => "csrf",
      fetch: (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return ++calls === 1
          ? reserved()
          : calls === 2
            ? Response.json({ error: code, transactionId: id }, { status })
            : Response.json(ready);
      }) as typeof fetch,
    });
    await assert.rejects(client.start(reference));
    await assert.rejects(
      client.retryStart(),
      (error) =>
        error instanceof TelegramRequestError &&
        !error.transactionTerminated &&
        error.transactionId === id,
    );
    assert.deepEqual(client.pendingStart(), {
      transactionId: id,
      phase: "resumable",
    });
    assert.equal(calls, 2);
    assert.deepEqual(await client.retryStart(), ready);
    assert.deepEqual(requests, [
      { reference },
      { transactionId: id },
      { transactionId: id },
    ]);
  });

for (const candidate of [undefined, null, "short", [id, other], other])
  test(`terminal metadata with uncorrelated ID ${JSON.stringify(candidate)} cannot retire or replace original T`, async () => {
    let calls = 0;
    const client = telegramConnectionClient({
      account: () => "account-a",
      generation: () => 1,
      csrf: () => "csrf",
      fetch: (async () =>
        ++calls === 1
          ? reserved()
          : Response.json(
              {
                error: "telegram_connection_expired",
                transactionId: candidate,
              },
              { status: 410 },
            )) as typeof fetch,
    });
    await assert.rejects(client.start(reference));
    await assert.rejects(
      client.retryStart(),
      (error) =>
        error instanceof TelegramRequestError &&
        !error.transactionTerminated &&
        error.transactionId === null,
    );
    assert.deepEqual(client.pendingStart(), {
      transactionId: id,
      phase: "resumable",
    });
    await assert.rejects(client.retryStart(other), /No matching/);
    assert.equal(calls, 2);
  });

test("broker403 remains resumable and cannot supply its own terminal flag", async () => {
  let calls = 0;
  const client = telegramConnectionClient({
    account: () => "account-a",
    generation: () => 1,
    csrf: () => "csrf",
    fetch: (async () =>
      ++calls === 1
        ? Response.json(
            {
              error: "telegram_broker_client_required",
              transactionId: id,
              transactionTerminated: true,
            },
            { status: 403 },
          )
        : Response.json(ready)) as typeof fetch,
  });
  await assert.rejects(
    client.start(reference),
    (error) =>
      error instanceof TelegramRequestError &&
      !error.transactionTerminated &&
      error.transactionId === id,
  );
  assert.deepEqual(client.pendingStart(), {
    transactionId: id,
    phase: "resumable",
  });
  assert.equal(calls, 1);
  assert.deepEqual(await client.retryStart(), ready);
  assert.equal(calls, 2);
});

test("a late terminal body cannot invalidate a replacement account's explicit intent", async () => {
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
      if (calls === 1) return reserved();
      if (calls === 3)
        return Response.json(
          { error: "telegram_broker_client_required", transactionId: other },
          { status: 403 },
        );
      return {
        ok: false,
        status: 410,
        async json() {
          entered.resolve();
          await release.promise;
          return { error: "telegram_connection_expired", transactionId: id };
        },
      } as Response;
    }) as typeof fetch,
  });
  await assert.rejects(client.start(reference));
  const late = client.retryStart();
  await entered.promise;
  account = "account-b";
  generation++;
  await assert.rejects(client.start("n".repeat(43)));
  assert.deepEqual(client.pendingStart(), {
    transactionId: other,
    phase: "resumable",
  });
  release.resolve();
  await assert.rejects(late, /account changed/);
  assert.deepEqual(client.pendingStart(), {
    transactionId: other,
    phase: "resumable",
  });
  assert.equal(calls, 3);
});
