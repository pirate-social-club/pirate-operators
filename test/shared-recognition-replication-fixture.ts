/** Models permitted repeated reads at an old D1 session bookmark. Actual storage,
 * transactions and first reads still use the real local D1 implementation.
 * This is a controlled replication schedule, not a replacement D1 engine. */
export function staleSessionReplica(database: D1Database) {
  const counts = { primaryReads: 0, staleReads: 0 };
  const wrapped = new Proxy(database, {
    get(target, property) {
      if (property === "withSession") {
        return (...args: Parameters<D1Database["withSession"]>) => {
          const session = target.withSession(...args);
          const cachedReads = new Map<string, unknown>();
          const originals = new WeakMap<
            D1PreparedStatement,
            D1PreparedStatement
          >();
          const statement = (
            actual: D1PreparedStatement,
            sql: string,
            values: unknown[] = [],
          ): D1PreparedStatement => {
            const proxy = new Proxy(actual, {
              get(prepared, key) {
                if (key === "bind")
                  return (...bound: unknown[]) =>
                    statement(prepared.bind(...bound), sql, bound);
                if (key === "first") {
                  return async (...columns: unknown[]) => {
                    const read = /^\s*SELECT\b/i.test(sql);
                    const cacheKey = JSON.stringify({ sql, values, columns });
                    if (read && cachedReads.has(cacheKey)) {
                      counts.staleReads++;
                      return structuredClone(cachedReads.get(cacheKey));
                    }
                    const value: unknown = await Reflect.apply(
                      prepared.first,
                      prepared,
                      columns,
                    );
                    // An uncached query may advance the actual session bookmark.
                    // Never reuse older cached results beyond that new bookmark.
                    cachedReads.clear();
                    if (read) {
                      cachedReads.set(cacheKey, structuredClone(value));
                      counts.primaryReads++;
                    }
                    return value;
                  };
                }
                if (key === "run" || key === "all" || key === "raw")
                  return async (...params: unknown[]) => {
                    const method: unknown = Reflect.get(prepared, key);
                    if (typeof method !== "function")
                      throw new Error("invalid_replica_fixture_method");
                    const value: unknown = await Reflect.apply(
                      method,
                      prepared,
                      params,
                    );
                    // Own writes and uncached reads invalidate an older view.
                    cachedReads.clear();
                    return value;
                  };
                const value: unknown = Reflect.get(prepared, key);
                return typeof value === "function"
                  ? value.bind(prepared)
                  : value;
              },
            });
            originals.set(proxy, actual);
            return proxy;
          };
          return new Proxy(session, {
            get(current, key) {
              if (key === "prepare")
                return (sql: string) => statement(current.prepare(sql), sql);
              if (key === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  const value = await current.batch(
                    statements.map(
                      (prepared) => originals.get(prepared) ?? prepared,
                    ),
                  );
                  cachedReads.clear();
                  return value;
                };
              const value: unknown = Reflect.get(current, key);
              return typeof value === "function" ? value.bind(current) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: wrapped, counts };
}
