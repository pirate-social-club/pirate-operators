import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { hashText, insist } from "../packages/community/common.ts";
import { communityMigrations } from "./package-migrations.ts";

const digest = (bytes: Uint8Array) =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;
const run = promisify(execFile);

const clientRequired = [
  "apps/web/src/live/entry.tsx", "apps/web/tsconfig.json",
  "apps/web/vite.live.config.ts", "apps/web/vite.shared.ts",
  "apps/web/package.json", "apps/web/package-lock.json",
] as const;
/** Only a complete inventory from this exact approved Git worktree is valid. */
export async function communityClientInventory(
  sourceRoot: string, environment: NodeJS.ProcessEnv = process.env,
) {
  const root = await directory(sourceRoot);
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "CI", "DO_NOT_TRACK", "NO_COLOR", "npm_config_userconfig", "npm_config_globalconfig"])
    if (environment[name] !== undefined) env[name] = environment[name];
  insist(env.HOME === process.env.HOME, "community_artifact_git_home_changed", 409);
  // No ambient GIT_DIR/WORK_TREE/INDEX_FILE/CONFIG_* or other Git redirection.
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
  const args = ["--no-optional-locks", "-c", `safe.directory=${root}`,
    "-c", "core.fsmonitor=false", "-C", root];
  const topology = await run("git", [...args, "rev-parse", "--show-toplevel"],
    { env, maxBuffer: 65536 });
  const declared = topology.stdout.replace(/\r?\n$/, "");
  insist(await realpath(declared) === root,
    "community_artifact_git_root_mismatch", 409);
  const tracked = await run("git", [...args, "ls-files", "--full-name", "--cached",
    "--others", "--exclude-standard", "-z", "--", "apps/web/src",
    ...clientRequired.filter((name) => !name.startsWith("apps/web/src/"))],
    { env, maxBuffer: 1024 * 1024 });
  const names = tracked.stdout.split("\0").filter(Boolean);
  insist(names.length > 0 && new Set(names).size === names.length &&
    clientRequired.every((name) => names.includes(name)),
    "community_artifact_client_inventory_incomplete", 409);
  for (const name of names)
    insist(inside(root, resolve(root, name)) === name &&
      (name.startsWith("apps/web/src/") || clientRequired.some((fixed) => fixed === name)),
      "community_artifact_client_inventory_invalid", 409);
  return names.sort();
}

function inside(root: string, path: string, allowRoot = false) {
  const value = relative(root, path);
  insist(
    (allowRoot || value !== "") &&
      value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value),
    "community_artifact_path", 409,
  );
  return value.split(sep).join("/");
}
async function directory(path: string) {
  const absolute = resolve(path), info = await lstat(absolute);
  insist(
    info.isDirectory() && !info.isSymbolicLink() &&
      await realpath(absolute) === absolute,
    "community_artifact_directory", 409,
  );
  return absolute;
}
async function regularBytes(path: string) {
  const absolute = resolve(path), before = await lstat(absolute);
  insist(
    before.isFile() && !before.isSymbolicLink() && before.nlink === 1 &&
      await realpath(absolute) === absolute,
    "community_artifact_input_invalid", 409,
  );
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    insist(opened.dev === before.dev && opened.ino === before.ino &&
      opened.nlink === 1, "community_artifact_input_changed", 409);
    const bytes = await file.readFile(), after = await file.stat();
    insist(after.size === bytes.length && after.size === opened.size &&
      after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs,
      "community_artifact_input_changed", 409);
    return bytes;
  } finally { await file.close(); }
}

/** Preserve the existing public inventory API, with regular-file checks. */
export async function artifactFiles(directoryInput: string, relativeInput = "") {
  const root = await directory(directoryInput);
  const start = relativeInput ? inside(root, resolve(root, relativeInput)) : "";
  const found: string[] = [];
  async function walk(prefix: string) {
    const current = await directory(join(root, prefix));
    inside(root, current, true);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(root, name), info = await lstat(path);
      insist(!info.isSymbolicLink(), "community_artifact_symlink", 409);
      if (info.isDirectory()) await walk(name);
      else {
        insist(info.isFile() && info.nlink === 1,
          "community_artifact_invalid", 409);
        found.push(name);
      }
    }
  }
  await walk(start);
  return found.sort();
}

