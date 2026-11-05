import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertPublishedUpgrade,
  publishedStateHash,
} from "../harness/published-state.ts";
import { hashJson } from "../packages/community/common.ts";

for (const side of ["application", "managed"] as const)
  test(`completed ${side} update cannot reset allowances or change resource and identity intent`, async () => {
    const prefix = "docs/deployments/first-song-managed-20261105.",
      previous = JSON.parse(
        await readFile(
          prefix +
            (side === "application"
              ? "application-plan-v8.json"
              : "moderation-plan-v7.json"),
          "utf8",
        ),
      ).profile,
      state = JSON.parse(
        await readFile(prefix + "published-state.json", "utf8"),
      ),
      next = {
        ...previous,
        sourceHashes: {},
        bundleSha256: "changed artifact",
        curatedState: state,
      };
    assert.equal(hashJson(state), publishedStateHash);
    assert.doesNotThrow(() => assertPublishedUpgrade(previous, next, side));
    for (const key of [
      "releaseGrant",
      "resources",
      "migrations",
      "stateProtection",
      "origin",
      "bounds",
      ...(side === "application"
        ? [
            "assets",
            "publisher",
            "creatorProfileHash",
            "credentialBinding",
            "queueConsumer",
          ]
        : [
            "registrationCredential",
            "pairings",
            "moderationSigner",
            "providerCredentials",
          ]),
    ]) {
      assert.throws(
        () => assertPublishedUpgrade(previous, { ...next, [key]: null }, side),
        /resource_or_spending/,
      );
    }
    assert.throws(
      () =>
        assertPublishedUpgrade(
          previous,
          { ...next, curatedState: { ...state, managed: {} } },
          side,
        ),
      /baseline/,
    );
    assert.throws(
      () =>
        assertPublishedUpgrade(
          { ...previous, origin: "https://changed.invalid" },
          next,
          side,
        ),
      /baseline/,
    );
  });
