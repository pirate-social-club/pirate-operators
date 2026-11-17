import type { DanceFence } from "../packages/dance/contracts.ts";
import type { DancePrivateRequestSession } from "./dance-private-session.ts";
import { StudyError } from "../packages/study/contracts.ts";

/** Reuse the actual request session's accepting predicates. Prefixing the real
 * D1 batch with a failing expression aborts that same transaction on authority
 * loss. No guard schema, public permission or command/nonce is introduced.
 * Prepared statements/results/CAS metadata remain those of the native engine. */
export function studyV5Database(db: D1Database, session: DancePrivateRequestSession, checkRuntime: () => void, sourceFences: () => readonly DanceFence[] = () => []): D1Database {
  const native = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  async function check() { checkRuntime(); await session.check(); checkRuntime(); }
  async function batch<T = Record<string, unknown>>(target: Pick<D1Database, "prepare" | "batch">, statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    await check();
    const fences = [...session.fences, ...sourceFences()];
    const guard = target.prepare(`SELECT CASE WHEN ${fences.map(f => `(${f.sql})`).join(" AND ")} THEN 1 ELSE json('study_private_authority_changed') END AS valid`)
      .bind(...fences.flatMap(f => f.values));
    let result: D1Result<T>[];
    try { result = await target.batch<T>([guard, ...statements.map(s => native.get(s) ?? s)]); }
    catch (error) { await check(); throw error; }
    await check(); return result.slice(1);
  }
  function wrap<T extends Pick<D1Database, "prepare" | "batch">>(target: T): T {
    function statement(sql: string, value: D1PreparedStatement): D1PreparedStatement {
      const proxy = new Proxy(value, { get(t, key) {
        if (key === "bind") return (...args: unknown[]) => statement(sql, t.bind(...args));
        if (key === "run") return async () => (await batch(target, [proxy]))[0];
        if (["first", "all", "raw"].includes(String(key))) return async (...args: unknown[]) => {
          await check();
          const result = await Reflect.apply(Reflect.get(t, key), t, args);
          await check(); return result;
        };
        const member = Reflect.get(t, key); return typeof member === "function" ? member.bind(t) : member;
      } });
      native.set(proxy, value); return proxy;
    }
    return new Proxy(target, { get(t, key) {
      if (key === "prepare") return (sql: string) => statement(sql, t.prepare(sql));
      if (key === "batch") return (statements: D1PreparedStatement[]) => batch(t, statements);
      if (key === "withSession") return (...args: unknown[]) => wrap(Reflect.apply(Reflect.get(t, key), t, args));
      if (key === "exec" || key === "dump") return () => { throw new StudyError("study_private_v5_unfenced_sql", 503); };
      const member = Reflect.get(t, key); return typeof member === "function" ? member.bind(t) : member;
    } });
  }
  return wrap(db);
}
