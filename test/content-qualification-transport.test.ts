import test from "node:test";
import assert from "node:assert/strict";
import { qualificationTransport } from "../harness/content-qualification-transport.ts";

for (const paused of ["body", "fsync"] as const)
  test(`expiry while ${paused} is paused preserves the reservation and sends zero requests`, async () => {
    let now = 0,
      reserved = 0,
      sends = 0;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      body: "{}",
    });
    if (paused === "body")
      Object.defineProperty(request, "clone", {
        value: () => ({
          async arrayBuffer() {
            entered();
            await waiting;
            return new ArrayBuffer(2);
          },
        }),
      });
    const transport = qualificationTransport({
      deadline: 100,
      maxRequests: 8,
      maxRequestBytes: 8192,
      now: () => now,
      requests: () => reserved,
      async reserve() {
        reserved++;
        if (paused === "fsync") {
          entered();
          await waiting;
        }
      },
      async send() {
        sends++;
        return Response.json({});
      },
    });
    const result = transport.request(request);
    await started;
    now = 101;
    release();
    await assert.rejects(result, /qualification_deadline_expired/);
    assert.equal(reserved, 1);
    assert.equal(sends, 0);
  });
test("a current request sends once with a bounded signal; exhausted quota and expired windows send nothing", async () => {
  let now = 0,
    reserved = 0,
    sends = 0;
  const transport = qualificationTransport({
    deadline: 1000,
    maxRequests: 1,
    maxRequestBytes: 8192,
    now: () => now,
    requests: () => reserved,
    async reserve() {
      reserved++;
    },
    async send(request) {
      assert(!request.signal.aborted);
      sends++;
      return Response.json({});
    },
  });
  const request = () =>
    new Request("https://api.openai.com/v1/moderations", {
      method: "POST",
      body: "{}",
    });
  assert.equal((await transport.request(request())).status, 200);
  assert.equal(sends, 1);
  await assert.rejects(
    transport.request(request()),
    /qualification_request_bound/,
  );
  assert.equal(sends, 1);
  now = 1001;
  await assert.rejects(
    transport.request(request()),
    /qualification_request_bound/,
  );
  assert.equal(sends, 1);
});
