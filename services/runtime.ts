import { DurableObject } from "cloudflare:workers";
import type { Address, Hex } from "viem";
import { check, supportedChain } from "../packages/protocol/index.ts";
import { community } from "./community.ts";
import { operator } from "./operator.ts";
import { onClose, onMessage, tick } from "./karaoke.ts";
import { communityTick } from "./community-purchases.ts";
import { D1Store, localControl } from "./storage.ts";
import { attest } from "./very.ts";

export interface Env {
  STATE: DurableObjectNamespace<ServiceState>;
  ROLE: string;
  LOCAL_ONLY: string;
  PRIVATE_KEY: Hex;
  COMMUNITY: Fetcher;
  OPERATOR: Fetcher;
  ISSUER: Address;
  OPERATOR_ADDRESS: Address;
  COMMUNITY_ID: string;
  COMMUNITY_DOMAIN: string;
  CUTOFF: string;
  SIGNATURE_CHAIN_ID?: string;
  INITIAL_NOW?: string;
  // Operator payments (docs/operator-payments.md). Local runs point RPC_URL at
  // loopback anvil only.
  RPC_URL?: string;
  PAYMENT_CHAIN_ID?: string;
  PAYMENT_TOKEN?: string;
  PAYMENTS_CONTRACT?: string;
  /** The community's address in OperatorPayments. */
  COMMUNITY_ADDRESS?: string;
  SEGMENT_PRICE?: string;
  REALTIME_RPC?: string;
  /** LearningRecords on the payment chain; publication is off without it. */
  RECORDS_CONTRACT?: string;
  /**
   * The only EIP-7702 delegate and initializer the operator will activate a
   * learner's account with: MOSS's account proxy and orchestrator on MegaETH.
   */
  ACCOUNT_DELEGATE?: string;
  ACCOUNT_INITIALIZER?: string;
  /** The operator quote's validity window, in seconds. */
  QUOTE_VALID_FROM?: string;
  QUOTE_VALID_UNTIL?: string;
  /** The community's own database; the community needs no Durable Object. */
  DB?: D1Database;
}
export class Store {
  readonly sql: SqlStorage;
  constructor(
    private readonly storage: DurableObjectStorage,
    readonly initialNow = 1800000000,
  ) {
    this.sql = storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  get<T>(key: string): T | undefined {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM records WHERE key = ?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  set(key: string, value: unknown) {
    this.sql.exec(
      "INSERT OR REPLACE INTO records VALUES (?, ?)",
      key,
      JSON.stringify(value),
    );
  }
  delete(key: string) {
    this.sql.exec("DELETE FROM records WHERE key = ?", key);
  }
  entries(prefix: string) {
    return this.sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM records WHERE key LIKE ? ORDER BY key",
        `${prefix}%`,
      )
      .toArray()
      .map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown }));
  }
  now() {
    return this.get<number>("clock") ?? this.initialNow;
  }
  /** Runs every write in `fn` as one SQLite transaction: all of them land, or none. */
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
export async function call<T>(
  binding: Fetcher,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await binding.fetch(`http://service${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = (await response.json()) as { error?: string };
  check(response.ok, value.error ?? `upstream_${response.status}`);
  return value as T;
}
export async function body<T>(request: Request): Promise<T> {
  const text = await request.text();
  check(text.length <= 32000, "request_too_large");
  return JSON.parse(text) as T;
}
export class ServiceState extends DurableObject<Env> {
  readonly store: Store;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(
      ctx.storage,
      Number(env.INITIAL_NOW ?? 1800000000),
    );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/__clock") {
        const { now } = await body<{ now: number }>(request);
        check(
          Number.isSafeInteger(now) && now >= this.store.now(),
          "clock_backwards",
        );
        this.store.set("clock", now);
        if (this.env.ROLE === "operator") await tick(this.env, this.store);
        return Response.json({ now });
      }
      if (path === "/__fault") {
        // Local fault injection for crash and race tests; LOCAL_ONLY guards it.
        const { key, value } = await body<{ key: string; value: unknown }>(
          request,
        );
        check(/^fault:[a-z-]{1,40}$/.test(key), "invalid_fault");
        if (value === null) this.store.delete(key);
        else this.store.set(key, value);
        return Response.json({ key });
      }
      if (path === "/__state") return Response.json(this.store.entries(""));
      if (this.env.ROLE === "operator")
        return await operator(request, this.env, this.store, this.ctx);
      if (this.env.ROLE === "very")
        return await attest(request, this.env, this.store);
      return new Response("unknown_role", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "internal_error" },
        { status: 400 },
      );
    }
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      check(
        typeof message === "string" && message.length <= 32000,
        "invalid_frame",
      );
      await onMessage(ws, JSON.parse(message), this.env, this.store);
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: error instanceof Error ? error.message : "protocol_error",
        }),
      );
    }
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    onClose(ws, this.store);
    ws.close(code, reason);
  }
}
/** The community runs in its Worker on D1; only the operator keeps a Durable Object. */
async function communityFetch(request: Request, env: Env) {
  check(env.DB, "community_database_unconfigured");
  const store = new D1Store(env.DB, Number(env.INITIAL_NOW ?? 1800000000));
  try {
    const path = new URL(request.url).pathname;
    const control = await localControl(path, request, store);
    if (control !== undefined) {
      if (path === "/__clock") await communityTick(env, store);
      return Response.json(control);
    }
    return await community(request, env, store);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "internal_error" },
      { status: 400 },
    );
  }
}
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    check(
      env.LOCAL_ONLY === "pirate-local-skeleton",
      "local_configuration_required",
    );
    if (env.ROLE === "community") return communityFetch(request, env);
    return env.STATE.getByName(`${env.ROLE}:${env.COMMUNITY_ID}`).fetch(
      request,
    );
  },
};

export function signatureChainId(env: Env) {
  return supportedChain(Number(env.SIGNATURE_CHAIN_ID ?? 31337));
}
