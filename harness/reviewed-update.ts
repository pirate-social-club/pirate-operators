import { assertFirstSongUpgrade } from "./first-song-upgrade.ts";
import { assertCuratedUpgrade, curatedBaselines } from "./curated-upgrade.ts";
// Bounded update of a previously applied, independently reviewed package.
// Ownership and fresh live module checks are supplied by each owning runner.
import {
  readFile,
  readdir,
  mkdir,
  copyFile,
  open,
  realpath,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import {
  canonical,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import {
  digest,
  durableJson,
  privateJson,
  replacePrivateJson,
} from "./private-json.ts";

export interface ReviewedUpdate {
  previousPlanPath: string;
  previousProfileHash: string;
  expectedExecutionSha256: string;
  expectedResultSha256: string | null;
}
type Package = {
  profile: Record<string, unknown> & { reviewedUpdate: ReviewedUpdate };
  profileHash: string;
};
const intent = (profile: Record<string, unknown>) =>
  Object.fromEntries(
    [
      "schema",
      "accountId",
      "resources",
      "origins",
      "origin",
      "prefix",
      "planId",
      "stage",
      "rpId",
      "operator",
      "operatorCredential",
      "stateProtection",
      "bounds",
      "publisher",
      "credentialBinding",
      "migrations",
      "predecessorState",
    ]
      .filter((k) => Object.hasOwn(profile, k))
      .map((k) => [k, profile[k]]),
  );

export async function reviewedPredecessor(
  directory: string,
  packaged: Package,
) {
  const policy = packaged.profile.reviewedUpdate,
    previous = object(
      JSON.parse(await readFile(policy.previousPlanPath, "utf8")),
    );
  insist(
    previous.profileHash === policy.previousProfileHash &&
      hashJson(previous.profile) === policy.previousProfileHash &&
      hashJson(packaged.profile) === packaged.profileHash,
    "reviewed_update_plan_changed",
    409,
  );
  if (
    canonical(intent(object(previous.profile))) !==
    canonical(intent(packaged.profile))
  ) {
    // Only the exact idle first-song application baseline has a functional
    // transition. Every other profile retains the generic immutable intent.
    if (
      previous.profileHash ===
      "0x968dfa65112ca99aeb1ceef68da0501891a24aa6da5a07c801f5d11b4acf8dfb"
    )
      assertFirstSongUpgrade(
        object(previous.profile),
        packaged.profile,
        "application",
      );
    else if (previous.profileHash === curatedBaselines.application)
      assertCuratedUpgrade(
        object(previous.profile),
        packaged.profile,
        "application",
      );
    else
      insist(false, "reviewed_update_changes_resource_or_spending_intent", 409);
  }
  const execution = await privateJson(join(directory, "execution.json"));
  insist(execution, "reviewed_update_execution_missing", 409);
  if (execution.profileHash === packaged.profileHash) {
    const backup = join(
        directory,
        `before-update-${packaged.profileHash.slice(2)}`,
      ),
      marker = await privateJson(join(backup, "preservation.json"));
    insist(
      execution.previousProfileHash === policy.previousProfileHash &&
        execution.previousExecutionSha256 === policy.expectedExecutionSha256 &&
        execution.backup === backup &&
        marker?.successor === packaged.profileHash &&
        digest(await readFile(join(backup, "execution.json"))) ===
          policy.expectedExecutionSha256,
      "reviewed_update_adoption_unverified",
      409,
    );
    await preserveReviewedPackage(directory, packaged.profileHash, {});
    return { previous, adopted: true };
  }
  insist(
    execution.profileHash === policy.previousProfileHash &&
      digest(await readFile(join(directory, "execution.json"))) ===
        policy.expectedExecutionSha256,
    "reviewed_update_execution_changed",
    409,
  );
  const result = await privateJson(join(directory, "deployment-result.json"));
  if (policy.expectedResultSha256 === null)
    insist(result === null, "reviewed_update_unexpected_result", 409);
  else
    insist(
      result?.profileHash === policy.previousProfileHash &&
        digest(await readFile(join(directory, "deployment-result.json"))) ===
          policy.expectedResultSha256,
      "reviewed_update_result_changed",
      409,
    );
  return { previous, adopted: false };
}

/** Preserve bytes, including encrypted state and diagnostics, before mutation.
 * Existing completed backups are verified and never overwritten on a retry. */
export async function preserveReviewedPackage(
  directory: string,
  successor: string,
  allowedLinks: Record<string, string>,
) {
  const backup = join(directory, `before-update-${successor.slice(2)}`),
    marker = join(backup, "preservation.json");
  const saved = await privateJson(marker);
  if (saved) {
    insist(
      saved.successor === successor,
      "reviewed_backup_profile_changed",
      409,
    );
    for (const [relative, hash] of Object.entries(object(saved.files))) {
      insist(
        !relative.startsWith("/") && !relative.split("/").includes(".."),
        "reviewed_backup_path_invalid",
        409,
      );
      insist(
        digest(await readFile(join(backup, relative))) === hash,
        "reviewed_backup_changed",
        409,
      );
    }
    return backup;
  }
  const files: string[] = [];
  async function walk(relative: string) {
    for (const entry of await readdir(join(directory, relative), {
      withFileTypes: true,
    })) {
      if (
        !relative &&
        (entry.name === "execution.lock" ||
          entry.name.startsWith("before-update-"))
      )
        continue;
      const path = join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        insist(
          allowedLinks[path] &&
            (await realpath(join(directory, path))) ===
              (await realpath(allowedLinks[path]!)),
          "reviewed_backup_unexpected_link",
          409,
        );
        continue;
      }
      if (entry.isDirectory()) await walk(path);
      else {
        insist(entry.isFile(), "reviewed_backup_unexpected_file", 409);
        files.push(path);
      }
    }
  }
  await walk("");
  insist(files.length < 512, "reviewed_backup_too_many_files", 409);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const backupStat = await lstat(backup);
  insist(
    backupStat.isDirectory() &&
      !backupStat.isSymbolicLink() &&
      backupStat.uid === process.getuid!() &&
      !(backupStat.mode & 0o077),
    "reviewed_backup_not_private",
    409,
  );
  const hashes: Record<string, string> = {},
    dirs = new Set([directory, backup]);
  let bytes = 0;
  for (const file of files.sort()) {
    const contents = await readFile(join(directory, file));
    bytes += contents.length;
    insist(bytes <= 64 * 1024 * 1024, "reviewed_backup_too_large", 409);
    hashes[file] = digest(contents);
  }
  // A restart can finish partial copies only while the complete captured source
  // still matches. No Alchemy phase starts before the completion marker exists.
  await durableJson(join(backup, "preservation-intent.json"), {
    successor,
    files: hashes,
  });
  for (const file of files.sort()) {
    const source = join(directory, file),
      target = join(backup, file),
      contents = await readFile(source);
    insist(
      digest(contents) === hashes[file],
      "reviewed_backup_source_changed",
      409,
    );
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    const handle = await open(target, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let dir = join(target, ".."); dir !== backup; dir = join(dir, ".."))
      dirs.add(dir);
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await durableJson(marker, { successor, files: hashes });
  return backup;
}

export async function adoptReviewedUpdate(
  directory: string,
  packaged: Package,
  allowedLinks: Record<string, string>,
) {
  const qualified = await reviewedPredecessor(directory, packaged);
  if (qualified.adopted) return;
  const backup = await preserveReviewedPackage(
    directory,
    packaged.profileHash,
    allowedLinks,
  );
  await replacePrivateJson(
    join(directory, "execution.json"),
    {
      profileHash: packaged.profileHash,
      previousProfileHash: packaged.profile.reviewedUpdate.previousProfileHash,
      previousExecutionSha256:
        packaged.profile.reviewedUpdate.expectedExecutionSha256,
      backup,
      at: new Date().toISOString(),
    },
    packaged.profile.reviewedUpdate.expectedExecutionSha256,
  );
}

/** Successful successors replace only the preserved, exact previous result. */
export async function finishReviewedUpdate(
  directory: string,
  packaged: Package,
  result: Record<string, unknown>,
) {
  const path = join(directory, "deployment-result.json"),
    saved = await privateJson(path);
  if (!saved) {
    await durableJson(path, result);
    return;
  }
  if (saved.profileHash === packaged.profileHash) {
    insist(
      canonical(saved) === canonical(result),
      "reviewed_result_conflict",
      409,
    );
    return;
  }
  const expected = packaged.profile.reviewedUpdate.expectedResultSha256;
  insist(
    expected &&
      saved.profileHash ===
        packaged.profile.reviewedUpdate.previousProfileHash &&
      (await privateJson(
        join(
          directory,
          `before-update-${packaged.profileHash.slice(2)}`,
          "preservation.json",
        ),
      )),
    "reviewed_result_not_preserved",
    409,
  );
  await replacePrivateJson(path, result, expected);
}
