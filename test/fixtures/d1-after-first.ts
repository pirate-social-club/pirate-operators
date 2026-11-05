// Inject a suspension after one real D1 statement resolves. Batch statements
// remain actual D1 transactions; only the selected returned result is delayed.
export function afterD1First(
  db: D1Database,
  match: (sql: string) => boolean,
  hook: () => void,
) {
  const originals = new WeakMap<object, D1PreparedStatement>();
  let seen = 0;
  function wrap(raw: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(raw, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === "first" && match(sql))
          return async (...args: unknown[]) => {
            const value = await Reflect.apply(target.first, target, args);
            seen++;
            hook();
            return value;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, raw);
    return proxy;
  }
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return (statements: D1PreparedStatement[]) =>
          target.batch(statements.map((s) => originals.get(s) ?? s));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, seen: () => seen };
}
