import assert from "node:assert/strict";
import { test } from "node:test";
import { createLearningActionOwner } from "../src/live/learning-action-owner.ts";

test("an old activity cannot publish actions or clear its replacement", () => {
  const seen: unknown[] = [];
  const registry = createLearningActionOwner((value) => seen.push(value));
  const first = registry.claim();
  const firstAction = { download: async () => {} };
  first.publish(firstAction);
  assert.equal(registry.current(), firstAction);
  const second = registry.claim();
  const secondAction = { download: async () => {} };
  second.publish(secondAction);
  const before = seen.length;
  first.publish(firstAction);
  first.publish(null);
  first.release();
  assert.equal(seen.length, before);
  assert.equal(registry.current(), secondAction);
  second.release();
  assert.equal(registry.current(), null);
  assert.equal(second.current(), false);
});

test("closing or losing a session invalidates even an unresolved action owner", () => {
  const registry = createLearningActionOwner(() => {});
  const owner = registry.claim();
  registry.clear();
  owner.publish({ download: async () => {} });
  assert.equal(registry.current(), null);
  assert.equal(owner.current(), false);
  const replacement = registry.claim();
  const action = { download: async () => {} };
  replacement.publish(action);
  owner.release();
  assert.equal(registry.current(), action);
});
