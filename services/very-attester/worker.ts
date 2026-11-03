import { DurableObject } from "cloudflare:workers";
import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { hostedProvider } from "../../packages/very/transport.ts";
import { RewardAttester, type SavedStore } from "./core.ts";
import { AttesterError, configuration, requireValue } from "./policy.ts";
import { poolInspector } from "./chain.ts";

export interface AttesterEnv {
  ATTESTER: DurableObjectNamespace<VeryAttesterState>;
  CONFIG: string;
  PRIVATE_KEY: Hex;
  ENABLE: string;
  LOCAL_TEST_NOW?: string;
}
class SqlStore implements SavedStore {
  private readonly sql: SqlStorage;
  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS attester_records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  get<T>(key: string): T | undefined {
    const row = this.sql
      .exec<{
        value: string;
      }>("SELECT value FROM attester_records WHERE key=?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  set(key: string, value: unknown) {
    this.sql.exec(
      "INSERT OR REPLACE INTO attester_records VALUES (?,?)",
      key,
      JSON.stringify(value),
    );
  }
}
async function input(request: Request) {
  requireValue(
    request.headers.get("Content-Type") === "application/json" && request.body,
    "invalid_request",
  );
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      requireValue(size <= 2_100_000, "request_too_large");
      parts.push(part.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
    );
  } finally {
    await reader.cancel();
  }
}
function refusal(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof AttesterError
          ? error.message
          : "attester_dependency_failed",
    },
    {
      status: error instanceof AttesterError ? 400 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
export class VeryAttesterState extends DurableObject<AttesterEnv> {
  readonly store: SqlStore;
  constructor(ctx: DurableObjectState, env: AttesterEnv) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage.sql);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      requireValue(
        this.env.ENABLE === "testnet-very-attester/1",
        "attester_disabled",
      );
      const config = configuration(JSON.parse(this.env.CONFIG));
      requireValue(
        this.env.LOCAL_TEST_NOW === undefined || config.chainId === 31337,
        "test_clock_refused",
      );
      const now = () =>
        this.env.LOCAL_TEST_NOW === undefined
          ? Math.floor(Date.now() / 1000)
          : Number(this.env.LOCAL_TEST_NOW);
      const core = new RewardAttester(config, {
        store: this.store,
        now,
        random: (size) => `0x${randomBytes(size).toString("hex")}`,
        inspect: poolInspector(config),
        verify: async (raw) => {
          try {
            await hostedProvider().verify(raw);
          } catch (error) {
            if (
              error instanceof Error &&
              ["verifier_rejected", "provider_unavailable_or_invalid"].includes(
                error.message,
              )
            )
              throw new AttesterError(error.message);
            throw error;
          }
        },
        privateKey: this.env.PRIVATE_KEY,
      });
      requireValue(request.method === "POST", "invalid_method");
      const path = new URL(request.url).pathname;
      requireValue(
        path === "/challenge" || path === "/issue",
        "unknown_method",
      );
      const value = await input(request);
      const result =
        path === "/challenge"
          ? await core.challenge(value)
          : await core.issue(value);
      return Response.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return refusal(error);
    }
  }
}
export default {
  async fetch(request: Request, env: AttesterEnv): Promise<Response> {
    try {
      requireValue(
        env.ENABLE === "testnet-very-attester/1",
        "attester_disabled",
      );
      const config = configuration(JSON.parse(env.CONFIG));
      // Never include app ID or policy version in the object name: that would
      // create fresh storage and bypass the existing pool's immutable pin.
      return await env.ATTESTER.getByName(
        `${config.chainId}:${config.pool.toLowerCase()}`,
      ).fetch(request);
    } catch (error) {
      return refusal(error);
    }
  },
} satisfies ExportedHandler<AttesterEnv>;
