import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableJson, privateJson } from "../harness/community-state.ts";
import { completedCommunityRelease } from "../harness/community-result.ts";
import { communityOwned } from "../harness/community-package.ts";

test("interruption before or after atomic execution/result publication never exposes partial JSON or replaces committed metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirate-community-metadata-"));
  try {
    for (const name of ["execution.json", "deployment-result.json"]) {
      const path = join(directory, name),
        value = { profileHash: "fixture", kind: name };
      await assert.rejects(
        durableJson(path, value, async (phase) => {
          if (phase === "prepared")
            throw new Error("fixture termination before commit");
        }),
        /fixture termination/,
      );
      assert.equal(await privateJson(path), null);
      assert.ok(
        (await readdir(directory)).some(
          (p) => p.startsWith(name + ".") && p.endsWith(".tmp"),
        ),
      );
      await assert.rejects(
        durableJson(path, value, async (phase) => {
          if (phase === "committed")
            throw new Error("fixture lost response after commit");
        }),
        /fixture lost response/,
      );
      assert.deepEqual(await privateJson(path), value);
      const before = await readFile(path);
      await durableJson(path, value);
      assert.deepEqual(await readFile(path), before);
      await assert.rejects(
        durableJson(path, { ...value, profileHash: "different" }),
        /metadata_conflict/,
      );
      assert.deepEqual(await readFile(path), before);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retry of a committed successful release returns preserved evidence only after fresh exact-profile reconciliation", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pirate-community-completed-"),
  );
  try {
    const profile = {
        planId: "fixture-plan",
        bundleSha256: "fixture-bundle",
      },
      profileHash = "fixture-profile",
      resources = communityOwned.map((r) => ({
        name: r.logical,
        id: r.id,
        present: true,
      })),
      health = {
        profileHash,
        planId: profile.planId,
        signIn: "available",
        creatorConnection: "available",
      },
      live = {
        inventory: { at: new Date().toISOString(), resources },
        modules: { "worker.mjs": profile.bundleSha256 },
        health,
      },
      result = {
        schema: "pirate.community-application-release/1",
        profileHash,
        before: live.inventory,
        after: live.inventory,
        health,
        logs: ["fixture.enc"],
      };
    assert.equal(
      await completedCommunityRelease(directory, profile, profileHash, live),
      null,
    );
    await durableJson(join(directory, "deployment-result.json"), result);
    const before = await readFile(join(directory, "deployment-result.json"));
    for (let retry = 0; retry < 3; retry++)
      assert.deepEqual(
        await completedCommunityRelease(directory, profile, profileHash, live),
        result,
      );
    assert.deepEqual(
      await readFile(join(directory, "deployment-result.json")),
      before,
    );
    await assert.rejects(
      completedCommunityRelease(directory, profile, "other-profile", live),
      /completed_result_conflict/,
    );
    await assert.rejects(
      completedCommunityRelease(directory, profile, profileHash, {
        ...live,
        modules: { "worker.mjs": "old-bundle" },
      }),
      /completed_release_not_live/,
    );
    await assert.rejects(
      completedCommunityRelease(directory, profile, profileHash, {
        ...live,
        health: { ...health, creatorConnection: "unavailable" },
      }),
      /completed_release_not_live/,
    );
    await assert.rejects(
      completedCommunityRelease(directory, profile, profileHash, {
        ...live,
        inventory: {
          ...live.inventory,
          resources: resources.map((r, i) =>
            i === 0 ? { ...r, id: "unrelated-worker" } : r,
          ),
        },
      }),
      /completed_release_not_live/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed predecessor release preserves and adopts before replacing its result, then reconciles success without another apply", async () => {
  const { hashJson } = await import("../packages/community/common.ts");
  const { digest } = await import("../harness/private-json.ts");
  const { adoptReviewedUpdate, finishReviewedUpdate } = await import(
    "../harness/reviewed-update.ts"
  );
  const directory = await mkdtemp(
    join(tmpdir(), "pirate-community-successor-"),
  );
  try {
    const previousProfile = {
      schema: "fixture",
      planId: "fixture-plan",
      bundleSha256: "previous-bundle",
    };
    const previousHash = hashJson(previousProfile);
    const previousPath = join(directory, "previous-plan.json");
    await durableJson(previousPath, {
      profile: previousProfile,
      profileHash: previousHash,
    });
    await durableJson(join(directory, "execution.json"), {
      profileHash: previousHash,
    });
    await durableJson(join(directory, "deployment-result.json"), {
      profileHash: previousHash,
    });
    const oldResult = await readFile(join(directory, "deployment-result.json"));
    const profile = {
      ...previousProfile,
      bundleSha256: "successor-bundle",
      reviewedUpdate: {
        previousPlanPath: previousPath,
        previousProfileHash: previousHash,
        expectedExecutionSha256: digest(
          await readFile(join(directory, "execution.json")),
        ),
        expectedResultSha256: digest(oldResult),
      },
    };
    const profileHash = hashJson(profile),
      packaged = { profile, profileHash };
    const resources = communityOwned.map((r) => ({
      name: r.logical,
      id: r.id,
      present: true,
    }));
    const health = {
      profileHash,
      planId: profile.planId,
      signIn: "available",
      creatorConnection: "available",
    };
    const live = {
      inventory: { at: new Date().toISOString(), resources },
      modules: { "worker.mjs": profile.bundleSha256 },
      health,
    };
    assert.equal(
      await completedCommunityRelease(directory, profile, profileHash, live),
      null,
    );
    assert.deepEqual(
      await readFile(join(directory, "deployment-result.json")),
      oldResult,
    );
    await adoptReviewedUpdate(directory, packaged, {});
    // An interruption after adoption still sees the exact old result. It must
    // proceed with the same preserved package rather than treating it as final.
    assert.equal(
      await completedCommunityRelease(directory, profile, profileHash, live),
      null,
    );
    const result = {
      schema: "pirate.community-application-release/1",
      profileHash,
      before: live.inventory,
      after: live.inventory,
      health,
      logs: [],
    };
    await finishReviewedUpdate(directory, packaged, result);
    assert.deepEqual(
      await completedCommunityRelease(directory, profile, profileHash, live),
      result,
    );
    await finishReviewedUpdate(directory, packaged, result);
    assert.deepEqual(
      await readFile(
        join(
          directory,
          `before-update-${profileHash.slice(2)}`,
          "deployment-result.json",
        ),
      ),
      oldResult,
    );
    await assert.rejects(
      completedCommunityRelease(
        directory,
        {
          ...profile,
          reviewedUpdate: {
            ...profile.reviewedUpdate,
            previousProfileHash: profileHash,
          },
        },
        "unknown-successor",
        live,
      ),
      /community_completed_result_conflict/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
