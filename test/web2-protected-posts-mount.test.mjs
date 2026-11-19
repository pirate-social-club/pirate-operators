import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { canonical, hashJson } from "../packages/community/common.ts";
import { nativeDigest } from "../packages/community/native-business-binding.ts";
import { CATALOG_OWNER_POLICY_HASH, CATALOG_OWNER_POLICY_VERSION } from "../packages/community/owner-policy.ts";
import { renderFullNativeConfig } from "../deploy/linux/full-native-config.ts";
import { signRecord } from "../deploy/linux/installed-records.ts";
import { startWeb2NativeActivityHost } from "../deploy/linux/web2-native-activity-host.ts";
import { createProtectedPostsMountLifetime, validateProtectedPostsTarget } from "../deploy/linux/web2-protected-posts-mount.ts";
import { createWeb2SetupLifetime } from "../deploy/linux/web2-service.ts";
import { acquireWeb2ServiceControl } from "../deploy/linux/web2-service-lease.ts";

test("revision-one Posts mounts before serve and reopens the same original under a fresh foreground lease", async t => {
  const root = await mkdtemp("/var/tmp/web2-posts-mount-");
  const dispose = [];
  t.after(async () => {
    try { for (const close of dispose.reverse()) await close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const directory = join(root, "posts-transport");
  const socket = join(root, "activity-transport", "host.sock");
  const configurationDirectory = join(root, "configuration");
  for (const path of [directory, join(root, "activity-transport"), configurationDirectory, join(root, "control")])
    await mkdir(path, { mode: 0o700 });
  const selectionPath = join(directory, "selection.json");
  const forwardPath = join(directory, "owner.auth");
  const reversePath = join(directory, "primary.auth");
  const installationId = "disposable-protected-posts";
  const hex = n => `0x${n.repeat(64)}`;
  const addr = n => `0x${n.repeat(40)}`;
  const origin = "https://owner.fixture.invalid";
  const policy = { version: CATALOG_OWNER_POLICY_VERSION, sha256: CATALOG_OWNER_POLICY_HASH };
  const ownerWallet = addr("3");
  const config = { configurationRevision: 1, chainId: 6343, installationId: hex("1") };
  const grantBody = {
    schema: "pirate.owner-publishing-grant/1", communityId: hex("2"), communityOrigin: origin,
    ownerWallet, policy, destination: { chainId: 6343, publisher: addr("4"), postsContract: addr("5") },
    validFrom: 1, expiresAt: 99, limits: { songs: 1, pinAdds: 3, pinBytes: "4096", recognitionRequests: 1, postFeeWei: "50" },
  };
  const grant = { ...grantBody, sha256: hashJson(grantBody) };
  const selectedGrant = {
    schema: "pirate.web2-configured-owner-grant/1",
    scope: { communityId: grant.communityId, origin, ownerWallet, policy, ...grant.destination },
    grant, admissionReference: "disposable-owner-grant",
  };
  const attachment = {
    schema: "pirate.web2-publishing-attachment/1",
    selection: { ...selectedGrant, selectionDigest: hashJson(selectedGrant) },
    authorization: { authorization: { schema: "pirate.owner-publishing-authorization/2",
      communityId: grant.communityId, ownerWallet, policy, validFrom: 1, expiresAt: 99 }, signature: "0x12" },
    custodyBindingDigest: hex("6"),
  };
  const attachmentDigest = hashJson(attachment);
  const keys = generateKeyPairSync("ed25519");
  const trust = { keyId: "disposable-install", spki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const key = keys.privateKey.export({ format: "der", type: "pkcs8" });
  const releaseBody = { schema: "pirate.complete-linux-web2-release/1", artifactDigest: hex("7"), sourceDigest: hex("8"),
    publishingAttachmentDigest: attachmentDigest, graph: { installationId, durableScope: "9".repeat(64), directoryRuntimeBinding: "{}" } };
  // The fixture crosses the post-authorization installer seam. The disposable
  // plan omits unrelated enrollment and Docker fields.
  const original = { schema: "pirate.web2-native-application-original/1", trust, durableScope: releaseBody.graph.durableScope,
    release: signRecord(releaseBody, trust, key),
    record: signRecord({ installationId, publishingAttachmentDigest: attachmentDigest, draft: { configuration: config } }, trust, key) };
  const transportRef = "disposable-posts";
  const selection = signRecord({
    schema: "pirate.web2-protected-posts-mount/1", transportRef, hostInstallationId: installationId,
    installationId: config.installationId, applicationOriginalSha256: `0x${nativeDigest(original)}`,
    releaseSha256: hashJson(releaseBody), configurationSha256: hashJson(config), grantSha256: grant.sha256,
  }, trust, key);
  key.fill(0);
  const graph = { ...releaseBody.graph, releaseRoot: "/disposable-release", schemaPath: "/disposable-release/workerd.capnp",
    stateRoots: { configuration: configurationDirectory, database: "/db", objects: "/objects", jobs: "/jobs",
      scheduler: "/scheduler", readiness: "/readiness" }, socket: "/run/disposable-control.sock",
    applicationBindings: [{ name: "WEB2_PUBLISHING_ATTACHMENT_JSON", text: canonical({ ...attachment, digest: attachmentDigest }) }],
    secretBindings: [], actors: [], requiredRoles: ["application"], queueConfiguration: { scope: original.durableScope },
    maintenanceConfiguration: { scope: original.durableScope }, allowedOrigins: [], listenAddress: "127.0.0.1:8443",
    tls: { keyFile: "/disposable/key", certificateFile: "/disposable/cert" }, migrationPlanFile: "/disposable/migrations",
    probePlanFile: "/disposable/probe", readbackKeyFile: "/disposable/readback",
    protectedFirstSong: { schema: "pirate.web2-protected-posts-transport/1", directory, transportRef } };
  const target = { stateRoot: root, containers: [{ key: "application",
    mounts: [directory, join(root, "activity-transport")].map(path => ({ source: path, target: path, readOnly: true })) }] };
  assert.equal(validateProtectedPostsTarget(graph, target).socket, socket);
  assert.throws(() => validateProtectedPostsTarget(graph, { ...target, containers: [
    ...target.containers, { ...target.containers[0], key: "store" },
  ] }), /protected_posts_read_only_mount_required/);
  const snapshot = { selection: "/run/probe/selection.json", forward: "/run/probe/owner.auth", reverse: "/run/probe/primary.auth" };
  const rendered = renderFullNativeConfig(graph, "serve", "1".repeat(64), "/run/probe/original.json", graph.socket, false,
    undefined, undefined, snapshot);
  assert.match(rendered, /WEB2_PROTECTED_POSTS_OWNER/);
  assert.ok(rendered.includes(`unix:${socket}`));
  assert.doesNotMatch(renderFullNativeConfig(graph, "initialize", undefined, "/run/probe/original.json"),
    /WEB2_PROTECTED_POSTS_(OWNER|SELECTION|FORWARD|REVERSE)/);
  assert.throws(() => renderFullNativeConfig({ ...graph, secretBindings: [
    { name: "COMMUNITY_PUBLISHER_PRIVATE_KEY", path: "/disposable/raw-key" },
  ] }, "serve", "1".repeat(64)), /protected_posts_legacy_binding_refused/);

  const events = [];
  const requestPath = "/publication/v1/posts-observation";
  const forward = "a".repeat(64);
  const reverse = "b".repeat(64);
  let allowed = true;
  let pending;
  function call(path, role = forward) {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: socket, path, method: "POST",
        headers: { authorization: "Bearer " + role, "content-length": "2" } }, res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end("{}");
    });
  }
  const input = { original, graph, async assertCurrent() { assert(allowed, "disposable_enrollment_withdrawn"); } };
  async function foreground(run) {
    const control = await acquireWeb2ServiceControl(join(root, "control"), installationId);
    const { lease } = control;
    const mount = createProtectedPostsMountLifetime({
      async open(value) {
        events.push(["open", run, value.startRetained, nativeDigest(value.original)]);
        if (!value.startRetained) {
          for (const [path, bytes] of [[selectionPath, canonical(selection)], [forwardPath, forward], [reversePath, reverse]])
            await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        }
        return { lease, socket, async close() { events.push(["close", run]); },
          async fetch(request) {
            assert.equal(request.url, "https://publication.internal" + requestPath);
            if (request.headers.get("authorization") !== "Bearer " + forward)
              return new Response(null, { status: 403 });
            if (pending) {
              pending.entered.resolve();
              await pending.release.promise;
            }
            return new Response(null, { status: 200 });
          } };
      },
    }, lease);
    const host = await startWeb2NativeActivityHost({
      ingress: { upstream: "https://127.0.0.1:8443", origin },
      stateRoot: root, lease, deferredProtectedPosts: mount.route,
    });
    const lifetime = createWeb2SetupLifetime();
    const close = async () => {
      await lifetime.shutdown(() => host.close(), () => host.drainProtectedPosts());
      await mount.close();
      await control.closeControl();
    };
    dispose.push(close);
    return { mount, lease, lifetime, close };
  }
  const first = await foreground("first");
  assert.equal(await call(requestPath), 503);
  assert.equal(await call("/transcribe"), 404);
  assert.deepEqual(events, []);
  await assert.rejects(first.lifetime.exclusive(() => first.mount.open({ ...input, startRetained: true })),
    /protected_posts_retained_mount_missing/);
  allowed = false;
  await assert.rejects(first.lifetime.exclusive(() => first.mount.open({ ...input, startRetained: false })),
    /disposable_enrollment_withdrawn/);
  assert.deepEqual(events, []);
  allowed = true;
  await first.lifetime.exclusive(() => first.mount.open({ ...input, startRetained: false }));
  assert.equal(await call(requestPath, reverse), 403);
  const originalBytes = await readFile(selectionPath, "utf8");
  pending = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const inFlight = call(requestPath);
  await pending.entered.promise;
  const shutdown = first.close();
  assert.equal(await call(requestPath), 429);
  assert.deepEqual(events.map(event => event[0]), ["open"]);
  pending.release.resolve();
  assert.equal(await inFlight, 200);
  pending = undefined;
  await shutdown;

  const reopened = await foreground("reopen");
  assert.notEqual(reopened.lease.operationId, first.lease.operationId);
  assert.equal(await call(requestPath), 503);
  await reopened.lifetime.exclusive(() => reopened.mount.open({ ...input, startRetained: true }));
  assert.equal(await call(requestPath), 200);
  assert.equal(await readFile(selectionPath, "utf8"), originalBytes);
  await reopened.close();

  const changed = await foreground("changed");
  await writeFile(reversePath, "c".repeat(64));
  await assert.rejects(changed.lifetime.exclusive(() => changed.mount.open({ ...input, startRetained: true })),
    /protected_posts_retained_mount_changed/);
  assert.equal(await call(requestPath), 503);
  await changed.close();
  assert.deepEqual(events, [
    ["open", "first", false, nativeDigest(original)], ["close", "first"],
    ["open", "reopen", true, nativeDigest(original)], ["close", "reopen"],
  ]);
});
