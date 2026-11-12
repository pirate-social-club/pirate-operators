import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableJson, privateJson } from "../harness/community-state.ts";
import { completedCommunityRelease } from "../harness/community-result.ts";

test("interruption before or after atomic execution/result publication never exposes partial JSON or replaces committed metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirate-community-metadata-"));
  try {
    for (const name of ["execution.json", "deployment-result.json"]) {
      const path = join(directory, name),
        value = { profileHash: "fixture", kind: name };
      await assert.rejects(
        durableJson(path, value, async (phase) => {
          if (phase === "prepared") throw new Error("fixture termination before commit");
        }),
        /fixture termination/,
      );
      assert.equal(await privateJson(path), null);
      assert.ok((await readdir(directory)).some((p) => p.startsWith(name + ".") && p.endsWith(".tmp")));
      await assert.rejects(
        durableJson(path, value, async (phase) => {
          if (phase === "committed") throw new Error("fixture lost response after commit");
        }),
        /fixture lost response/,
      );
      assert.deepEqual(await privateJson(path), value);
      const before = await readFile(path);
      await durableJson(path, value);
      assert.deepEqual(await readFile(path), before);
      await assert.rejects(durableJson(path, { ...value, profileHash: "different" }), /metadata_conflict/);
      assert.deepEqual(await readFile(path), before);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Positive same-package/state completion and actual zero-apply recovery moved
// to community-package-custody.test.ts with the real six-record fixture.
test("a live-looking completed receipt cannot reconcile without authenticated package custody", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community-completed-unbound-"));
  try {
    await durableJson(join(directory, "deployment-result.json"), { profileHash: "fixture" });
    const before = await readFile(join(directory, "deployment-result.json"));
    const live = { inventory: { at: "fixture", resources: [] }, modules: {}, health: {} };
    await assert.rejects(
      completedCommunityRelease(directory, { planId: "fixture", bundleSha256: "fixture" }, "fixture", live),
      /package_binding_required/,
    );
    assert.deepEqual(await readFile(join(directory, "deployment-result.json")), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("new execution without binding fails before any authentication substitute or replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community-new-unbound-"));
  try {
    const profileHash = "0x" + "a".repeat(64);
    await durableJson(join(directory, "execution.json"), { profileHash });
    await durableJson(join(directory, "deployment-result.json"), { profileHash });
    const before = await readFile(join(directory, "execution.json"));
    let authenticated = false;
    await assert.rejects(
      completedCommunityRelease(
        directory,
        {
          planId: "fixture",
          bundleSha256: "fixture",
          reviewedUpdate: {
            previousProfileHash: "0x" + "b".repeat(64),
            previousPlanPath: "fixture-not-read.json",
            expectedExecutionSha256: "0x" + "c".repeat(64),
            expectedResultSha256: null,
          },
        },
        profileHash,
        { inventory: { at: "fixture", resources: [] }, modules: {}, health: {} },
        async () => {
          authenticated = true;
          return { files: {}, identities: {} };
        },
      ),
      /binding_missing/,
    );
    assert.equal(authenticated, false);
    assert.deepEqual(await readFile(join(directory, "execution.json")), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
