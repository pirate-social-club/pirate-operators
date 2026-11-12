import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TelegramRequestError,
  telegramConnectionClient,
} from "../apps/web/src/telegram/client.ts";
import { barrier } from "./telegram-repair1-fixture.ts";

test("a definite stale predecessor releases the cached operation for a later explicit action", async () => {
  const calls: {
    method: string;
    body: { operationId: string; expectedGrantId: string } | null;
  }[] = [];
  let current = "grant-A";
  // Pause the first status body after grant A was captured; B arrives before DELETE.
  const gate = barrier();
  let statuses = 0;
  const client = telegramConnectionClient({
    account: () => "account-one",
    generation: () => 0,
    csrf: () => "csrf",
    fetch: (async (_url, init) => {
      if (init?.method === "GET" && statuses++ === 0) {
        const value = {
          connected: true,
          grantId: current,
          unlinkOperation: null,
        };
        calls.push({ method: "GET", body: null });
        return {
          ok: true,
          status: 200,
          async json() {
            await gate.pause();
            return value;
          },
        } as Response;
      }
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init!.method!, body });
      if (init?.method === "GET")
        return Response.json({
          connected: true,
          grantId: current,
          unlinkOperation: null,
        });
      if (body.expectedGrantId !== current)
        return Response.json(
          { error: "telegram_unlink_predecessor_changed" },
          { status: 409 },
        );
      return Response.json({ unlinked: true });
    }) as typeof fetch,
  });
  const first = client.unlink();
  await gate.waiting;
  current = "grant-B";
  gate.release();
  await assert.rejects(first, /telegram_unlink_predecessor_changed/);
  assert.equal(
    calls.length,
    2,
    "a rejected action does not silently retry with a new intent",
  );
  await client.unlink();
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "DELETE", "GET", "DELETE"],
  );
  assert.equal(calls[1].body?.expectedGrantId, "grant-A");
  assert.equal(calls[3].body?.expectedGrantId, "grant-B");
  assert.notEqual(calls[1].body?.operationId, calls[3].body?.operationId);
});

for (const [status, code] of [
  [503, "telegram_unlink_predecessor_changed"],
  [409, "telegram_transition_conflict"],
] as const)
  test(`uncertain unlink ${status}/${code} retains the exact cached predecessor`, async () => {
    const bodies: unknown[] = [];
    let reads = 0,
      fail = true;
    const client = telegramConnectionClient({
      account: () => "account-one",
      generation: () => 0,
      csrf: () => "csrf",
      fetch: (async (_url, init) => {
        if (init?.method === "GET") {
          reads++;
          return Response.json({
            connected: true,
            grantId: "grant-A",
            unlinkOperation: null,
          });
        }
        bodies.push(JSON.parse(String(init!.body)));
        if (fail) {
          fail = false;
          return Response.json({ error: code }, { status });
        }
        return Response.json({ unlinked: true });
      }) as typeof fetch,
    });
    await assert.rejects(
      client.unlink(),
      (error) =>
        error instanceof TelegramRequestError &&
        error.status === status &&
        error.code === code,
    );
    await client.unlink();
    assert.equal(reads, 1);
    assert.deepEqual(bodies[0], bodies[1]);
  });

for (const body of [null, "unavailable", { error: 17 }])
  test(`unstructured error body ${JSON.stringify(body)} preserves uncertain unlink intent`, async () => {
    const requests: unknown[] = [];
    let fail = true;
    const client = telegramConnectionClient({
      account: () => "account-one",
      generation: () => 0,
      csrf: () => "csrf",
      fetch: (async (_url, init) => {
        if (init?.method === "GET")
          return Response.json({
            connected: true,
            grantId: "grant-A",
            unlinkOperation: null,
          });
        requests.push(JSON.parse(String(init!.body)));
        if (fail) {
          fail = false;
          return Response.json(body, { status: 503 });
        }
        return Response.json({ unlinked: true });
      }) as typeof fetch,
    });
    await assert.rejects(
      client.unlink(),
      (error) =>
        error instanceof TelegramRequestError &&
        error.status === 503 &&
        error.code === null,
    );
    await client.unlink();
    assert.deepEqual(requests[0], requests[1]);
  });

test("unlink retries retain the original operation after a lost response and replacement", async () => {
  const calls: { method: string; body: unknown }[] = [];
  let fail = true;
  const client = telegramConnectionClient({
    account: () => "account-one",
    generation: () => 0,
    csrf: () => "csrf",
    fetch: (async (_url, init) => {
      calls.push({
        method: init!.method!,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (init?.method === "GET")
        return Response.json({
          connected: true,
          grantId: "original_grant",
          unlinkOperation: null,
        });
      if (fail) {
        fail = false;
        throw Error("fixture_response_lost");
      }
      return Response.json({ unlinked: true });
    }) as typeof fetch,
  });
  await assert.rejects(client.unlink(), /response_lost/);
  await client.unlink();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].body, calls[2].body);
  assert.equal(
    (calls[1].body as { expectedGrantId: string }).expectedGrantId,
    "original_grant",
  );
});

test("reload resumes server-persisted unlink while no current grant exists", async () => {
  const operation = {
    operationId: "retained_operation_001",
    expectedGrantId: "old_grant",
    complete: false,
  };
  let body: unknown;
  const client = telegramConnectionClient({
    account: () => "account-one",
    generation: () => 0,
    csrf: () => "csrf",
    fetch: (async (_url, init) => {
      if (init?.method === "GET")
        return Response.json({
          connected: false,
          grantId: null,
          unlinkOperation: operation,
        });
      body = JSON.parse(String(init!.body));
      return Response.json({ unlinked: true });
    }) as typeof fetch,
  });
  await client.unlink();
  assert.deepEqual(body, {
    operationId: operation.operationId,
    expectedGrantId: operation.expectedGrantId,
  });
});

test("account change during unlink status body delivery sends no mutation", async () => {
  const gate = barrier();
  let account = "first",
    mutations = 0;
  const client = telegramConnectionClient({
    account: () => account,
    generation: () => 0,
    csrf: () => "csrf",
    fetch: (async (_url, init) => {
      if (init?.method !== "GET") mutations++;
      return {
        ok: true,
        async json() {
          await gate.pause();
          return {
            connected: true,
            grantId: "original_grant",
            unlinkOperation: null,
          };
        },
      } as Response;
    }) as typeof fetch,
  });
  const result = client.unlink();
  await gate.waiting;
  account = "second";
  gate.release();
  await assert.rejects(result, /account changed/);
  assert.equal(mutations, 0);
});
