// Real Durable Object storage operations, not an in-memory queue substitute.
// Native workerd transactions/alarms and crash recovery remain UNRUN.
export class QueueFailure extends Error {
  readonly status: number;
  constructor(code: string, status = 500) { super(code); this.status = status; }
}
export function requireQueue(value: unknown, code: string, status = 500): asserts value {
  if (!value) throw new QueueFailure(code, status);
}
export const integer = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high;
export type QueueFormat = "text" | "json" | "bytes" | "v8";
export interface QueueConfiguration {
  version: 1;
  // Opaque audited installation scope. Never derive this solely from a shared
  // registry address/chain or infer namespace authority from it.
  scope: string;
  name: string;
  batchSize: number;
  maxAttempts: number;
  leaseMs: number;
  retryDelaySeconds: number;
  defaultDelaySeconds: number;
  maxEntries: number;
  maxBytes: number;
}
export interface IncomingQueueMessage {
  id?: string; timestamp?: number; format: QueueFormat; body: Uint8Array; delaySeconds: number;
}
export interface StoredQueueMessage {
  id: string; timestamp: number; format: QueueFormat; body: Uint8Array;
  attempts: number; nextAt: number; lease: string | null;
}
export interface QueueSettlement { id: string; ack: boolean; delaySeconds: number }
interface QueueStats { pending: number; dead: number; bytes: number; pendingBytes: number }
const idValid = (id: string) => id.length > 0 && id.length <= 128 && !/[^A-Za-z0-9_-]/.test(id);
const timeKey = (at: number, id: string) => "t:" + String(at).padStart(16, "0") + ":" + id;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);

export function queueConfiguration(value: unknown): QueueConfiguration {
  requireQueue(value !== null && typeof value === "object" && !Array.isArray(value), "queue_config_invalid");
  const c = value as Record<string, unknown>;
  const keys = ["version", "scope", "name", "batchSize", "maxAttempts", "leaseMs", "retryDelaySeconds", "defaultDelaySeconds", "maxEntries", "maxBytes"];
  requireQueue(Object.keys(c).length === keys.length && keys.every((key) => Object.hasOwn(c, key)), "queue_config_invalid");
  requireQueue(c.version === 1 && typeof c.scope === "string" && c.scope.length === 64 && /^[a-f0-9]{64}$/.test(c.scope), "queue_scope_invalid");
  requireQueue(typeof c.name === "string" && c.name.length > 0 && c.name.length <= 64 &&
    /^[a-z]/.test(c.name) && !/[^a-z0-9_-]/.test(c.name), "queue_name_invalid");
  requireQueue(integer(c.batchSize, 1, 100) && integer(c.maxAttempts, 1, 100) && integer(c.leaseMs, 30_000, 3_600_000) &&
    integer(c.retryDelaySeconds, 0, 86400) && integer(c.defaultDelaySeconds, 0, 86400) &&
    integer(c.maxEntries, 1, 100_000) && integer(c.maxBytes, 128_000, 256 * 1024 * 1024), "queue_config_limits_invalid");
  return { version: 1, scope: c.scope, name: c.name, batchSize: c.batchSize, maxAttempts: c.maxAttempts,
    leaseMs: c.leaseMs, retryDelaySeconds: c.retryDelaySeconds, defaultDelaySeconds: c.defaultDelaySeconds,
    maxEntries: c.maxEntries, maxBytes: c.maxBytes };
}

