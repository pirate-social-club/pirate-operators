// UNRUN proposal: actual HTTP/account/D1/CAS/operator routes and SQLite journal.
// Chain reads alone are an explicit ABI-level, pinned-block JSON-RPC simulation.
// No provider, socket, browser, chain node or financial transaction is exercised.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { accounts, keys } from "../harness/runtime.ts";
import { firstSongFixture } from "../harness/karaoke-live.ts";
import { verifyLoginOffline } from "../harness/login-verifier.ts";
import { resultsV4Abi } from "../packages/protocol/learning-results-v4.ts";
import { digest } from "../packages/protocol/index.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  communityFetch,
  type CommunityEnv,
  type CommunityDependencies,
} from "../services/community-application.ts";
import { karaokeRoute } from "../services/karaoke.ts";
import { Store } from "../services/operator-store.ts";
import type { Env } from "../services/runtime.ts";
import type { WalletState } from "../services/community-purchases.ts";
import {
  admissionReadFixture,
  id,
} from "./karaoke-reservation-admission-fixture.ts";

export async function readRecoveryFixture() {
  const f = await admissionReadFixture(),
    sqlite = new DatabaseSync(":memory:");
  const originalFetch = globalThis.fetch;
  let authenticating = true;
  let clock = 110000,
    since = 100n,
    revoked = 0n,
    owner = accounts[5].address;
  let casAckLost = false,
    failPrepare = false,
    losePrepareAck = false;
  let loseCommunityAck = false;
  let failCommunityAckWrite = false,
    failOperatorAckWrite = false,
    terminalPending = false;
  let afterPrepare: (() => void | Promise<void>) | undefined;
  const counts = {
    ticketPosts: 0,
    canonicalGets: 0,
    prepareDispatches: 0,
    realPrepares: 0,
    casCommits: 0,
  };
  const responses: Array<{ status: number; value: unknown }> = [];
  let depth = 0;
  const storage = {
    transactionSync<T>(fn: () => T) {
      const savepoint = `recovery_${depth++}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = fn();
        sqlite.exec(`RELEASE ${savepoint}`);
        return value;
      } catch (error) {
        sqlite.exec(`ROLLBACK TO ${savepoint}`);
        sqlite.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally {
        depth--;
      }
    },
    sql: {
      exec(sql: string, ...values: (string | number)[]) {
        const statement = sqlite.prepare(sql);
        const rows = statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
        return {
          toArray: () => rows,
          one: () => {
            assert.equal(rows.length, 1);
            return rows[0];
          },
        };
      },
    },
  };
  const store = new Store(storage as unknown as DurableObjectStorage, 110);
  const operatorStore = new Proxy(store, {
    get(target, key) {
      if (key === "set")
        return (name: string, value: unknown) => {
          if (failOperatorAckWrite && name.startsWith("karaokePreparedV1:")) {
            failOperatorAckWrite = false;
            throw Error("fixture_operator_ack_write_failed");
          }
          return target.set(name, value);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key !== "prepare") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const wrap = (
          statement: D1PreparedStatement,
          values: unknown[] = [],
        ): D1PreparedStatement =>
          new Proxy(statement, {
            get(st, property) {
              if (property === "bind")
                return (...next: unknown[]) => wrap(st.bind(...next), next);
              if (property === "run")
                return async () => {
                  if (
                    failCommunityAckWrite &&
                    values.some(
                      (v) =>
                        typeof v === "string" &&
                        v.startsWith("karaokePreparedV1:"),
                    )
                  ) {
                    failCommunityAckWrite = false;
                    throw Error("fixture_community_ack_write_failed");
                  }
                  const result = await st.run();
                  if (
                    loseCommunityAck &&
                    values.some(
                      (v) =>
                        typeof v === "string" &&
                        v.startsWith("karaokePreparedV1:"),
                    ) &&
                    result.meta.changes === 1
                  ) {
                    loseCommunityAck = false;
                    throw Error("fixture_community_ack_lost_after_commit");
                  }
                  if (
                    /^(INSERT INTO|UPDATE) karaoke_state/.test(sql) &&
                    values.includes(
                      `wallet:${accounts[5].address.toLowerCase()}`,
                    ) &&
                    result.meta.changes === 1
                  ) {
                    counts.casCommits++;
                    if (casAckLost) {
                      casAckLost = false;
                      throw Error("fixture_reservation_ack_lost");
                    }
                  }
                  return result;
                };
              const value = Reflect.get(st, property);
              return typeof value === "function" ? value.bind(st) : value;
            },
          });
        return wrap(target.prepare(sql));
      };
    },
  });
  const operatorEnv = {
    SERVICE_MODE: "internal",
    PRIVATE_KEY: keys[2],
    ISSUER: accounts[1].address,
    OPERATOR_ADDRESS: accounts[2].address,
    COMMUNITY_ID: f.config.communityId,
    COMMUNITY_ADDRESS: accounts[1].address,
    PAYMENT_CHAIN_ID: "6343",
    SIGNATURE_CHAIN_ID: "6343",
    PAYMENT_TOKEN: accounts[0].address,
    PAYMENTS_CONTRACT: f.config.operatorPayments,
    RESULTS_V4_CONTRACT: f.config.learningRecords,
    RPC_URL: "http://reservation-rpc.invalid",
    QUOTE_VALID_FROM: "1",
    QUOTE_VALID_UNTIL: "1000",
    SPONSOR_CAP_WEI: "1000",
    SPONSOR_GAS_PRICE_WEI: "1",
    SPONSOR_GAS_LIMIT: "1",
    SPONSOR_DATA_FEE_WEI: "0",
  } as unknown as Env;
  const binding = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init),
        path = new URL(request.url).pathname;
      if (path === "/prepare") {
        counts.prepareDispatches++;
        if (failPrepare) throw Error("fixture_prepare_interrupted");
      }
      if (terminalPending && path === "/result")
        return Response.json({ error: "result_not_final" }, { status: 409 });
      try {
        const response = await karaokeRoute(
          request,
          operatorEnv,
          operatorStore,
          {} as DurableObjectState,
        );
        assert.ok(response, `unexpected operator path ${path}`);
        if (path === "/prepare" && response.ok) {
          counts.realPrepares++;
          await afterPrepare?.();
          if (losePrepareAck) {
            losePrepareAck = false;
            throw Error("fixture_prepare_ack_lost");
          }
        }
        return response;
      } catch (error) {
        return Response.json(
          { error: (error as Error).message },
          { status: 409 },
        );
      }
    },
  } as Fetcher;
  const env = {
    ...f.env,
    DB: db,
    MEDIA: f.media,
    JOBS: { send: async () => {} },
    ASSETS: { fetch: async () => new Response("fixture") },
    COMMUNITY_NAME: firstSong.name,
    PLAN_ID: firstSong.planId,
    APPLICATION_PROFILE_HASH: `0x${"a".repeat(64)}`,
    CREATOR_PROFILE_HASH: `0x${"b".repeat(64)}`,
    KARAOKE_RPC_URL: operatorEnv.RPC_URL,
    KARAOKE_OPERATOR: binding,
  } as unknown as CommunityEnv;
  const dependencies: CommunityDependencies = {
    configuration: async () => f.config,
    publicReads: f.reads,
    verifyLogin: verifyLoginOffline,
    creatorHealth: async () => false,
    now: () => (authenticating ? Date.now() : clock),
  };
  const call = async (path: string, init: RequestInit = {}) => {
    if (path.startsWith("/api/karaoke/attempt")) counts.canonicalGets++;
    if (path === "/api/karaoke/tickets" && init.method === "POST")
      counts.ticketPosts++;
    const response = await communityFetch(
      new Request(firstSong.origin + path, init),
      env,
      dependencies,
    );
    if (path === "/api/karaoke/tickets")
      responses.push({
        status: response.status,
        value: await response.clone().json(),
      });
    return response;
  };
  const post = (
    path: string,
    value: unknown,
    headers: Record<string, string> = {},
  ) =>
    call(path, {
      method: "POST",
      headers: {
        origin: firstSong.origin,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(value),
    });
  // The actual authorization readers use the actual ABI, pinning their reads
  // to a block. Unknown RPC calls fail the fixture instead of inventing data.
  const rpc = (payload: { id: unknown; method: string; params: unknown[] }) => {
    if (payload.method === "eth_blockNumber")
      return { jsonrpc: "2.0", id: payload.id, result: "0x64" };
    assert.equal(payload.method, "eth_call");
    const input = payload.params[0] as { to: string; data: Hex };
    assert.equal(
      input.to.toLowerCase(),
      operatorEnv.RESULTS_V4_CONTRACT!.toLowerCase(),
    );
    assert.equal(payload.params[1], "0x64");
    const decoded = decodeFunctionData({ abi: resultsV4Abi, data: input.data });
    const values: Record<string, unknown> = {
      authorizationLearner: owner,
      authorizationIssuedAt: 100n,
      authorizedSince: since,
      revokedAt: revoked,
      nextNonce: 0n,
    };
    assert.ok(Object.hasOwn(values, decoded.functionName));
    if (decoded.functionName.startsWith("authorization"))
      assert.equal(decoded.args?.[0], id);
    const result = encodeFunctionResult({
      abi: resultsV4Abi,
      functionName: decoded.functionName,
      result: values[decoded.functionName],
    } as never);
    return { jsonrpc: "2.0", id: payload.id, result };
  };
  let auth: Record<string, string>;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("http://reservation-rpc.invalid")) {
      const payload = JSON.parse(String(init?.body));
      return Response.json(
        Array.isArray(payload) ? payload.map(rpc) : rpc(payload),
      );
    }
    assert.ok(url.startsWith("/api/"), `unexpected fixture network ${url}`);
    const headers = new Headers(init?.headers);
    headers.set("cookie", auth.cookie);
    return call(url, { ...init, headers });
  }) as typeof fetch;
  try {
    const challenge = (await (
      await post("/api/auth/challenge", { address: accounts[5].address })
    ).json()) as { id: string; message: string };
    const response = await post("/api/auth/verify", {
      id: challenge.id,
      signature: await accounts[5].signMessage({ message: challenge.message }),
    });
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    const verified = (await response.json()) as { csrf: string };
    authenticating = false;
    auth = {
      cookie: response.headers.get("set-cookie")!.split(";")[0],
      "x-csrf-token": verified.csrf,
      "x-study-account": accounts[5].address.toLowerCase(),
    };
    const walletState = async () =>
      JSON.parse(
        (await f.db
          .prepare("SELECT value FROM karaoke_state WHERE key=?")
          .bind(`wallet:${accounts[5].address.toLowerCase()}`)
          .first<{ value: string }>())!.value,
      ) as WalletState;
    const row = async <T>(key: string): Promise<T | undefined> => {
      const r = await f.db
        .prepare("SELECT value FROM karaoke_state WHERE key=?")
        .bind(key)
        .first<{ value: string }>();
      return r ? (JSON.parse(r.value) as T) : undefined;
    };
    return {
      ...f,
      env,
      operatorEnv,
      store: operatorStore,
      counts,
      responses,
      call,
      post,
      auth,
      wallet: accounts[5].address.toLowerCase(),
      postId: firstSongFixture.postId,
      walletState,
      row,
      get: (headers = auth) =>
        call(`/api/karaoke/attempt?postId=${firstSongFixture.postId}`, {
          headers,
        }),
      create: () =>
        post("/api/karaoke/tickets", { postId: firstSongFixture.postId }, auth),
      snapshot: async () => ({
        wallet: await walletState(),
        sponsor: digest(operatorStore.entries("sponsor:")),
      }),
      fault: (
        kind:
          | "cas"
          | "beforePrepare"
          | "prepareAck"
          | "communityAck"
          | "communityAckLost"
          | "operatorAck",
      ) => {
        if (kind === "cas") casAckLost = true;
        if (kind === "beforePrepare") failPrepare = true;
        if (kind === "prepareAck") losePrepareAck = true;
        if (kind === "communityAck") failCommunityAckWrite = true;
        if (kind === "communityAckLost") loseCommunityAck = true;
        if (kind === "operatorAck") failOperatorAckWrite = true;
      },
      releasePrepare: () => {
        failPrepare = false;
      },
      afterPrepare: (hook?: () => void | Promise<void>) => {
        afterPrepare = hook;
      },
      revoke: () => {
        since = 0n;
        revoked = 111n;
      },
      wrongOwner: () => {
        owner = accounts[6].address;
      },
      time: (value: number) => {
        clock = value * 1000;
        operatorStore.set("clock", value);
      },
      markTerminalPending: () => {
        terminalPending = true;
      },
      dispose: async () => {
        globalThis.fetch = originalFetch;
        sqlite.close();
        await f.dispose();
      },
    };
  } catch (error) {
    globalThis.fetch = originalFetch;
    sqlite.close();
    await f.dispose();
    throw error;
  }
}
