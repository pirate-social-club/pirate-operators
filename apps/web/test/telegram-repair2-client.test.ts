import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramConnectionClient } from "../src/telegram/client.ts";

function delayedResponse(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>,
    entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const response = new Response(stream, {
      status,
      headers: { "content-type": "application/json" },
    }),
    read = response.json.bind(response);
  response.json = () => {
    entered();
    return read();
  };
  return {
    response,
    reading,
    finish(value: string) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
    fail() {
      controller.error(new Error("private-account-a-body-error"));
    },
  };
}

for (const mode of [
  "private-status",
  "server-error",
  "malformed-json",
  "body-error",
])
  test(`account switch during delayed JSON fences ${mode}`, async () => {
    let account = "account-a";
    const delayed = delayedResponse(mode === "server-error" ? 403 : 200);
    const client = telegramConnectionClient({
      account: () => account,
      generation: () => 0,
      csrf: () => "csrf",
      fetch: (async () => delayed.response) as typeof fetch,
    });
    const pending = client.status();
    await delayed.reading;
    account = "account-b";
    if (mode === "body-error") delayed.fail();
    else
      delayed.finish(
        mode === "malformed-json"
          ? "private-account-a-invalid-json"
          : JSON.stringify(
              mode === "server-error"
                ? { error: "private-account-a-server-error" }
                : {
                    connected: true,
                    linkedAt: 123,
                    preferences: {
                      reminders: true,
                      rewards: true,
                      dance: false,
                    },
                  },
            ),
      );
    await assert.rejects(
      pending,
      (error) =>
        error instanceof Error &&
        /account changed/.test(error.message) &&
        !/private-account-a/.test(error.message),
    );
  });

test("delayed completion body cannot acknowledge another account or consume its callback", async () => {
  let account = "account-a",
    calls = 0,
    replaced = false;
  const delayed = delayedResponse();
  const client = telegramConnectionClient({
    account: () => account,
    generation: () => 0,
    csrf: () => "csrf",
    fetch: (async () =>
      ++calls === 1
        ? Response.json({ state: "redeeming" })
        : delayed.response) as typeof fetch,
  });
  const pending = client.complete(
    new URL(
      "https://community.example/telegram/connect/return?transactionId=id&state=s&code=c",
    ),
    () => {
      replaced = true;
    },
  );
  await delayed.reading;
  account = "account-b";
  delayed.finish(JSON.stringify({ connected: true, linkedAt: 123 }));
  await assert.rejects(pending, /account changed/);
  assert.equal(replaced, false);
  assert.equal(calls, 2);
});

test("a delayed body still returns to its unchanged account", async () => {
  const delayed = delayedResponse(),
    client = telegramConnectionClient({
      account: () => "account-a",
      generation: () => 0,
      csrf: () => "csrf",
      fetch: (async () => delayed.response) as typeof fetch,
    });
  const pending = client.status();
  await delayed.reading;
  const expected = {
    connected: true,
    linkedAt: 123,
    preferences: { reminders: true, rewards: false, dance: false },
  };
  delayed.finish(JSON.stringify(expected));
  assert.deepEqual(await pending, expected);
});
