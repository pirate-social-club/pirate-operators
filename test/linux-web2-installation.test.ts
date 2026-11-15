import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdir,
  writeFile,
  readFile,
  mkdtemp,
  readlink,
} from "node:fs/promises";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { PublicClient, Hex } from "viem";
import { acquireWeb2ServiceControl } from "../deploy/linux/web2-service-lease.ts";
import { authenticateWeb2Enrollment } from "../deploy/linux/web2-profile-authority.ts";
import {
  installationAuthorityFixture,
  availablePort,
} from "./fixtures/linux-web2-installation.ts";

// Observable process lifetime, rather than a mocked lock: two clean foreground
// boots must retain one installation while a competitor/crash cannot take it.
test(
  "Web2 service control supports clean process restart and refuses competing or crashed ownership",
  { timeout: 20000 },
  async (t) => {
    assert(process.env.TMPDIR);
    const root = await mkdtemp(join(process.env.TMPDIR, "web2-control-"));
    const module = new URL(
      "../deploy/linux/web2-service-lease.ts",
      import.meta.url,
    ).href;
    const children: ReturnType<typeof spawn>[] = [];
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const terminal = once(child, "exit");
          child.kill("SIGKILL");
          await terminal;
        }
    });
    async function boot(directory: string) {
      const script = `import {acquireWeb2ServiceControl} from ${JSON.stringify(module)};
      const control=await acquireWeb2ServiceControl(process.argv[1],"restart-fixture");
      process.stdout.write(JSON.stringify({operationId:control.lease.operationId,directory:control.lease.directory})+"\\n");
      for await(const data of process.stdin){
        if(data.toString().trim()!=="stop")throw Error("unexpected fixture command");
        await control.lease.record("fixture-foreground-stopped",{persistentContainersUntouched:true});
        await control.closeControl();
        break;
      }`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, directory],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      children.push(child);
      const terminal = once(child, "exit");
      let output = "",
        errors = "";
      child.stderr!.on("data", (chunk) => {
        errors += chunk;
      });
      const ready = new Promise<{ operationId: string; directory: string }>(
        (resolve, reject) => {
          child.stdout!.on("data", (chunk) => {
            output += chunk;
            if (output.includes("\n")) resolve(JSON.parse(output.trim()));
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            reject(Error("fixture exited before ready: " + code + errors)),
          );
        },
      );
      return { child, terminal, ready, errors: () => errors };
    }
    const clean = join(root, "clean");
    await mkdir(clean, { mode: 0o700 });
    const first = await boot(clean),
      a = await first.ready;
    const originalLock = await readFile(
      join(clean, "active-web2-service.json"),
    );
    const firstBootOriginal = await readFile(
      join(a.directory, "active-operation.json"),
    );
    await assert.rejects(acquireWeb2ServiceControl(clean, "restart-fixture"), {
      code: "EEXIST",
    });
    assert.deepEqual(
      await readFile(join(clean, "active-web2-service.json")),
      originalLock,
    );
    first.child.stdin!.end("stop\n");
    assert.deepEqual(await first.terminal, [0, null], first.errors());
    const second = await boot(clean),
      b = await second.ready;
    assert.notEqual(a.operationId, b.operationId);
    assert.notEqual(a.directory, b.directory);
    assert.deepEqual(
      await readFile(join(a.directory, "active-operation.json")),
      firstBootOriginal,
      "the first boot journal is preserved",
    );
    second.child.stdin!.end("stop\n");
    assert.deepEqual(await second.terminal, [0, null], second.errors());
    const crashed = join(root, "crashed");
    await mkdir(crashed, { mode: 0o700 });
    const third = await boot(crashed);
    await third.ready;
    const crashLock = await readFile(join(crashed, "active-web2-service.json"));
    third.child.kill("SIGKILL");
    assert.deepEqual(await third.terminal, [null, "SIGKILL"]);
    await assert.rejects(
      acquireWeb2ServiceControl(crashed, "restart-fixture"),
      { code: "EEXIST" },
    );
    assert.deepEqual(
      await readFile(join(crashed, "active-web2-service.json")),
      crashLock,
    );
    await mkdir(".local/linux-web2-installation", { recursive: true });
    await writeFile(
      ".local/linux-web2-installation/service-control-restart.json",
      JSON.stringify({
        root,
        boots: [a, b],
        competitorRefused: true,
        crashRefused: true,
        persistentResourcesNotControlledByLease: true,
      }) + "\n",
    );
  },
);

