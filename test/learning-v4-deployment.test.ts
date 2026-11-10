import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { studyDeploymentFixture } from "./study-deployment-fixture.ts";
import { studyDeploymentMain } from "../harness/megaeth/study-deployment.ts";
import { studyDeploymentPlan } from "../harness/megaeth/study-deployment-plan.ts";

test("V4 CLI defaults to offline preparation of its actual four-argument constructor", async () => {
  const f = await studyDeploymentFixture(4);
  const path = join(f.directory, "profile-v4.json");
  writeFileSync(path, JSON.stringify(f.profile));
  let clients = 0;
  const result = await studyDeploymentMain(["--profile", path], {
    client: () => {
      clients++;
      throw Error("plan created client");
    },
  });
  assert.equal(result.mode, "plan");
  assert.equal(clients, 0);
  assert("operations" in result);
  assert.equal(
    result.operations[0].data,
    studyDeploymentPlan(f.profile, f.artifact).operations[0].data,
  );
  for (const field of ["origin", "revision", "artifact"] as const) {
    const p = structuredClone(f.profile);
    if (field === "origin") p.communityOrigin = "https://wrong.invalid";
    if (field === "revision") p.configurationRevision = "4";
    const artifact =
      field === "artifact"
        ? (await studyDeploymentFixture()).artifact
        : f.artifact;
    assert.throws(() => studyDeploymentPlan(p, artifact));
  }
});
