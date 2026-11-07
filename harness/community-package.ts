import { firstSongGrant, releaseGrantPath } from "./first-song-upgrade.ts";
import { ownedModuleGraph } from "./owned-module-graph.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  readdir,
  writeFile,
  mkdir,
  copyFile,
  symlink,
  lstat,
  realpath,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { hashJson, hashText, insist } from "../packages/community/common.ts";
import { fileDigest } from "./creator-state.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  communityDependencyModules,
  verifyCommunityDependencies,
} from "./community-dependencies.ts";
import { learningCommunityProfile } from "./learning-community-profile.ts";
import {
  rewardsReleaseSelection,
  type RewardsReleaseSelection,
} from "./rewards-release-profile.ts";
import {
  applicationInfrastructureSources,
  writeApplicationInfrastructure,
} from "./community-infrastructure.ts";
import {
  studyReleaseSelection,
  type StudyReleaseSelection,
} from "./study-release-profile.ts";

export const communityBase = join(
  homedir(),
  ".local/state/pirate-first-song-managed-20261105",
);
export const communityPrefix = "pirate-first-song-20261105";
export const communityAccount = "08a4c22cf52e2ecae883e36f80a33f4a";
export const communityOwned = [
  {
    logical: "App",
    type: "Cloudflare.Worker",
    id: "a29dd318429e42eda7846ea4997ad999",
    attributes: {
      workerId: "a29dd318429e42eda7846ea4997ad999",
      workerName: communityPrefix,
    },
  },
  {
    logical: "Database",
    type: "Cloudflare.D1Database",
    id: "307cd8f0-cdc3-49de-884a-aeebffe75fd7",
    attributes: { databaseId: "307cd8f0-cdc3-49de-884a-aeebffe75fd7" },
  },
  {
    logical: "Media",
    type: "Cloudflare.R2.Bucket",
    id: "pirate-first-song-20261105-media",
    attributes: { bucketName: "pirate-first-song-20261105-media" },
  },
  {
    logical: "Jobs",
    type: "Cloudflare.Queues.Queue",
    id: "fe031cd96fbb47579585eb10154f785d",
    attributes: { queueId: "fe031cd96fbb47579585eb10154f785d" },
  },
] as const;
export async function artifactFiles(
  directory: string,
  relative = "",
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(directory, relative), {
    withFileTypes: true,
  })) {
    const path = join(relative, entry.name);
    insist(!entry.isSymbolicLink(), "community_artifact_symlink", 409);
    if (entry.isDirectory())
      found.push(...(await artifactFiles(directory, path)));
    else {
      insist(entry.isFile(), "community_artifact_invalid", 409);
      found.push(path);
    }
  }
  return found.sort();
}
export async function communityPackage(
  study?: StudyReleaseSelection,
  rewards?: RewardsReleaseSelection,
) {
  const selection = study ? studyReleaseSelection(study) : undefined;
  const rewardSelection = rewards
    ? rewardsReleaseSelection(rewards)
    : undefined;
  insist(
    !rewardSelection || selection,
    "reward_release_study_selection_required",
    409,
  );
  await verifyCommunityDependencies();
  const learning = await learningCommunityProfile(selection);
  const run = promisify(execFile),
    clean = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CI: "true",
      DO_NOT_TRACK: "1",
      NO_COLOR: "1",
    };
  const cli = await run(
    join(communityDependencyModules, ".bin/alchemy"),
    ["--version"],
    { env: clean, timeout: 30000, maxBuffer: 65536 },
  );
  insist(
    /2\.0\.0-beta\.85/.test(cli.stdout),
    "community_alchemy_version_changed",
    409,
  );
  await run("npm", ["run", "build:live"], {
    cwd: resolve("apps/web"),
    env: clean,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  const bundle = await build({
      entryPoints: ["services/community-application.ts"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2024",
      external: ["node:*"],
      minify: true,
      metafile: true,
      logLevel: "silent",
      legalComments: "none",
    }),
    bytes = bundle.outputFiles![0]!.contents;
  const graph = await build({
    entryPoints: ["harness/community-release.ts"],
    bundle: true,
    write: false,
    platform: "node",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  const tracked = await run(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps/web/src/live",
      "apps/web/src/karaoke",
      "apps/web/src/study",
      "apps/web/src/ui.ts",
      "apps/web/src/api-contract.ts",
      "apps/web/src/model.ts",
      "apps/web/tsconfig.json",
      "apps/web/vite.live.config.ts",
      "apps/web/vite.shared.ts",
      "apps/web/package.json",
      "apps/web/package-lock.json",
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const migrations = (await readdir("apps/community-wizard/infra/migrations"))
    .filter((p) => /^\d{4}_.+\.sql$/.test(p))
    .filter((p) => p !== "0011_manual_rewards.sql" || !!rewardSelection)
    .sort();
  const sourcePaths = [
    ...new Set(
      [
        ...Object.keys(bundle.metafile!.inputs),
        ...Object.keys(graph.metafile!.inputs),
        ...(await ownedModuleGraph("harness/published-replay.ts")),
        ...tracked.stdout.trim().split("\n"),
        ...migrations.map((p) => `apps/community-wizard/infra/migrations/${p}`),
        ...applicationInfrastructureSources,
        "docs/deployments/learning-results-testnet-20261106.contract.json",
        "packages/community/application-api.ts",
        selection?.reviewedUpdate.previousPlanPath ??
          "docs/deployments/first-song-managed-20261105.application-plan-v18.json",
        "docs/deployments/first-song-managed-20261105.creator-update-plan-v5.json",
        "docs/deployments/first-song-managed-20261105.published-state.json",
        releaseGrantPath,
        "docs/deployments/first-song-managed-20261105.moderation-plan.json",
        "harness/published-replay.ts",
        "package.json",
        "package-lock.json",
        "apps/community-wizard/package.json",
        "apps/community-wizard/package-lock.json",
      ].filter((p) => p && !p.includes("node_modules/")),
    ),
  ].sort();
  const hashes = Object.fromEntries(
      await Promise.all(
        sourcePaths.map(async (p) => [
          p,
          p.endsWith(".mp3")
            ? fileDigest(await readFile(p))
            : hashText(await readFile(p, "utf8")),
        ]),
      ),
    ),
    assetFiles = await artifactFiles("apps/web/dist/live"),
    assets = Object.fromEntries(
      await Promise.all(
        assetFiles.map(async (p) => [
          p,
          fileDigest(await readFile(join("apps/web/dist/live", p))),
        ]),
      ),
    ),
    stateFiles = [...communityOwned.map((r) => r.logical), "__stack_output__"],
    predecessor = Object.fromEntries(
      await Promise.all(
        stateFiles.map(async (logical) => {
          const relative = `${communityPrefix}/setup/${logical}.json`,
            path = join(communityBase, "deployment/.alchemy/state", relative),
            stat = await lstat(path);
          insist(
            stat.isFile() &&
              !(stat.mode & 0o077) &&
              stat.uid === process.getuid!(),
            "community_original_state_not_private",
            409,
          );
          return [relative, fileDigest(await readFile(path))];
        }),
      ),
    );
  const releaseGrant = await firstSongGrant();
  const profile = {
    schema: "pirate.community-application-plan/1",
    accountId: communityAccount,
    prefix: communityPrefix,
    origin: firstSong.origin,
    planId: firstSong.planId,
    stage: "setup",
    resources: communityOwned,
    predecessorState: predecessor,
    predecessorWorkerSha256: fileDigest(
      await readFile(join(communityBase, "deployment/worker/worker.mjs")),
    ),
    sourceHashes: hashes,
    bundleSha256: fileDigest(bytes),
    bundleBytes: bytes.length,
    assets,
    migrations,
    releaseGrant,
    curatedState: JSON.parse(
      await readFile(
        "docs/deployments/first-song-managed-20261105.published-state.json",
        "utf8",
      ),
    ),
    managedProfileHash: JSON.parse(
      await readFile(
        "docs/deployments/first-song-managed-20261105.moderation-plan.json",
        "utf8",
      ),
    ).profileHash as string,
    queueConsumer: {
      logical: "Consumer",
      queueId: "fe031cd96fbb47579585eb10154f785d",
      scriptName: communityPrefix,
      batchSize: 1,
      maxConcurrency: 1,
      maxRetries: 3,
      retryDelay: 60,
    },
    creatorProfileHash: JSON.parse(
      await readFile(
        "docs/deployments/first-song-managed-20261105.creator-update-plan-v5.json",
        "utf8",
      ),
    ).profileHash as string,
    reviewedUpdate: selection?.reviewedUpdate ?? {
      previousPlanPath:
        "docs/deployments/first-song-managed-20261105.application-plan-v18.json",
      previousProfileHash:
        "0xf3f969461ccae7af98b7d1cf7f00c7ac7af562e4613b24811cac1b52378b9c32",
      expectedExecutionSha256:
        "0xed141b9dd5997acbbf630aef9aefc0cd939d95b945ea151b715417748b1640ba",
      expectedResultSha256:
        "0xafe41cac7e8c8f47bbced40b22c0bf019fd470581f30c7cdbe1fa50e88290f4c",
    },
    publisher: "0x14b90a55657d9695a727254eaec5e0e32d20d602",
    credentialBinding: {
      projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
      environment: "staging",
      path: `/services/${communityPrefix}`,
      name: "COMMUNITY_PUBLISHER_PRIVATE_KEY",
    },
    stateProtection: {
      projectId: "43d2261a-f739-428f-92f2-5f907db24c07",
      environment: "staging",
      path: "/communities/first-song-20261105-runner",
    },
    bounds: {
      executionSeconds: 900,
      newResources: 1,
      nativeTransactions: 0,
      providerRequests: 24,
      registrationTransactions: 1,
      publicationTransactions: 1,
      publicPins: 5,
      maximumRegistrationFee: releaseGrant.registration.maximumTotalFee,
      maximumPublicationFee: "30000000000000",
    },
    acceptance: learning.acceptance,
    learning,
    ...(rewardSelection ? { rewards: rewardSelection } : {}),
    recovery:
      "Keep original encrypted wizard state unchanged. Reconcile the same owned resource IDs and encrypted application successor after interruption. Never reapply the obsolete setup Worker.",
  };
  return { profile, profileHash: hashJson(profile), bytes };
}
export async function writeCommunityPackage(
  directory: string,
  bytes: Uint8Array,
  migrations: string[],
) {
  const cwd = join(directory, "deployment");
  for (const path of [
    cwd,
    join(cwd, "worker"),
    join(cwd, "assets"),
    join(cwd, "migrations"),
  ])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(
    join(cwd, "package.json"),
    '{"private":true,"type":"module"}\n',
    { mode: 0o600 },
  );
  await writeApplicationInfrastructure(cwd);
  for (const file of migrations)
    await copyFile(
      `apps/community-wizard/infra/migrations/${file}`,
      join(cwd, "migrations", file),
    );
  await writeFile(join(cwd, "worker/worker.mjs"), bytes, { mode: 0o600 });
  for (const file of await artifactFiles("apps/web/dist/live")) {
    const target = join(cwd, "assets", file);
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await copyFile(join("apps/web/dist/live", file), target);
  }
  const modules = join(cwd, "node_modules"),
    expected = communityDependencyModules;
  try {
    await symlink(expected, modules, "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  insist(
    (await lstat(modules)).isSymbolicLink() &&
      (await realpath(modules)) === (await realpath(expected)),
    "community_dependencies_changed",
    409,
  );
  return cwd;
}
