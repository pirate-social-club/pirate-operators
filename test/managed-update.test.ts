import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preserveManagedDeployment } from "../harness/managed-update.ts";

test("managed update preserves predecessor bytes and refuses a corrupt or incomplete backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pirate-managed-update-")),
    profile = `0x${"a".repeat(64)}`,
    backup = join(dir, `before-update-${profile.slice(2)}`);
  try {
    await mkdir(join(dir, "deployment/.alchemy/state"), { recursive: true });
    await writeFile(
      join(dir, "deployment/.alchemy/state/resource.json"),
      "encrypted-state-fixture",
    );
    await writeFile(
      join(dir, "deployment/worker.mjs"),
      "original-bundle-fixture",
    );
    await writeFile(
      join(dir, "deployment-result.json"),
      '{"profileHash":"original-fixture"}',
    );
    await symlink(
      "/unread-dependency-fixture",
      join(dir, "deployment/node_modules"),
    );
    await preserveManagedDeployment(dir, profile);
    const read = (path: string) => readFile(join(backup, path), "utf8");
    assert.equal(
      await read("deployment/.alchemy/state/resource.json"),
      "encrypted-state-fixture",
    );
    assert.equal(
      await read("deployment/worker.mjs"),
      "original-bundle-fixture",
    );
    assert.ok(
      !(await readdir(join(backup, "deployment"))).includes("node_modules"),
    );
    const marker = await read("preservation.json");
    await writeFile(
      join(dir, "deployment/worker.mjs"),
      "updated-bundle-fixture",
    );
    await writeFile(
      join(dir, "deployment-result.json"),
      '{"profileHash":"successor-fixture"}',
    );
    await preserveManagedDeployment(dir, profile);
    assert.equal(await read("preservation.json"), marker);
    assert.equal(
      await read("deployment/worker.mjs"),
      "original-bundle-fixture",
    );
    await writeFile(join(backup, "deployment-result.json"), "corrupted");
    await assert.rejects(
      preserveManagedDeployment(dir, profile),
      /managed_backup_result_changed/,
    );
    const second = `0x${"b".repeat(64)}`;
    await mkdir(join(dir, `before-update-${second.slice(2)}`));
    await assert.rejects(preserveManagedDeployment(dir, second));
    assert.equal(
      await readFile(join(dir, "deployment/worker.mjs"), "utf8"),
      "updated-bundle-fixture",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