test(
  "Web2 installation authenticates the original safe enrollment and refuses changed source, configuration or stale evidence",
  { timeout: 120000 },
  async (t) => {
    const f = await installationAuthorityFixture();
    t.after(f.close);
    const original = await authenticateWeb2Enrollment(f.authority, f.draft);
    assert.equal(original.transactionHash, f.chain.original.transactionHash);
    assert.equal(original.configurationRevision, 1);
    assert.equal(
      (
        await f.chain.client.getTransactionReceipt({
          hash: original.transactionHash,
        })
      ).status,
      "success",
    );
    const safe = await f.chain.client.getBlock({
      blockNumber: BigInt(original.safeBlock),
    });
    f.setNow(safe.timestamp + 600n);
    assert.equal(
      (await authenticateWeb2Enrollment(f.authority, f.draft)).transactionHash,
      original.transactionHash,
    );
    f.setNow(safe.timestamp + 601n);
    await assert.rejects(
      authenticateWeb2Enrollment(f.authority, f.draft),
      /install_directory_unavailable/,
    );
    f.setNow(BigInt(Math.floor(Date.now() / 1000)));
    await assert.rejects(
      authenticateWeb2Enrollment(
        {
          ...f.authority,
          deployment: {
            ...f.authority.deployment,
            sourceCommit: "0".repeat(40),
          },
        },
        f.draft,
      ),
      /unadmitted_install_deployment/,
    );

    const wrong = structuredClone(f.draft);
    const deploymentBlock = await f.chain.client.getBlock({
      blockNumber: f.chain.profile.deploymentBlock,
    });
    assert(deploymentBlock.transactions[0]);
    wrong.enrollment.operations[0]!.transactionHash =
      deploymentBlock.transactions[0];
    await assert.rejects(authenticateWeb2Enrollment(f.authority, wrong));

    const snapshot = await f.chain.rpc("evm_snapshot");
    await f.chain.nextRevision(); // real non-role app-label change with new CID/event
    await assert.rejects(
      authenticateWeb2Enrollment(f.authority, f.draft),
      /install_current_authority_changed/,
    );
    assert.equal(await f.chain.rpc("evm_revert", [snapshot]), true);
    assert.equal(
      (await authenticateWeb2Enrollment(f.authority, f.draft)).transactionHash,
      original.transactionHash,
    );
    const code = await f.chain.client.getCode({
      address: f.draft.deployment.posts.address,
    });
    assert(code);
    await f.chain.rpc("anvil_setCode", [
      f.draft.deployment.posts.address,
      "0x60006000fd",
    ]);
    await f.chain.rpc("anvil_mine", ["0x40", "0x0"]);
    await assert.rejects(
      authenticateWeb2Enrollment(f.authority, f.draft),
      /install_posts_source_changed/,
    );
    await mkdir(".local/linux-web2-installation", { recursive: true });
    await writeFile(
      ".local/linux-web2-installation/chain-authority.json",
      JSON.stringify({
        original,
        source: f.authority.deployment,
        exactExpiryChecked: true,
        nonRoleRevisionRefused: true,
        actualSnapshotRevertChecked: true,
        changedPostsCodeRefused: true,
      }) + "\n",
    );
  },
);

