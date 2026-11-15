import { integer, QueueFailure, requireQueue } from "./durable-queue-store.ts";
import type { IncomingQueueMessage, QueueConfiguration, QueueFormat, QueueSettlement, StoredQueueMessage } from "./durable-queue-store.ts";

// Native workerd's service_binding_extra_handlers interface, taken from the
// pinned experimental types and published broker. It is not an HTTP substitute
// for the application's real queue() handler. Actual native compatibility UNRUN.
export type NativeQueueMessage = {
  id: string; timestamp: Date; attempts: number;
} & ({ body: unknown } | { serializedBody: ArrayBuffer });
export interface NativeQueueConsumer {
  queue(name: string, messages: NativeQueueMessage[], metadata: {
    metrics: { backlogCount: number; backlogBytes: number };
  }): Promise<unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const decoder = new TextDecoder();
function format(value: unknown): QueueFormat {
  requireQueue(value === "text" || value === "json" || value === "bytes" || value === "v8", "queue_format_invalid", 400);
  return value;
}
function delay(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  requireQueue(integer(value, 0, 86400), "queue_delay_invalid", 400); return value;
}
function delayHeader(request: Request, fallback: number) {
  const raw = request.headers.get("X-Msg-Delay-Secs");
  if (raw === null) return fallback;
  requireQueue(/^[0-9]{1,5}$/.test(raw), "queue_delay_invalid", 400);
  return delay(Number(raw), fallback);
}
async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new QueueFailure("queue_body_too_large", 413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
function base64(value: unknown): Uint8Array {
  requireQueue(typeof value === "string" && value.length <= 170668 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), "queue_base64_invalid", 400);
  const decoded = atob(value);
  requireQueue(btoa(decoded) === value && decoded.length <= 128000, "queue_message_too_large_or_invalid", 413);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
function validPayload(message: IncomingQueueMessage) {
  // Reject malformed JSON at enqueue. V8 stays as native serialized bytes and
  // must be deserialized by workerd itself, never a hand-written decoder.
  if (message.format === "json") {
    try { JSON.parse(decoder.decode(message.body)); }
    catch { throw new QueueFailure("queue_json_invalid", 400); }
  }
  return message;
}
export async function incomingQueueMessages(request: Request, path: string, config: QueueConfiguration): Promise<IncomingQueueMessage[]> {
  const defaultDelay = delayHeader(request, config.defaultDelaySeconds);
  if (path === "/message") return [validPayload({
    format: format(request.headers.get("X-Msg-Fmt") ?? "v8"),
    body: await boundedBody(request, 128000), delaySeconds: defaultDelay,
  })];
  requireQueue(path === "/batch", "queue_route_missing", 404);
  let body: unknown;
  try { body = JSON.parse(decoder.decode(await boundedBody(request, 512000))); }
  catch (error) { if (error instanceof QueueFailure) throw error; throw new QueueFailure("queue_batch_invalid", 400); }
  requireQueue(object(body) && exactKeys(body, ["messages"]) && Array.isArray(body.messages) &&
    body.messages.length > 0 && body.messages.length <= 100, "queue_batch_invalid", 400);
  let bytes = 0;
  return body.messages.map((value: unknown) => {
    requireQueue(object(value) && exactKeys(value, ["id", "timestamp", "contentType", "body", "delaySecs"]), "queue_message_invalid", 400);
    requireQueue(value.id === undefined || (typeof value.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.id)), "queue_id_invalid", 400);
    requireQueue(value.timestamp === undefined || integer(value.timestamp, 0, 8_640_000_000_000_000), "queue_timestamp_invalid", 400);
    const body = base64(value.body); bytes += body.byteLength;
    requireQueue(bytes <= 288000, "queue_batch_too_large", 413);
    return validPayload({ id: value.id, timestamp: value.timestamp, body,
      format: format(value.contentType ?? "v8"), delaySeconds: delay(value.delaySecs, defaultDelay) });
  });
}
export function nativeQueueMessages(rows: StoredQueueMessage[]): NativeQueueMessage[] {
  return rows.map((row) => {
    const common = { id: row.id, timestamp: new Date(row.timestamp), attempts: row.attempts };
    // Copy into an owned ArrayBuffer, not a view with an unrelated byte range.
    const bytes = new Uint8Array(row.body).buffer;
    if (row.format === "v8") return { ...common, serializedBody: bytes };
    if (row.format === "bytes") return { ...common, body: bytes };
    const text = decoder.decode(row.body);
    return { ...common, body: row.format === "json" ? JSON.parse(text) : text };
  });
}
export function queueSettlements(rows: StoredQueueMessage[], result: unknown, defaultDelay: number): QueueSettlement[] {
  requireQueue(object(result) && typeof result.outcome === "string" && typeof result.ackAll === "boolean" &&
    object(result.retryBatch) && typeof result.retryBatch.retry === "boolean" && Array.isArray(result.explicitAcks) &&
    Array.isArray(result.retryMessages), "queue_consumer_result_invalid");
  const ids = new Set(rows.map((row) => row.id)), ack = new Set<string>(), retry = new Map<string, number>();
  const retryBatch = result.retryBatch, ackAll = result.ackAll, outcome = result.outcome;
  requireQueue(!(ackAll && retryBatch.retry), "queue_consumer_actions_conflict");
  const batchDelay = delay(retryBatch.delaySeconds, defaultDelay);
  for (const id of result.explicitAcks) {
    requireQueue(typeof id === "string" && ids.has(id) && !ack.has(id), "queue_consumer_ack_invalid"); ack.add(id);
  }
  for (const item of result.retryMessages) {
    requireQueue(object(item) && typeof item.msgId === "string" && ids.has(item.msgId) &&
      !retry.has(item.msgId) && !ack.has(item.msgId), "queue_consumer_retry_invalid");
    retry.set(item.msgId, delay(item.delaySeconds, batchDelay));
  }
  // Explicit per-message actions override batch actions, as in the native API.
  // An invalid result is rejected as a whole; the caller retains/retries all.
  return rows.map((row) => ({ id: row.id,
    ack: ack.has(row.id) || (!retry.has(row.id) && (ackAll || (!retryBatch.retry && outcome === "ok"))),
    delaySeconds: retry.get(row.id) ?? batchDelay,
  }));
}
