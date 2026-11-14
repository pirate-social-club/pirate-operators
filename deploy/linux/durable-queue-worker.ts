import { DurableObject } from "cloudflare:workers";
import { DurableQueueStore, QueueFailure, queueConfiguration, requireQueue } from "./durable-queue-store.ts";
import type { QueueSettlement } from "./durable-queue-store.ts";
import { incomingQueueMessages, nativeQueueMessages, queueSettlements } from "./durable-queue-protocol.ts";
import type { NativeQueueConsumer } from "./durable-queue-protocol.ts";

interface QueueEnvironment {
  QUEUE_CONFIGURATION: string;
  QUEUE_STATE: DurableObjectNamespace;
  CONSUMER: NativeQueueConsumer;
}
function unavailable(error: unknown) {
  // No consumer payload, raw exception, credentials or request body in output.
  return Response.json({ error: error instanceof QueueFailure ? error.message : "queue_internal_failure" },
    { status: error instanceof QueueFailure ? error.status : 503 });
}
export class PersistentQueue extends DurableObject<QueueEnvironment> {
  readonly #store: DurableQueueStore;
  readonly #ready: Promise<void>;
  constructor(ctx: DurableObjectState, env: QueueEnvironment) {
    super(ctx, env);
    requireQueue(typeof env.CONSUMER?.queue === "function", "queue_native_consumer_binding_missing");
    this.#store = new DurableQueueStore(ctx.storage, queueConfiguration(JSON.parse(env.QUEUE_CONFIGURATION)));
    // Initialization only. Never block concurrency across the consumer call:
    // the real handler may enqueue another job into this same queue.
    this.#ready = ctx.blockConcurrencyWhile(() => this.#store.initialize());
  }
  async fetch(request: Request): Promise<Response> {
    try {
      await this.#ready;
      const url = new URL(request.url);
      requireQueue(url.search === "", "queue_route_missing", 404);
      if (request.method === "GET" && url.pathname === "/metrics") return Response.json(await this.#store.metrics());
      if (request.method === "GET" && url.pathname === "/dead") return Response.json(await this.#store.deadMetadata());
      requireQueue(request.method === "POST" && ["/message", "/batch"].includes(url.pathname), "queue_route_missing", 404);
      await this.#store.enqueue(await incomingQueueMessages(request, url.pathname, this.#store.config));
      const metrics = await this.#store.metrics();
      return Response.json({ metadata: { metrics: { backlogCount: metrics.backlogCount, backlogBytes: metrics.backlogBytes } } });
    } catch (error) { return unavailable(error); }
  }
  async alarm(): Promise<void> {
    await this.#ready;
    // Persist the lease AND its next alarm before any real handler side effect.
    const rows = await this.#store.claim(); if (rows.length === 0) return;
    let decisions: QueueSettlement[];
    try {
      const metrics = await this.#store.metrics();
      const result = await this.env.CONSUMER.queue(this.#store.config.name, nativeQueueMessages(rows), {
        metrics: { backlogCount: metrics.backlogCount - rows.length,
          backlogBytes: metrics.backlogBytes - rows.reduce((sum, row) => sum + row.body.byteLength, 0) },
      });
      decisions = queueSettlements(rows, result, this.#store.config.retryDelaySeconds);
    } catch {
      decisions = rows.map((row) => ({ id: row.id, ack: false, delaySeconds: this.#store.config.retryDelaySeconds }));
    }
    // A failed settlement is not a success acknowledgement: preserve the lease
    // and throw so the persisted alarm can recover. Delivery is at least once.
    await this.#store.settle(rows, decisions);
  }
}

// PRIVATE service for workerd's native queue binding. Do not attach an ingress
// listener or route public requests here. No HTTP-to-application fake handler.
export default {
  async fetch(request: Request, env: QueueEnvironment): Promise<Response> {
    try {
      const config = queueConfiguration(JSON.parse(env.QUEUE_CONFIGURATION));
      const id = env.QUEUE_STATE.idFromName(config.scope + ":" + config.name);
      return await env.QUEUE_STATE.get(id).fetch(request);
    } catch (error) { return unavailable(error); }
  },
} satisfies ExportedHandler<QueueEnvironment>;
