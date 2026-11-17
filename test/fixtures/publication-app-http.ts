// Actual HTTP, D1 and SQLite adapters. No permission or journal mock.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { Store } from "../../services/operator-store.ts";
import { migrateOwnerDatabase } from "../owner-publishing-migration-fixture.ts";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function loopback(
  handler: (request: Request) => Promise<Response>,
  canonicalOrigin?: string,
) {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const body = Buffer.concat(chunks);
      const request = new Request((canonicalOrigin ?? origin) + req.url, {
        method: req.method,
        headers,
        ...(body.length ? { body } : {}),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const value = error as {
        status?: number;
        code?: string;
        message?: string;
      };
      res.writeHead(value.status ?? 500, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify({
          error: value.code ?? value.message ?? "fixture_http_failure",
        }),
      );
    }
  });
  let origin = "";
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  return {
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
export async function appDatabase() {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('actual D1')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const native = await runtime.getD1Database("DB");
    const names = (
      await readdir(
        new URL(
          "../../apps/community-wizard/infra/migrations/",
          import.meta.url,
        ),
      )
    )
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    // Use the actual ordered migration files and qualified Alchemy parser,
    // including prerequisite setup bookkeeping and trigger-aware transport.
    await migrateOwnerDatabase(
      native,
      names.map((name) => "apps/community-wizard/infra/migrations/" + name),
    );
    let held: {
      fragment: string;
      entered: ReturnType<typeof deferred>;
      gate: ReturnType<typeof deferred>;
    } | null = null;
    const pause = async (sql: string) => {
      if (held && sql.includes(held.fragment)) {
        const item = held;
        held = null;
        item.entered.resolve();
        await item.gate.promise;
      }
    };
    let failedRead: string | null = null;
    const readFault = (sql: string) => {
      if (failedRead && sql.includes(failedRead)) {
        failedRead = null;
        throw Error("fixture_current_read_unavailable");
      }
    };
    const originals = new WeakMap<object, D1PreparedStatement>();
    const queries = new WeakMap<object, string>();
    const wrap = (
      statement: D1PreparedStatement,
      sql: string,
    ): D1PreparedStatement => {
      const proxy = new Proxy(statement, {
        get(target, key) {
          if (key === "bind")
            return (...args: unknown[]) => wrap(target.bind(...args), sql);
          if (key === "first")
            return async (column?: string) => {
              readFault(sql);
              return column === undefined
                ? target.first()
                : target.first(column);
            };
          if (key === "all")
            return async () => {
              readFault(sql);
              return target.all();
            };
          if (key === "run")
            return async () => {
              await pause(sql);
              return target.run();
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      originals.set(proxy, statement);
      queries.set(proxy, sql);
      return proxy;
    };
    const db = new Proxy(native, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => wrap(target.prepare(sql), sql);
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            // Pause before the real atomic batch, never between its statements.
            for (const statement of statements)
              await pause(queries.get(statement) ?? "");
            return target.batch(statements.map((s) => originals.get(s) ?? s));
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return {
      runtime,
      native,
      db,
      failRead(fragment: string) {
        assert.equal(failedRead, null);
        failedRead = fragment;
      },
      holdMutation(fragment: string) {
        assert.equal(held, null);
        const entered = deferred(),
          gate = deferred();
        held = { fragment, entered, gate };
        return { entered: entered.promise, release: gate.resolve };
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
export function operatorDatabase(filename: string, nowS: number) {
  const sqlite = new DatabaseSync(filename);
  let sequence = 0;
  const storage = {
    sql: {
      exec(query: string, ...args: (string | number | null)[]) {
        const rows = sqlite.prepare(query).all(...args);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(work: () => T) {
      const point = "app_" + sequence++;
      sqlite.exec("SAVEPOINT " + point);
      try {
        const result = work();
        sqlite.exec("RELEASE " + point);
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK TO " + point);
        sqlite.exec("RELEASE " + point);
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  return { store: new Store(storage, nowS), close: () => sqlite.close() };
}
