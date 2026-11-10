// The previously qualified deployment deliberately retains its dependency tree.
// Verify it in place; never retarget or replace that preservation copy.
import {
  lstat,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileDigest } from "./creator-state.ts";
import { insist } from "../packages/community/common.ts";

export const communityDependencyRoot = join(
  homedir(),
  ".local/state/pirate-first-song-managed-20261105/retained-dependencies",
);
export const communityDependencyModules = join(
  communityDependencyRoot,
  "community-wizard/node_modules",
);
export const managedDependencyModules = join(
  communityDependencyRoot,
  "managed-moderation/node_modules",
);
const preservationDigest =
  "0x2d3441931fdb2e08aa3a51780e23d1afc07a60e06a2fe520a83a36d68d0d8c7d";
/** One retained package's lock equals the lock this source was reviewed with. */
async function retainedLock(retained: string, source: string, code: string) {
  const record = await readFile(
    join(communityDependencyRoot, "preservation.json"),
  );
  insist(
    fileDigest(record) === preservationDigest,
    "community_dependency_preservation_changed",
    409,
  );
  insist(
    fileDigest(await readFile(join(communityDependencyRoot, retained))) ===
      fileDigest(await readFile(source)),
    code,
    409,
  );
}
/** Read-only check of every retained tree and runner link, with a named error. */
async function verifyRetainedTrees() {
  try {
    await promisify(execFile)(
      "python3",
      [join(communityDependencyRoot, "verify.py")],
      { timeout: 120000, maxBuffer: 65536 },
    );
  } catch (error) {
    // The verifier prints only package names, tree digests and assertions.
    const e = error as { stdout?: string; stderr?: string; message?: string };
    console.error(
      String(e.stderr || e.stdout || e.message || "")
        .trim()
        .split("\n")
        .slice(-5)
        .join("\n"),
    );
    insist(false, "retained_dependencies_unverified", 409);
  }
}
export async function verifyCommunityDependencies() {
  await retainedLock(
    "community-wizard/package-lock.json",
    "apps/community-wizard/package-lock.json",
    "community_dependency_lock_changed",
  );
  await verifyRetainedTrees();
}
/**
 * The managed runner uses the same retained, recorded dependency tree as the
 * community runner, never the repository's working install, so a managed
 * deployment leaves every recorded runner link intact.
 */
export async function verifyManagedDependencies() {
  await retainedLock(
    "managed-moderation/package-lock.json",
    "apps/managed-moderation/package-lock.json",
    "managed_dependency_lock_changed",
  );
  await verifyRetainedTrees();
}

/**
 * Points a runner's node_modules link at its retained tree. An already
 * correct link is left untouched; a previous link is replaced atomically
 * through a temporary link, never a real directory. Verification runs only
 * after a change; the caller's preflight verified an unchanged link.
 */
export async function linkRetainedDependencies(
  modules: string,
  dependencies: { modules: string; verify(): Promise<void> },
) {
  let current: string | undefined;
  try {
    const info = await lstat(modules);
    insist(info.isSymbolicLink(), "unexpected_managed_dependencies");
    current = await readlink(modules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current === dependencies.modules) return { changed: false };
  // Outside the runner directory, so a leftover never enters its preservation.
  const temporary = join(
    dirname(dirname(modules)),
    `.node_modules.${process.pid}.link`,
  );
  await rm(temporary, { force: true });
  await symlink(dependencies.modules, temporary, "dir");
  await rename(temporary, modules);
  insist(
    (await realpath(modules)) === (await realpath(dependencies.modules)),
    "unexpected_managed_dependencies",
  );
  await dependencies.verify();
  return { changed: true };
}