export interface CommunityArtifactOptions {
  sourceRoot: string;
  assetDirectory: string;
  /** Explicit target; Linux requires its validated server deployment profile. */
  target?: "first-song" | "linux";
  migrations: Parameters<typeof communityMigrations>[1];
}
/** Actual selected community entrypoint; this does not build the web assets. */
export async function buildCommunityArtifacts(options: CommunityArtifactOptions) {
  insist(options.target === undefined || options.target === "first-song" || options.target === "linux",
    "community_artifact_target_invalid", 409);
  const root = await directory(options.sourceRoot);
  const assetsRoot = await directory(resolve(root, options.assetDirectory));
  const clientSources = await communityClientInventory(root);
  const migrations = communityMigrations(
    await readdir(join(root, "apps/community-wizard/infra/migrations")),
    options.migrations,
  );
  const names = await artifactFiles(assetsRoot);
  insist(names.includes("index.html"), "community_artifact_entry_missing", 409);
  const entrypoint = options.target === "linux"
    ? "services/linux-community.ts" : "services/community-application.ts";
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: [entrypoint],
    bundle: true, write: false, platform: "browser", format: "esm",
    target: "es2024", external: ["node:*"], minify: true, metafile: true,
    logLevel: "silent", legalComments: "none",
  });
  const inputs = [
    ...Object.keys(bundle.metafile!.inputs),
    ...clientSources,
    ...migrations.map((name) => `apps/community-wizard/infra/migrations/${name}`),
    "harness/community-artifacts.ts", "harness/package-migrations.ts",
    "package.json", "package-lock.json",
  ].filter((name) => !name.includes("node_modules/"));
  const sourcePaths = [...new Set(inputs.map((name) =>
    inside(root, resolve(root, name))))].sort();
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(
    async (name) => {
      const bytes = await regularBytes(join(root, name));
      return [name, name.endsWith(".mp3") ? digest(bytes) : hashText(bytes.toString("utf8"))];
    },
  )));
  const assets = Object.fromEntries(await Promise.all(names.map(async (name) =>
    [name, digest(await regularBytes(join(assetsRoot, name)))])));
  const bytes = bundle.outputFiles![0]!.contents;
  return { bytes, entrypoint, bundleSha256: digest(bytes), assets, migrations, sourcePaths, sourceHashes };
}

/** Validates inputs; Root still qualifies the actual executables and children. */
export async function communityBuildEnvironment(input: NodeJS.ProcessEnv = process.env) {
  const required = ["PATH", "HOME", "TMPDIR", "npm_config_userconfig",
    "npm_config_globalconfig"] as const;
  for (const name of required)
    insist(typeof input[name] === "string" && input[name]!.length > 0 &&
      !input[name]!.includes("\0"), "community_build_runtime_unconfigured", 409);
  insist(input.HOME === process.env.HOME, "community_build_home_changed", 409);
  const uid = process.getuid?.();
  insist(typeof uid === "number", "community_build_platform_unqualified", 409);
  const temp = await directory(input.TMPDIR!);
  const tempInfo = await lstat(temp);
  insist(temp === input.TMPDIR && tempInfo.uid === uid &&
    (tempInfo.mode & 0o777) === 0o700, "community_build_temp_unsafe", 409);
  const configs = [];
  for (const name of ["npm_config_userconfig", "npm_config_globalconfig"] as const) {
    const path = input[name]!;
    insist(isAbsolute(path) && resolve(path) === path,
      "community_build_config_unsafe", 409);
    inside(temp, path);
    const info = await lstat(path);
    insist(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
      info.uid === uid && (info.mode & 0o077) === 0 && info.size === 0 &&
      await realpath(path) === path, "community_build_config_unsafe", 409);
    insist((await regularBytes(path)).length === 0,
      "community_build_config_changed", 409);
    configs.push({ path, dev: info.dev, ino: info.ino });
  }
  insist(configs[0]!.path !== configs[1]!.path &&
    !(configs[0]!.dev === configs[1]!.dev && configs[0]!.ino === configs[1]!.ino),
    "community_build_config_alias", 409);
  const clean: Record<string, string> = {
    PATH: input.PATH!, HOME: input.HOME!, CI: "true", DO_NOT_TRACK: "1", NO_COLOR: "1",
    TMPDIR: input.TMPDIR!, npm_config_userconfig: input.npm_config_userconfig!,
    npm_config_globalconfig: input.npm_config_globalconfig!,
  };
  for (const name of ["TMP", "TEMP"] as const) {
    if (input[name] === undefined) continue;
    const path = await directory(input[name]!);
    inside(temp, path, true);
    const info = await lstat(path);
    insist(path === input[name] && info.uid === uid &&
      (info.mode & 0o777) === 0o700, "community_build_temp_unsafe", 409);
    clean[name] = input[name]!;
  }
  return clean;
}
