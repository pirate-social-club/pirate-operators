import { insist } from "../community/common.ts";
import type { DanceFence, SqlValue } from "./contracts.ts";

/** Internal complete, read-only predicate expressions: values are positional
 * bindings or SELECT-local data, never references to generated private names.
 * This codec verifies composition; it is not an untrusted-SQL sandbox. */
const FRAME = "/*pirate.dance-fence/1:";
const BACKTICK = String.fromCharCode(96);
const joined = new WeakMap<DanceFence, { sql: string; payload: string; leaves: DanceFence[] }>();
let fenceAlias = 0;
type Plan = { a: string; n: number[]; l: number[]; p: [number, number, string][] };
type Layout = { i: number; length: number } | { left: Layout; right: Layout; length: number };
const value = (v: unknown): v is SqlValue => v === null || typeof v === "string" ||
  (typeof v === "number" && Number.isFinite(v));
const invalid = (ok: unknown) => insist(ok, "dance_fence_plan_invalid", 503);
function snapshot(f: DanceFence): DanceFence {
  const sql = f?.sql, values = f?.values;
  insist(typeof sql === "string" && !!sql.trim() && Array.isArray(values), "dance_host_fence_invalid", 503);
  const copied = Array.from(values);
  insist(copied.every(value), "dance_host_fence_invalid", 503);
  return { sql, values: copied };
}
/** Lexical delimiters only, shared by the positional binder and exact-frame
 * recovery. This does not parse or rewrite arbitrary SQL grammar. */
function quotedEnd(sql: string, i: number): number | null {
  const c = sql[i];
  if (c === "'" || c === '"' || c === BACKTICK || c === "[") {
    const end = c === "[" ? "]" : c;
    let j = i + 1;
    while (j < sql.length) {
      if (sql[j++] !== end) continue;
      if (sql[j] === end) { j++; continue; }
      return j;
    }
    invalid(false);
  }
  if (sql.startsWith("--", i)) {
    const end = sql.indexOf("\n", i);
    invalid(end >= 0); return end + 1;
  }
  if (sql.startsWith("/*", i)) {
    const end = sql.indexOf("*/", i + 2);
    invalid(end >= 0); return end + 2;
  }
  return null;
}
function bind(f: DanceFence, replace: (index: number, lexeme: string, occurrence: number) => string) {
  let out = "", i = 0, highest = 0, occurrence = 0, depth = 0;
  while (i < f.sql.length) {
    const start = i, c = f.sql[i], end = quotedEnd(f.sql, i);
    if (end !== null) { out += f.sql.slice(i, end); i = end; continue; }
    if (c === "?") {
      i++; const digits = i;
      while (/[0-9]/.test(f.sql[i] ?? "")) i++;
      const n = i === digits ? highest + 1 : Number(f.sql.slice(digits, i));
      insist(Number.isSafeInteger(n) && n > 0 && n <= f.values.length,
        "dance_host_fence_bind_mismatch", 503);
      highest = Math.max(highest, n);
      out += replace(n - 1, f.sql.slice(start, i), occurrence++); continue;
    }
    if (c === "(") depth++;
    if (c === ")") invalid(--depth >= 0);
    invalid(c !== ";");
    insist(!((c === ":" || c === "@" || c === "$") && /[a-zA-Z_]/.test(f.sql[i + 1] ?? "")),
      "dance_host_named_parameters_unsupported", 503);
    out += c; i++;
  }
  invalid(depth === 0);
  insist(highest === f.values.length, "dance_host_fence_bind_mismatch", 503);
  return out;
}
function and(parts: string[]) {
  let level = parts;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(i + 1 < level.length ? "(" + level[i] + " AND " + level[i + 1] + ")" : level[i]);
    level = next;
  }
  return level[0];
}
function aliasFor(leaves: DanceFence[]) {
  let alias: string;
  do {
    insist(Number.isSafeInteger(++fenceAlias), "dance_host_fence_alias_exhausted", 503);
    alias = "_d" + fenceAlias.toString(36);
  } while (leaves.some(f => f.sql.toLowerCase().includes(alias)));
  return alias;
}
function render(leaves: DanceFence[], alias: string, framed: boolean): DanceFence {
  const values: SqlValue[] = [], expressions: string[] = [], p: Plan["p"] = [];
  const n: number[] = [], l: number[] = [];
  for (const [i, leaf] of leaves.entries()) {
    const offset = values.length;
    const sql = bind(leaf, (index, lexeme, occurrence) => {
      if (lexeme !== "?") p.push([i, occurrence, lexeme]);
      return "json_extract(" + alias + "." + alias + ",'$[" + (offset + index) + "]')";
    });
    expressions.push("(" + sql + ")"); l.push(sql.length); n.push(leaf.values.length);
    values.push(...leaf.values);
  }
  const body = "EXISTS(WITH " + alias + "(" + alias + ") AS MATERIALIZED (SELECT ?) SELECT 1 FROM " +
    alias + " WHERE " + and(expressions) + ")";
  const plan: Plan = { a: alias, n, l, p };
  return { sql: (framed ? FRAME + JSON.stringify(plan) + "*/" : "") + body, values: [JSON.stringify(values)] };
}
/** Public packed-value shape and exact-duplicate behavior remain unchanged.
 * The private cache is an optimization only; atomic recovery uses the frame. */
