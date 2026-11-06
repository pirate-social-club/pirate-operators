// The previously qualified deployment deliberately retains its dependency tree.
// Verify it in place; never retarget or replace that preservation copy.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
export async function verifyCommunityDependencies() {
  const record = await readFile(
    join(communityDependencyRoot, "preservation.json"),
  );
  insist(
    fileDigest(record) ===
      "0x2d3441931fdb2e08aa3a51780e23d1afc07a60e06a2fe520a83a36d68d0d8c7d",
    "community_dependency_preservation_changed",
    409,
  );
  const retained = await readFile(
    join(communityDependencyRoot, "community-wizard/package-lock.json"),
  );
  insist(
    fileDigest(retained) ===
      fileDigest(await readFile("apps/community-wizard/package-lock.json")),
    "community_dependency_lock_changed",
    409,
  );
  await promisify(execFile)(
    "python3",
    [join(communityDependencyRoot, "verify.py")],
    { timeout: 120000, maxBuffer: 65536 },
  );
}
