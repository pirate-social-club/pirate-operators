import { DurableObject } from "cloudflare:workers";
import type { Address, Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import { community } from "./community.ts";
import { operator, onPerformance } from "./operator.ts";
import { payer, provider } from "./payments.ts";
import { attest } from "./very.ts";

export interface Env {
  STATE: DurableObjectNamespace<ServiceState>;
  ROLE: string;
  LOCAL_ONLY: string;
  PRIVATE_KEY: Hex;
  COMMUNITY: Fetcher;
  OPERATOR: Fetcher;
  PAYER: Fetcher;
  PROVIDER: Fetcher;
  ISSUER: Address;
  OPERATOR_ADDRESS: Address;
  COMMUNITY_ID: string;
  COMMUNITY_DOMAIN: string;
  CUTOFF: string;
}
export class Store {
  constructor(readonly sql: SqlStorage) {
    sql.exec(
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
    return this.get<number>("clock") ?? 1800000000;
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
    this.store = new Store(ctx.storage.sql);
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
        return Response.json({ now });
      }
      if (path === "/__state") return Response.json(this.store.entries(""));
      if (this.env.ROLE === "community")
        return await community(request, this.env, this.store);
      if (this.env.ROLE === "operator")
        return await operator(request, this.env, this.store, this.ctx);
      if (this.env.ROLE === "payer")
        return await payer(request, this.env, this.store);
      if (this.env.ROLE === "provider")
        return await provider(request, this.store);
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
      await onPerformance(ws, JSON.parse(message), this.env, this.store);
    } catch (error) {
      ws.send(
        JSON.stringify({
          error: error instanceof Error ? error.message : "invalid_frame",
        }),
      );
    }
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code, reason);
  }
}
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    check(
      env.LOCAL_ONLY === "pirate-local-skeleton",
      "local_configuration_required",
    );
    return env.STATE.getByName(`${env.ROLE}:${env.COMMUNITY_ID}`).fetch(
      request,
    );
  },
};