export function joinDanceFences(...fences: DanceFence[]): DanceFence {
  insist(fences.length > 0, "dance_host_fence_missing", 503);
  const unique = new Map<string, DanceFence>();
  for (const f of fences) {
    const current = snapshot(f), prior = joined.get(f);
    const leaves = prior && current.sql === prior.sql && current.values.length === 1 &&
      current.values[0] === prior.payload ? prior.leaves : [current];
    for (const leaf of leaves) {
      const copy = snapshot(leaf);
      unique.set(JSON.stringify([copy.sql, copy.values]), copy);
    }
  }
  const leaves = [...unique.values()];
  const result = render(leaves, aliasFor(leaves), true);
  joined.set(result, { sql: result.sql, payload: String(result.values[0]), leaves });
  return result;
}
function layout(lengths: number[], available: number): Layout {
  let level: Layout[] = lengths.map((n, i) => ({ i, length: n + 2 }));
  while (level.length > 1) {
    const next: Layout[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) next.push(level[i]);
      else {
        const length = level[i].length + level[i + 1].length + 7;
        invalid(Number.isSafeInteger(length) && length <= available);
        next.push({ left: level[i], right: level[i + 1], length });
      }
    }
    level = next;
  }
  return level[0];
}
function planFrom(raw: string, available: number): Plan {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { invalid(false); }
  invalid(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const o = parsed as Record<string, unknown>;
  invalid(Object.keys(o).join(",") === "a,n,l,p" && JSON.stringify(o) === raw);
  invalid(typeof o.a === "string" && /^_d[1-9a-z][0-9a-z]*$/.test(o.a) &&
    Number.isSafeInteger(Number.parseInt(o.a.slice(2), 36)) &&
    "_d" + Number.parseInt(o.a.slice(2), 36).toString(36) === o.a);
  invalid(Array.isArray(o.n) && Array.isArray(o.l) && Array.isArray(o.p));
  const n = o.n as unknown[], l = o.l as unknown[], p = o.p as unknown[];
  invalid(n.length > 0 && n.length <= available && n.length === l.length);
  invalid(n.every(x => typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= available) &&
    l.every(x => typeof x === "number" && Number.isSafeInteger(x) && x > 0 && x <= available));
  const exceptions: Plan["p"] = [];
  for (const item of p) {
    invalid(Array.isArray(item) && item.length === 3);
    const e = item as unknown[];
    invalid(typeof e[0] === "number" && Number.isSafeInteger(e[0]) && e[0] >= 0 && e[0] < n.length &&
      typeof e[1] === "number" && Number.isSafeInteger(e[1]) && e[1] >= 0 && e[1] <= available &&
      typeof e[2] === "string" && /^\?[0-9]+$/.test(e[2]));
    exceptions.push([Number(e[0]), Number(e[1]), String(e[2])]);
  }
  return { a: String(o.a), n: n.map(Number), l: l.map(Number), p: exceptions };
}
/** Recover only this compiler's exact serialized shape. Span lengths are not
 * trusted: the entire expression, bind numbering and payload are rebuilt and
 * compared. No caller-supplied plan can omit a different SQL predicate. */
function generatedPrefix(sql: string, packed: SqlValue | undefined) {
  if (!sql.startsWith(FRAME)) return null;
  const end = sql.indexOf("*/", FRAME.length);
  invalid(end >= 0 && typeof packed === "string");
  const plan = planFrom(sql.slice(FRAME.length, end), sql.length);
  let decoded: unknown;
  try { decoded = JSON.parse(String(packed)); } catch { invalid(false); }
  invalid(Array.isArray(decoded) && Array.from(decoded).every(value) && JSON.stringify(decoded) === packed);
  const values = decoded as SqlValue[];
  invalid(plan.n.reduce((a, b) => a + b, 0) === values.length);
  const prefix = "EXISTS(WITH " + plan.a + "(" + plan.a + ") AS MATERIALIZED (SELECT ?) SELECT 1 FROM " + plan.a + " WHERE ";
  let cursor = end + 2;
  invalid(sql.slice(cursor, cursor + prefix.length) === prefix); cursor += prefix.length;
  const compiled: string[] = [];
  const take = (node: Layout): void => {
    invalid(sql[cursor++] === "(");
    if ("i" in node) {
      const stop = cursor + plan.l[node.i];
      invalid(stop <= sql.length); compiled[node.i] = sql.slice(cursor, stop); cursor = stop;
    } else {
      take(node.left); invalid(sql.slice(cursor, cursor + 5) === " AND "); cursor += 5; take(node.right);
    }
    invalid(sql[cursor++] === ")");
  };
  take(layout(plan.l, sql.length)); invalid(sql[cursor++] === ")");
  const exceptions = new Map<string, string>(), used = new Set<string>();
  for (const [leaf, occurrence, lexeme] of plan.p) {
    const key = leaf + ":" + occurrence;
    invalid(!exceptions.has(key)); exceptions.set(key, lexeme);
  }
  let offset = 0;
  const leaves: DanceFence[] = compiled.map((text, leaf) => {
    let raw = "", i = 0, occurrence = 0;
    const ref = "json_extract(" + plan.a + "." + plan.a + ",'$[";
    while (i < text.length) {
      if (text.startsWith(ref, i)) {
        const close = text.indexOf("]')", i + ref.length);
        invalid(close >= 0);
        const digits = text.slice(i + ref.length, close), index = Number(digits);
        invalid(/^[0-9]+$/.test(digits) && Number.isSafeInteger(index) &&
          index >= offset && index < offset + plan.n[leaf]);
        const key = leaf + ":" + occurrence++, lexeme = exceptions.get(key) ?? "?";
        if (exceptions.has(key)) used.add(key);
        raw += lexeme; i = close + 3;
      } else {
        const end = quotedEnd(text, i);
        if (end !== null) { raw += text.slice(i, end); i = end; }
        else raw += text[i++];
      }
    }
    invalid(!raw.toLowerCase().includes(plan.a));
    const f = { sql: raw, values: values.slice(offset, offset + plan.n[leaf]) };
    const rebuilt = bind(f, index => "json_extract(" + plan.a + "." + plan.a + ",'$[" + (offset + index) + "]')");
    invalid(rebuilt === text); offset += plan.n[leaf]; return f;
  });
  invalid(used.size === exceptions.size);
  const rebuilt = render(leaves, plan.a, true);
  invalid(rebuilt.sql === sql.slice(0, cursor) && rebuilt.values[0] === packed);
  return { leaves, length: cursor };
}
function closeParen(sql: string, start: number) {
  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    const end = quotedEnd(sql, i);
    if (end !== null) { i = end - 1; continue; }
    if (sql[i] === "(") depth++;
    if (sql[i] === ")" && --depth === 0) return i + 1;
    if (depth < 0) return -1;
  }
  return -1;
}
/** Compatibility for audited leading-generated-fence AND wrappers only.
 * Parenthesized operands stay opaque; EXISTS is consumed to its exact close.
 * Only the three existing scalar suffix forms are recognized. OR/unknown SQL
 * is never distributed, replaced with truth, or parsed as a general grammar. */
