import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hexToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashJson } from "../packages/community/common.ts";
import { acquireOperation } from "../deploy/linux/backend-state.ts";
import { createManagedKeyClient, startManagedKeyAgent } from "../deploy/linux/managed-key-channel.ts";
import { createWeb2RetainedPublisherIdentityReader } from "../deploy/linux/web2-retained-publisher-identity.ts";

test("retained Dance custody derives just the original publisher identity on the held operation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "retained-publisher-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "lease"), { mode: 0o700 });
  await mkdir(join(directory, "other-lease"), { mode: 0o700 });
  const lease = await acquireOperation(
    join(directory, "lease"), "retained-dance-stage", "pirate-retained-test-installation",
    { original: "disposable" }, await readlink("/proc/self/ns/pid"),
  );
  const otherLease = await acquireOperation(
    join(directory, "other-lease"), "retained-dance-other", lease.installationId,
    { original: "disposable" }, await readlink("/proc/self/ns/pid"),
  );
  const custody = join(directory, "custody");
  await mkdir(custody, { mode: 0o700 });
  const keyFile = join(custody, "publisher.key");
  const privateKey = generatePrivateKey();
  await writeFile(keyFile, hexToBytes(privateKey), { mode: 0o600 });

  const binding = {
    keyReference: "disposable-stage-publisher",
    generation: 1,
    installationId: lease.installationId,
    publisher: privateKeyToAccount(privateKey).address.toLowerCase() as `0x${string}`,
  };
  const original = { ...binding, custodyBindingDigest: hashJson(binding) };
  const authenticationKey = randomBytes(32);
  t.after(() => { authenticationKey.fill(0); });
  const socket = join(custody, "key.sock");
  async function startAgent() {
    const agent = await startManagedKeyAgent({
      socket, directory: custody, installationId: lease.installationId, authenticationKey,
      lease, keys: [{ ref: original.keyReference, generation: original.generation, path: keyFile, bytes: 32 }],
      signingKeyFile: join(custody, "unused-signing-key"), trust: { keyId: "unused", spki: "" },
      permittedProfileDigests: new Set(), capturedRoots: [lease.directory],
    });
    return agent;
  }
  const agent = await startAgent();
  const key = await createManagedKeyClient({ socket, installationId: lease.installationId, authenticationKey, lease });
  let observed = original;
  let keyReads = 0;
  const reader = createWeb2RetainedPublisherIdentityReader({
    lease, original,
    async readCurrentBinding() { return observed; },
    keys: {
      async withKey(ref, generation, callback) {
        keyReads++;
        return key.withKey(ref, generation, callback);
      },
    },
  });
  const request = {
    installationId: lease.installationId,
    operationId: lease.operationId,
    leaseIntentSha256: lease.intentRef.sha256,
    keyReference: original.keyReference,
    generation: original.generation,
  };
  try {
    assert.deepEqual(Object.keys(reader), ["read"]);
    await assert.rejects(reader.read({ ...request, generation: 2 }), /retained_publisher_identity_request_changed/);
    await assert.rejects(reader.read({ ...request, installationId: "other-installation" }), /retained_publisher_identity_request_changed/);
    await assert.rejects(reader.read({ ...request, operationId: otherLease.operationId,
      leaseIntentSha256: otherLease.intentRef.sha256 }), /retained_publisher_identity_request_changed/);
    assert.equal(keyReads, 0);
    assert.deepEqual(await reader.read(request), {
      address: original.publisher, custodyBindingDigest: original.custodyBindingDigest,
    });
    observed = { ...original, generation: 2 };
    await assert.rejects(reader.read(request), /retained_publisher_custody_binding_changed/);
    assert.equal(keyReads, 1);
    observed = original;
    await writeFile(keyFile, hexToBytes(generatePrivateKey()), { mode: 0o600 });
    await assert.rejects(reader.read(request), /retained_publisher_key_address_changed/);
    await chmod(join(lease.directory, "active-operation.json"), 0o644);
    await assert.rejects(reader.read(request));
    assert.equal(keyReads, 2);
  } finally {
    key.dispose();
    await agent.close();
  }
});
