import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStudyApplicationUpgrade } from "../harness/study-application-upgrade.ts";
import { learningCommunityProfile } from "../harness/learning-community-profile.ts";
import { studyReleaseSelection } from "../harness/study-release-profile.ts";
import { reviewedPredecessor } from "../harness/reviewed-update.ts";
import { hashJson } from "../packages/community/common.ts";
import { digest, durableJson } from "../harness/private-json.ts";
import { selectionFixture } from "./fixtures/study-release.ts";

async function fixture() {
  const previous = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.application-plan-v15.json",
      "utf8",
    ),
  ).profile;
  previous.learning = await learningCommunityProfile();
  previous.acceptance = previous.learning.acceptance;
  const next = {
    ...structuredClone(previous),
    learning: await learningCommunityProfile(
      studyReleaseSelection(selectionFixture()),
    ),
    migrations: [
      ...previous.migrations,
      "0009_study.sql",
      "0010_study_retention.sql",
    ],
  };
  next.acceptance = next.learning.acceptance;
  return { previous, next };
}
test("Study upgrade preserves V2 app resources and billing intent while adding exactly migrations9/10", async () => {
  const f = await fixture();
  assert.doesNotThrow(() => assertStudyApplicationUpgrade(f.previous, f.next));
  assert.doesNotThrow(() =>
    assertStudyApplicationUpgrade(f.next, structuredClone(f.next)),
  );
});
for (const [name, change] of Object.entries<(p: any) => void>({
  resources: (p) => {
    p.resources = [];
  },
  budget: (p) => {
    p.bounds.providerRequests++;
  },
  namespace: (p) => {
    p.learning.operatorWorker = "pirate-learning-testnet-v3";
  },
  origin: (p) => {
    p.learning.operatorOrigin = "https://other.example";
  },
  credentials: (p) => {
    p.learning.providerCredential.key = "NEW";
  },
  quota: (p) => {
    p.learning.speechDailyCalls = 10;
  },
  retention: (p) => {
    p.learning.historyRetentionDays = 1;
  },
  legacy: (p) => {
    p.learning.contract = p.learning.studyContract;
  },
  omission: (p) => {
    p.migrations.pop();
  },
  reorder: (p) => {
    p.migrations.reverse();
  },
  extra: (p) => {
    p.migrations.push("0011_other.sql");
  },
  disclosure: (p) => {
    p.learning.publicityPolicy = `0x${"5".repeat(64)}`;
  },
  extraBinding: (p) => {
    p.learning.speechNamespace = "new";
  },
}))
  test(`Study upgrade refuses ${name} change`, async () => {
    const f = await fixture();
    change(f.next);
    assert.throws(
      () => assertStudyApplicationUpgrade(f.previous, f.next),
      /study_upgrade_/,
    );
  });
test("reviewed predecessor enforces Study guard even when generic resource intent is unchanged", async () => {
  const f = await fixture(),
    directory = await mkdtemp(join(tmpdir(), "pirate-study-upgrade-"));
  try {
    const previous = f.next,
      previousProfileHash = hashJson(previous),
      previousPlanPath = join(directory, "previous.json");
    await durableJson(previousPlanPath, {
      profile: previous,
      profileHash: previousProfileHash,
    });
    await durableJson(join(directory, "execution.json"), {
      profileHash: previousProfileHash,
    });
    await durableJson(join(directory, "deployment-result.json"), {
      profileHash: previousProfileHash,
    });
    const policy = {
      previousPlanPath,
      previousProfileHash,
      expectedExecutionSha256: digest(
        await readFile(join(directory, "execution.json")),
      ),
      expectedResultSha256: digest(
        await readFile(join(directory, "deployment-result.json")),
      ),
    };
    const next = { ...structuredClone(previous), reviewedUpdate: policy };
    assert.equal(
      (
        await reviewedPredecessor(directory, {
          profile: next,
          profileHash: hashJson(next),
        })
      ).adopted,
      false,
    );
    for (const change of [
      (p: any) => {
        delete p.learning.studyContract;
      },
      (p: any) => {
        p.learning.studyContract = `0x${"8".repeat(40)}`;
      },
      (p: any) => {
        p.learning.providerCredential.key = "NEW";
      },
      (p: any) => {
        p.learning = null;
      },
    ]) {
      const broken = structuredClone(next);
      change(broken);
      await assert.rejects(
        reviewedPredecessor(directory, {
          profile: broken,
          profileHash: hashJson(broken),
        }),
        /study_upgrade_/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
