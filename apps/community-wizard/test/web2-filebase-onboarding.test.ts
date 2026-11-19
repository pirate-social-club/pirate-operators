import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { hexToBytes, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CommunityError, hashJson, hashText } from "../../../packages/community/common.ts";
import { assertHostedRedeemDeadline } from "../../../packages/community-setup/hosted-enrollment-client.ts";
import { addPin, preparePin } from "../../../packages/community/ipfs.ts";
import {
  enrollmentTypedData, policyHash, type Enrollment, type HostedPolicy,
} from "../../../packages/community/hosted-enrollment.ts";
import {
  CATALOG_OWNER_POLICY_HASH, CATALOG_OWNER_POLICY_VERSION,
} from "../../../packages/community/owner-policy.ts";
import { directoryV3Build, parseWeb2ProfileDocument, web2ProfileDocument } from "../../../packages/community/web2-directory.ts";
import { prepareWeb2Registration } from "../../../packages/community/web2-registration-chain.ts";
import { acquireOperation } from "../../../deploy/linux/backend-state.ts";
import { createManagedKeyClient, startManagedKeyAgent } from "../../../deploy/linux/managed-key-channel.ts";
import { createWeb2PublisherProofSigner } from "../../../deploy/linux/web2-publisher-proof.ts";
import { createWeb2RetainedPublisherIdentityReader } from "../../../deploy/linux/web2-retained-publisher-identity.ts";
import { startPairedOperator } from "../../../deploy/linux/bootstrap-local-target.ts";
import { createWeb2WizardRuntime } from "../server/web2-runtime.ts";
import { infisicalAuth } from "../server/infisical-auth.ts";
import { createWeb2FilebaseCredentials } from "../server/web2-filebase-credentials.ts";
import type { Web2SetupInputs } from "../server/web2-setup.ts";

const address = (digit: string) => ("0x" + digit.repeat(40)) as `0x${string}`;
const notice = "Disposable wizard Filebase onboarding fixture.";
const policy: HostedPolicy = {
  schema: "pirate.hosted-enrollment-policy/1", pilotId: "filebase-fixture",
  serviceOrigin: "https://admission.example",
  deployment: {
    schema: "pirate.web2-directory/3", chainId: 6343, directory: address("1"),
    directoryCodeHash: directoryV3Build.runtimeCodeHash,
    directoryAbiSha256: directoryV3Build.abiSha256,
    sourceCommit: "1".repeat(40), deploymentBlock: 1n,
  },
  registrar: address("2"), funder: address("3"), registrarRevision: "1",
  noticeSha256: hashText(notice), inviteMaxSeconds: 3600, challengeSeconds: 1800,
  maxSafeBlockAgeSeconds: 600, broadcastRetrySeconds: 10, maxBroadcastAttempts: 3,
  registrationGas: "3000000", topupGas: "50000", maxFeePerGas: "1000000",
  maxPriorityFeePerGas: "1", extraFeeCeiling: "0", extraFeeField: "none",
  globalCeiling: "1000000000000000000", communityCeiling: "100000000000000000",
  recipientCeiling: "100000000000000000", controllerInitialWei: "0", publisherInitialWei: "2000000000000000",
};

async function availablePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  assert(bound && typeof bound === "object");
  const closed = once(server, "close");
  server.close();
  await closed;
  return bound.port;
}

