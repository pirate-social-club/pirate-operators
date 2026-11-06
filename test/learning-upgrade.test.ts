import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertLearningApplicationUpgrade,
  learningCommunityProfile,
} from "../harness/learning-community-profile.ts";

test("learning deployment preserves existing resources, spending and release intent", async () => {
  const old = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.application-plan-v9.json",
      "utf8",
    ),
  ).profile;
  const next = {
    ...old,
    migrations: [...old.migrations, "0008_karaoke.sql"],
    learning: await learningCommunityProfile(),
    acceptance: "testnet learning",
    sourceHashes: { fixture: "next" },
  };
  assert.doesNotThrow(() => assertLearningApplicationUpgrade(old, next));
  assert.throws(
    () => assertLearningApplicationUpgrade(old, { ...next, resources: [] }),
    /unrelated_intent/,
  );
  assert.throws(
    () =>
      assertLearningApplicationUpgrade(old, {
        ...next,
        bounds: { ...old.bounds, providerRequests: 1000 },
      }),
    /unrelated_intent/,
  );
  assert.throws(
    () =>
      assertLearningApplicationUpgrade(old, {
        ...next,
        migrations: [...next.migrations, "0009_other.sql"],
      }),
    /migrations_changed/,
  );
  assert.throws(
    () =>
      assertLearningApplicationUpgrade(old, {
        ...next,
        learning: { ...next.learning, speechDailyCalls: 100 },
      }),
    /scope_changed/,
  );
});
