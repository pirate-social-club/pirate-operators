import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashJson } from "../packages/community/common.ts";
import { digest, durableJson, privateJson } from "../harness/private-json.ts";
import {
  adoptReviewedUpdate,
  reviewedPredecessor,
  finishReviewedUpdate,
  preserveReviewedPackage,
} from "../harness/reviewed-update.ts";

async function fixture(completed = true) {
  const directory = await mkdtemp(join(tmpdir(), "pirate-reviewed-update-")),
    previousProfile = {
      schema: "fixture",
      resources: { worker: "owned" },
      bounds: { executionSeconds: 900, newResources: 0, providerRequests: 0 },
      sourceHashes: { old: "old" },
    },
    previousProfileHash = hashJson(previousProfile),
    previousPlanPath = join(directory, "previous-plan.json");
  await durableJson(previousPlanPath, {
    profile: previousProfile,
    profileHash: previousProfileHash,
  });
  await durableJson(join(directory, "execution.json"), {
    profileHash: previousProfileHash,
  });
  if (completed)
    await durableJson(join(directory, "deployment-result.json"), {
      profileHash: previousProfileHash,
      health: "available",
    });
  await mkdir(join(directory, "deployment"));
  await writeFile(
    join(directory, "deployment/worker.mjs"),
    "old public module",
    { mode: 0o600 },
  );
  const policy = {
      previousPlanPath,
      previousProfileHash,
      expectedExecutionSha256: digest(
        await readFile(join(directory, "execution.json")),
      ),
      expectedResultSha256: completed
        ? digest(await readFile(join(directory, "deployment-result.json")))
        : null,
    },
    profile = {
      ...previousProfile,
      sourceHashes: { new: "new" },
      reviewedUpdate: policy,
    },
    packaged = { profile, profileHash: hashJson(profile) };
  return {
    directory,
    packaged,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

for (const completed of [false, true])
  test(`reviewed ${completed ? "completed" : "applied unqualified"} predecessor is preserved before atomic adoption and result finalization`, async () => {
    const f = await fixture(completed);
    try {
      assert.equal(
        (await reviewedPredecessor(f.directory, f.packaged)).adopted,
        false,
      );
      const oldExecution = await readFile(join(f.directory, "execution.json"));
      await adoptReviewedUpdate(f.directory, f.packaged, {});
      const backup = join(
        f.directory,
        `before-update-${f.packaged.profileHash.slice(2)}`,
      );
      assert.deepEqual(
        await readFile(join(backup, "execution.json")),
        oldExecution,
      );
      assert.equal(
        await readFile(join(backup, "deployment/worker.mjs"), "utf8"),
        "old public module",
      );
      const adopted = await readFile(join(f.directory, "execution.json"));
      await adoptReviewedUpdate(f.directory, f.packaged, {});
      assert.deepEqual(
        await readFile(join(f.directory, "execution.json")),
        adopted,
      );
      const result = {
        profileHash: f.packaged.profileHash,
        health: "new available",
      };
      await finishReviewedUpdate(f.directory, f.packaged, result);
      await finishReviewedUpdate(f.directory, f.packaged, result);
      assert.deepEqual(
        await privateJson(join(f.directory, "deployment-result.json")),
        result,
      );
      assert.deepEqual(
        await readFile(join(backup, "execution.json")),
        oldExecution,
      );
      if (completed)
        assert.equal(
          digest(await readFile(join(backup, "deployment-result.json"))),
          f.packaged.profile.reviewedUpdate.expectedResultSha256,
        );
    } finally {
      await f.dispose();
    }
  });

test("changed resources, spend bounds, predecessor metadata or a fabricated adoption are refused", async () => {
  const f = await fixture();
  try {
    for (const changes of [
      { resources: { worker: "unrelated" } },
      { bounds: { ...f.packaged.profile.bounds, providerRequests: 1 } },
    ]) {
      const profile = { ...f.packaged.profile, ...changes };
      await assert.rejects(
        adoptReviewedUpdate(
          f.directory,
          { profile, profileHash: hashJson(profile) },
          {},
        ),
        /resource_or_spending_intent/,
      );
    }
    await writeFile(
      join(f.directory, "execution.json"),
      JSON.stringify({ profileHash: f.packaged.profileHash }),
      { mode: 0o600 },
    );
    await assert.rejects(
      adoptReviewedUpdate(f.directory, f.packaged, {}),
      /adoption_unverified/,
    );
    await writeFile(
      join(f.directory, "execution.json"),
      JSON.stringify({
        profileHash: f.packaged.profile.reviewedUpdate.previousProfileHash,
        changed: true,
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      adoptReviewedUpdate(f.directory, f.packaged, {}),
      /execution_changed/,
    );
  } finally {
    await f.dispose();
  }
});

test("an interrupted backup can finish exact source copies before adoption; a sealed changed backup refuses reuse", async () => {
  const f = await fixture(false);
  try {
    const backup = join(
      f.directory,
      `before-update-${f.packaged.profileHash.slice(2)}`,
    );
    await mkdir(join(backup, "deployment"), { recursive: true, mode: 0o700 });
    await writeFile(join(backup, "deployment/worker.mjs"), "partial copy", {
      mode: 0o600,
    });
    await preserveReviewedPackage(f.directory, f.packaged.profileHash, {});
    assert.equal(
      await readFile(join(backup, "deployment/worker.mjs"), "utf8"),
      "old public module",
    );
    await writeFile(
      join(backup, "deployment/worker.mjs"),
      "changed after completion",
      { mode: 0o600 },
    );
    await assert.rejects(
      preserveReviewedPackage(f.directory, f.packaged.profileHash, {}),
      /backup_changed/,
    );
    assert.equal(
      (await privateJson(join(f.directory, "execution.json")))!.profileHash,
      f.packaged.profile.reviewedUpdate.previousProfileHash,
    );
  } finally {
    await f.dispose();
  }
});

// UNRUN community-only guard; generic creator adoption cases above stay intact.
test("community adoption refuses an unready package without replacing predecessor execution", async () => {
  const f = await fixture();
  try {
    const { adoptPreparedCommunityUpdate } = await import(
      "../harness/reviewed-update.ts"
    );
    const before = await readFile(join(f.directory, "execution.json"));
    await assert.rejects(
      adoptPreparedCommunityUpdate(
        f.directory,
        f.packaged,
        {
          schema: "pirate.community-package-binding/1",
          profileHash: f.packaged.profileHash,
          relativePath: `deployment-${f.packaged.profileHash.slice(2)}`,
          manifestSha256: "0x" + "a".repeat(64),
        },
        async () => {
          throw new Error(
            "fixture authentication must not run before readiness",
          );
        },
      ),
    );
    assert.deepEqual(
      await readFile(join(f.directory, "execution.json")),
      before,
    );
  } finally {
    await f.dispose();
  }
});