test("paired Web2 saves once, recovers the selected Filebase key, prepares and reopens", async t => {
  const directory = await mkdtemp(join(await realpath("/var/tmp"), "web2-filebase-"));
  const wizardDirectory = join(directory, "wizard");
  const nonceDirectory = join(directory, "nonces");
  const dist = join(directory, "dist");
  for (const path of [wizardDirectory, nonceDirectory, dist]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(dist, "index.html"), "<title>Disposable wizard fixture</title>");
  const agentDirectory = join(directory, "agent");
  await mkdir(agentDirectory, { mode: 0o700 });
  await mkdir(join(directory, "lease"), { mode: 0o700 });
  const lease = await acquireOperation(
    join(directory, "lease"), "wizard-publisher-identity", "web2-filebase-fixture",
    { purpose: "disposable enrollment" }, await readlink("/proc/self/ns/pid"),
  );
  let now = 1_800_000_000;
  const controller = privateKeyToAccount(generatePrivateKey());
  const publisherKey = generatePrivateKey();
  const publisher = privateKeyToAccount(publisherKey).address.toLowerCase() as typeof controller.address;
  const prepareInput = {
    name: "Credential fixture", origin: "https://web2.example",
    controller: controller.address.toLowerCase(), publisher,
    inviteToken: "a".repeat(64), noticeAccepted: true,
  };
  const binding = {
    keyReference: "fixture-restricted-publisher", generation: 1,
    installationId: lease.installationId, publisher,
  };
  const originalBinding = { ...binding, custodyBindingDigest: hashJson(binding) };
  const identity = { address: publisher, custodyBindingDigest: originalBinding.custodyBindingDigest };
  const request = {
    installationId: lease.installationId, operationId: lease.operationId,
    leaseIntentSha256: lease.intentRef.sha256,
    keyReference: binding.keyReference, generation: binding.generation,
  };
  const socket = join(agentDirectory, "key.sock"), authenticationKey = randomBytes(32);
  const otherSecret = Buffer.from("disposable-general-agent-secret");
  const otherSecretFile = join(agentDirectory, "general.fixture");
  await writeFile(otherSecretFile, otherSecret, { mode: 0o400 });
  const generalAgent = await startManagedKeyAgent({
    socket, directory: agentDirectory, installationId: lease.installationId,
    authenticationKey, lease,
    keys: [{ ref: "fixture-general-secret", generation: 1, path: otherSecretFile, bytes: otherSecret.length }],
    signingKeyFile: join(agentDirectory, "unused"), trust: { keyId: "fixture", spki: "unused" },
    permittedProfileDigests: new Set(), capturedRoots: [wizardDirectory],
  });
  t.after(() => generalAgent.close());
  const general = await createManagedKeyClient({ socket, installationId: lease.installationId, authenticationKey, lease });
  authenticationKey.fill(0);
  t.after(() => general.dispose());
  const restrictedKey = {
    async withKey<T>(ref: string, generation: number, use: (value: Uint8Array) => Promise<T>) {
      assert.equal(ref, binding.keyReference);
      assert.equal(generation, binding.generation);
      const bytes = hexToBytes(publisherKey);
      try { return await use(bytes); }
      finally { bytes.fill(0); }
    },
  };
  let identityCurrent = true, signingAuthorized = false;
  let identityReads = 0, foregroundKeyAttempts = 0, proofRequests = 0, signatures = 0;
  const reader = createWeb2RetainedPublisherIdentityReader({
    lease, original: originalBinding, keys: restrictedKey,
    async readCurrentBinding() {
      return identityCurrent ? originalBinding : { ...originalBinding, generation: 2 };
    },
  });
  const ownerSigner = createWeb2PublisherProofSigner({
    ...binding, key: restrictedKey, lease, policy, now: () => now,
    async currentBinding() { return binding; },
  });
  const legacySelection = createWeb2PublisherProofSigner({
    ...binding, key: general, lease, policy, now: () => now,
    async currentBinding() { return binding; },
  });
  let enrollment: Enrollment | undefined;
  let redeemRequests = 0, statusRequests = 0, topups = 0;
  let nextRedeemAdmission: { enter(): void; wait: Promise<void> } | undefined;
  let statusUnavailable = false, registrationSeen = false, withdrawIdentityDuringStatus = false;
  const scope = {
    siteUrl: "https://infisical.invalid", projectId: "00000000-0000-0000-0000-000000000001",
    environment: "dev", secretPath: "/communities/filebase-fixture",
  };
  const secretName = "FILEBASE_IPFS_TOKEN";
  const secret = "disposable-filebase-fixture-bearer";
  const authToken = "fixture." + Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url") + ".signature";
  let loggedIn = false, scopeAllowed = false, activationAllowed = false;
  const auth = infisicalAuth({ INFISICAL_SITE_URL: scope.siteUrl }, async args => {
    if (args[0] === "--version") return "infisical fixture";
    if (!loggedIn) throw Error("CLI detail " + authToken);
    return args[0] === "login" ? JSON.stringify({ sessions: [{
      principalType: "user", status: "authenticated", domain: scope.siteUrl,
      profile: "fixture", verification: { state: "verified" },
    }] }) : authToken;
  });
  let stored: string | undefined;
  let writes = 0, pinAdds = 0, hostedPrepares = 0, reads = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== scope.siteUrl) return originalFetch(input, init);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + authToken);
    const method = init?.method ?? "GET";
    const payload = method === "GET" ? Object.fromEntries(url.searchParams) : JSON.parse(String(init?.body));
    assert.equal(payload.workspaceId, scope.projectId);
    assert.equal(payload.environment, scope.environment);
    if (!scopeAllowed) return Response.json({ message: "scope refusal " + authToken }, { status: 403 });
    if (url.pathname === "/api/v1/folders") {
      assert.equal(method, "GET");
      assert.ok(payload.path === "/" || payload.path === "/communities");
      return Response.json({ folders: [{ name: payload.path === "/" ? "communities" : "filebase-fixture" }] });
    }
    assert.equal(payload.secretPath, scope.secretPath);
    if (method === "GET" && url.pathname === "/api/v3/secrets/raw") {
      assert.equal(payload.viewSecretValue, "false");
      assert.equal(payload.include_imports, "false");
      return Response.json({ secrets: stored ? [{ secretKey: secretName }] : [] });
    }
    assert.ok(url.pathname.endsWith("/" + secretName));
    if (method === "GET") {
      reads++;
      assert.equal(payload.includeImports, "false");
      assert.equal(payload.expandSecretReferences, "false");
      return stored
        ? Response.json({ secret: { secretKey: secretName, secretValue: stored } })
        : Response.json({}, { status: 404 });
    }
    assert.equal(method, "POST");
    assert.equal(payload.secretValue, secret);
    assert.equal(stored, undefined);
    writes++;
    stored = secret;
    // The vault commits the create while the acknowledgement is lost.
    return Response.json({ message: "uncertain " + secret }, { status: 502 });
  };

  let channelValue: string | undefined, observedUri: string | undefined;
  const recognition = {
    schema: "pirate.recognition-profile/1" as const,
    namespace: hashText("fixture recognition"),
    origin: "https://recognition.example", signer: address("7"),
    providerBindingSha256: hashText("fixture recognition binding"),
  };
  const config: Web2SetupInputs["configuration"] = {
    operatorPayments: address("0"), signingKeyId: "filebase-fixture",
    policies: { admission: { version: CATALOG_OWNER_POLICY_VERSION, sha256: CATALOG_OWNER_POLICY_HASH },
      moderationSigner: address("2"), recognition: { ...recognition, sha256: hashJson(recognition) } },
  };
  let paired: Awaited<ReturnType<typeof startPairedOperator>> | undefined;
  async function stop() {
    await paired?.close();
    paired = undefined;
    channelValue = undefined;
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  async function boot(pairingOnly = false) {
    let draftAuthority: (() => void) | undefined;
    const filebaseCredentials = createWeb2FilebaseCredentials({
      scope, secretName, auth,
      async bind(bytes) {
        if (!activationAllowed) throw Error("fixture binding unavailable " + secret);
        channelValue = new TextDecoder().decode(bytes);
      },
    });
    const inputs: Web2SetupInputs = {
      policy, notice, configuration: config, hostInstallationId: "web2-filebase-fixture", filebaseCredentials,
      clock: () => now,
      publisherIdentity: {
        async selected() {
          identityReads++;
          return reader.read(request);
        },
      },
      publisherProof: {
        async selected() {
          foregroundKeyAttempts++;
          return legacySelection.selected();
        },
        async signEnrollment(value) {
          proofRequests++;
          if (!signingAuthorized) throw new CommunityError("publisher_custody_binding_unavailable", 503);
          const proof = await ownerSigner.signEnrollment(value);
          signatures++;
          return proof;
        },
      },
      deployment: {
        postingPeriod: "fixture", rpcUrl: "https://rpc.example", ipfsGateways: ["https://ipfs.filebase.io"],
        managedOrigin: "https://managed.example", posts: { address: address("6"),
          runtimeCodeHash: hashText("posts code"), deploymentBlock: "1" },
        freshness: { maxSafeBlockAgeSeconds: "600" },
      },
      async pinConfiguration({ bytes, uri }) {
        assert.equal(channelValue, secret);
        const pin = await preparePin(bytes, "application/json");
        assert.equal(pin.uri, uri);
        const cid = uri.slice(7);
        await addPin(pin, bytes, channelValue, async () => {}, async request => {
          const url = new URL(request.url);
          if (url.origin === "https://rpc.filebase.io") {
            assert.equal(request.headers.get("authorization"), "Bearer " + secret);
            if (url.pathname === "/api/v0/add") {
              pinAdds++;
              return Response.json({ Hash: cid });
            }
            assert.equal(url.pathname, "/api/v0/pin/ls");
            assert.equal(url.searchParams.get("arg"), cid);
            return Response.json({ Keys: { [cid]: { Type: "recursive" } } });
          }
          assert.equal(request.headers.get("authorization"), null);
          assert.ok(url.pathname.endsWith("/" + cid));
          return new Response(new Uint8Array(bytes));
        });
        observedUri = uri;
      },
      async transport(input, init, context) {
        const payload = JSON.parse(String(init?.body));
        const url = new URL(String(input));
        assert.equal(url.origin, policy.serviceOrigin);
        if (url.pathname !== "/redeem") assert.equal(context, undefined);
        if (["/redeem", "/status", "/initial-topup"].includes(url.pathname)) {
          assert(enrollment);
          assert.equal(payload.enrollmentId, enrollment.id);
          const typed = enrollmentTypedData(enrollment);
          assert(await verifyTypedData({ ...typed, address: controller.address, signature: payload.controllerSignature }));
          if (url.pathname === "/redeem") {
            assert.deepEqual(Object.keys(payload).sort(), ["controllerSignature", "enrollmentId"]);
            assert.equal(context?.redeemExpiresAt, enrollment.expiresAt);
            const gate = nextRedeemAdmission;
            if (gate) {
              nextRedeemAdmission = undefined;
              gate.enter();
              await gate.wait;
            }
            assertHostedRedeemDeadline(context?.redeemExpiresAt, now);
            redeemRequests++;
            throw Error("disposable lost redeem acknowledgement");
          }
          if (url.pathname === "/status") {
            statusRequests++;
            if (statusUnavailable) throw Error("disposable status unavailable");
            if (withdrawIdentityDuringStatus) identityCurrent = false;
          }
          const topup = url.pathname === "/initial-topup";
          if (topup) {
            assert(registrationSeen);
            assert.equal(payload.recipientProofs.length, 1);
            const proof = payload.recipientProofs[0];
            assert.equal(proof.recipient, publisher);
            assert(await verifyTypedData({ ...typed, address: publisher, signature: proof.signature }));
            topups++;
          }
          return Response.json({
            schema: "pirate.hosted-enrollment-status/1", enrollmentId: enrollment.id,
            communityId: enrollment.plan.profile.communityId, installationId: enrollment.plan.profile.installationId,
            profile: web2ProfileDocument(enrollment.plan.profile), configurationUri: enrollment.plan.uri,
            operations: [
              ...(registrationSeen ? [
                { kind: "registration", state: "consumed", transactionHash: hashText("registration fixture"), receipt: null },
              ] : []),
              ...(topup ? [{ kind: "topup", state: "consumed", transactionHash: hashText("topup fixture"), receipt: null }] : []),
            ],
          });
        }
        assert.equal(url.pathname, "/prepare");
        hostedPrepares++;
        assert.equal(payload.uri, observedUri);
        assert.ok(!String(init?.body).includes(secret));
        const profile = parseWeb2ProfileDocument(payload.profile);
        const plan = prepareWeb2Registration(profile, payload.config, payload.uri, policy.registrar, 1n);
        const inviteId = hashText("fixture invite"), id = hashText("hosted-enrollment:" + inviteId);
        enrollment = {
          schema: "pirate.hosted-enrollment/1" as const, id, inviteId,
          allowanceId: hashText("fixture allowance"), expiresAt: now + 60,
          noticeSha256: policy.noticeSha256, policyHash: policyHash(policy), plan,
        };
        return new Response(JSON.stringify({
          schema: enrollment.schema, enrollmentId: id, expiresAt: enrollment.expiresAt,
          typedData: enrollmentTypedData(enrollment),
        }, (_key, value) => typeof value === "bigint" ? String(value) : value));
      },
    };
    const pairing = randomBytes(32);
    const code = pairing.toString("base64url");
    const frontPort = await availablePort();
    let innerPort = await availablePort();
    while (innerPort === frontPort) innerPort = await availablePort();
    try {
      paired = await startPairedOperator({
        installationId: "web2-filebase-fixture", setup: "linux-web2",
        frontPort, innerPort, pairingSecret: pairing, pairingNonceDirectory: nonceDirectory,
        ...(pairingOnly ? { readOnly: true as const } : {}),
        async assertHeld() {},
        createRuntime: (authorization) => createWeb2WizardRuntime({
          ...inputs, directory: wizardDirectory, dist,
          authorization: {
            async authorize(req, action) {
              await authorization.authorize(req, action);
              if (req.url === "/api/web2/draft" && action === "write") draftAuthority?.();
            },
          },
          ...(pairingOnly ? { pairingOnly: true as const } : {}),
          custody: { async assertHeld() {} },
        }),
      });
    } finally { pairing.fill(0); }
    const origin = paired.origin;
    const pairResponse = await fetch(origin + "/pair", {
      method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ code }),
    });
    assert.equal(pairResponse.status, 303);
    const cookie = pairResponse.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    const state = () => fetch(origin + "/api/web2/state", {
      headers: { cookie },
    }).then(response => response.json());
    async function send(action: string, value: Record<string, unknown>, paired = true) {
      const before = await state();
      const response = await fetch(origin + "/api/web2/" + action, {
        method: "POST",
        headers: { origin, "x-wizard-token": before.csrf,
          ...(paired ? { cookie } : {}), "content-type": "application/json" },
        body: JSON.stringify({ revision: before.view.revision, ...value }),
      });
      const raw = await response.text();
      assert.ok(!raw.includes(secret) && !raw.includes(authToken));
      return { status: response.status, json: JSON.parse(raw) };
    }
    const page = () => fetch(origin + "/?setup=linux-web2", { headers: { cookie } });
    async function draft(
      write?: { revision: number; fields: Record<string, unknown> },
      { paired = true, csrf = true } = {},
    ) {
      const current = await state();
      return fetch(origin + "/api/web2/draft", {
        method: "POST",
        body: JSON.stringify(write ?? { action: "read" }),
        headers: {
          ...(paired ? { cookie } : {}),
          origin,
          "content-type": "application/json",
          ...(csrf ? { "x-wizard-token": current.csrf } : {}),
        },
      });
    }
    async function interruptedDraft(
      input: Record<string, unknown>,
      boundary: "revoke" | "expire",
    ) {
      const { csrf } = await state();
      let observeAdmission!: () => void;
      const admitted = new Promise<void>(resolve => { observeAdmission = resolve; });
      let revoked = false, authorityClock = 99;
      draftAuthority = () => {
        if (revoked || authorityClock >= 100) throw new CommunityError("fixture_draft_authority_ended", 403);
        observeAdmission();
      };
      let request!: ReturnType<typeof httpRequest>;
      const reply = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        request = httpRequest(origin + "/api/web2/draft", {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json", "x-wizard-token": csrf },
        }, response => {
          let received = "";
          response.setEncoding("utf8");
          response.on("data", value => { received += value; });
          response.on("end", () => resolve({ status: response.statusCode, body: received }));
          response.on("error", reject);
        });
        request.on("error", reject);
        request.setTimeout(3000, () => request.destroy(Error("draft fixture request timed out")));
      });
      const content = JSON.stringify(input);
      request.write(content.slice(0, -1));
      try {
        await Promise.race([
          admitted,
          reply.then(() => assert.fail("draft replied before its body and first authorization were complete")),
        ]);
        revoked = boundary === "revoke";
        authorityClock = boundary === "expire" ? 100 : 99;
        request.end(content.slice(-1));
        return await reply;
      } finally {
        draftAuthority = undefined;
        request.destroy();
      }
    }
    return { state, send, page, draft, interruptedDraft };
  }

  const preview = await boot(true);
  assert.equal((await preview.page()).status, 200);
  assert.equal((await preview.state()).view.pairingOnly, true);
  assert.equal((await preview.send("prepare", prepareInput)).json.code, "web2_pairing_only");
  assert.equal((await preview.draft()).status, 403);
  assert.equal((await preview.draft({ revision: 0, fields: {} })).status, 403);
  assert.deepEqual(await readdir(wizardDirectory), []);
  assert.equal(writes + pinAdds + hostedPrepares + proofRequests, 0);
  await stop();
  const first = await boot();
  assert.equal((await first.page()).status, 200);
  assert.deepEqual((await first.state()).view.serverPublisher, identity);
  assert.equal(identityReads, 2);
  assert.equal(foregroundKeyAttempts + proofRequests + signatures, 0);
  await general.withSecret("fixture-general-secret", 1, async value => assert.deepEqual(Buffer.from(value), otherSecret));
  await assert.rejects(general.withKey(binding.keyReference, binding.generation, async () => assert.fail("general agent exposed publisher")));
  const original = join(wizardDirectory, "web2-wizard-original.json");
  await assert.rejects(readFile(original), { code: "ENOENT" });
  const fields = {
    name: prepareInput.name, origin: prepareInput.origin,
    controller: prepareInput.controller, owner: prepareInput.controller,
    invite: prepareInput.inviteToken,
  };
  assert.equal((await first.draft(undefined, { paired: false })).status, 403);
  assert.equal((await first.draft(undefined, { csrf: false })).status, 403);
  assert.equal((await first.draft({ revision: 0, fields }, { csrf: false })).status, 403);
  assert.deepEqual(await (await first.draft()).json(), { revision: 0, fields: null });
  const rejectedAttestation = await first.draft({ revision: 0, fields: { ...fields, noticeAccepted: true } });
  assert.equal(rejectedAttestation.status, 400);
  const saved = await first.draft({ revision: 0, fields });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.deepEqual(await saved.json(), { revision: 1, fields });
  assert.deepEqual(await (await first.draft({ revision: 0, fields })).json(), { revision: 1, fields });
  assert.equal((await first.draft({ revision: 0, fields: { ...fields, name: "Stale tab" } })).status, 409);
  assert.deepEqual(await (await first.draft()).json(), { revision: 1, fields });
  const revokedRestore = await first.interruptedDraft({ action: "read" }, "revoke");
  const expiredSave = await first.interruptedDraft({ revision: 1, fields: { ...fields, name: "Late draft" } }, "expire");
  assert.deepEqual([revokedRestore.status, expiredSave.status], [403, 403]);
  assert(!revokedRestore.body.includes(prepareInput.inviteToken));
  assert(!expiredSave.body.includes(prepareInput.inviteToken));
  assert.deepEqual(await (await first.draft()).json(), { revision: 1, fields });
  assert(!JSON.stringify(await first.state()).includes(prepareInput.inviteToken));
  await assert.rejects(readFile(original), { code: "ENOENT" });
  assert.equal((await first.send("filebase-save", { token: secret }, false)).status, 403);
  assert.equal((await first.send("filebase-save", { token: secret })).json.code, "web2_filebase_scope_required");
  assert.equal((await first.send("filebase-check", {})).status, 409);
  loggedIn = true;
  assert.equal((await first.send("filebase-check", {})).status, 409);
  scopeAllowed = true;
  assert.equal((await first.send("filebase-check", {})).status, 200);
  assert.equal((await first.send("prepare", prepareInput)).json.code, "web2_filebase_credential_required");
  await assert.rejects(readFile(original), { code: "ENOENT" });
  assert.equal(pinAdds + hostedPrepares + writes, 0);
  assert.equal((await first.send("filebase-save", { token: secret })).json.code, "web2_filebase_binding_unavailable");
  assert.equal(writes, 1);
  activationAllowed = true;
  const recovered = await first.send("filebase-check", {});
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.view.filebase.status, "ready");
  assert.equal((await first.send("filebase-save", { token: "different-fixture-token" })).json.code,
    "web2_filebase_credential_conflict");
  assert.equal(writes, 1);
  identityCurrent = false;
  assert.equal((await first.send("prepare", prepareInput)).json.code, "retained_publisher_custody_binding_changed");
  assert.equal(hostedPrepares + pinAdds + proofRequests, 0);
  identityCurrent = true;
  const prepared = await first.send("prepare", prepareInput);
  assert.equal(prepared.status, 200, JSON.stringify(prepared));
  assert.equal(prepared.json.view.phase, "prepared");
  assert.deepEqual(await (await first.draft()).json(), { revision: 1, fields: { ...fields, invite: "" } });
  assert.equal((await first.draft({ revision: 1, fields })).status, 409);
  assert.equal(pinAdds, 1);
  assert.equal(hostedPrepares, 1);
  assert.equal(foregroundKeyAttempts + proofRequests + signatures, 0);
  assert.equal((await first.send("topup", {})).json.code, "web2_controller_proof_required");
  assert.equal(proofRequests, 0);
  assert(enrollment);
  const controllerProof = await controller.signTypedData(enrollmentTypedData(enrollment));
  const unknown = await first.send("redeem", { signature: controllerProof });
  assert.equal(unknown.json.view.phase, "unknown");
  assert.deepEqual(unknown.json.view.selection, prepared.json.view.selection);
  assert.equal(redeemRequests, 1);
  assert.equal((await first.send("topup", { proofs: [{ recipient: publisher, signature: controllerProof }] })).json.code,
    "web2_browser_publisher_proof_refused");
  assert.equal(statusRequests, 0);
  statusUnavailable = true;
  const unavailable = await first.send("topup", {});
  assert.equal(proofRequests, 0, "unknown redeem and unavailable hosted status must not request a publisher proof");
  assert.equal(unavailable.json.view.phase, "unknown");
  assert.equal(statusRequests, 1);
  assert.equal(proofRequests + signatures + topups, 0);
  statusUnavailable = false;
  const pending = await first.send("topup", {});
  assert.equal(pending.json.code, "safe_registration_required");
  assert.equal(statusRequests, 2);
  assert.equal(proofRequests + signatures + topups, 0);
  const retained = JSON.parse(await readFile(original, "utf8"));
  assert.equal(retained.pending, "redeem");
  assert.equal(retained.controllerSignature, controllerProof);
  assert.deepEqual((await first.state()).view.selection, prepared.json.view.selection);
  const liveClock = now;
  now = enrollment.expiresAt;
  try {
    const late = await first.send("redeem", {});
    assert.equal(late.status, 410);
    assert.equal(late.json.code, "web2_registration_challenge_expired");
    assert.equal(prepared.json.view.registrationExpiresAt, enrollment.expiresAt);
    assert.equal(redeemRequests, 1, "the expired retained proof cannot reach the hosted Redeem route");
    const afterExpiry = JSON.parse(await readFile(original, "utf8"));
    assert.equal(afterExpiry.controllerSignature, controllerProof);
    assert.deepEqual(afterExpiry.prepared, retained.prepared);
    const reconciled = await first.send("reconcile", {});
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.json.view.controllerAuthorized, true);
    assert.deepEqual(reconciled.json.view.enrollment.operations, []);

    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { resume = resolve; });
    nextRedeemAdmission = { enter: entered, wait: held };
    now = enrollment.expiresAt - 1;
    const inFlight = first.send("redeem", {});
    try {
      await Promise.race([
        waiting,
        inFlight.then(() => assert.fail("Redeem did not reach the live admission fixture")),
      ]);
    } finally {
      now = enrollment.expiresAt;
      resume();
    }
    const crossedCutoff = await inFlight;
    assert.equal(crossedCutoff.status, 410);
    assert.equal(crossedCutoff.json.code, "web2_registration_challenge_expired");
    assert.equal(redeemRequests, 1, "expiry during admission must stop before the hosted fetch");
    const afterAdmission = JSON.parse(await readFile(original, "utf8"));
    assert.equal(afterAdmission.controllerSignature, controllerProof);
    assert.deepEqual(afterAdmission.prepared, retained.prepared);
  } finally {
    now = liveClock;
  }
  registrationSeen = true;
  withdrawIdentityDuringStatus = true;
  assert.equal((await first.send("topup", {})).json.code, "retained_publisher_custody_binding_changed");
  assert.equal(statusRequests, 4);
  assert.equal(proofRequests + signatures + topups, 0);
  identityCurrent = true;
  withdrawIdentityDuringStatus = false;
  assert.equal((await first.send("topup", {})).json.code, "publisher_custody_binding_unavailable");
  assert.equal(proofRequests, 1);
  assert.equal(signatures + topups, 0);
  signingAuthorized = true;
  const funded = await first.send("topup", {});
  assert.equal(funded.status, 200, JSON.stringify(funded));
  assert.equal(funded.json.view.phase, "funded");
  assert.equal(signatures, 1);
  assert.equal(topups, 1);
  assert.equal(redeemRequests, 1);
  assert.equal(statusRequests, 6);
  assert.deepEqual(funded.json.view.selection, prepared.json.view.selection);
  assert.equal(foregroundKeyAttempts, 0);
  await stop();
  assert.equal(channelValue, undefined);
  const reopened = await boot();
  const latest = await reopened.state();
  assert.equal(latest.view.filebase.status, "ready");
  assert.equal(latest.view.phase, "funded");
  assert.deepEqual(latest.view.serverPublisher, identity);
  assert.equal(foregroundKeyAttempts, 0);
  assert.equal(signatures, 1);
  assert.equal(latest.view.selection.configurationUri, observedUri);
  assert.equal(channelValue, secret);
  assert.equal(writes, 1);
  assert.equal(pinAdds, 1);
  assert.ok(reads >= 3);
  await stop();
  const snapshot = async () => Promise.all((await readdir(wizardDirectory)).sort().map(async name => {
    const path = join(wizardDirectory, name);
    const { ino, size, mtimeMs } = await stat(path);
    return { name, ino, size, mtimeMs, bytes: await readFile(path) };
  }));
  const retainedFiles = await snapshot();
  const retainedReads = reads;
  const retainedPreview = await boot(true);
  assert.equal((await retainedPreview.page()).status, 200);
  const view = (await retainedPreview.state()).view;
  assert.equal(view.pairingOnly, true);
  assert.equal(view.phase, "funded");
  assert.deepEqual(view.selection, latest.view.selection);
  assert.equal(channelValue, undefined);
  for (const action of [
    "prepare", "resume-prepare", "redeem", "topup", "reconcile", "filebase-check", "filebase-save",
    "publishing-prepare", "publishing-authorize", "publishing-attach", "publishing-reconcile",
    "installation-prepare", "install", "installation-status",
  ]) {
    const denied = await retainedPreview.send(action, action === "prepare" ? prepareInput : {});
    assert.equal(denied.status, 403, action);
    assert.equal(denied.json.code, "web2_pairing_only", action);
  }
  await stop();
  assert.deepEqual(await snapshot(), retainedFiles);
  assert.equal(reads, retainedReads);
  assert.equal(hostedPrepares, 1);
  assert.equal(redeemRequests, 1);
  assert.equal(statusRequests, 6);
  assert.equal(topups, 1);
  assert.equal(signatures, 1);
  assert.equal(pinAdds, 1);
  assert.equal(writes, 1);
  for (const name of await readdir(wizardDirectory))
    assert.doesNotMatch(await readFile(join(wizardDirectory, name), "utf8"), /disposable-filebase-fixture-bearer|\\.signature/);
});
