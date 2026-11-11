import assert from "node:assert/strict";
import { test } from "node:test";
import { telegramConnectionClient } from "../apps/web/src/telegram/client.ts";
import { barrier } from "./telegram-repair1-fixture.ts";

test("unlink retries retain the original operation after a lost response and replacement", async () => {
  const calls: { method: string; body: unknown }[] = [];
  let fail = true;
  const client = telegramConnectionClient({
    account: () => "account-one",
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
