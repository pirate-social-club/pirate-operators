import {
  assertPublishedUpgrade,
  publishedBaselines,
} from "./published-state.ts";
import { assertFirstSongUpgrade } from "./first-song-upgrade.ts";
import { assertPublishingManagedUpgrade } from "./publishing-release-profile.ts";
import { assertCuratedUpgrade, curatedBaselines } from "./curated-upgrade.ts";
import { qualifyRetainedState } from "./published-state.ts";
import {
  readFile,
  lstat,
  readdir,
  mkdir,
  copyFile,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import {
  canonical,
  hashJson,
  hashText,
  insist,
  object,
} from "../packages/community/common.ts";
import { unseal } from "../apps/managed-moderation/protected-data.ts";
import { cfJson } from "./managed-inventory.ts";
import type { managedInventory } from "./managed-inventory.ts";
import type { managedPackage } from "./managed-package.ts";
import { fetchWorkerModuleDigests } from "./worker-modules.ts";

type Profile = Awaited<ReturnType<typeof managedPackage>>["profile"];
type Inventory = Awaited<ReturnType<typeof managedInventory>>;
const json = async (path: string) =>
  object(JSON.parse(await readFile(path, "utf8")));

/** Read-only ownership and retained-state qualification. Never creates resources. */
export async function qualifyManagedUpdate(
  directory: string,
  profile: Profile,
  inventory: Inventory,
  password: string,
  env: NodeJS.ProcessEnv,
) {
  const previous = await json(profile.update.previousPlanPath),
    startup = await json(profile.update.startupEvidencePath),
    previousEvidence = await json(profile.update.previousEvidencePath);
  insist(
    previous.profileHash === profile.update.previousProfileHash &&
      hashJson(previous.profile) === previous.profileHash &&
      (previousEvidence.profileHash ??
        (previousEvidence.profiles
          ? object(previousEvidence.profiles).managed
          : object(object(previousEvidence.services).managed).profileHash)) ===
        previous.profileHash,
    "managed_update_predecessor_changed",
    409,
  );
  const intent = (input: unknown) => {
    const {
      sourceHashes,
      bundleSha256,
      bundleBytes,
      update,
      // Pinned by hash and checked against live state in qualifyRetainedState.
      curatedStateRepair,
      ...rest
    } = object(input);
    return rest;
  };
  if (
    (profile as { ownerGrant?: unknown }).ownerGrant ||
    object(previous.profile).ownerGrant
  )
    assertPublishingManagedUpgrade(object(previous.profile), profile);
  else if (canonical(intent(previous.profile)) !== canonical(intent(profile))) {
    if (previous.profileHash === publishedBaselines.managed)
      assertPublishedUpgrade(object(previous.profile), profile, "managed");
    else if (previous.profileHash === curatedBaselines.managed)
      assertCuratedUpgrade(object(previous.profile), profile, "managed");
    else assertFirstSongUpgrade(object(previous.profile), profile, "managed");
  }
  const ids = object(startup.resourceIds),
    expected = [
      object(ids.worker).id,
      object(ids.database).uuid,
      object(ids.media).name,
      object(ids.queue).queue_id,
    ];
  insist(
    inventory.resources.length === 4 &&
      inventory.resources.every((r, i) => r.present && r.id === expected[i]),
    "managed_update_resource_identity_changed",
    409,
  );
  const retainedResult = await json(join(directory, "deployment-result.json"));
  if (retainedResult.profileHash === previous.profileHash)
    insist(
      hashText(
        await readFile(join(directory, "deployment-result.json"), "utf8"),
      ) === profile.update.expectedResultSha256,
      "managed_update_result_changed",
      409,
    );
  else {
    insist(
      retainedResult.profileHash === hashJson(profile),
      "managed_update_result_profile_changed",
      409,
    );
    const backup = join(
        directory,
        `before-update-${hashJson(profile).slice(2)}`,
      ),
      marker = await json(join(backup, "preservation.json"));
    insist(
      marker.successor === hashJson(profile) &&
        marker.resultSha256 === profile.update.expectedResultSha256 &&
        hashText(
          await readFile(join(backup, "deployment-result.json"), "utf8"),
        ) === profile.update.expectedResultSha256,
      "managed_update_backup_result_changed",
      409,
    );
  }
  const state = join(directory, "deployment/.alchemy/state");
  for (const [logical, type, attributes] of [
    [
      "App",
      "Cloudflare.Worker",
      { workerId: expected[0], workerName: profile.prefix },
    ],
    ["Database", "Cloudflare.D1Database", { databaseId: expected[1] }],
    ["Media", "Cloudflare.R2.Bucket", { bucketName: expected[2] }],
    ["Jobs", "Cloudflare.Queues.Queue", { queueId: expected[3] }],
    [
      "Consumer",
      "Cloudflare.Queues.Consumer",
      {
        queueId: expected[3],
        consumerId: "304066df0ff94bb495e66ebb59e0ef5d",
        scriptName: profile.prefix,
      },
    ],
  ] as const) {
    const relative = `${profile.prefix}/managed/${logical}.json`,
      path = join(state, relative),
      metadata = await lstat(path);
    insist(
      metadata.isFile() &&
        !(metadata.mode & 0o077) &&
        metadata.uid === process.getuid!(),
      "managed_update_state_not_private",
      409,
    );
    const record = object(
        JSON.parse(
          unseal(
            await readFile(path, "utf8"),
            password,
            `alchemy-state:${relative}`,
          ),
        ),
      ),
      attr = object(record.attr);
    insist(
      ["created", "updated"].includes(String(record.status)) &&
        record.resourceType === type &&
        record.logicalId === logical &&
        attr.accountId === profile.accountId &&
        Object.entries(attributes).every(([key, value]) => attr[key] === value),
      "managed_update_state_identity_changed",
      409,
    );
  }
  const response = await fetch(profile.origin + "/health", {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    }),
    health = object(await response.json());
  insist(
    response.ok &&
      health.status === "available" &&
      (health.profileHash === previous.profileHash ||
        health.profileHash === hashJson(profile)),
    "managed_update_live_profile_changed",
    409,
  );
  const modules = await fetchWorkerModuleDigests(
    String(env.CLOUDFLARE_API_TOKEN),
    profile.accountId,
    profile.prefix,
    ["worker.mjs"],
  );
  insist(
    Object.keys(modules).length === 1 &&
      Object.values(modules).every(
        (hash) =>
          hash === object(previous.profile).bundleSha256 ||
          hash === profile.bundleSha256,
      ),
    "managed_update_live_source_changed",
    409,
  );
  if (profile.curatedState) {
    await qualifyRetainedState(
      String(env.CLOUDFLARE_API_TOKEN),
      profile.accountId,
      profile.curatedState,
      "managed",
      (profile as { curatedStateRepair?: unknown }).curatedStateRepair,
    );
    return;
  }
  // Functional enablement must finish before the first paid request. Existing
  // jobs are never migrated by this idle-only staging transition.
  const counts = await cfJson(
    [
      "d1",
      "query",
      String(expected[1]),
      "--sql",
      "SELECT (SELECT COUNT(*) FROM managed_admissions) AS admissions, (SELECT COUNT(*) FROM moderation_provider_calls) AS providerCalls",
    ],
    env,
  );
  insist(
    Array.isArray(counts) && counts.length === 1,
    "managed_update_idle_check_invalid",
    503,
  );
  const result = object(counts[0]);
  insist(
    result.success === true &&
      Array.isArray(result.results) &&
      result.results.length === 1,
    "managed_update_idle_check_invalid",
    503,
  );
  const count = object(result.results[0]);
  insist(
    count.admissions === 0 && count.providerCalls === 0,
    "managed_update_requires_idle_service",
    409,
  );
}

/** Preserve encrypted predecessor state and its source before updating in place.
 * An incomplete backup is retained and blocks execution for reconciliation. */
export async function preserveManagedDeployment(
  directory: string,
  successor: string,
) {
  const source = join(directory, "deployment"),
    backup = join(directory, `before-update-${successor.slice(2)}`),
    files: string[] = [];
  async function enumerate(relative: string) {
    for (const entry of await readdir(join(source, relative), {
      withFileTypes: true,
    })) {
      if (entry.name === "node_modules") continue;
      const next = join(relative, entry.name);
      insist(!entry.isSymbolicLink(), "managed_backup_unexpected_symlink", 409);
      if (entry.isDirectory()) await enumerate(next);
      else if (entry.isFile()) files.push(next);
      else insist(false, "managed_backup_unexpected_file", 409);
    }
  }
  await enumerate("");
  const manifest = Object.fromEntries(
    await Promise.all(
      files
        .sort()
        .map(async (file) => [
          file,
          hashText(await readFile(join(source, file), "utf8")),
        ]),
    ),
  );
  const complete = join(backup, "preservation.json");
  try {
    await mkdir(backup, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const saved = await json(complete);
    insist(
      saved.successor === successor,
      "managed_backup_successor_changed",
      409,
    );
    const retained = object(saved.files);
    for (const [file, digest] of Object.entries(retained)) {
      insist(
        !file.startsWith("/") && !file.split("/").includes(".."),
        "managed_backup_invalid_path",
        409,
      );
      insist(
        hashText(await readFile(join(backup, "deployment", file), "utf8")) ===
          digest,
        "managed_backup_changed",
        409,
      );
    }
    insist(
      hashText(
        await readFile(join(backup, "deployment-result.json"), "utf8"),
      ) === saved.resultSha256,
      "managed_backup_result_changed",
      409,
    );
    await syncBackupDirectories(backup, directory, Object.keys(retained));
    return;
  }
  for (const file of files) {
    const target = join(backup, "deployment", file);
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await copyFile(join(source, file), target);
    const handle = await open(target, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const original = await readFile(
    join(directory, "deployment-result.json"),
    "utf8",
  );
  const save = async (name: string, value: string) => {
    const handle = await open(join(backup, name), "wx", 0o600);
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  await save("deployment-result.json", original);
  await syncBackupDirectories(backup, directory, files);
  // The completion marker is written only after every predecessor entry is durable.
  await save(
    "preservation.json",
    canonical({ successor, files: manifest, resultSha256: hashText(original) }),
  );
  await syncBackupDirectories(backup, directory, []);
}
async function syncBackupDirectories(
  backup: string,
  directory: string,
  files: string[],
) {
  const dirs = new Set([backup, directory]);
  for (const file of files) {
    let parent = join(backup, "deployment", file, "..");
    while (parent !== backup) {
      dirs.add(parent);
      parent = join(parent, "..");
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
