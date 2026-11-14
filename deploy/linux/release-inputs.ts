import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Artifact API hashes are canonical 0x-prefixed SHA256; release pins are bare. */
export function artifactAssetSha256(value: unknown): string {
  assert(typeof value === "string" && value.length === 66 && /^0x[a-f0-9]{64}$/.test(value),
    "Invalid artifact asset SHA256 representation");
  return value.slice(2);
}

/** Same whitelist and HOME invariant as communityClientInventory. */
export function releaseGitEnvironment(
  incoming: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "CI", "DO_NOT_TRACK", "NO_COLOR", "npm_config_userconfig", "npm_config_globalconfig"]) {
    if (incoming[name] !== undefined) env[name] = incoming[name];
  }
  assert.equal(env.HOME, process.env.HOME, "Release Git HOME changed");
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });
  return env;
}

/** Read the approved canonical owning repository, without ambient Git inputs. */
export async function readOwningGitSource(
  sourceRoot: string,
  incoming: NodeJS.ProcessEnv = process.env,
): Promise<{ head: string; tree: string }> {
  const root = await realpath(sourceRoot);
  assert.equal(root, sourceRoot, "Release source root must be canonical");
  const env = releaseGitEnvironment(incoming);
  const prefix = ["--no-optional-locks", "-c", "safe.directory=" + root,
    "-c", "core.fsmonitor=false", "-C", root];
  const git = async (...args: string[]) => {
    const result = await run("/usr/bin/git", [...prefix, ...args], {
      env, encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  };
  const topology = (await git("rev-parse", "--show-toplevel")).replace(/\r?\n$/, "");
  assert.equal(await realpath(topology), root, "Release Git top-level mismatch");
  const head = (await git("rev-parse", "HEAD")).replace(/\r?\n$/, "");
  const tree = (await git("rev-parse", "HEAD^{tree}")).replace(/\r?\n$/, "");
  assert(head.length === 40 && tree.length === 40 &&
    /^[a-f0-9]{40}$/.test(head) && /^[a-f0-9]{40}$/.test(tree),
    "Release Git object identity invalid");
  assert.equal(await git("status", "--porcelain=v1", "--untracked-files=all"), "",
    "Release source must be clean");
  return { head, tree };
}
