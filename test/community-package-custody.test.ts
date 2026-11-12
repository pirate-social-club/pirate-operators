// UNRUN. Local sealed fixtures and subprocess cwd only; no provider/credential authority.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { hashJson } from "../packages/community/common.ts";
import { seal } from "../apps/community-wizard/infra/protected-data.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { communityOwned, communityAccount, communityPrefix } from "../harness/community-package.ts";
import { inventoryCommunityState } from "../harness/community-state.ts";
import { digest, durableJson, privateJson } from "../harness/private-json.ts";
import {
  preserveReviewedPackage,
  adoptPreparedCommunityUpdate,
  finishReviewedUpdate,
} from "../harness/reviewed-update.ts";
import {
  communityArtifactInputs,
  prepareCommunityPackage,
  verifyCommunityPackage,
  runCommunityPackageCommand,
} from "../harness/community-package-custody.ts";
import { completedCommunityRelease } from "../harness/community-result.ts";
import { qualifyCommunityConsumer } from "../harness/community-consumer.ts";
import { applicationInfrastructureSources } from "../harness/community-infrastructure.ts";

async function fixture(completedPredecessor = false) {
  const directory = await mkdtemp(join(tmpdir(), "community-custody-role-"));
  const password = "fixture-state-password-not-an-operator-secret";
  const cwd = join(directory, "deployment"),
    modules = join(directory, "fixture-modules");
  await mkdir(modules, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  await symlink(modules, join(cwd, "node_modules"));
  const appBindings = [
    { sid: "DB", data: { bindings: [{ type: "d1", name: "DB", databaseId: communityOwned[1]!.id }] } },
    {
      sid: "MEDIA",
      data: { bindings: [{ type: "r2_bucket", name: "MEDIA", bucketName: communityOwned[2]!.id }] },
    },
    {
      sid: "JOBS",
      data: {
        bindings: [
          {
            type: "queue",
            name: "JOBS",
            queueId: communityOwned[3]!.id,
            queueName: communityPrefix + "-jobs",
          },
        ],
      },
    },
    {
      sid: "learning-operator",
      data: {
        bindings: [{ type: "service", name: "KARAOKE_OPERATOR", service: "pirate-learning-testnet-v2" }],
      },
    },
    {
      sid: "KARAOKE_SPEECH_BUDGET",
      data: {
        bindings: [
          {
            type: "durable_object_namespace",
            name: "KARAOKE_SPEECH_BUDGET",
            className: "SpeechBudget",
            scriptName: "pirate-learning-testnet-v2",
          },
        ],
      },
    },
    {
      sid: "APPLICATION_PROFILE_HASH",
      data: { bindings: [{ type: "plain_text", name: "APPLICATION_PROFILE_HASH", text: "fixture-before" }] },
    },
  ];
  const rows: Record<string, Record<string, unknown>> = Object.fromEntries(
    communityOwned.map((r) => [
      r.logical,
      {
        status: "updated",
        resourceType: r.type,
        logicalId: r.logical,
        fqn: r.logical,
        instanceId: "fixture-instance-" + r.logical,
        attr: { accountId: communityAccount, ...r.attributes },
        bindings: r.logical === "App" ? appBindings : [],
      },
    ]),
  );
  rows.Consumer = {
    status: "created",
    resourceType: "Cloudflare.Queues.Consumer",
    logicalId: "Consumer",
    fqn: "Consumer",
    instanceId: "fixture-instance-Consumer",
    attr: {
      accountId: communityAccount,
      queueId: communityOwned[3]!.id,
      scriptName: communityPrefix,
      consumerId: "fixture-consumer",
    },
    bindings: [],
  };
  rows.__stack_output__ = { origin: firstSong.origin, database: communityOwned[1]!.id };
  async function save(root: string, name: string, row = rows[name]!) {
    const relative = `${communityPrefix}/setup/${name}.json`,
      path = join(root, ".alchemy/state", relative);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, seal(JSON.stringify(row), password, `alchemy-state:${relative}`), { mode: 0o600 });
  }
  for (const name of Object.keys(rows)) await save(cwd, name);
  await mkdir(join(cwd, "assets"), { mode: 0o700 });
  await writeFile(join(cwd, "assets/stale-extra.js"), "old evidence", { mode: 0o600 });
  const previous = { schema: "fixture", planId: "fixture-plan", bundleSha256: "previous-worker" };
  const previousHash = hashJson(previous),
    previousPlanPath = join(directory, "previous-plan.json");
  await durableJson(previousPlanPath, { profile: previous, profileHash: previousHash });
  await durableJson(join(directory, "execution.json"), { profileHash: previousHash });
  if (completedPredecessor)
    await durableJson(join(directory, "deployment-result.json"), { profileHash: previousHash });
  const policy = {
    previousPlanPath,
    previousProfileHash: previousHash,
    expectedExecutionSha256: digest(await readFile(join(directory, "execution.json"))),
    expectedResultSha256: completedPredecessor
      ? digest(await readFile(join(directory, "deployment-result.json")))
      : null,
  };
  const files = {
    "worker/worker.mjs": Buffer.from("fixture-worker"),
    "assets/index.html": Buffer.from("fixture selected asset"),
    "migrations/0001_fixture.sql": Buffer.from("-- fixture only"),
    "package.json": Buffer.from('{"private":true,"type":"module"}\n'),
    "alchemy.run.ts": Buffer.from("export default undefined;\n"),
  };
  const profile = { ...previous, bundleSha256: digest(files["worker/worker.mjs"]), reviewedUpdate: policy };
  const packaged = { profile, profileHash: hashJson(profile) };
  const authenticate = (root: string) => inventoryCommunityState(root, password);
  const options = { directory, profileHash: packaged.profileHash, policy, files, modules, authenticate };
  const preserve = () =>
    preserveReviewedPackage(directory, packaged.profileHash, { "deployment/node_modules": modules });
  return {
    directory,
    cwd,
    password,
    rows,
    files,
    packaged,
    policy,
    options,
    authenticate,
    preserve,
    save,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

test("exclusive fresh package preserves legacy extras but never includes them; complete ready inventory binds exact bytes", async () => {
  const f = await fixture();
  try {
    await assert.rejects(prepareCommunityPackage(f.options), /predecessor_not_preserved/);
    await f.preserve();
    const binding = await prepareCommunityPackage(f.options);
    const cwd = join(f.directory, binding.relativePath);
    assert.equal((await lstat(cwd)).mode & 0o777, 0o700);
    assert.equal((await lstat(cwd)).isSymbolicLink(), false);
    assert.equal(await readFile(join(f.cwd, "assets/stale-extra.js"), "utf8"), "old evidence");
    assert.deepEqual(await readdir(join(cwd, "assets")), ["index.html"]);
    const ready = await privateJson(join(cwd, ".custody-ready.json"));
    assert.equal(hashJson(ready), binding.manifestSha256);
    assert.equal(Object.keys((ready!.state as any).files).length, 6);
    assert.deepEqual(await f.authenticate(cwd), await f.authenticate(f.cwd));
    assert.deepEqual(await prepareCommunityPackage(f.options), binding);
  } finally {
    await f.dispose();
  }
});
test("asset capture rejects an extra input instead of expanding the selected public manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community-extra-input-role-")),
    original = process.cwd();
  try {
    await mkdir(join(directory, "apps/web/dist/live"), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "apps/web/dist/live/index.html"), "selected");
    await writeFile(join(directory, "apps/web/dist/live/old.js"), "old-extra");
    process.chdir(directory);
    const bytes = Buffer.from("worker");
    await assert.rejects(
      communityArtifactInputs(bytes, {
        bundleSha256: digest(bytes),
        assets: { "index.html": digest("selected") },
        migrations: [],
        sourceHashes: {},
      }),
      /asset_inputs_changed/,
    );
  } finally {
    process.chdir(original);
    await rm(directory, { recursive: true, force: true });
  }
});
for (const phase of ["created", "copied", "ready"] as const)
  test(`interruption at ${phase} preserves evidence and never adopts automatically`, async () => {
    const f = await fixture();
    try {
      await f.preserve();
      const before = await readFile(join(f.directory, "execution.json"));
      await assert.rejects(
        prepareCommunityPackage({
          ...f.options,
          boundary: async (at) => {
            if (at === phase) throw new Error("fixture interruption");
          },
        }),
        /fixture interruption/,
      );
      assert.deepEqual(await readFile(join(f.directory, "execution.json")), before);
      const target = join(f.directory, `deployment-${f.packaged.profileHash.slice(2)}`);
      assert.equal((await lstat(target)).isDirectory(), true);
      if (phase === "ready") await prepareCommunityPackage(f.options);
      else await assert.rejects(prepareCommunityPackage(f.options));
    } finally {
      await f.dispose();
    }
  });
