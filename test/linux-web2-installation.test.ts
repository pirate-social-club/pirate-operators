import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdir,
  writeFile,
  readFile,
  mkdtemp,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
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
  const { startPairedOperator, PairedOperatorStartupFailure } = await import(
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

  // Fail the actual proxy bind AFTER the inner runtime starts, then refuse its
  // first cleanup. The error must carry the original cleanup owner, not lose it.
  const conflict = createServer((_req, res) => res.end("owned port conflict"));
  conflict.listen(frontPort, "127.0.0.1");
  await once(conflict, "listening");
  t.after(
    () => new Promise<void>((resolve) => conflict.close(() => resolve())),
  );
  const controlDirectory = join(root, "startup-control");
  await mkdir(controlDirectory, { mode: 0o700 });
  const control = await acquireWeb2ServiceControl(
    controlDirectory,
    "web2-paired-fixture",
  );
  let cleanupBlocked = true;
  const inner = createServer((_req, res) => res.end("original inner runtime"));
  let startup: InstanceType<typeof PairedOperatorStartupFailure> | undefined;
  t.after(async () => {
    cleanupBlocked = false;
    await startup?.close();
    await control.closeControl();
  });
  try {
    await startPairedOperator({
      installationId: control.lease.installationId,
      frontPort,
      innerPort,
      pairingSecret: randomBytes(32),
      pairingNonceDirectory: join(root, "nonces"),
      assertHeld: control.lease.assertHeld,
      async createRuntime() {
        return {
          server: inner,
          async listen(port) {
            inner.listen(port, "127.0.0.1");
            await once(inner, "listening");
          },
          async close() {
            if (cleanupBlocked)
              throw Error("fixture_runtime_cleanup_unavailable");
            await new Promise<void>((resolve, reject) =>
              inner.close((error) => (error ? reject(error) : resolve())),
            );
          },
        };
      },
    });
    assert.fail("occupied front port must fail startup");
  } catch (error) {
    assert(error instanceof PairedOperatorStartupFailure);
    startup = error;
  }
  assert(inner.listening, "the unresolved original runtime is still owned");
  await assert.rejects(startup.close(), /fixture_runtime_cleanup_unavailable/);
  await control.lease.assertHeld();
  await assert.rejects(
    acquireWeb2ServiceControl(controlDirectory, "web2-paired-fixture"),
    { code: "EEXIST" },
  );
  cleanupBlocked = false;
  await startup.close();
  assert.equal(inner.listening, false);
  await control.closeControl();
});

