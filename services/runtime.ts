import { DurableObject } from "cloudflare:workers";
import type { Address, Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import { community } from "./community.ts";
import { operator } from "./operator.ts";
import { studyPublicationAlarm } from "./study-publication-recovery.ts";
import { onClose, onMessage, tick } from "./karaoke.ts";
import { communityTick } from "./community-purchases.ts";
import { D1Store, localControl } from "./storage.ts";
import { body, signatureChainId } from "./service-call.ts";
// Pure helpers live apart so Node-run modules can use them without Workers imports.
export { body, call, signatureChainId } from "./service-call.ts";
import { attest } from "./very.ts";
import type { SpeechBudget } from "./speech-budget.ts";
import { isLearningProfile, admittedLearningProfile } from "./learning-profile.ts";

export interface Env {
  STATE: DurableObjectNamespace<ServiceState>;
  ROLE: string;
  /** Explicit testnet v2 profile; legacy skeleton fixtures remain local only. */
  RESULTS_V2_CONTRACT?: string;
  /** Successor default; V2 remains configured for historical pending work. */
  RESULTS_V3_CONTRACT?: string;
  RESULTS_V4_CONTRACT?: string;
  SERVICE_MODE?: "internal";
  SPONSOR_CAP_WEI?: string;
  SPONSOR_GAS_PRICE_WEI?: string;
  SPONSOR_GAS_LIMIT?: string;
  SPONSOR_DATA_FEE_WEI?: string;
  SPEECH_DAILY_LIMIT?: string;
  SPEECH_BUDGET?: DurableObjectNamespace<SpeechBudget>;
  HISTORY_RETENTION_DAYS?: string;
  OPERATOR_PROFILE?: string;
  APPROVED_ACTIVATION_ACCOUNT?: string;
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
    private readonly liveClock = false,
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
    if (this.liveClock) return Math.floor(Date.now() / 1000);
    return this.get<number>("clock") ?? this.initialNow;
  }
  /** Runs every write in `fn` as one SQLite transaction: all of them land, or none. */
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
export class ServiceState extends DurableObject<Env> {
  readonly store: Store;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(
      ctx.storage,
      Number(env.INITIAL_NOW ?? 1800000000),
      isLearningProfile(env),
    );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/__") && isLearningProfile(this.env))
        return new Response("not_found", { status: 404 });
      if (isLearningProfile(this.env)) await this.schedule();
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
  private async schedule() {
    const due = Date.now() + 5000;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > due)
      await this.ctx.storage.setAlarm(due);
  }
  async alarm() {
    try { await tick(this.env, this.store); }
    finally {
      // Reconcile unknown receipts and abandoned takes independently of browsers.
      const attempts = this.store.entries("attempt:");
      const pending = attempts.some(({ key, value }) => !(value as { finalized?: boolean }).finalized ||
        ((publication) => publication?.state === "pending" || (publication?.state === "published" && !publication.confirmed))(
          this.store.get<{ state: string; confirmed?: boolean }>(`publicationV2:${key.slice(8)}`)));
      const unsettled = this.store.entries("tx:").some(({ value }) => !(value as { mined: unknown }).mined);
      const authorizations = this.store.entries("pendingEnrollment:").length > 0 || this.store.entries("revocationIntent:").some(({ value }) => (value as { pending: boolean }).pending);
      const expiries = [...this.store.entries("history:"), ...this.store.entries("studySpeech:")].map(({ value }) => (value as { expiresAt: number }).expiresAt * 1000);
      const audits = this.store.entries("publicationV2:").map(({ value }) => value as { state: string; confirmed?: boolean; checkedAt?: number })
        .filter((publication) => publication.state === "published" && publication.confirmed)
        .map((publication) => ((publication.checkedAt ?? this.store.now()) + 3600) * 1000);
      const due = Math.min(...expiries, ...audits, ...studyPublicationAlarm(this.store), pending ? Date.now() + 5000 : unsettled || authorizations ? Date.now() + 30000 : Infinity);
      if (Number.isFinite(due)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, due));
    }
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
      env.LOCAL_ONLY === "pirate-local-skeleton" ||
        admittedLearningProfile(env),
      "local_configuration_required",
    );
    if (env.ROLE === "community") return communityFetch(request, env);
    return env.STATE.getByName(`${env.ROLE}:${env.COMMUNITY_ID}`).fetch(
      request,
    );
  },
};
