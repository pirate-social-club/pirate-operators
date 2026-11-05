// Minimal bun:test/vitest compatibility for the adopted centralized Karaoke
// tests, so their bodies stay as written upstream. Only the matchers and spy
// features those tests use are provided; anything else fails loudly.
import assert from "node:assert/strict";
import { afterEach, describe, it, mock, test } from "node:test";

export { afterEach, describe, it, test };

type Fn = (...args: any[]) => any;
export interface Spy<F extends Fn = Fn> {
  (...args: Parameters<F>): ReturnType<F>;
  readonly calls: Parameters<F>[];
  mockImplementationOnce(impl: F): Spy<F>;
  mockRejectedValueOnce(reason: unknown): Spy<F>;
}

function fn<F extends Fn>(impl?: F): Spy<F> {
  const once: Fn[] = [];
  const calls: unknown[][] = [];
  const spy = function (this: unknown, ...args: unknown[]) {
    calls.push(args);
    const next = once.shift() ?? impl;
    return next ? next.apply(this, args) : undefined;
  } as unknown as Spy<F>;
  Object.defineProperty(spy, "calls", { get: () => calls });
  spy.mockImplementationOnce = (next) => (once.push(next), spy);
  spy.mockRejectedValueOnce = (reason) => (
    once.push(() => Promise.reject(reason)),
    spy
  );
  return spy;
}

const isSpy = (value: unknown): value is Spy =>
  typeof value === "function" && Array.isArray((value as Spy).calls);

// toEqual ignores properties whose value is undefined, as upstream does.
function defined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(defined);
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, defined(v)]),
    );
  return value;
}

function check(pass: boolean, negate: boolean, message: string) {
  if (pass === negate) assert.fail(negate ? `not: ${message}` : message);
}

function matchers(actual: unknown, negate: boolean) {
  const calls = () => {
    assert.ok(isSpy(actual), "expected a spy");
    return (actual as Spy).calls;
  };
  const same = (a: unknown, b: unknown) => {
    try {
      assert.deepStrictEqual(defined(a), defined(b));
      return true;
    } catch {
      return false;
    }
  };
  return {
    toBe: (expected: unknown) =>
      check(
        Object.is(actual, expected),
        negate,
        `${String(actual)} toBe ${String(expected)}`,
      ),
    toEqual: (expected: unknown) => {
      if (negate) return check(same(actual, expected), true, "toEqual");
      assert.deepStrictEqual(defined(actual), defined(expected));
    },
    toBeNull: () =>
      check(actual === null, negate, `${String(actual)} toBeNull`),
    toBeCloseTo: (expected: number, digits = 2) =>
      check(
        Math.abs((actual as number) - expected) < 10 ** -digits / 2,
        negate,
        `${String(actual)} toBeCloseTo ${expected}`,
      ),
    toContain: (item: unknown) =>
      check(
        typeof actual === "string"
          ? actual.includes(item as string)
          : (actual as unknown[]).includes(item),
        negate,
        `toContain ${String(item)}`,
      ),
    toMatch: (pattern: RegExp | string) =>
      check(
        typeof pattern === "string"
          ? (actual as string).includes(pattern)
          : pattern.test(actual as string),
        negate,
        `toMatch ${String(pattern)}`,
      ),
    toThrow: (expected?: string | RegExp) => {
      let thrown: unknown;
      try {
        (actual as () => unknown)();
      } catch (error) {
        thrown = error ?? new Error("thrown");
      }
      const text = thrown instanceof Error ? thrown.message : String(thrown);
      const pass =
        thrown !== undefined &&
        (expected === undefined ||
          (typeof expected === "string"
            ? text.includes(expected)
            : expected.test(text)));
      check(pass, negate, `toThrow ${String(expected)} (got ${text})`);
    },
    toHaveBeenCalled: () =>
      check(calls().length > 0, negate, "toHaveBeenCalled"),
    toHaveBeenCalledOnce: () =>
      check(
        calls().length === 1,
        negate,
        `toHaveBeenCalledOnce (${calls().length})`,
      ),
    toHaveBeenCalledTimes: (n: number) =>
      check(
        calls().length === n,
        negate,
        `toHaveBeenCalledTimes ${n} (${calls().length})`,
      ),
    toHaveBeenCalledWith: (...args: unknown[]) =>
      check(
        calls().some((call) => same(call, args)),
        negate,
        "toHaveBeenCalledWith",
      ),
    toHaveBeenLastCalledWith: (...args: unknown[]) =>
      check(same(calls().at(-1), args), negate, "toHaveBeenLastCalledWith"),
  };
}

export function expect(actual: unknown) {
  return Object.assign(matchers(actual, false), {
    not: matchers(actual, true),
  });
}

export const vi = {
  fn,
  useFakeTimers: () =>
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] }),
  useRealTimers: () => mock.timers.reset(),
  async advanceTimersByTimeAsync(ms: number) {
    mock.timers.tick(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  },
};