function wrapper(f: DanceFence): DanceFence[] | null {
  if (!f.sql.startsWith("(" + FRAME)) return null;
  const inner = generatedPrefix(f.sql.slice(1), f.values[0]);
  invalid(inner);
  let cursor = 1 + inner!.length;
  if (f.sql.slice(cursor, cursor + 6) !== ") AND ") return null;
  cursor += 6;
  const parts: string[] = [];
  while (cursor < f.sql.length) {
    const start = cursor;
    if (f.sql[cursor] === "(") cursor = closeParen(f.sql, cursor);
    else if (f.sql.startsWith("EXISTS(", cursor)) cursor = closeParen(f.sql, cursor + 6);
    else {
      const scalar = ["? IS NULL", "?=?", "typeof(?)='integer'"].find(s =>
        f.sql.startsWith(s, cursor) && (cursor + s.length === f.sql.length ||
          f.sql.startsWith(" AND ", cursor + s.length)));
      if (!scalar) return null;
      cursor += scalar.length;
    }
    if (cursor < start) return null;
    parts.push(f.sql.slice(start, cursor));
    if (cursor === f.sql.length) break;
    if (!f.sql.startsWith(" AND ", cursor)) return null;
    cursor += 5;
    if (cursor === f.sql.length) return null;
  }
  if (!parts.length) return null;
  const tail: DanceFence[] = [];
  let offset = 1;
  for (const sql of parts) {
    let count = 0;
    for (let i = 0; i < sql.length; i++) {
      const end = quotedEnd(sql, i);
      if (end !== null) { i = end - 1; continue; }
      if (sql[i] === "?") {
        if (/[0-9]/.test(sql[i + 1] ?? "")) return null;
        count++;
      }
    }
    const fpart = { sql, values: f.values.slice(offset, offset + count) };
    bind(fpart, (_, lexeme) => lexeme);
    tail.push(fpart); offset += count;
  }
  invalid(offset === f.values.length);
  return [...inner!.leaves, ...tail];
}
/** Flatten only verified generated composition, independent of WeakMap state.
 * Every pending child is strictly shorter, so recovery is bounded by input
 * SQL length. Unknown leaves remain exact; no database fact is pre-evaluated. */
export function danceAtomicPredicates(input: DanceFence): DanceFence[] {
  const pending = [snapshot(input)], leaves: DanceFence[] = [];
  let recovered = false;
  while (pending.length) {
    const f = pending.pop()!;
    const frame = generatedPrefix(f.sql, f.values[0]);
    const children = frame && frame.length === f.sql.length ? (invalid(f.values.length === 1), frame.leaves) : wrapper(f);
    if (!children) { leaves.push(f); continue; }
    recovered = true;
    for (const child of children) invalid(child.sql.length < f.sql.length);
    pending.push(...children.reverse());
  }
  if (!recovered) return leaves;
  const guards: DanceFence[] = [];
  for (let i = 0; i < leaves.length; i += 16) {
    const chunk = leaves.slice(i, i + 16);
    // Even a final singleton keeps the generated one-JSON-bind guarantee.
    guards.push(render(chunk, aliasFor(chunk), false));
  }
  return guards;
}
