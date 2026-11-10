import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramConnectionClient } from "../src/telegram/client.ts";

test("Telegram settings use existing same-origin session, CSRF and explicit account binding", async () => {
  const calls: RequestInit[] = [];
  const client = telegramConnectionClient({
    account: () => "account-one",
    csrf: () => "session-csrf",
    fetch: (async (_url, init) => {
      calls.push(init!);
      return Response.json({ unlinked: true });
    }) as typeof fetch,
  });
  await client.unlink();
  assert.equal(calls[0].credentials, "same-origin");
  assert.equal(calls[0].redirect, "error");
  const headers = new Headers(calls[0].headers);
  assert.equal(headers.get("x-telegram-account"), "account-one");
  assert.equal(headers.get("x-csrf-token"), "session-csrf");
});
test("account switching fences old responses; completion removes callback only after server acknowledgement", async () => {
  let account = "first";
  const switching = telegramConnectionClient({
    account: () => account,
    csrf: () => "csrf",
    fetch: (async () => {
      account = "second";
      return Response.json({ connected: true });
    }) as typeof fetch,
  });
  await assert.rejects(switching.status(), /account changed/);
  const paths: string[] = [];
  const client = telegramConnectionClient({
    account: () => "first",
    csrf: () => "csrf",
    fetch: (async (path) => {
      paths.push(String(path));
      return Response.json({ connected: true });
    }) as typeof fetch,
  });
  let replaced = "";
  await client.complete(
    new URL(
      "https://community.example/telegram/connect/return?transactionId=id&state=state&code=one-use",
    ),
    (value) => {
      replaced = value;
    },
  );
  assert.equal(paths.length, 2);
  assert.equal(paths[1], "/api/telegram/connect/complete");
  assert.equal(replaced, "/telegram/connect/return");
});
test("uncertain completion retains the callback for a same-transaction retry and rejects parameter pollution", async () => {
  const client = telegramConnectionClient({
    account: () => "first",
    csrf: () => "csrf",
    fetch: (async () =>
      Response.json(
        { error: "telegram_exchange_pending" },
        { status: 503 },
      )) as typeof fetch,
  });
  let replaced = false;
  await assert.rejects(
    client.complete(
      new URL(
        "https://community.example/telegram/connect/return?transactionId=id&state=s&code=c",
      ),
      () => {
        replaced = true;
      },
    ),
    /pending/,
  );
  assert.equal(replaced, false);
  await assert.rejects(
    client.complete(
      new URL(
        "https://community.example/telegram/connect/return?transactionId=id&state=s&state=t&code=c",
      ),
      () => {},
    ),
    /invalid/,
  );
});
