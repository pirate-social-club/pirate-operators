import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  creatorPredecessor,
  creatorResources,
  creatorAccount,
  restoreCreatorState,
  fileDigest,
} from "../harness/creator-state.ts";
import { seal, unseal } from "../apps/creator-spike/infra/protected-data.ts";
import { workerModuleDigests } from "../harness/worker-modules.ts";
import { canonical, hashJson } from "../packages/community/common.ts";
import { adoptCreatorProfile } from "../harness/creator-profile-recovery.ts";
import { inspectPrivateFiles } from "../apps/community-wizard/server/state-inspection.ts";

test("native restore keeps the historical bytes and resumes the encrypted owned state without another plaintext copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pirate-native-state-")),
    original = join(dir, "original"),
    target = join(dir, "encrypted"),
    prefix = "pirate-creator-wallet-testnet/testnet",
    password = "explicit-fixture-state-password-32-bytes",
    secret = "explicit-fixture-native-key";
  try {
    await mkdir(join(original, prefix), { recursive: true, mode: 0o700 });
    for (const [logical, expected] of Object.entries(creatorResources))
      await writeFile(
        join(original, prefix, `${logical}.json`),
        JSON.stringify({
          status: "created",
          logicalId: logical,
          resourceType: expected.type,
          attr: { accountId: creatorAccount, ...expected.identity },
          props: { env: { SUI_OPERATOR_SECRET_KEY: secret } },
        }),
        { mode: 0o600 },
      );
    await writeFile(
      join(original, prefix, "__stack_output__.json"),
      '{"fixture":true}',
      { mode: 0o600 },
    );
    const hashes = await creatorPredecessor(original);
    await restoreCreatorState(target, hashes, password, secret, original);
    const file = join(target, prefix, "WalletTest.json"),
      encrypted = await readFile(file, "utf8");
    assert.ok(!encrypted.includes(secret));
    assert.equal(
      unseal(encrypted, password, `alchemy-state:${prefix}/WalletTest.json`),
      await readFile(join(original, prefix, "WalletTest.json"), "utf8"),
    );
    assert.deepEqual(await creatorPredecessor(original), hashes);
    await restoreCreatorState(target, hashes, password, secret, original);
    assert.equal(await readFile(file, "utf8"), encrypted);
    await assert.rejects(
      restoreCreatorState(target, hashes, "wrong-password", secret, original),
    );
    await assert.rejects(
      restoreCreatorState(
        join(dir, "wrong-key"),
        hashes,
        password,
        "changed-key",
        original,
      ),
      /signer_changed/,
    );
    await writeFile(
      join(original, prefix, "WalletTest.json"),
      "changed-original",
      { mode: 0o600 },
    );
    await assert.rejects(
      restoreCreatorState(target, hashes, password, secret, original),
      /predecessor_changed/,
    );
    assert.equal(await readFile(file, "utf8"), encrypted);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Worker multipart hashes preserve binary bytes even when fields have no filenames", () => {
  const boundary = "worker-fixture-boundary",
    script = Buffer.from(
      "export default {fetch(){return new Response('fixture')}}\n",
    ),
    wasm = Buffer.from([0, 97, 115, 109, 255, 254, 192, 0, 128, 10, 13]),
    part = (name: string, type: string, bytes: Uint8Array) =>
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
        ),
        bytes,
        Buffer.from("\r\n"),
      ]),
    bytes = Buffer.concat([
      part("index.js", "application/javascript", script),
      part("ika.wasm", "application/wasm", wasm),
      Buffer.from(`--${boundary}--\r\n`),
    ]),
    type = `multipart/form-data; boundary=${boundary}`;
  assert.deepEqual(workerModuleDigests(bytes, type), {
    "index.js": fileDigest(script),
    "ika.wasm": fileDigest(wasm),
  });
  assert.throws(() => workerModuleDigests(bytes.subarray(0, -20), type));
  const duplicate = Buffer.concat([
    part("index.js", "application/javascript", script),
    part("index.js", "application/javascript", script),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  assert.throws(
    () => workerModuleDigests(duplicate, type),
    /unexpected_worker_module/,
  );
  assert.deepEqual(workerModuleDigests(script, "application/javascript"), {
    "index.js": fileDigest(script),
  });
});

