import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  artifactAssetSha256,
  readOwningGitSource,
  releaseGitEnvironment,
} from "../deploy/linux/release-inputs.ts";

const run = promisify(execFile);

test("artifact-prefixed asset hashes become exact bare release pins", () => {
  const body = Buffer.from("<html>genuine asset bytes</html>\n");
  const hex = createHash("sha256").update(body).digest("hex");
  assert.equal(artifactAssetSha256("0x" + hex), hex);
  assert.equal(createHash("sha256").update(body).digest("hex"), artifactAssetSha256("0x" + hex));
});

test("artifact hash boundary refuses malformed or noncanonical representations", () => {
  const hex = "ab".repeat(32);
  for (const value of [hex, "0x" + hex.toUpperCase(), "0x" + hex.slice(2),
    "0x0x" + hex, "0x" + hex + "\n", null, 123, { sha256: "0x" + hex }]) {
    assert.throws(() => artifactAssetSha256(value), /Invalid artifact asset SHA256/);
  }
});

test("Git whitelist strips redirection and configuration without changing incoming env", () => {
  const incoming = {
    ...process.env,
    GIT_DIR: "/foreign/.git", GIT_WORK_TREE: "/foreign", GIT_INDEX_FILE: "/foreign/index",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_PARAMETERS: "'core.bare=true'", GIT_CONFIG_GLOBAL: "/foreign/config",
    GIT_CONFIG_SYSTEM: "/foreign/system", GIT_EXEC_PATH: "/foreign/bin", GIT_CONFIG: "/foreign/config",
    GIT_CEILING_DIRECTORIES: "/", GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
    PRIVATE_FIXTURE_INPUT: "must-not-be-forwarded",
  };
  const before = { ...incoming };
  const env = releaseGitEnvironment(incoming);
  assert.deepEqual(incoming, before);
  assert.deepEqual(Object.keys(env).filter((key) => key.startsWith("GIT_")).sort(),
    ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT"]);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.PRIVATE_FIXTURE_INPUT, undefined);
});

test("producer refuses a changed HOME", () => {
  assert.throws(() => releaseGitEnvironment({ ...process.env, HOME: "/different-fixture-home" }),
    /Release Git HOME changed/);
});

test("owning Git identity ignores independent foreign repo index and config overrides", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pirate-release-git-")));
  const env = releaseGitEnvironment();
  const git = async (root: string, ...args: string[]) => run("/usr/bin/git", [
    "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args,
  ], { env, encoding: "utf8" });
  async function repository(name: string) {
    const root = join(directory, name); await mkdir(root);
    await git(root, "init", "--quiet", "--initial-branch=fixture");
    await writeFile(join(root, "fixture.txt"), name + "\n");
    await git(root, "add", "--", "fixture.txt");
    await git(root, "-c", "user.name=fixture_operator", "-c", "user.email=operator@example.invalid",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Fixture source");
    return root;
  }
  try {
    const own = await repository("own"), foreign = await repository("foreign");
    const baseline = await readOwningGitSource(own);
    assert.notEqual((await readOwningGitSource(foreign)).tree, baseline.tree);
    const config = join(directory, "foreign-config");
    await writeFile(config, "[core]\n bare = true\n worktree = " + foreign + "\n");
    for (const overrides of [
      { GIT_DIR: join(foreign, ".git") },
      { GIT_WORK_TREE: foreign },
      { GIT_INDEX_FILE: join(foreign, ".git/index") },
      { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_NOSYSTEM: "0" },
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: foreign },
      { GIT_CONFIG_PARAMETERS: "'core.bare=true'" },
      { GIT_DIR: join(foreign, ".git"), GIT_WORK_TREE: foreign,
        GIT_INDEX_FILE: join(foreign, ".git/index"), GIT_CONFIG_GLOBAL: config },
    ]) {
      assert.deepEqual(await readOwningGitSource(own, { ...process.env, ...overrides }), baseline);
    }
    const child = join(own, "nested"); await mkdir(child);
    await assert.rejects(readOwningGitSource(child), /Release Git top-level mismatch/);
    await writeFile(join(own, "fixture.txt"), "changed\n");
    await assert.rejects(readOwningGitSource(own), /Release source must be clean/);
    // The producer reader itself must never create or change an index lock.
    await assert.rejects(access(join(own, ".git/index.lock")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
