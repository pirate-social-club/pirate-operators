import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  creatorPredecessor,
  creatorResources,
  creatorAccount,
  restoreCreatorState,
  fileDigest,
} from "../harness/creator-state.ts";
import { unseal } from "../apps/creator-spike/infra/protected-data.ts";
import { workerModuleDigests } from "../harness/worker-modules.ts";

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