test("paired Web2 setup keeps its destination, captured secret and actual private forwarder boundary", async (t) => {
  const { startPairedOperator } = await import(
    "../deploy/linux/bootstrap-local-target.ts"
  );
  const { acquireOperation } = await import("../deploy/linux/backend-state.ts");
  assert(process.env.TMPDIR);
  const root = await mkdtemp(join(process.env.TMPDIR, "web2-pair-"));
  await mkdir(join(root, "control"), { mode: 0o700 });
  await mkdir(join(root, "nonces"), { mode: 0o700 });
  const lease = await acquireOperation(
    join(root, "control"),
    "web2-pair",
    "web2-paired-fixture",
    { purpose: "real paired HTTP transport" },
    await readlink("/proc/self/ns/pid"),
  );
  const secret = randomBytes(32),
    code = secret.toString("base64url"),
    frontPort = await availablePort(),
    innerPort = await availablePort();
  let resume!: () => void,
    entered!: () => void,
    first = true;
  const paused = new Promise<void>((r) => {
      resume = r;
    }),
    waiting = new Promise<void>((r) => {
      entered = r;
    });
  const task = startPairedOperator({
    installationId: lease.installationId,
    frontPort,
    innerPort,
    pairingSecret: secret,
    setup: "linux-web2",
    pairingNonceDirectory: join(root, "nonces"),
    async assertHeld() {
      await lease.assertHeld();
      if (first) {
        first = false;
        entered();
        await paused;
      }
    },
    async createRuntime(authorization) {
      // Echo transport only; production proxy authorization is exercised here.
      const server = createServer((req, res) => {
        void authorization.authorize(req, "read").then(
          () => {
            res
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ path: req.url, host: req.headers.host }));
          },
          () => res.writeHead(403).end(),
        );
      });
      return {
        server,
        async listen(port) {
          server.listen(port, "127.0.0.1");
          await once(server, "listening");
        },
        close: () =>
          new Promise<void>((resolve, reject) =>
            server.close((e) => (e ? reject(e) : resolve())),
          ),
      };
    },
  });
  await waiting;
  secret.fill(0);
  resume();
  const paired = await task;
  t.after(() => paired.close());
  const call = (path: string, init: RequestInit = {}) =>
    fetch(paired.origin + path, {
      signal: AbortSignal.timeout(3000),
      redirect: "manual",
      ...init,
    });
  const direct = await fetch(`http://127.0.0.1:${innerPort}/private`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(
    direct.status,
    403,
    "the private runtime requires the real proxy credential",
  );
  assert.equal(
    (
      await call("/pair", {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
        body: new URLSearchParams({ code }),
      })
    ).status,
    403,
  );
  const linked = await call("/pair", {
    method: "POST",
    headers: { Origin: paired.origin },
    body: new URLSearchParams({ code }),
  });
  assert.equal(linked.status, 303);
  assert.equal(linked.headers.get("location"), "/?setup=linux-web2");
  const cookie = linked.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const response = await call("/api/setup", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    path: "/api/setup",
    host: `127.0.0.1:${innerPort}`,
  });
  assert.equal(
    (
      await call("/api/setup", {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  let cleanupUnavailable = true;
  const finishSetup = async () => {
    if (cleanupUnavailable) throw Error("injected_setup_cleanup_unavailable");
  };
  await assert.rejects(
    paired.close(finishSetup),
    /paired_runtime_custody_retained/,
  );
  cleanupUnavailable = false;
  await paired.close(finishSetup);
  await assert.rejects(call("/api/setup", { headers: { Cookie: cookie } }));
});

test(
  "Web2 native initialization keeps one signed original and binds actual login sessions in D1",
  { timeout: 120000 },
  async (t) => {
    const f = await installationAuthorityFixture();
    t.after(f.close);
    const { nativeProducerFixture } = await import(
      "./application-native-producer-fixture.ts"
    );
    const database = await nativeProducerFixture(false);
    t.after(database.dispose);
    const { nativeBusinessTransition } = await import(
      "../packages/community/native-business-transition.ts"
    );
    const { initializeWeb2NativeOriginal } = await import(
      "../packages/community/web2-native-business-binding.ts"
    );
    const { nativeCanonical, nativeDigest } = await import(
      "../packages/community/native-business-binding.ts"
    );
    const { signRecord, canonicalDigest } = await import(
      "../deploy/linux/installed-records.ts"
    );
    const { default: application } = await import(
      "../services/linux-community.ts"
    );
    const schema = await readFile(
      "packages/community/native-business.sql",
      "utf8",
    );
    await database.db.batch(nativeBusinessTransition(database.db, schema));
    const keys = generateKeyPairSync("ed25519"),
      privateKey = keys.privateKey.export({ format: "der", type: "pkcs8" });
    const trust = {
      keyId: "public-web2-native-fixture",
      spki: keys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    };
    const body = {
      schema: "pirate.linux-web2-install-plan/1" as const,
      planId: "web2-" + f.draft.enrollment.enrollmentId.slice(2),
      installationId: "web2-native-fixture-installation",
      durableScope: "a".repeat(64),
      generation: 2,
      draft: f.draft,
      releaseArtifactDigest: "0x" + "b".repeat(64),
      releaseSourceDigest: "0x" + "c".repeat(64),
      targetDigest: "d".repeat(64),
      hostFingerprint: "fixture-only-no-host-qualification",
      enrollment: await authenticateWeb2Enrollment(f.authority, f.draft),
      registrationAuthority: {
        registrar: f.authority.registrar,
        registrarRevision: String(f.authority.registrarRevision),
        maxSafeBlockAgeSeconds: "600",
      },
    };
    // Signed application identity fixture only. Never passed to the host's full
    // release verifier or represented as an installed filesystem/code proof.
    const release = {
      schema: "pirate.complete-linux-web2-release/1" as const,
      artifactDigest: body.releaseArtifactDigest,
      sourceDigest: body.releaseSourceDigest,
      graph: {
        installationId: body.installationId,
        durableScope: body.durableScope,
        directoryRuntimeBinding: JSON.stringify(f.draft.deployment),
      },
    };
    const original = {
      schema: "pirate.web2-native-application-original/1" as const,
      trust,
      durableScope: body.durableScope,
      record: signRecord(body, trust, privateKey),
      release: signRecord(release, trust, privateKey),
    };
    const raw = nativeCanonical(original),
      digest = await initializeWeb2NativeOriginal(database.db, raw);
    const env = {
      ...database.env,
      COMMUNITY_NAME: f.draft.name,
      COMMUNITY_DEPLOYMENT_PROFILE_JSON: JSON.stringify(f.draft.deployment),
      NATIVE_APPLICATION_ORIGINAL_JSON: raw,
    };
    const call = (path: string, init: RequestInit = {}) =>
      application.fetch(new Request(f.draft.origin + path, init), env);
    const post = (path: string, value: unknown) =>
      call(path, {
        method: "POST",
        headers: { Origin: f.draft.origin, "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
    const challenge = await post("/api/auth/challenge", {
      address: database.wallet.address,
    });
    assert.equal(challenge.status, 200, await challenge.clone().text());
    const c = (await challenge.json()) as { id: string; message: string };
    const verified = await post("/api/auth/verify", {
      id: c.id,
      signature: await database.wallet.signMessage({ message: c.message }),
    });
    assert.equal(verified.status, 200, await verified.clone().text());
    const cookie = verified.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    assert.equal(
      (await call("/api/session", { headers: { Cookie: cookie } })).status,
      200,
    );
    const binding = await database.db
      .prepare(
        "SELECT original_digest,request_id FROM native_business_bindings WHERE kind='session'",
      )
      .first<{ original_digest: string; request_id: string }>();
    assert.deepEqual(binding, { original_digest: digest, request_id: c.id });
    assert.equal(await initializeWeb2NativeOriginal(database.db, raw), digest);
    assert.equal(
      (await call("/api/session", { headers: { Cookie: cookie } })).status,
      200,
      "re-initialization must retain the actual session",
    );
    const changed = {
      ...original,
      record: signRecord({ ...body, generation: 3 }, trust, privateKey),
    };
    await assert.rejects(
      initializeWeb2NativeOriginal(database.db, nativeCanonical(changed)),
      /CHECK constraint failed/,
    );
    const retained = await database.db
      .prepare(
        "SELECT original_digest,original_json FROM native_application_original WHERE singleton=1",
      )
      .first<{ original_digest: string; original_json: string }>();
    assert.deepEqual(retained, {
      original_digest: nativeDigest(original),
      original_json: raw,
    });
    const forged = structuredClone(original);
    forged.record.body.generation = 4;
    await assert.rejects(
      initializeWeb2NativeOriginal(database.db, nativeCanonical(forged)),
    );
    await assert.rejects(
      application.fetch(
        new Request(f.draft.origin + "/api/session", {
          headers: { Cookie: cookie },
        }),
        { ...env, NATIVE_APPLICATION_ORIGINAL_JSON: nativeCanonical(changed) },
      ),
      /web2_native_original_changed/,
    );
    await writeFile(
      ".local/linux-web2-installation/native-original.json",
      JSON.stringify({
        digest,
        planDigest: canonicalDigest(body),
        originalRetained: true,
        actualSessionBound: true,
        changedOriginalRefused: true,
      }) + "\n",
    );
  },
);

test(
  "Web2 installation owns its draft and original transaction before deferred RPC reads",
  { timeout: 120000 },
  async (t) => {
    const f = await installationAuthorityFixture();
    t.after(f.close);
    let entered!: () => void, resume!: () => void;
    const reading = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
    const client: PublicClient = {
      ...f.authority.client,
      async getTransaction(args) {
        entered();
        await paused;
        return f.authority.client.getTransaction(args);
      },
    };
    const input = structuredClone(f.draft),
      expected = input.enrollment.operations[0]!.transactionHash;
    const pending = authenticateWeb2Enrollment(
      { ...f.authority, client },
      input,
    );
    await reading;
    input.enrollment.operations[0]!.transactionHash =
      `0x${"f".repeat(64)}` as Hex;
    input.configuration.app.label = "mutated while awaiting RPC";
    resume();
    const result = await pending;
    assert.equal(result.transactionHash, expected);
    assert.equal(result.configurationRevision, 1);
    assert.equal(
      (await authenticateWeb2Enrollment(f.authority, f.draft)).transactionHash,
      expected,
    );
  },
);
