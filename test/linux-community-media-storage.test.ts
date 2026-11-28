import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, generateKeyPairSync } from "node:crypto";

// Community-owned media credential custody, end to end on the real key agent,
// real encrypted vault and real filesystem. The Filebase transport is the one
// injected boundary; it records every request so the test can prove the check
// ordering, the read-only scope of the probe and the absence of secret echo.
test(
  "community media storage checks, commits, recovers and rotates generations",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pirate-media-storage-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ["operation", "keys", "agent", "vault", "cohort"])
      await mkdir(join(root, name), { mode: 0o700 });
    const { processIdentity, acquireOperation } = await import(
      "../deploy/linux/backend-state.ts"
    );
    const frame = await processIdentity(process.pid);
    assert(frame);
    const installationId = "fixture-community-media-installation";
    const lease = await acquireOperation(
      join(root, "operation"),
      "media-storage-test",
      installationId,
      { purpose: "integration" },
      frame.pidNamespace,
    );
    const pair = generateKeyPairSync("ed25519");
    const trust = {
      keyId: "media-storage-test-issuer",
      spki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    };
    await writeFile(
      join(root, "keys", "issuer.der"),
      pair.privateKey.export({ format: "der", type: "pkcs8" }),
      { mode: 0o600 },
    );
    const master = randomBytes(32);
    await writeFile(join(root, "keys", "master"), master, { mode: 0o600 });
    const { startManagedKeyAgent, createManagedKeyClient } = await import(
      "../deploy/linux/managed-key-channel.ts"
    );
    const authenticationKey = randomBytes(32);
    const socket = join(root, "agent", "key.sock");
    const agent = await startManagedKeyAgent({
      socket,
      directory: join(root, "agent"),
      installationId,
      authenticationKey,
      lease,
      keys: [
        {
          ref: "community-media",
          generation: 1,
          path: join(root, "keys", "master"),
          bytes: 32,
        },
      ],
      signingKeyFile: join(root, "keys", "issuer.der"),
      trust,
      permittedProfileDigests: new Set(),
      capturedRoots: [join(root, "cohort")],
    });
    t.after(() => agent.close());
    const channel = await createManagedKeyClient({
      socket,
      installationId,
      authenticationKey,
      lease,
    });
    t.after(() => channel.dispose());

    // Fixture provider: token alpha/bravo are accepted with distinct pin
    // counts, everything else is refused. Every request is recorded.
    const calls: Array<{ path: string; method: string; authorization: string | null }> = [];
    const accepted = new Map([
      ["token-alpha", 3],
      ["token-bravo", 0],
    ]);
    const transport = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      calls.push({ path: url.pathname + url.search, method: request.method, authorization });
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!accepted.has(token))
        return new Response("refused", { status: 401 });
      const pins: Record<string, { Type: string }> = {};
      for (let i = 0; i < accepted.get(token)!; i++)
        pins["bafybeig" + String(i).padStart(40, "0")] = { Type: "recursive" };
      return new Response(JSON.stringify({ Keys: pins }), { status: 200 });
    };
    const { createCommunityMediaStorage } = await import(
      "../deploy/linux/community-media-storage.ts"
    );
    const storage = await createCommunityMediaStorage({
      directory: join(root, "vault"),
      lease,
      channel,
      keyRef: "community-media",
      keyGeneration: 1,
      installationId,
      send: transport,
    });
    t.after(() => storage.dispose());

    // Fresh store: no active generation.
    assert.equal(await storage.status(), null);

    // Declined token: nothing committed, no generation exists.
    assert.deepEqual(await storage.checkAndSave({
      requestId: "a".repeat(32),
      token: "token-refused",
    }), { state: "declined" });
    assert.equal(await storage.status(), null);
    assert.equal((await readdir(join(root, "vault"))).length, 0);

    // Genuine save: probe passed first, generation one committed.
    const first = await storage.checkAndSave({
      requestId: "b".repeat(32),
      token: "token-alpha",
    });
    assert.deepEqual(first, { state: "saved", generation: 1 });
    const status = await storage.status();
    assert.equal(status?.generation, 1);
    assert.equal(status?.check.pinCount, 3);
    // The check was a read-only pin-list; no object was ever added.
    assert(calls.every((c) => c.path.startsWith("/api/v0/pin/ls")));
    // The plaintext token never reached the vault files.
    for (const name of await readdir(join(root, "vault"))) {
      const content = await readFile(join(root, "vault", name), "utf8");
      assert(!content.includes("token-alpha"), "plaintext token in vault");
    }
    // useToken resolves exactly the committed secret for local use.
    let recovered: string | undefined;
    await storage.useToken(async (token) => {
      recovered = token;
    });
    assert.equal(recovered, "token-alpha");

    // Lost save reply: reconcile by request id recovers the original
    // generation without the token, and a completed operation never repeats.
    assert.deepEqual(
      await storage.reconcile({ requestId: "b".repeat(32) }),
      { state: "saved", generation: 1 },
    );
    assert.deepEqual(
      await storage.reconcile({ requestId: "c".repeat(32) }),
      { state: "not-saved" },
    );

    // Failed replacement: the previous generation stays active and usable.
    assert.deepEqual(
      await storage.checkAndSave({ requestId: "d".repeat(32), token: "token-refused" }),
      { state: "declined" },
    );
    assert.equal((await storage.status())?.generation, 1);
    recovered = undefined;
    await storage.useToken(async (token) => {
      recovered = token;
    });
    assert.equal(recovered, "token-alpha");

    // Successful rotation: generation two becomes active, generation one is
    // retained immutably, and the active secret switches.
    assert.deepEqual(
      await storage.checkAndSave({ requestId: "e".repeat(32), token: "token-bravo" }),
      { state: "saved", generation: 2 },
    );
    assert.equal((await storage.status())?.generation, 2);
    assert.equal((await storage.status())?.check.pinCount, 0);
    recovered = undefined;
    await storage.useToken(async (token) => {
      recovered = token;
    });
    assert.equal(recovered, "token-bravo");
    // No response or evidence value anywhere contains either secret.
    const artifact = JSON.stringify(status) + JSON.stringify(first);
    assert(!artifact.includes("token-alpha") && !artifact.includes("token-bravo"));
  },
);