test("changed copy input and changed current ciphertext fail without ready/adoption", async () => {
  for (const change of ["artifact", "state"] as const) {
    const f = await fixture();
    try {
      await f.preserve();
      await assert.rejects(
        prepareCommunityPackage({
          ...f.options,
          boundary: async (at) => {
            if (at !== "created") return;
            if (change === "artifact") f.files["worker/worker.mjs"][0] ^= 1;
            else await f.save(f.cwd, "Consumer"); // fresh ciphertext, same fixture identity
          },
        }),
        /copy_(input|state)_changed/,
      );
      assert.equal(
        await privateJson(
          join(f.directory, `deployment-${f.packaged.profileHash.slice(2)}`, ".custody-ready.json"),
        ),
        null,
      );
    } finally {
      await f.dispose();
    }
  }
});
for (const change of ["missing-consumer", "foreign-consumer", "missing-bindings", "foreign-binding"] as const)
  test(`${change} refuses current-state custody`, async () => {
    const f = await fixture();
    try {
      const baseline = await f.authenticate(f.cwd);
      assert.equal(Object.keys(baseline.files).length, 6);
      if (change === "missing-consumer")
        await rm(join(f.cwd, ".alchemy/state", communityPrefix, "setup/Consumer.json"));
      if (change === "foreign-consumer")
        await f.save(f.cwd, "Consumer", {
          ...f.rows.Consumer!,
          attr: { ...(f.rows.Consumer!.attr as object), consumerId: null },
        });
      if (change === "missing-bindings") await f.save(f.cwd, "App", { ...f.rows.App!, bindings: [] });
      if (change === "foreign-binding") {
        const app = structuredClone(f.rows.App!);
        const bindings = app.bindings as Array<{
          sid: string;
          data: { bindings: Array<Record<string, unknown>> };
        }>;
        const db = bindings.find((binding) => binding.sid === "DB");
        assert.ok(db);
        assert.equal(db.data.bindings[0]!.databaseId, communityOwned[1]!.id);
        db.data.bindings[0]!.databaseId = "foreign";
        const expected = structuredClone(f.rows.App!) as typeof app;
        const expectedBindings = expected.bindings as typeof bindings;
        expectedBindings.find((binding) => binding.sid === "DB")!.data.bindings[0]!.databaseId = "foreign";
        assert.deepEqual(app, expected); // the complete record differs only at DB's target
        assert.deepEqual(
          bindings.filter((binding) => binding.sid !== "DB"),
          (f.rows.App!.bindings as typeof bindings).filter((binding) => binding.sid !== "DB"),
        );
        await f.save(f.cwd, "App", app);
      }
      await assert.rejects(f.authenticate(f.cwd));
      if (change === "foreign-binding") {
        await f.save(f.cwd, "App");
        assert.deepEqual((await f.authenticate(f.cwd)).identities, baseline.identities);
      }
    } finally {
      await f.dispose();
    }
  });
