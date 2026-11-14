import { DurableObject } from "cloudflare:workers";
import { integer, QueueFailure, requireQueue } from "./durable-queue-store.ts";

// A fixed-interval recovery scan for the actual community scheduled handler.
// Missed intervals coalesce; this is not a general cron/workflows replacement.
interface MaintenanceConfiguration {
  version: 1; scope: string; name: string;
  intervalSeconds: number; retryDelaySeconds: number; leaseMs: number;
}
interface Tick {
  id: string; scheduledAt: number; attempts: number; lease: string | null;
}
interface MaintenanceState {
  nextAt: number; tick: Tick;
  last: { id: string; scheduledAt: number; completedAt: number; attempts: number; outcome: "ok" | "failed-no-retry" } | null;
}
interface MaintenanceEnvironment {
  MAINTENANCE_CONFIGURATION: string;
  MAINTENANCE_STATE: DurableObjectNamespace;
  CONSUMER: { scheduled(options: { scheduledTime: Date }): Promise<unknown> };
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && value.length === 36 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function configuration(json: string): MaintenanceConfiguration {
  const c: unknown = JSON.parse(json);
  requireQueue(object(c) && Object.keys(c).length === 6 && c.version === 1 &&
    typeof c.scope === "string" && c.scope.length === 64 && /^[a-f0-9]{64}$/.test(c.scope) &&
    typeof c.name === "string" && c.name.length > 0 && c.name.length <= 64 &&
    /^[a-z]/.test(c.name) && !/[^a-z0-9_-]/.test(c.name) &&
    integer(c.intervalSeconds, 1, 86400) && integer(c.retryDelaySeconds, 1, 86400) &&
    integer(c.leaseMs, 30_000, 3_600_000), "maintenance_config_invalid");
  return Object.freeze({ version: 1, scope: c.scope, name: c.name, intervalSeconds: c.intervalSeconds,
    retryDelaySeconds: c.retryDelaySeconds, leaseMs: c.leaseMs });
}
function unavailable(error: unknown) {
  return Response.json({ error: error instanceof QueueFailure ? error.message : "maintenance_internal_failure" },
    { status: error instanceof QueueFailure ? error.status : 503 });
}
export class PersistentMaintenance extends DurableObject<MaintenanceEnvironment> {
  readonly #config: MaintenanceConfiguration;
  readonly #ready: Promise<void>;
  constructor(ctx: DurableObjectState, env: MaintenanceEnvironment) {
    super(ctx, env);
    requireQueue(typeof env.CONSUMER?.scheduled === "function", "maintenance_native_consumer_binding_missing");
    this.#config = configuration(env.MAINTENANCE_CONFIGURATION);
    this.#ready = ctx.blockConcurrencyWhile(() => this.#initialize());
  }
  async #state(tx: DurableObjectTransaction) {
    const state = await tx.get<MaintenanceState>("state");
    requireQueue(state && Object.keys(state).length === 3 && integer(state.nextAt, 0, 8_640_000_000_000_000) &&
      state.tick && Object.keys(state.tick).length === 4 && uuid(state.tick.id) &&
      integer(state.tick.scheduledAt, 0, 8_640_000_000_000_000) && integer(state.tick.attempts, 0, Number.MAX_SAFE_INTEGER) &&
      (state.tick.lease === null || uuid(state.tick.lease)),
    "maintenance_state_invalid");
    const last = state.last;
    requireQueue(last === null || (object(last) && Object.keys(last).length === 5 && uuid(last.id) &&
      integer(last.scheduledAt, 0, 8_640_000_000_000_000) && integer(last.completedAt, 0, 8_640_000_000_000_000) &&
      integer(last.attempts, 1, Number.MAX_SAFE_INTEGER) && ["ok", "failed-no-retry"].includes(last.outcome)),
    "maintenance_last_result_invalid");
    return state;
  }
  async #initialize() {
    const now = Date.now(), id = crypto.randomUUID();
    await this.ctx.storage.transaction(async (tx) => {
      const expected = JSON.stringify(this.#config), existing = await tx.get<string>("identity");
      if (existing === undefined) {
        requireQueue((await tx.list({ limit: 1 })).size === 0, "maintenance_existing_state_not_adopted");
        await tx.put("identity", expected);
        const state: MaintenanceState = { nextAt: now, tick: { id, scheduledAt: now, attempts: 0, lease: null }, last: null };
        await tx.put("state", state);
      } else requireQueue(existing === expected, "maintenance_identity_or_config_changed");
      const state = await this.#state(tx);
      if (await tx.getAlarm() === null) await tx.setAlarm(Math.max(now + 1, state.nextAt));
    });
    await this.ctx.storage.sync();
  }
  async #claim(): Promise<Tick | null> {
    const lease = crypto.randomUUID();
    const tick = await this.ctx.storage.transaction(async (tx) => {
      const state = await this.#state(tx), now = Date.now();
      if (state.nextAt > now) { await tx.setAlarm(state.nextAt); return null; }
      requireQueue(state.tick.attempts < Number.MAX_SAFE_INTEGER, "maintenance_attempt_counter_exhausted");
      state.tick.attempts++; state.tick.lease = lease; state.nextAt = now + this.#config.leaseMs;
      await tx.put("state", state); await tx.setAlarm(state.nextAt); return { ...state.tick };
    });
    await this.ctx.storage.sync(); return tick;
  }
  async #settle(tick: Tick, result: { outcome: string; noRetry: boolean }) {
    const nextId = crypto.randomUUID();
    await this.ctx.storage.transaction(async (tx) => {
      const state = await this.#state(tx), now = Date.now();
      requireQueue(tick.lease !== null && state.tick.id === tick.id && state.tick.lease === tick.lease &&
        state.tick.attempts === tick.attempts, "maintenance_lease_changed");
      if (result.outcome === "ok" || result.noRetry) {
        state.last = { id: tick.id, scheduledAt: tick.scheduledAt, completedAt: now, attempts: tick.attempts,
          outcome: result.outcome === "ok" ? "ok" : "failed-no-retry" };
        const interval = this.#config.intervalSeconds * 1000;
        // Coalesce offline periods. Recovery scans current durable app state;
        // do not replay an unbounded sequence of missed cron timestamps.
        const scheduledAt = tick.scheduledAt + Math.max(1, Math.floor((now - tick.scheduledAt) / interval) + 1) * interval;
        state.tick = { id: nextId, scheduledAt, attempts: 0, lease: null }; state.nextAt = scheduledAt;
      } else {
        state.tick.lease = null; state.nextAt = now + this.#config.retryDelaySeconds * 1000;
      }
      await tx.put("state", state); await tx.setAlarm(Math.max(now + 1, state.nextAt));
    });
    await this.ctx.storage.sync();
  }
  async alarm(): Promise<void> {
    await this.#ready;
    const tick = await this.#claim(); if (!tick) return;
    let result = { outcome: "exception", noRetry: false };
    try {
      const response = await this.env.CONSUMER.scheduled({ scheduledTime: new Date(tick.scheduledAt) });
      requireQueue(object(response) && typeof response.outcome === "string" && typeof response.noRetry === "boolean",
        "maintenance_consumer_result_invalid");
      result = { outcome: response.outcome, noRetry: response.noRetry };
    } catch {
      // Persist an actual retry; never replace a failed real handler with an
      // invented successful tick or log a potentially secret error body.
    }
    await this.#settle(tick, result);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      await this.#ready;
      const url = new URL(request.url);
      requireQueue(request.method === "GET" && url.pathname === "/status" && url.search === "", "maintenance_route_missing", 404);
      const state = await this.ctx.storage.transaction((tx) => this.#state(tx));
      return Response.json({ nextAt: state.nextAt, tick: state.tick.id, scheduledAt: state.tick.scheduledAt,
        attempts: state.tick.attempts, inFlight: state.tick.lease !== null, last: state.last });
    } catch (error) { return unavailable(error); }
  }
}

// Private-only initialization/health service. The admitted startup controller
// must initialize/read this before opening application ingress. That controller
// and real alarm restart qualification are not implemented by this module.
export default {
  async fetch(request: Request, env: MaintenanceEnvironment): Promise<Response> {
    try {
      const config = configuration(env.MAINTENANCE_CONFIGURATION);
      return await env.MAINTENANCE_STATE.get(env.MAINTENANCE_STATE.idFromName(config.scope + ":" + config.name)).fetch(request);
    } catch (error) { return unavailable(error); }
  },
} satisfies ExportedHandler<MaintenanceEnvironment>;