test("paired native installation replies can exceed thirty seconds without extending ordinary requests", { timeout: 65000 }, async (t) => {
  const { startPairedOperator } = await import("../deploy/linux/bootstrap-local-target.ts");
  const { hostedWizardFixture } = await import("./fixtures/web2-hosted-wizard.ts");
  const fixture = await hostedWizardFixture();
  t.after(fixture.close);
  assert(process.env.TMPDIR);
  const root = await mkdtemp(join(process.env.TMPDIR, "web2-long-pair-"));
  await mkdir(join(root, "nonces"), { mode: 0o700 });
  const frontPort = await availablePort(), innerPort = await availablePort();
  const secret = randomBytes(32), code = secret.toString("base64url");
  const identity = await fixture.state(), originalBroadcasts = fixture.broadcasts();
  const replies: Array<{ method: string; path: string; status: number }> = [];
  const handled = new Map<string, () => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const paired = await startPairedOperator({
    installationId: "long-native-reply", frontPort, innerPort, pairingSecret: secret,
    setup: "linux-web2", pairingNonceDirectory: join(root, "nonces"),
    async assertHeld() {},
    async createRuntime(authorization) {
      const server = createServer((req, res) => {
        void (async () => {
          await authorization.authorize(req, "write");
          let body = "";
          for await (const chunk of req) body += chunk;
          // Delay only the transport of the genuine unavailable-installer reply.
          // The real Wizard, CSRF, journal and original enrollment stay intact.
          const reply = await fixture.raw(req.method!, req.url!, body ? JSON.parse(body) : undefined);
          replies.push({ method: req.method!, path: req.url!, status: reply.status });
          handled.get(req.url!)?.();
          const timer = setTimeout(() => {
            timers.delete(timer);
            res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
          }, 31000);
          timers.add(timer);
        })().catch(() => res.writeHead(403).end());
      });
      return { server, async listen(port) { server.listen(port, "127.0.0.1"); await once(server, "listening"); },
        async close() { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
    },
  });
  t.after(() => paired.close());
  const linked = await fetch(paired.origin + "/pair", { method: "POST", redirect: "manual", headers: { Origin: paired.origin }, body: new URLSearchParams({ code }) });
  assert.equal(linked.status, 303);
  const cookie = linked.headers.get("set-cookie")!.split(";")[0]!;
  const state = await fixture.raw("GET", "/api/web2/state");
  const nativePaths = ["/api/web2/installation-prepare", "/api/web2/install", "/api/web2/installation-status"];
  const request = async (method: string, path: string, revision = identity.revision) => {
    const started = performance.now();
    const response = await fetch(paired.origin + path, { method, headers: { Cookie: cookie, Origin: paired.origin, "content-type": "application/json", "x-wizard-token": String(state.body.csrf) },
      ...(method === "POST" ? { body: JSON.stringify({ revision }) } : {}), signal: AbortSignal.timeout(45000) });
    return { response, body: await response.json(), elapsedMs: performance.now() - started };
  };
  const nativeRequests = [];
  for (const path of nativePaths) {
    const observed = new Promise<void>(resolve => handled.set(path, resolve));
    const current = await fixture.state();
    nativeRequests.push(request("POST", path, current.revision));
    // The actual journal refuses a stale revision. Let each real refusal settle
    // before issuing the next original request; their delayed replies overlap.
    await observed;
  }
  const outcomes = await Promise.allSettled([
    ...nativeRequests,
    request("POST", "/api/web2/state"), request("GET", nativePaths[0]!), request("POST", nativePaths[0] + "?extra=1"),
  ]);
  for (const outcome of outcomes.slice(0, 3)) {
    assert.equal(outcome.status, "fulfilled", "the actual paired native reply must survive thirty seconds");
    assert.equal(outcome.value.response.status, 503);
    assert(outcome.value.body && typeof outcome.value.body === "object" && "code" in outcome.value.body);
    assert.equal(outcome.value.body.code, "web2_installation_unavailable");
    assert(outcome.value.elapsedMs >= 31000);
  }
  for (const outcome of outcomes.slice(3)) assert.equal(outcome.status, "rejected", "only the three exact POST routes receive the longer bound");
  assert.equal(fixture.broadcasts(), originalBroadcasts);
  assert.deepEqual((await fixture.state()).selection, identity.selection);
  await mkdir(".local/linux-web2-installation", { recursive: true });
  await writeFile(".local/linux-web2-installation/paired-long-reply.json", JSON.stringify({ replies, outcomes: outcomes.map(result => result.status), originalBroadcasts, finalBroadcasts: fixture.broadcasts(), scope: "actual paired proxy and genuine unavailable installer, not installed success" }) + "\n");
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
    const { initializeWeb2NativeOriginal, web2NativeOriginal } = await import(
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
    // The optional attachment digest is part of both independently signed
    // originals. A newer parser must still accept the unmodified V1 original.
    const attachmentDigest = `0x${"a7".repeat(32)}` as Hex;
    const attached = {
      ...original,
      record: signRecord({ ...body, publishingAttachmentDigest: attachmentDigest }, trust, privateKey),
      release: signRecord({ ...release, publishingAttachmentDigest: attachmentDigest }, trust, privateKey),
    };
    assert.equal((await web2NativeOriginal(nativeCanonical(attached))).record.body.publishingAttachmentDigest, attachmentDigest);
    await assert.rejects(web2NativeOriginal(nativeCanonical({
      ...attached, release: original.release,
    })), /web2_native_original_binding_changed/);
    await assert.rejects(web2NativeOriginal(nativeCanonical({
      ...attached, record: signRecord({ ...body, publishingAttachmentDigest: `0x${"a8".repeat(32)}` },trust,privateKey),
    })), /web2_native_original_binding_changed/);
    assert.equal(await initializeWeb2NativeOriginal(database.db, raw), digest);
    await assert.rejects(
      web2NativeOriginal(
        nativeCanonical({
          ...original,
          release: signRecord(
            { ...release, files: { "host-inventory": "a".repeat(64) } },
            trust,
            privateKey,
          ),
        }),
      ),
      /invalid_fields/,
      "a separately signed app identity cannot carry the host artifact inventory",
    );
    const env = {
      ...database.env,
      COMMUNITY_NAME: f.draft.name,
      COMMUNITY_DEPLOYMENT_PROFILE_JSON: JSON.stringify(f.draft.deployment),
      NATIVE_APPLICATION_ORIGINAL_JSON: raw,
    };
    const call = (path: string, init: RequestInit = {}) =>
      application.fetch(new Request(f.draft.origin + path, init), env);
    const changedAttachment=await application.fetch(new Request(f.draft.origin+"/api/session"),{...env,WEB2_PUBLISHING_ATTACHMENT_SHA256:attachmentDigest});
    assert.equal(changedAttachment.status,503);
    assert.deepEqual(await changedAttachment.json(),{error:"web2_publishing_attachment_changed"});
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
    await mkdir(".local/web2-owner-signing-implementation/native",{recursive:true});
    await writeFile(
      ".local/web2-owner-signing-implementation/native/original.json",
      JSON.stringify({
        digest,
        planDigest: canonicalDigest(body),
        checkedRevision:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
        publishingAttachmentDigest:attachmentDigest,
        attachmentOriginalDigest:nativeDigest(attached),
        registrationTransaction:f.chain.original.transactionHash,
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

test("paired Web2 shares the signed session cutoff and preserves one-shot reauthentication", { timeout: 10000 }, async t => {
  const { startPairedOperator } = await import("../deploy/linux/bootstrap-local-target.ts");
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/var/tmp", "paired-cutoff-"));
  const nonces = join(root, "nonces");
  await mkdir(nonces, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = Date.UTC(2026, 10, 19, 17, 29, 48);
  const signedCutoff = Date.UTC(2026, 10, 19, 18, 5, 24);
  t.mock.timers.enable({ apis: ["Date"], now: started });
  const journalPath = join(root, "retained-original.json");
  await writeFile(journalPath, JSON.stringify({ phase: "unknown", controllerAuthorized: true }), { mode: 0o600 });
  let protectedRequests = 0;
  let advanceWhileAuthorizing: number | undefined;
  async function boot(sessionExpiresAt: number) {
    const frontPort = await availablePort();
    let innerPort = await availablePort();
    while (innerPort === frontPort) innerPort = await availablePort();
    const secret = randomBytes(32);
    const code = secret.toString("base64url");
    const paired = await startPairedOperator({
      installationId: "paired-cutoff-fixture", setup: "linux-web2", frontPort, innerPort,
      sessionExpiresAt, pairingSecret: secret, pairingNonceDirectory: nonces,
      async assertHeld() {
        if (advanceWhileAuthorizing === undefined) return;
        t.mock.timers.setTime(advanceWhileAuthorizing);
        advanceWhileAuthorizing = undefined;
      },
      async createRuntime(authorization) {
        const server = createServer((req, res) => {
          void authorization.authorize(req, "read").then(async () => {
            protectedRequests++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(await readFile(journalPath));
          }, () => res.writeHead(403).end());
        });
        return {
          server,
          async listen(port) {
            server.listen(port, "127.0.0.1");
            await once(server, "listening");
          },
          close: () => new Promise<void>((resolve, reject) =>
            server.close(error => error ? reject(error) : resolve())),
        };
      },
    });
    secret.fill(0);
    t.after(() => paired.close());
    const call = (path: string, init?: RequestInit) =>
      fetch(paired.origin + path, { signal: AbortSignal.timeout(2000), redirect: "manual", ...init });
    const pair = (input = code) => call("/pair", {
      method: "POST", headers: { Origin: paired.origin }, body: new URLSearchParams({ code: input }),
    });
    return { paired, call, pair, code };
  }

  const first = await boot(signedCutoff);
  const pairedAt = started + 98_500;
  t.mock.timers.setTime(pairedAt);
  const link = await first.pair();
  assert.equal(link.status, 303);
  const setCookie = link.headers.get("set-cookie");
  assert(setCookie?.includes(`Max-Age=${Math.floor((signedCutoff - pairedAt) / 1000)}`));
  assert(setCookie?.includes("HttpOnly; SameSite=Strict"));
  const cookie = setCookie?.split(";")[0];
  assert(cookie);
  assert.equal((await first.pair()).status, 403, "same launch cannot Pair twice");
  assert.equal((await readdir(nonces)).length, 1);

  const state = () => first.call("/api/web2/state", { headers: { Cookie: cookie } });
  t.mock.timers.setTime(started + 30 * 60_000 + 1);
  assert.equal((await state()).status, 200, "the old short pairing timer cannot evict this signed operation");
  t.mock.timers.setTime(signedCutoff - 1);
  const before = await state();
  assert.equal(before.status, 200);
  assert.equal(before.headers.get("x-pirate-operator-session-expires-at"), String(signedCutoff));
  assert.deepEqual(await before.json(), { phase: "unknown", controllerAuthorized: true });
  const priorRequests = protectedRequests;
  advanceWhileAuthorizing = signedCutoff;
  const expired = await state();
  assert.equal(expired.status, 410);
  assert.partialDeepStrictEqual(await expired.json(), { code: "operator_session_expired" });
  assert.equal((await first.pair()).status, 410);
  t.mock.timers.setTime(signedCutoff - 1);
  assert.equal((await state()).status, 410, "clock regression cannot restore a closed session");
  assert.equal(protectedRequests, priorRequests);
  await first.paired.close();

  t.mock.timers.setTime(signedCutoff + 1000);
  const second = await boot(signedCutoff + 600_000);
  assert.equal((await second.call("/api/web2/state", { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await second.pair(first.code)).status, 403);
  const relink = await second.pair();
  assert.equal(relink.status, 303, "a newly authenticated session can read the saved original");
  const newCookie = relink.headers.get("set-cookie")?.split(";")[0];
  assert(newCookie);
  const retained = await second.call("/api/web2/state", { headers: { Cookie: newCookie } });
  assert.equal(retained.status, 200);
  assert.deepEqual(await retained.json(), { phase: "unknown", controllerAuthorized: true });
  await second.paired.close();

  const beforeLatePair = await readdir(nonces);
  const thirdStarted = signedCutoff + 2000;
  t.mock.timers.setTime(thirdStarted);
  const third = await boot(thirdStarted + 600_000);
  t.mock.timers.setTime(thirdStarted + 300_000);
  const expiredCode = await third.pair();
  assert.equal(expiredCode.status, 410);
  assert.partialDeepStrictEqual(await expiredCode.json(), { code: "operator_pairing_expired" });
  const expiredPage = await third.call("/?setup=linux-web2");
  assert.equal(expiredPage.status, 410);
  assert.deepEqual(await readdir(nonces), beforeLatePair);
});