async function recoveryFixture() {
  const dir = await mkdtemp(join(tmpdir(), "pirate-native-profile-recovery-")),
    relative = "pirate-creator-wallet-testnet/testnet/WalletTest.json",
    raw = '{"explicit":"restored-original-fixture"}',
    password = "explicit-fixture-password-32-bytes",
    statePath = join(dir, "deployment/infra/.alchemy/state", relative),
    predecessorModules = {
      "index.js": fileDigest("old-script-fixture"),
      "ika.wasm": fileDigest("old-wasm-fixture"),
    },
    previousProfile = {
      sourceHashes: { fixture: "old" },
      predecessorState: { [relative]: fileDigest(raw) },
      predecessorModules,
      bounds: { newResources: 0, nativeTransactions: 0, executionSeconds: 900 },
    },
    previousHash = hashJson(previousProfile),
    original = canonical({
      profileHash: previousHash,
      at: "2026-11-05T00:00:00.000Z",
    }),
    previousPlanPath = join(dir, "previous-plan.json");
  await mkdir(join(statePath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(statePath, seal(raw, password, `alchemy-state:${relative}`), {
    mode: 0o600,
  });
  await writeFile(join(dir, "execution.json"), original, { mode: 0o600 });
  await writeFile(
    previousPlanPath,
    JSON.stringify({ profileHash: previousHash, profile: previousProfile }),
    { mode: 0o600 },
  );
  const profile = {
    ...previousProfile,
    sourceHashes: { fixture: "scanner-recovery" },
    restoredStateRecovery: {
      previousPlanPath,
      previousProfileHash: previousHash,
      expectedExecutionFileSha256: fileDigest(original),
    },
  };
  const planned = { profile, profileHash: hashJson(profile) },
    reads: string[] = [];
  return {
    dir,
    password,
    planned,
    original,
    raw,
    statePath,
    relative,
    reads,
    readModules: async (_token: string, name: string) => {
      reads.push(name);
      return predecessorModules;
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}
test("native profile handoff preserves the execution proof and restored ciphertext before any provider phase", async () => {
  const f = await recoveryFixture();
  try {
    const originalCiphertext = await readFile(f.statePath, "utf8");
    await adoptCreatorProfile(
      f.dir,
      f.planned,
      f.password,
      "explicit-fixture-token",
      f.readModules,
    );
    assert.equal(
      await readFile(join(f.dir, "execution-before-scan-update.json"), "utf8"),
      f.original,
    );
    assert.equal(await readFile(f.statePath, "utf8"), originalCiphertext);
    assert.equal(
      JSON.parse(await readFile(join(f.dir, "execution.json"), "utf8"))
        .profileHash,
      f.planned.profileHash,
    );
    assert.deepEqual(f.reads, ["pirate-wallet-test", "pirate-creator-spike"]);
  } finally {
    await f.dispose();
  }
});
test("changed native intent, state, metadata, live modules or any started external phase refuses local adoption", async () => {
  for (const fault of [
    "intent",
    "state",
    "metadata",
    "live",
    "diagnostics",
    "result",
  ]) {
    const f = await recoveryFixture();
    try {
      if (fault === "intent") {
        f.planned.profile.bounds.newResources = 1;
        f.planned.profileHash = hashJson(f.planned.profile);
      }
      if (fault === "state")
        await writeFile(
          f.statePath,
          seal("changed-state", f.password, `alchemy-state:${f.relative}`),
        );
      if (fault === "metadata")
        await writeFile(join(f.dir, "execution.json"), "changed-metadata");
      if (fault === "diagnostics") await mkdir(join(f.dir, "diagnostics"));
      if (fault === "result")
        await writeFile(join(f.dir, "deployment-result.json"), "{}");
      const before = await readFile(join(f.dir, "execution.json"), "utf8");
      await assert.rejects(
        adoptCreatorProfile(
          f.dir,
          f.planned,
          f.password,
          "explicit-fixture-token",
          fault === "live"
            ? async () => ({ "index.js": "changed-live-modules" })
            : f.readModules,
        ),
      );
      assert.equal(
        await readFile(join(f.dir, "execution.json"), "utf8"),
        before,
      );
    } finally {
      await f.dispose();
    }
  }
});
test("native package scan boundaries allow only the validated dependency link and still scan public assets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pirate-native-scan-"));
  try {
    const infra = join(dir, "infra"),
      dist = join(dir, "dist"),
      secret = "explicit-fixture-secret";
    await mkdir(infra);
    await mkdir(dist);
    await symlink("/unread-dependency-fixture", join(infra, "node_modules"));
    await writeFile(join(infra, "public-source.ts"), "export {};");
    await assert.rejects(
      inspectPrivateFiles(dir, [secret]),
      /Unexpected symlink/,
    );
    await inspectPrivateFiles(infra, [secret]);
    await inspectPrivateFiles(dist, [secret]);
    await writeFile(join(dist, "asset.js"), secret);
    await assert.rejects(
      inspectPrivateFiles(dist, [secret]),
      /Plaintext credential/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
