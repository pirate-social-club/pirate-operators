import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { readPrebuiltWorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Prebuilt";
import { prepareDeploymentFiles } from "../server/provision.ts";
import { seal } from "../infra/protected-data.ts";

async function collect(cwd: string) {
  // Read the generated stack's actual entry, so a configuration regression
  // cannot pass by collecting a separate hardcoded path in the test.
  const stack = await readFile(join(cwd, "alchemy.run.ts"), "utf8");
  assert.match(stack, /bundle: false/);
  const main = stack.match(/^\s*main: "([^"]+)",?$/m)?.[1];
  assert.ok(main, "Expected an explicit prebuilt Worker entry in the stack");
  return Effect.runPromise(
    readPrebuiltWorkerBundle({ main: join(cwd, main) }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

for (const retry of [false, true]) {
  test(`Alchemy collects only the Worker on ${retry ? "an existing failed deployment" : "a fresh deployment"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "wizard-module-packaging-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const deployment = join(directory, "deployment");
    const saved = new Map<string, string>();
    if (retry) {
      const state = join(deployment, ".alchemy/state/pirate-fixture/setup");
      await mkdir(state, { recursive: true });
      for (const resource of ["Database", "Media", "Jobs"]) {
        saved.set(
          join(state, `${resource}.json`),
          seal(
            JSON.stringify({ instanceId: `existing-${resource}` }),
            "fixture-password-for-packaging-test-only",
            `alchemy-state:pirate-fixture/setup/${resource}.json`,
          ),
        );
      }
      // Match the old generated layout and include file types the provider
      // would upload if the entry's directory still included private state.
      saved.set(join(deployment, "worker.mjs"), "export default {};\n");
      saved.set(join(deployment, ".alchemy/private.txt"), "private fixture\n");
      saved.set(join(directory, "setup.json"), '{"attempted":true}\n');
      for (const [file, value] of saved) await writeFile(file, value);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const cwd = await prepareDeploymentFiles(directory);
      assert.equal(cwd, deployment);
      assert.ok((await lstat(join(cwd, "node_modules"))).isSymbolicLink());
      const bundle = await collect(cwd);
      assert.equal(bundle.files.length, 1, "Only the Worker may be uploaded");
      assert.equal(bundle.files[0].path, "worker.mjs");
      assert.deepEqual(
        Buffer.from(bundle.files[0].content),
        await readFile(new URL("../community/worker.mjs", import.meta.url)),
      );
      // Regeneration must not reset the failed run's resource state.
      for (const [file, value] of saved)
        assert.equal(await readFile(file, "utf8"), value);
    }
  });
}