export class DurableQueueStore {
  readonly storage: DurableObjectStorage;
  readonly config: QueueConfiguration;
  constructor(storage: DurableObjectStorage, config: QueueConfiguration) {
    this.storage = storage; this.config = Object.freeze(queueConfiguration(config));
  }
  async stats(tx: DurableObjectTransaction): Promise<QueueStats> {
    const s = await tx.get<QueueStats>("stats");
    requireQueue(s && integer(s.pending, 0, this.config.maxEntries) && integer(s.dead, 0, this.config.maxEntries) &&
      s.pending + s.dead <= this.config.maxEntries && integer(s.bytes, 0, this.config.maxBytes) &&
      integer(s.pendingBytes, 0, s.bytes), "queue_stats_invalid");
    return s;
  }
  async schedule(tx: DurableObjectTransaction, stats: QueueStats, now: number) {
    const first = await tx.list<string>({ prefix: "t:", limit: 1 });
    if (stats.pending === 0) {
      requireQueue(first.size === 0, "queue_index_conflict"); await tx.deleteAlarm(); return;
    }
    requireQueue(first.size === 1, "queue_index_missing");
    const key = first.keys().next().value!;
    requireQueue(/^t:[0-9]{16}:/.test(key), "queue_index_invalid");
    const at = Number(key.slice(2, 18)); requireQueue(integer(at, 0, Number.MAX_SAFE_INTEGER), "queue_index_invalid");
    await tx.setAlarm(Math.max(now + 1, at));
  }
  async initialize() {
    await this.storage.transaction(async (tx) => {
      const identity = await tx.get<string>("identity"), expected = JSON.stringify(this.config);
      if (identity === undefined) {
        requireQueue((await tx.list({ limit: 1 })).size === 0, "queue_existing_state_not_adopted");
        await tx.put("identity", expected); await tx.put("stats", { pending: 0, dead: 0, bytes: 0, pendingBytes: 0 });
      } else requireQueue(identity === expected, "queue_identity_or_config_changed");
      const stats = await this.stats(tx);
      if (await tx.getAlarm() === null) await this.schedule(tx, stats, Date.now());
    });
    await this.storage.sync();
  }
  async enqueue(incoming: IncomingQueueMessage[]) {
    requireQueue(incoming.length > 0 && incoming.length <= 100, "queue_batch_count_invalid", 400);
    // Generate once outside the retryable transaction; automatic transaction
    // retries must not replace an intent's generated message identities.
    const prepared = incoming.map((message) => ({ ...message, timestampSupplied: message.timestamp !== undefined,
      id: message.id ?? crypto.randomUUID(),
      timestamp: message.timestamp ?? Date.now(), body: new Uint8Array(message.body) }));
    for (const m of prepared) requireQueue(typeof m.id === "string" && idValid(m.id) && integer(m.timestamp, 0, 8_640_000_000_000_000) &&
      ["text", "json", "bytes", "v8"].includes(m.format) && m.body.byteLength <= 128_000 &&
      integer(m.delaySeconds, 0, 86400), "queue_message_invalid", 400);
    requireQueue(prepared.reduce((sum, m) => sum + m.body.byteLength, 0) <= 288_000, "queue_batch_size_invalid", 413);
    await this.storage.transaction(async (tx) => {
      const stats = await this.stats(tx);
      for (const m of prepared) {
        const existing = await tx.get<StoredQueueMessage>("m:" + m.id) ?? await tx.get<StoredQueueMessage>("d:" + m.id);
        if (existing) {
          requireQueue(existing.format === m.format && sameBytes(existing.body, m.body) &&
            (!m.timestampSupplied || existing.timestamp === m.timestamp),
          "queue_message_identity_conflict", 409);
          continue;
        }
        requireQueue(stats.pending + stats.dead < this.config.maxEntries && stats.bytes + m.body.byteLength <= this.config.maxBytes,
          "queue_capacity_exhausted", 429);
        const row: StoredQueueMessage = { id: m.id, timestamp: m.timestamp, format: m.format, body: m.body,
          attempts: 0, nextAt: Date.now() + m.delaySeconds * 1000, lease: null };
        await tx.put("m:" + row.id, row); await tx.put(timeKey(row.nextAt, row.id), row.id);
        stats.pending++; stats.bytes += row.body.byteLength; stats.pendingBytes += row.body.byteLength;
      }
      await tx.put("stats", stats); await this.schedule(tx, stats, Date.now());
    });
    await this.storage.sync(); // No HTTP enqueue acknowledgement before durable storage.
  }
  async moveToDead(tx: DurableObjectTransaction, row: StoredQueueMessage, stats: QueueStats, reason: string) {
    await tx.put("d:" + row.id, { ...row, lease: null, deadAt: Date.now(), reason });
    await tx.delete("m:" + row.id); await tx.delete(timeKey(row.nextAt, row.id));
    stats.pending--; stats.dead++; stats.pendingBytes -= row.body.byteLength;
  }
  async claim(): Promise<StoredQueueMessage[]> {
    const claimed = await this.storage.transaction(async (tx) => {
      const now = Date.now(), stats = await this.stats(tx), rows: StoredQueueMessage[] = [];
      for (const [key, id] of await tx.list<string>({ prefix: "t:", limit: this.config.batchSize })) {
        const at = Number(key.slice(2, 18)); if (at > now) break;
        const row = await tx.get<StoredQueueMessage>("m:" + id);
        requireQueue(row && row.id === id && timeKey(row.nextAt, id) === key, "queue_index_conflict");
        if (row.attempts >= this.config.maxAttempts) { await this.moveToDead(tx, row, stats, "attempt-limit-or-uncertain-delivery"); continue; }
        await tx.delete(key); row.attempts++; row.lease = crypto.randomUUID(); row.nextAt = now + this.config.leaseMs;
        await tx.put("m:" + id, row); await tx.put(timeKey(row.nextAt, id), id); rows.push(row);
      }
      await tx.put("stats", stats); await this.schedule(tx, stats, now); return rows;
    });
    await this.storage.sync(); return claimed;
  }
  async settle(claimed: StoredQueueMessage[], decisions: QueueSettlement[]) {
    requireQueue(decisions.length === claimed.length && new Set(decisions.map((d) => d.id)).size === claimed.length,
      "queue_delivery_result_invalid");
    await this.storage.transaction(async (tx) => {
      const stats = await this.stats(tx);
      for (const previous of claimed) {
        const decision = decisions.find((d) => d.id === previous.id);
        requireQueue(decision && typeof decision.ack === "boolean" && integer(decision.delaySeconds, 0, 86400), "queue_delivery_result_invalid");
        const row = await tx.get<StoredQueueMessage>("m:" + previous.id);
        requireQueue(row && previous.lease !== null && row.lease === previous.lease && row.attempts === previous.attempts,
          "queue_delivery_lease_changed");
        if (decision.ack) {
          await tx.delete("m:" + row.id); await tx.delete(timeKey(row.nextAt, row.id));
          stats.pending--; stats.bytes -= row.body.byteLength; stats.pendingBytes -= row.body.byteLength;
        } else if (row.attempts >= this.config.maxAttempts) {
          await this.moveToDead(tx, row, stats, "consumer-failed-attempt-limit");
        } else {
          await tx.delete(timeKey(row.nextAt, row.id)); row.lease = null; row.nextAt = Date.now() + decision.delaySeconds * 1000;
          await tx.put("m:" + row.id, row); await tx.put(timeKey(row.nextAt, row.id), row.id);
        }
      }
      await tx.put("stats", stats); await this.schedule(tx, stats, Date.now());
    });
    await this.storage.sync();
  }
  async metrics() {
    const stats = await this.storage.transaction((tx) => this.stats(tx));
    return { backlogCount: stats.pending, backlogBytes: stats.pendingBytes, deadCount: stats.dead, retainedBytes: stats.bytes };
  }
  async deadMetadata() {
    const rows = await this.storage.list<StoredQueueMessage & { reason: string; deadAt: number }>({ prefix: "d:", limit: 10 });
    return [...rows.values()].map((row) => ({ id: row.id, timestamp: row.timestamp, attempts: row.attempts,
      reason: row.reason, deadAt: row.deadAt }));
  }
}
