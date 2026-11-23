import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealReleaseTree } from "../harness/linux-full-target/release-tree-modes.ts";

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "release-tree-modes-"));
  const place = async (name: string, mode: number) => {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), "fixture\n", { flag: "wx", mode });
    await chmod(join(root, name), mode);
  };
  await place("toolchain/ca-certificates.crt", 0o400);
  await place("toolchain/node", 0o555);
  await place("source/backend.ts", 0o400);
  await place("source/deploy/linux/web2-launch.ts", 0o400);
  await place("wizard/index.html", 0o400);
  const unseal = async (path: string) => {
    for (const row of await readdir(path, { withFileTypes: true })) {
      const child = join(path, row.name);
      if (row.isDirectory()) await unseal(child);
      else await chmod(child, 0o644).catch(() => {});
    }
    await chmod(path, 0o755);
  };
  return { root, place, dispose: async () => { await unseal(root).catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}

const mode = async (path: string) => (await lstat(path)).mode & 0o777;

test("the seal makes every umask-stripped release file readable for the container user", async () => {
  const t = await tree();
  try {
    await sealReleaseTree(t.root);
    assert.equal(await mode(join(t.root, "toolchain/ca-certificates.crt")), 0o444);
    assert.equal(await mode(join(t.root, "toolchain/node")), 0o555);
    assert.equal(await mode(join(t.root, "source/backend.ts")), 0o400);
    assert.equal(await mode(join(t.root, "source/deploy/linux/web2-launch.ts")), 0o444);
    assert.equal(await mode(join(t.root, "wizard/index.html")), 0o444);
    assert.equal(await mode(join(t.root, "source")), 0o555);
    assert.equal(await mode(join(t.root, "toolchain")), 0o555);
  } finally {
    await t.dispose();
  }
});

test("the seal refuses writable entries and symlinks", async () => {
  for (const broken of ["writable-file", "symlink"] as const) {
    const t = await tree();
    try {
      if (broken === "writable-file") {
        await t.place("source/deploy/linux/rogue.ts", 0o400);
        await chmod(join(t.root, "source/deploy/linux/rogue.ts"), 0o644);
      } else {
        await symlink("index.html", join(t.root, "wizard/link"));
      }
      await assert.rejects(() => sealReleaseTree(t.root), {
        message: broken === "writable-file" ? "release_tree_writable_refused" : "release_tree_symlink_refused",
      });
    } finally {
      await t.dispose();
    }
  }
});

test("the seal fails the build when the CA bundle is absent", async () => {
  const t = await tree();
  try {
    await rm(join(t.root, "toolchain/ca-certificates.crt"));
    await assert.rejects(() => sealReleaseTree(t.root));
  } finally {
    await t.dispose();
  }
});
