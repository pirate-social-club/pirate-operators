import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  copyFile,
  symlink,
  lstat,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashJson, insist } from "../packages/community/common.ts";
import { build } from "esbuild";
import {
  creatorAccount,
  creatorPredecessor,
  creatorResources,
  fileDigest,
} from "./creator-state.ts";

const run = promisify(execFile),
  root = resolve("apps/creator-spike");
const cleanEnvironment = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CI: "true",
  DO_NOT_TRACK: "1",
  NO_COLOR: "1",
});
async function files(directory: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(directory, relative), {
    withFileTypes: true,
  })) {
    const next = join(relative, entry.name);
    insist(!entry.isSymbolicLink(), "unexpected_creator_artifact_symlink");
    if (entry.isDirectory()) found.push(...(await files(directory, next)));
    else if (entry.isFile()) found.push(next);
    else insist(false, "unexpected_creator_artifact");
  }
  return found.sort();
}
export async function creatorPackage() {
  const cli = await run(
    resolve(root, "infra/node_modules/.bin/alchemy"),
    ["--version"],
    {
      cwd: root,
      env: cleanEnvironment(),
      timeout: 30000,
      maxBuffer: 65536,
    },
  );
  insist(
    /2\.0\.0-beta\.85/.test(cli.stdout),
    "creator_alchemy_version_changed",
  );
  await run("npm", ["run", "build"], {
    cwd: root,
    env: cleanEnvironment(),
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const source = await run(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps/creator-spike",
      "packages/community",
      "packages/protocol",
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  const graph = await build({
    entryPoints: ["harness/creator-service.ts"],
    bundle: true,
    write: false,
    platform: "node",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  const paths = [
    ...new Set([
      ...source.stdout.trim().split("\n"),
      ...Object.keys(graph.metafile!.inputs).filter(
        (path) => !path.includes("node_modules/"),
      ),
      "harness/creator-package.ts",
      "harness/creator-service.ts",
      "harness/creator-state.ts",
      "harness/creator-inventory.ts",
      "harness/managed-inventory.ts",
      "package.json",
      "package-lock.json",
      "docs/deployments/first-song-managed-20261105.creator-update-plan-v1.json",
      ...[
        "operator",
        "infisical-auth",
        "diagnostics",
        "state",
        "state-inspection",
        "model",
      ].map((n) => `apps/community-wizard/server/${n}.ts`),
    ]),
  ].sort();
  const sourceHashes = Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [path, fileDigest(await readFile(path))]),
      ),
    ),
    artifactFiles = await files(join(root, "dist")),
    artifacts = Object.fromEntries(
      await Promise.all(
        artifactFiles.map(async (path) => [
          path,
          fileDigest(await readFile(join(root, "dist", path))),
        ]),
      ),
    ),
    evidence = JSON.parse(
      await readFile(
        "apps/creator-spike/evidence/deployment-20261104.json",
        "utf8",
      ),
    );
  const profile = {
    schema: "pirate.first-song-creator-update/1",
    accountId: creatorAccount,
    resources: creatorResources,
    origins: [
      "https://pirate-wallet-test.piratesocialclub.workers.dev",
      "https://pirate-creator-spike.piratesocialclub.workers.dev",
    ],
    rpId: "pirate-wallet-test.piratesocialclub.workers.dev",
    sourceHashes,
    artifacts,
    predecessorState: await creatorPredecessor(),
    restoredStateRecovery: {
      previousPlanPath:
        "docs/deployments/first-song-managed-20261105.creator-update-plan-v1.json",
      previousProfileHash:
        "0xae814c25d199ceace77150841573df2549da2a3c08df6015b05fcc6c95be6d3d",
      expectedExecutionFileSha256:
        "0x55f999f9e9424229e1f8da5f2b5a226b1df070f7892e02e140f024f5d43f6d2d",
    },
    predecessorModules: {
      "index.js": `0x${evidence.filesSha256["worker/index.js"]}`,
      "ika.wasm": `0x${evidence.filesSha256["worker/ika.wasm"]}`,
    },
    operator:
      "0xe80513f6f72a375ef3fc279f74e904ba4ab244554abbd468559a13a811a82ea6",
    operatorCredential: {
      projectId: "43d2261a-f739-428f-92f2-5f907db24c07",
      environment: "dev",
      path: "/",
      name: "SUI_OPERATOR_SECRET_KEY",
    },
    stateProtection: {
      projectId: "43d2261a-f739-428f-92f2-5f907db24c07",
      environment: "staging",
      path: "/communities/first-song-20261105-runner",
      name: "PIRATE_WIZARD_STATE_PASSWORD",
    },
    bounds: {
      executionSeconds: 900,
      newResources: 0,
      nativeTransactions: 0,
      providerRequests: 0,
    },
    recovery:
      "Preserve the historical state without changing it. Resume the same encrypted successor and exact reviewed package; reconcile owned resources before retry. Never repeat a funded native operation.",
  };
  return { profile, profileHash: hashJson(profile) };
}
export async function writeCreatorPackage(directory: string) {
  const deployment = join(directory, "deployment"),
    cwd = join(deployment, "infra");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await writeFile(
    join(cwd, "package.json"),
    '{"private":true,"type":"module"}\n',
    { mode: 0o600 },
  );
  for (const name of [
    "alchemy.run.ts",
    "encrypted-state.ts",
    "protected-data.ts",
  ])
    await copyFile(join(root, "infra", name), join(cwd, name));
  for (const relative of await files(join(root, "dist"))) {
    const target = join(deployment, "dist", relative);
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await copyFile(join(root, "dist", relative), target);
  }
  await mkdir(join(cwd, "migrations"), { recursive: true, mode: 0o700 });
  for (const name of await files(join(root, "infra/migrations")))
    await copyFile(
      join(root, "infra/migrations", name),
      join(cwd, "migrations", name),
    );
  const modules = join(cwd, "node_modules"),
    expected = join(root, "infra/node_modules");
  try {
    await symlink(expected, modules, "dir");
  } catch (error) {
    insist(
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
        (await lstat(modules)).isSymbolicLink() &&
        (await realpath(modules)) === (await realpath(expected)),
      "creator_dependencies_changed",
      409,
    );
  }
  return cwd;
}