test("wrong profile/path/manifest, extras, links and hash drift cannot reach a command callback", async () => {
  for (const kind of [
    "profile",
    "path",
    "manifest",
    "extra",
    "missing",
    "bytes",
    "link",
    "dependencies",
  ] as const) {
    const f = await fixture();
    try {
      await f.preserve();
      const binding = await prepareCommunityPackage(f.options);
      await adoptPreparedCommunityUpdate(f.directory, f.packaged, binding, f.authenticate);
      const cwd = join(f.directory, binding.relativePath),
        execution = await privateJson(join(f.directory, "execution.json"));
      if (kind === "profile" || kind === "path" || kind === "manifest") {
        const changed = {
          ...binding,
          ...(kind === "profile"
            ? { profileHash: "0x" + "a".repeat(64) }
            : kind === "path"
              ? { relativePath: "../deployment" }
              : { manifestSha256: "0x" + "b".repeat(64) }),
        };
        await writeFile(
          join(f.directory, "execution.json"),
          JSON.stringify({ ...execution, packageBinding: changed }),
          { mode: 0o600 },
        );
      } else if (kind === "extra") await writeFile(join(cwd, "assets/extra.js"), "stale", { mode: 0o600 });
      else if (kind === "missing") await rm(join(cwd, "assets/index.html"));
      else if (kind === "bytes") await writeFile(join(cwd, "worker/worker.mjs"), "drift", { mode: 0o600 });
      else if (kind === "link") {
        await rm(join(cwd, "assets/index.html"));
        await symlink(join(f.cwd, "assets/stale-extra.js"), join(cwd, "assets/index.html"));
      } else {
        await rm(join(cwd, "node_modules"));
        await mkdir(join(f.directory, "foreign-modules"), { mode: 0o700 });
        await symlink(join(f.directory, "foreign-modules"), join(cwd, "node_modules"));
      }
      let called = false;
      await assert.rejects(
        runCommunityPackageCommand(f.directory, binding, f.policy, f.authenticate, async () => {
          called = true;
        }),
      );
      assert.equal(called, false);
    } finally {
      await f.dispose();
    }
  }
});
test("actual subprocess cwd matches adopted package; evolving attempted state survives retry byte-for-byte", async () => {
  const f = await fixture();
  try {
    await f.preserve();
    const binding = await prepareCommunityPackage(f.options);
    await adoptPreparedCommunityUpdate(f.directory, f.packaged, binding, f.authenticate);
    const cwd = join(f.directory, binding.relativePath);
    await f.save(cwd, "App", {
      ...f.rows.App!,
      status: "updating",
      old: { attr: f.rows.App!.attr, bindings: f.rows.App!.bindings },
      props: { fixtureRevision: 2 },
    });
    const before = await f.authenticate(cwd);
    for (const phase of ["plan", "deploy"]) {
      const result = await runCommunityPackageCommand(
        f.directory,
        binding,
        f.policy,
        f.authenticate,
        async (commandCwd) =>
          promisify(execFile)(process.execPath, ["-p", "process.cwd()"], { cwd: commandCwd }),
      );
      assert.equal(result.stdout.trim(), cwd, phase);
    }
    assert.deepEqual(
      (await verifyCommunityPackage(f.directory, binding.profileHash, f.policy, f.authenticate)).state,
      before,
    );
    await adoptPreparedCommunityUpdate(f.directory, f.packaged, binding, f.authenticate);
    assert.deepEqual(await f.authenticate(cwd), before);
    await assert.rejects(prepareCommunityPackage(f.options), /preparation_after_adoption/);
  } finally {
    await f.dispose();
  }
});
test("lost adoption acknowledgement reuses the exact ready binding and execution bytes", async () => {
  const f = await fixture();
  try {
    await f.preserve();
    const binding = await prepareCommunityPackage(f.options);
    const previous = await readFile(join(f.directory, "execution.json"));
    await assert.rejects(
      (async () => {
        await adoptPreparedCommunityUpdate(f.directory, f.packaged, binding, f.authenticate);
        throw new Error("fixture adoption ACK lost");
      })(),
      /ACK lost/,
    );
    const adopted = await readFile(join(f.directory, "execution.json"));
    assert.notDeepEqual(adopted, previous);
    await adoptPreparedCommunityUpdate(f.directory, f.packaged, binding, f.authenticate);
    assert.deepEqual(await readFile(join(f.directory, "execution.json")), adopted);
    const backup = join(f.directory, `before-update-${binding.profileHash.slice(2)}`);
    assert.deepEqual(await readFile(join(backup, "execution.json")), previous);
  } finally {
    await f.dispose();
  }
});
test("completed reconciliation proves same bound package/state and performs zero new applies", async () => {
  const f = await fixture();
  try {
    await f.preserve();
    const binding = await prepareCommunityPackage(f.options);
    await adoptPreparedCommunityUpdate(f.directory, f.packaged, binding, f.authenticate);
    const state = await f.authenticate(join(f.directory, binding.relativePath));
    const resources = communityOwned.map((r) => ({ name: r.logical, id: r.id, present: true }));
    const inventory = { at: "fixture", resources },
      health = {
        profileHash: binding.profileHash,
        planId: f.packaged.profile.planId,
        signIn: "available",
        creatorConnection: "available",
      };
    const live = { inventory, modules: { "worker.mjs": f.packaged.profile.bundleSha256 }, health };
    const result = {
      schema: "pirate.community-application-release/1",
      profileHash: binding.profileHash,
      packageBinding: binding,
      packageState: state,
      health,
      after: inventory,
    };
    assert.equal(
      await completedCommunityRelease(
        f.directory,
        f.packaged.profile,
        binding.profileHash,
        live,
        f.authenticate,
      ),
      null,
    );
    await durableJson(join(f.directory, "deployment-result.json"), result);
    const savedResult = await readFile(join(f.directory, "deployment-result.json"));
    let applies = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const complete = await completedCommunityRelease(
        f.directory,
        f.packaged.profile,
        binding.profileHash,
        live,
        f.authenticate,
      );
      if (!complete)
        await runCommunityPackageCommand(f.directory, binding, f.policy, f.authenticate, async () => {
          applies++;
        });
      assert.deepEqual(complete, result);
    }
    assert.equal(applies, 0);
    assert.deepEqual(await readFile(join(f.directory, "deployment-result.json")), savedResult);
    await assert.rejects(
      completedCommunityRelease(f.directory, f.packaged.profile, "0x" + "e".repeat(64), live, f.authenticate),
      /community_package_execution_missing_or_foreign/,
    );
    await assert.rejects(
      completedCommunityRelease(
        f.directory,
        f.packaged.profile,
        binding.profileHash,
        { ...live, modules: { "worker.mjs": "old-bundle" } },
        f.authenticate,
      ),
      /completed_release_not_live/,
    );
    const creatorUnavailable = { ...live, health: { ...health, creatorConnection: "unavailable" } };
    await assert.rejects(
      completedCommunityRelease(
        f.directory,
        f.packaged.profile,
        binding.profileHash,
        creatorUnavailable,
        f.authenticate,
      ),
      /completed_release_not_live/,
    );
    // Same completion-port owner marker as the fca control; no owner-policy or
    // owner-upgrade authorization is qualified by this local fixture.
    assert.deepEqual(
      await completedCommunityRelease(
        f.directory,
        { ...f.packaged.profile, ownerPublishing: {} },
        binding.profileHash,
        creatorUnavailable,
        f.authenticate,
      ),
      result,
    );
    await assert.rejects(
      completedCommunityRelease(
        f.directory,
        f.packaged.profile,
        binding.profileHash,
        {
          ...live,
          inventory: {
            ...inventory,
            resources: resources.map((resource, index) =>
              index === 0 ? { ...resource, id: "unrelated-worker" } : resource,
            ),
          },
        },
        f.authenticate,
      ),
      /completed_release_not_live/,
    );
    assert.equal(applies, 0);
    assert.deepEqual(await readFile(join(f.directory, "deployment-result.json")), savedResult);
    await f.save(join(f.directory, binding.relativePath), "Consumer");
    await assert.rejects(
      completedCommunityRelease(f.directory, f.packaged.profile, binding.profileHash, live, f.authenticate),
      /completed_package_or_state_changed/,
    );
  } finally {
    await f.dispose();
  }
});
test("Consumer qualification reads the adopted binding and refuses absent or foreign live identity", async () => {
  const f = await fixture();
  try {
    await f.preserve();
    const binding = await prepareCommunityPackage(f.options);
    await adoptPreparedCommunityUpdate(f.directory, f.packaged, binding, f.authenticate);
    let consumers = [
      {
        consumer_id: "fixture-consumer",
        script: communityPrefix,
        settings: { batch_size: 1, max_concurrency: 1, max_retries: 3, retry_delay: 60 },
      },
    ];
    const query = async (args: string[]) => {
      assert.deepEqual(args, ["queues", "consumers", "list", "--queue-id", communityOwned[3]!.id]);
      return consumers;
    };
    const custody = { profileHash: binding.profileHash, policy: f.policy };
    assert.deepEqual(await qualifyCommunityConsumer(f.directory, f.password, {}, true, query, custody), {
      queueId: communityOwned[3]!.id,
      scriptName: communityPrefix,
      consumerId: "fixture-consumer",
    });
    consumers[0]!.consumer_id = "foreign-consumer";
    await assert.rejects(
      qualifyCommunityConsumer(f.directory, f.password, {}, true, query, custody),
      /ownership_unverified/,
    );
    consumers[0]!.consumer_id = "fixture-consumer";
    consumers[0]!.script = "unrelated-worker";
    await assert.rejects(
      qualifyCommunityConsumer(f.directory, f.password, {}, true, query, custody),
      /ownership_unverified/,
    );
    consumers[0]!.script = communityPrefix;
    const currentCwd = join(f.directory, binding.relativePath);
    await f.save(currentCwd, "Consumer", {
      ...f.rows.Consumer!,
      attr: { ...(f.rows.Consumer!.attr as object), queueId: "unrelated-queue" },
    });
    await assert.rejects(
      qualifyCommunityConsumer(f.directory, f.password, {}, true, query, custody),
      /community_state_identity_changed/,
    );
    await f.save(currentCwd, "Consumer");
    assert.deepEqual(await qualifyCommunityConsumer(f.directory, f.password, {}, true, query, custody), {
      queueId: communityOwned[3]!.id,
      scriptName: communityPrefix,
      consumerId: "fixture-consumer",
    });
    consumers.push(structuredClone(consumers[0]!));
    await assert.rejects(
      qualifyCommunityConsumer(f.directory, f.password, {}, true, query, custody),
      /ambiguous/,
    );
    consumers.pop();
    consumers = [];
    await assert.rejects(
      qualifyCommunityConsumer(f.directory, f.password, {}, false, query, custody),
      /missing_or_interrupted/,
    );
  } finally {
    await f.dispose();
  }
});
test("completed predecessor is preserved through preparation/adoption and result replacement without reapply", async () => {
  const f = await fixture(true);
  try {
    assert.equal(Object.keys((await f.authenticate(f.cwd)).files).length, 6);
    const profileHash = f.packaged.profileHash;
    const resources = communityOwned.map((resource) => ({
      name: resource.logical,
      id: resource.id,
      present: true,
    }));
    const inventory = { at: "fixture", resources };
    const health = {
      profileHash,
      planId: f.packaged.profile.planId,
      signIn: "available",
      creatorConnection: "available",
    };
    const live = { inventory, modules: { "worker.mjs": f.packaged.profile.bundleSha256 }, health };
    const resultPath = join(f.directory, "deployment-result.json");
    const oldResult = await readFile(resultPath);
    assert.equal(
      await completedCommunityRelease(f.directory, f.packaged.profile, profileHash, live, f.authenticate),
      null,
    );
    assert.deepEqual(await readFile(resultPath), oldResult);
    await f.preserve();
    const binding = await prepareCommunityPackage(f.options);
    await adoptPreparedCommunityUpdate(f.directory, f.packaged, binding, f.authenticate);
    // A valid adopted package with only its predecessor result is incomplete.
    assert.equal(
      await completedCommunityRelease(f.directory, f.packaged.profile, profileHash, live, f.authenticate),
      null,
    );
    assert.deepEqual(await readFile(resultPath), oldResult);
    const state = await f.authenticate(join(f.directory, binding.relativePath));
    const result = {
      schema: "pirate.community-application-release/1",
      profileHash,
      packageBinding: binding,
      packageState: state,
      before: inventory,
      after: inventory,
      health,
      logs: [],
    };
    await finishReviewedUpdate(f.directory, f.packaged, result);
    const committed = await readFile(resultPath);
    let applies = 0;
    for (let retry = 0; retry < 3; retry++) {
      const complete = await completedCommunityRelease(
        f.directory,
        f.packaged.profile,
        profileHash,
        live,
        f.authenticate,
      );
      if (!complete)
        await runCommunityPackageCommand(f.directory, binding, f.policy, f.authenticate, async () => {
          applies++;
        });
      assert.deepEqual(complete, result);
    }
    assert.equal(applies, 0);
    await finishReviewedUpdate(f.directory, f.packaged, result);
    assert.deepEqual(await readFile(resultPath), committed);
    assert.deepEqual(
      await readFile(join(f.directory, `before-update-${profileHash.slice(2)}`, "deployment-result.json")),
      oldResult,
    );
    await assert.rejects(
      completedCommunityRelease(
        f.directory,
        {
          ...f.packaged.profile,
          reviewedUpdate: { ...f.policy, previousProfileHash: profileHash },
        },
        "0x" + "f".repeat(64),
        live,
        f.authenticate,
      ),
      /community_completed_result_conflict/,
    );
    assert.equal(applies, 0);
    assert.deepEqual(await readFile(resultPath), committed);
  } finally {
    await f.dispose();
  }
});
test("actual pinned encryption wrapper reads relocated ciphertext only with unchanged relative AAD", async () => {
  const f = await fixture();
  try {
    await f.preserve();
    const binding = await prepareCommunityPackage(f.options);
    const { encryptedFileSystem } = await import("../apps/community-wizard/infra/encrypted-state.ts");
    const require = createRequire(new URL("../apps/community-wizard/package.json", import.meta.url));
    const Effect = await import(pathToFileURL(require.resolve("effect/Effect")).href);
    const port = { readFile: (path: string) => Effect.tryPromise(() => readFile(path)) };
    const root = join(f.directory, binding.relativePath, ".alchemy/state");
    const fs = encryptedFileSystem(port as any, f.password, root);
    const relative = `${communityPrefix}/setup/Consumer.json`;
    const decoded = await Effect.runPromise(fs.readFile(join(root, relative)));
    assert.deepEqual(JSON.parse(Buffer.from(decoded as Uint8Array).toString()), f.rows.Consumer);
    const wrong = encryptedFileSystem(port as any, f.password, join(root, communityPrefix));
    await assert.rejects(Effect.runPromise(wrong.readFile(join(root, relative))));
    // This is real wrapper crypto with an explicit FS port, not CLI/engine acceptance.
  } finally {
    await f.dispose();
  }
});
test("UNRUN native loader regression imports exact infrastructure from a fresh real linked package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community-loader-role-"));
  try {
    for (const source of applicationInfrastructureSources) {
      const name = source.split("/").at(-1)!;
      await writeFile(
        join(directory, name === "application-alchemy.run.ts" ? "alchemy.run.ts" : name),
        await readFile(source),
        { mode: 0o600 },
      );
    }
    await writeFile(join(directory, "package.json"), '{"private":true,"type":"module"}\n', { mode: 0o600 });
    await symlink(join(process.cwd(), "apps/community-wizard/node_modules"), join(directory, "node_modules"));
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const module = await import('./alchemy.run.ts'); if (!module.default) throw new Error('stack missing'); console.log('fixture-stack-imported');",
      ],
      {
        cwd: directory,
        timeout: 30000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "true", DO_NOT_TRACK: "1", NO_COLOR: "1" },
      },
    );
    assert.equal(result.stdout.trim(), "fixture-stack-imported");
    // No stack evaluation, plan, apply, provider or authenticated state is claimed.
    // Retained execution-tree loader/engine equivalence remains coordinator-owned.
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
