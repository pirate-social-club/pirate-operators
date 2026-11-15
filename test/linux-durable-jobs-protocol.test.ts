import assert from "node:assert/strict";
import { test } from "node:test";
import { incomingQueueMessages, nativeQueueMessages, queueSettlements } from "../deploy/linux/durable-queue-protocol.ts";
import { QueueFailure, queueConfiguration } from "../deploy/linux/durable-queue-store.ts";
import type { StoredQueueMessage } from "../deploy/linux/durable-queue-store.ts";

// Protocol boundary regressions only, not fake storage or a queue consumer.
// Actual disk persistence, native bindings, delivery and restart are separate.
const config = queueConfiguration({ version: 1, scope: "1".repeat(64), name: "jobs", batchSize: 10, maxAttempts: 3,
  leaseMs: 30000, retryDelaySeconds: 60, defaultDelaySeconds: 0, maxEntries: 100, maxBytes: 1000000 });
const row = (id: string): StoredQueueMessage => ({ id, timestamp: 123, attempts: 1, format: "bytes",
  body: new Uint8Array([1, 2, 3]), nextAt: 200, lease: "fixture-lease" });
const failure = (status: number) => (error: unknown) => error instanceof QueueFailure && error.status === status;

test("explicit acknowledgements survive another message's failed delivery and batch retry", () => {
  const rows = [row("done"), row("retry"), row("unfinished")];
  assert.deepEqual(queueSettlements(rows, { outcome: "exception", ackAll: false,
    retryBatch: { retry: true, delaySeconds: 70 }, explicitAcks: ["done"],
    retryMessages: [{ msgId: "retry", delaySeconds: 120 }] }, 60), [
    { id: "done", ack: true, delaySeconds: 70 }, { id: "retry", ack: false, delaySeconds: 120 },
    { id: "unfinished", ack: false, delaySeconds: 70 },
  ]);
  assert.deepEqual(queueSettlements(rows, { outcome: "ok", ackAll: true,
    retryBatch: { retry: false }, explicitAcks: [], retryMessages: [{ msgId: "retry", delaySeconds: 0 }] }, 60), [
    { id: "done", ack: true, delaySeconds: 60 }, { id: "retry", ack: false, delaySeconds: 0 },
    { id: "unfinished", ack: true, delaySeconds: 60 },
  ]);
});

test("unknown, contradictory and invalid consumer actions cannot become acknowledgements", () => {
  const result = { outcome: "ok", ackAll: false, retryBatch: { retry: false }, explicitAcks: [], retryMessages: [] };
  assert.throws(() => queueSettlements([row("a")], { ...result, explicitAcks: ["other"] }, 60), failure(500));
  assert.throws(() => queueSettlements([row("a")], { ...result, explicitAcks: ["a"], retryMessages: [{ msgId: "a" }] }, 60), failure(500));
  assert.throws(() => queueSettlements([row("a")], { ...result, retryMessages: [{ msgId: "a", delaySeconds: -1 }] }, 60), failure(400));
  assert.throws(() => queueSettlements([row("a")], { ...result, ackAll: true, retryBatch: { retry: true } }, 60), failure(500));
});

test("actual streamed bytes enforce message size even when headers claim a small body", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(64000)); controller.enqueue(new Uint8Array(64001)); controller.close();
  } });
  const request = new Request("http://private.invalid/message", {
    method: "POST", body: stream, headers: { "Content-Length": "1", "X-Msg-Fmt": "bytes" }, duplex: "half",
  } as RequestInit);
  await assert.rejects(incomingQueueMessages(request, "/message", config), failure(413));
});

test("batch payload validation preserves native envelopes and enforces aggregate bytes", async () => {
  const batch = (messages: unknown[]) => new Request("http://private.invalid/batch", {
    method: "POST", body: JSON.stringify({ messages }), headers: { "X-Msg-Delay-Secs": "5" },
  });
  const json = Buffer.from('{"jobId":"intent-1"}').toString("base64");
  const messages = await incomingQueueMessages(batch([
    { contentType: "json", body: json }, { contentType: "bytes", body: "AAEC", delaySecs: 0 },
  ]), "/batch", config);
  assert.equal(messages[0].delaySeconds, 5); assert.equal(messages[1].delaySeconds, 0);
  assert.equal(new TextDecoder().decode(messages[0].body), '{"jobId":"intent-1"}');
  assert.deepEqual(messages[1].body, new Uint8Array([0, 1, 2]));
  const large = { contentType: "bytes", body: Buffer.alloc(100000).toString("base64") };
  await assert.rejects(incomingQueueMessages(batch([large, large, large]), "/batch", config), failure(413));
  await assert.rejects(incomingQueueMessages(batch([{ contentType: "json", body: "ew==" }]), "/batch", config), failure(400));
  await assert.rejects(incomingQueueMessages(batch([{ contentType: "bytes", body: "AAE" }]), "/batch", config), failure(400));
});

test("serialized native values retain only their original byte range in an owned buffer", () => {
  const original = new Uint8Array([99, 1, 2, 88]);
  const message = { ...row("v8"), format: "v8" as const, body: original.subarray(1, 3) };
  const [native] = nativeQueueMessages([message]);
  assert("serializedBody" in native); original.fill(0);
  assert.deepEqual(new Uint8Array(native.serializedBody), new Uint8Array([1, 2]));
  assert.equal(native.timestamp.getTime(), 123); assert.equal(native.attempts, 1);
  // This intentionally does not claim those arbitrary bytes are valid V8.
  // Genuine serialization/deserialization belongs to the native producer test.
});

test("an old contract address or extra legacy identity fields cannot be a queue scope", () => {
  assert.throws(() => queueConfiguration({ ...config, scope: "0x" + "1".repeat(40) }), failure(500));
  assert.throws(() => queueConfiguration({ ...config, scope: config.scope + "\n" }), failure(500));
  assert.throws(() => queueConfiguration({ ...config, chainId: 6343 }), failure(500));
  // A syntactically valid opaque scope is not namespace authorization. The
  // owning runtime must supply a verified binding after the registry handback.
});
