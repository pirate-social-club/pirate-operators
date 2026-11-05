import {
  readFile,
  copyFile,
  writeFile,
  symlink,
  lstat,
  realpath,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { privateDirectory } from "../apps/community-wizard/server/state.ts";
import { hashJson, hashText, insist } from "../packages/community/common.ts";

export const managedPrefix = "pirate-managed-firstsong-20261105";
export const managedOrigin = `https://${managedPrefix}.piratesocialclub.workers.dev`;
export async function managedPackage() {
  const cli = await promisify(execFile)(
    resolve("apps/managed-moderation/node_modules/.bin/alchemy"),
    ["--version"],
    {
      cwd: resolve("apps/managed-moderation"),
      timeout: 30000,
      maxBuffer: 65536,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: "true",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
      },
    },
  );
  insist(/2\.0\.0-beta\.85/.test(cli.stdout), "managed_cli_version_mismatch");
  const bundle = await build({
    entryPoints: ["services/managed-moderation.ts"],
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
  });
  const bytes = bundle.outputFiles![0]!.contents;
  const files = [
    ...Object.keys(bundle.metafile!.inputs).filter(
      (p) => !p.includes("node_modules/"),
    ),
    "package.json",
    "package-lock.json",
    "apps/managed-moderation/package.json",
    "apps/managed-moderation/package-lock.json",
    "apps/managed-moderation/alchemy.run.ts",
    "apps/managed-moderation/encrypted-state.ts",
    "apps/managed-moderation/protected-data.ts",
    "apps/managed-moderation/migrations/0001_managed.sql",
    "apps/community-wizard/infra/encrypted-state.ts",
    "apps/community-wizard/infra/protected-data.ts",
    "apps/community-wizard/server/infisical-auth.ts",
    "apps/community-wizard/server/operator.ts",
    "apps/community-wizard/server/state.ts",
    "apps/community-wizard/server/model.ts",
    "apps/community-wizard/server/state-inspection.ts",
    "apps/community-wizard/server/diagnostics.ts",
    "apps/community-wizard/package-lock.json",
    "harness/managed-package.ts",
    "harness/managed-service.ts",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      [...new Set(files)]
        .sort()
        .map(async (path) => [path, hashText(await readFile(path, "utf8"))]),
    ),
  );
  const contracts = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.contracts.json",
      "utf8",
    ),
  );
  const pairings = [
    {
      communityId: contracts.communityId,
      registry: contracts.registry.address,
      directory: contracts.directory.address,
      controller: contracts.registry.admin.toLowerCase(),
      communityOrigin: contracts.profile.origin,
      serviceOrigin: managedOrigin,
      enabled: true,
      budgetPeriod: "first-song-20261105-v1",
      requestCap: 24,
    },
  ];
  const directoryProfiles = [
    {
      chainId: 6343,
      communityId: contracts.communityId,
      registry: contracts.registry.address,
      directory: contracts.directory.address,
      deploymentBlock: contracts.directory.blockNumber,
      directoryCodeHash: contracts.directory.runtimeCodeHash,
    },
  ];
  const profile = {
    schema: "pirate.managed-service-plan/1",
    accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
    prefix: managedPrefix,
    origin: managedOrigin,
    resources: {
      worker: managedPrefix,
      database: `${managedPrefix}-db`,
      media: `${managedPrefix}-media`,
      jobs: `${managedPrefix}-jobs`,
      consumer: managedPrefix,
    },
    sourceHashes: hashes,
    bundleSha256: hashText(bundle.outputFiles![0]!.text),
    bundleBytes: bytes.length,
    pairings,
    directoryProfiles,
    moderationSigner: "0xa67ac40bc3d5e1b25d7da5ca2e8585f335a37329",
    serviceBudgetPeriod: "first-song-20261105-v1",
    serviceRequestCap: 24,
    acrHost: "identify-eu-west-1.acrcloud.com",
    providerCredentials: {
      projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
      environment: "staging",
      sourcePath: "/services/api-next",
      targetPath: `/services/${managedPrefix}`,
    },
    stateProtection: {
      projectId: "43d2261a-f739-428f-92f2-5f907db24c07",
      environment: "staging",
      path: "/communities/first-song-20261105-runner",
    },
    secretNames: [
      "ACRCLOUD_ACCESS_KEY",
      "ACRCLOUD_ACCESS_SECRET",
      "OPENAI_API_KEY",
      "MODERATION_SIGNER_PRIVATE_KEY",
    ],
    bounds: {
      executionSeconds: 900,
      healthSeconds: 60,
      providerRequests: 24,
      registrationTransactions: 0,
      paymentDeposits: 0,
    },
    recovery:
      "Keep the same encrypted Alchemy state and D1 provider journals. Reconcile task-owned resources after an interrupted apply. Unknown paid provider sends cannot be replayed.",
  };
  return { profile, profileHash: hashJson(profile), bytes };
}
export async function writeManagedPackage(
  directory: string,
  bytes: Uint8Array,
) {
  const cwd = join(directory, "deployment");
  for (const path of [
    directory,
    cwd,
    join(cwd, "worker"),
    join(cwd, "migrations"),
  ])
    await privateDirectory(path);
  await writeFile(
    join(cwd, "package.json"),
    '{"private":true,"type":"module"}\n',
    { mode: 0o600 },
  );
  const source = await readFile(
    "apps/managed-moderation/alchemy.run.ts",
    "utf8",
  );
  await writeFile(join(cwd, "alchemy.run.ts"), source, { mode: 0o600 });
  await writeFile(join(cwd, "worker/worker.mjs"), bytes, { mode: 0o600 });
  await copyFile(
    "apps/managed-moderation/migrations/0001_managed.sql",
    join(cwd, "migrations/0001_managed.sql"),
  );
  for (const file of ["encrypted-state.ts", "protected-data.ts"])
    await copyFile(`apps/managed-moderation/${file}`, join(cwd, file));
  const modules = join(cwd, "node_modules"),
    expected = resolve("apps/managed-moderation/node_modules");
  try {
    insist(
      (await lstat(modules)).isSymbolicLink(),
      "unexpected_managed_dependencies",
    );
    await unlink(modules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(expected, modules, "dir");
  insist(
    (await realpath(modules)) === (await realpath(expected)),
    "unexpected_managed_dependencies",
  );
  return cwd;
}
