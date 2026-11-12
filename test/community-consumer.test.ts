// UNRUN. Explicit current-state contract replaces obsolete first-enable absence.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualifyCommunityConsumer } from "../harness/community-consumer.ts";
import { durableJson, digest } from "../harness/private-json.ts";
import { readFile } from "node:fs/promises";
test("Consumer cannot fall back to a hardcoded directory without execution custody", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community-consumer-role-"));
  try {
    let queries = 0;
    const query = async () => {
      queries++;
      return [];
    };
    await assert.rejects(
      qualifyCommunityConsumer(directory, "fixture-password", {}, false, query),
      /package_binding_required/,
    );
    assert.equal(queries, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("recorded predecessor with missing current state fails before live Consumer lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community-consumer-state-role-"));
  try {
    const previous = "0x" + "a".repeat(64);
    await durableJson(join(directory, "execution.json"), { profileHash: previous });
    await mkdir(join(directory, "deployment"), { mode: 0o700 });
    let queries = 0;
    const custody = {
      profileHash: "0x" + "b".repeat(64),
      policy: {
        previousPlanPath: "fixture-unused.json",
        previousProfileHash: previous,
        expectedExecutionSha256: digest(await readFile(join(directory, "execution.json"))),
        expectedResultSha256: null,
      },
    };
    await assert.rejects(
      qualifyCommunityConsumer(
        directory,
        "fixture-password",
        {},
        false,
        async () => {
          queries++;
          return [];
        },
        custody,
      ),
    );
    assert.equal(queries, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
// The complete positive/foreign/absent remote cases use actual authenticated
// six-record fixture state in community-package-custody.test.ts.
