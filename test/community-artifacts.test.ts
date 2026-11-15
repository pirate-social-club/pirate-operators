import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactFiles, buildCommunityArtifacts, communityBuildEnvironment, communityClientInventory } from "../harness/community-artifacts.ts";

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "community-artifacts-")));
  const assets = join(base, "assets"), temp = join(base, "runtime");
  await mkdir(assets, { mode: 0o700 });
  await mkdir(temp, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "<html>explicit asset fixture</html>");
  await writeFile(join(assets, "entry.js"), "export {};\n");
  const user = join(temp, "user.npmrc"), global = join(temp, "global.npmrc");
  await writeFile(user, "", { mode: 0o600 });
  await writeFile(global, "", { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: temp,
    npm_config_userconfig: user, npm_config_globalconfig: global };
  return { base, assets, temp, user, global, env,
    dispose: () => rm(base, { recursive: true, force: true }) };
}
const migrationSelection = { rewards: false, ownerPublishing: false, v4: false };

test("portable artifacts build the real application with explicit asset fixtures", async () => {
  const f = await fixture();
  try {
    // These assets exercise inventory binding, not real Vite-output equivalence.
    // Actual live-asset parity requires the separate complete build gate.
    const result = await buildCommunityArtifacts({
      sourceRoot: await realpath(process.cwd()), assetDirectory: f.assets,
      migrations: migrationSelection,
    });
    assert.match(Buffer.from(result.bytes).toString("utf8"), /wrong_community_host/);
    assert.equal(result.bundleSha256,
      `0x${createHash("sha256").update(result.bytes).digest("hex")}`);
    assert.deepEqual(Object.keys(result.assets).sort(), ["entry.js", "index.html"]);
    assert.ok(result.migrations.includes("0001_setup.sql"));
    assert.ok(!result.migrations.includes("0013_learning_authorization.sql"));
    assert.ok(result.sourceHashes["services/community-application.ts"]);
    assert.ok(result.sourceHashes["harness/community-artifacts.ts"]);
    assert.ok(result.sourceHashes["harness/package-migrations.ts"]);
    assert.ok(!result.sourcePaths.includes("harness/community-package.ts"));
    assert.ok(!result.sourcePaths.includes("harness/creator-state.ts"));
    assert.ok(result.sourcePaths.every((path) => !path.startsWith("/") && !path.startsWith("..")));
  } finally { await f.dispose(); }
});

test("artifact construction refuses missing assets and incompatible migration dependencies", async () => {
  const f = await fixture();
  try {
    const input = { sourceRoot: await realpath(process.cwd()),
      assetDirectory: f.assets, migrations: migrationSelection };
    await assert.rejects(buildCommunityArtifacts({ ...input,
      assetDirectory: join(f.base, "missing") }));
    await assert.rejects(buildCommunityArtifacts({ ...input,
      migrations: { ...migrationSelection, ownerPublishing: true } }),
      /owner_publishing_rewards_selection_required/);
  } finally { await f.dispose(); }
});

test("artifact inventory refuses traversal, links and special entries", async () => {
  const f = await fixture();
  const server = createServer();
  try {
    await assert.rejects(artifactFiles(f.assets, ".."), /community_artifact_path/);
    await symlink(join(f.assets, "entry.js"), join(f.assets, "alias.js"));
    await assert.rejects(artifactFiles(f.assets), /community_artifact_symlink/);
    await rm(join(f.assets, "alias.js"));
    await link(join(f.assets, "entry.js"), join(f.assets, "hard.js"));
    await assert.rejects(artifactFiles(f.assets), /community_artifact_invalid/);
    await rm(join(f.assets, "hard.js"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(f.assets, "special.sock"), resolve);
    });
    await assert.rejects(artifactFiles(f.assets), /community_artifact_invalid/);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await f.dispose();
  }
});

test("approved child environment preserves HOME and private temp/config inputs", async () => {
  const f = await fixture(), home = process.env.HOME;
  try {
    const env = await communityBuildEnvironment({ ...f.env, TMP: f.temp, TEMP: f.temp,
      UNRELATED_FIXTURE_VALUE: "not forwarded" });
    assert.equal(env.HOME, home);
    assert.equal(process.env.HOME, home);
    assert.equal(env.TMPDIR, f.temp);
    assert.equal(env.TMP, f.temp);
    assert.equal(env.TEMP, f.temp);
    assert.equal(env.npm_config_userconfig, f.user);
    assert.equal(env.npm_config_globalconfig, f.global);
    assert.equal(env.PATH, f.env.PATH);
    assert.equal(env.UNRELATED_FIXTURE_VALUE, undefined);
  } finally { await f.dispose(); }
});

for (const scenario of ["missing", "nonempty", "alias", "hardlink", "symlink", "public", "outside", "temp", "home"] as const) {
  test(`child build isolation refuses ${scenario} inputs`, async () => {
    const f = await fixture();
    try {
      const env: NodeJS.ProcessEnv = { ...f.env };
      if (scenario === "missing") delete env.npm_config_userconfig;
      if (scenario === "nonempty") await writeFile(f.user, "fixture-setting=true\n");
      if (scenario === "alias") env.npm_config_globalconfig = f.user;
      if (scenario === "hardlink") {
        await rm(f.global); await link(f.user, f.global);
      }
      if (scenario === "symlink") {
        await rm(f.global); await symlink(f.user, f.global);
      }
      if (scenario === "public") await chmod(f.user, 0o644);
      if (scenario === "outside") {
        const outside = join(f.base, "outside.npmrc");
        await writeFile(outside, "", { mode: 0o600 });
        env.npm_config_globalconfig = outside;
      }
      if (scenario === "temp") await chmod(f.temp, 0o755);
      if (scenario === "home") env.HOME = join(f.base, "changed-home");
      await assert.rejects(communityBuildEnvironment(env));
      assert.equal(process.env.HOME, f.env.HOME);
    } finally { await f.dispose(); }
  });
}


test("client provenance rejects an ancestor Git root and incomplete inventory", async () => {
  const f = await fixture();
  try {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    await promisify(execFile)("git", ["init", "--quiet", f.base], { env });
    const nested = join(f.base, "ignored-source");
    await mkdir(nested);
    await writeFile(join(f.base, ".gitignore"), "ignored-source/\n");
    await assert.rejects(communityClientInventory(nested),
      /community_artifact_git_root_mismatch/);
    // A nonempty but incomplete client inventory also cannot qualify.
    await mkdir(join(f.base, "apps/web/src/live"), { recursive: true });
    await writeFile(join(f.base, "apps/web/src/live/entry.tsx"), "// inventory fixture only\n");
    await assert.rejects(communityClientInventory(f.base),
      /community_artifact_client_inventory_incomplete/);
  } finally { await f.dispose(); }
});

test("client provenance ignores ambient Git root, index and configuration redirection", async () => {
  const f = await fixture();
  try {
    const root = await realpath(process.cwd());
    const names = await communityClientInventory(root, { ...process.env,
      GIT_DIR: join(f.base, "foreign.git"), GIT_WORK_TREE: f.base,
      GIT_INDEX_FILE: join(f.base, "foreign.index"), GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: f.base });
    assert.ok(names.includes("apps/web/src/live/entry.tsx"));
    assert.ok(names.includes("apps/web/package.json"));
    assert.ok(names.includes("apps/web/package-lock.json"));
    assert.ok(names.every((name) => name.startsWith("apps/web/")));
  } finally { await f.dispose(); }
});
