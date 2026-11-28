import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { Hex } from "viem";
import { canonical, hashText } from "../packages/community/common.ts";
import { installationReadbackMessage, installationReadbackTypedData } from "../packages/community/web2-installation-readback.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { enrollmentDocument } from "../packages/community/hosted-enrollment.ts";
import { linuxWeb2DraftFrom } from "../packages/community-setup/linux-web2-profile.ts";
import { web2ProfileDocument } from "../packages/community/web2-directory.ts";
import { authenticateWeb2InstallEnrollment, authenticateWeb2InstallationAuthorization } from "../deploy/linux/web2-profile-authority.ts";
import { signRecord } from "../deploy/linux/installed-records.ts";
import {
  inspectCommunityIngress,
  retainPublicIngress,
  startPublicIngress,
  waitForCommunityIngress,
} from "../deploy/linux/public-ingress.ts";
import {
  initializeWeb2NativeOriginal,
} from "../packages/community/web2-native-business-binding.ts";
import { nativeCanonical } from "../packages/community/native-business-binding.ts";
import { communityIpfsTransport } from "../services/community-deployment-profile.ts";
import linuxApplication from "../services/linux-community.ts";
import { hostedFixture } from "./fixtures/hosted-community-enrollment.ts";
import { ingressFixture } from "./fixtures/linux-web2-installation.ts";
import { communityRuntime } from "./community-runtime.ts";

// A controller-authorized installation must be publicly readable before the
// first registration receipt exists. The registrar transport below is only a
// hostname mapping onto the real pinned-Caddy HTTPS edge; the response and its
// signature come from the actual application handler and its empty Directory.
test(
  "empty Directory installation proves itself through HTTPS before one recovered registration",
  { timeout: 120000 },
  async (t) => {
    const hosted = await hostedFixture({ challengeSeconds: 20 }, { chainId: 6343 });
    const ingress = await ingressFixture();
    const runtime = await communityRuntime();
    let edge: Awaited<ReturnType<typeof startPublicIngress>> | undefined;
    t.after(async () => {
      hosted.state.readInstallation = undefined;
      ingress.setApplicationHandler(undefined);
      if (edge) await edge.stop();
      await ingress.close();
      await runtime.dispose();
      await hosted.close();
    });

    // Align the disposable chain clock with the host wall clock. Registration
    // freshness and enrollment expiry are independently checked against both.
    hosted.state.clock = Math.floor(Date.now() / 1000);

    const input = await hosted.permissionless();
    input.config.app.origin = ingress.ingress.origin;
    input.config.feed.endpoint = ingress.ingress.origin + "/api/feed";
    const configurationBytes = new TextEncoder().encode(canonical(input.config)),
      configurationPin = await preparePin(configurationBytes, "application/json");
    hosted.pins.set(configurationPin.uri, configurationBytes);
    input.body.config = input.config;
    input.body.uri = configurationPin.uri;
    const prepared = await hosted.prepare(input);
    // A second genuine enrollment expires on the same schedule but is never
    // registered. It is the negative restart authority control below.
    const unregisteredInput = await hosted.permissionless();
    unregisteredInput.config.app.origin = ingress.ingress.origin;
    unregisteredInput.config.feed.endpoint = ingress.ingress.origin + "/api/feed";
    const unregisteredBytes = new TextEncoder().encode(canonical(unregisteredInput.config)),
      unregisteredPin = await preparePin(unregisteredBytes, "application/json");
    hosted.pins.set(unregisteredPin.uri, unregisteredBytes);
    unregisteredInput.body.config = unregisteredInput.config;
    unregisteredInput.body.uri = unregisteredPin.uri;
    const unregisteredPrepared = await hosted.prepare(unregisteredInput);
    const deployment = {
      schema: "pirate.community-deployment/2" as const,
      origin: input.config.app.origin,
      name: input.config.app.label,
      planId: hashText("empty-directory-installation").slice(2),
      postingPeriod: "empty-directory-registration",
      rpcUrl: hosted.proxyUrl,
      ipfsGateways: [hosted.proxyUrl],
      managedOrigin: "https://managed.example",
      directoryProfile: web2ProfileDocument(input.profile),
      posts: hosted.posts,
      freshness: { maxSafeBlockAgeSeconds: "600" },
    };
    const authorization = {
      enrollment: enrollmentDocument(prepared.e),
      controllerSignature: prepared.auth.controllerSignature,
    };
    const draft = linuxWeb2DraftFrom({
      schema: "pirate.linux-web2-draft/1",
      name: deployment.name,
      origin: deployment.origin,
      deployment,
      configuration: input.config,
      enrollment: {
        schema: "pirate.hosted-enrollment-status/1",
        enrollmentId: prepared.e.id,
        communityId: input.config.communityId,
        installationId: input.config.installationId,
        profile: deployment.directoryProfile,
        configurationUri: input.body.uri,
        operations: [],
      },
      authorization,
    });
    const {
      communityId: _community,
      communityKey: _key,
      installationId: _install,
      ...directoryDeployment
    } = draft.enrollment.profile;
    const installEvidence = await authenticateWeb2InstallationAuthorization(
      {
        client: hosted.client,
        deployment: directoryDeployment,
        send: communityIpfsTransport(deployment),
        now: () => BigInt(Math.floor(Date.now() / 1000)),
        maxSafeBlockAgeSeconds: 600n,
        registrar: hosted.policy.registrar,
        registrarRevision: 1n,
      },
      draft,
    );

    const keys = generateKeyPairSync("ed25519"),
      trust = {
        keyId: "empty-directory-native-fixture",
        spki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      },
      privateKey = keys.privateKey.export({ format: "der", type: "pkcs8" });
    const installationPlan = {
      schema: "pirate.linux-web2-install-plan/1" as const,
      planId: "web2-" + prepared.e.id.slice(2),
      installationId: "empty-directory-fixture-installation",
      durableScope: "a".repeat(64),
      generation: 1,
      draft,
      releaseArtifactDigest: ("0x" + "b".repeat(64)) as Hex,
      releaseSourceDigest: ("0x" + "c".repeat(64)) as Hex,
      targetDigest: "d".repeat(64),
      hostFingerprint: "fixture-installation",
      enrollment: installEvidence,
      registrationAuthority: {
        registrar: hosted.policy.registrar,
        registrarRevision: hosted.policy.registrarRevision,
        maxSafeBlockAgeSeconds: deployment.freshness.maxSafeBlockAgeSeconds,
      },
    };
    const applicationRelease = {
      schema: "pirate.complete-linux-web2-release/1" as const,
      artifactDigest: installationPlan.releaseArtifactDigest,
      sourceDigest: installationPlan.releaseSourceDigest,
      graph: {
        installationId: installationPlan.installationId,
        durableScope: installationPlan.durableScope,
        directoryRuntimeBinding: JSON.stringify(deployment),
      },
    };
    const original = {
      schema: "pirate.web2-native-application-original/1" as const,
      trust,
      durableScope: installationPlan.durableScope,
      record: signRecord(installationPlan, trust, privateKey),
      release: signRecord(applicationRelease, trust, privateKey),
    };
    const originalJson = nativeCanonical(original);

    await runtime.db.batch([
      runtime.db.prepare(`CREATE TABLE native_application_original(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        original_digest TEXT NOT NULL UNIQUE CHECK(length(original_digest)=64),
        original_json TEXT NOT NULL CHECK(json_valid(original_json))
      )`),
      runtime.db.prepare(`CREATE TABLE native_business_bindings(
        kind TEXT NOT NULL CHECK(kind IN ('session','media','learning','submission')),
        record_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        original_digest TEXT NOT NULL REFERENCES native_application_original(original_digest),
        session_hash TEXT UNIQUE REFERENCES community_sessions(session_hash) ON DELETE CASCADE,
        media_id TEXT UNIQUE REFERENCES community_media(id) ON DELETE CASCADE,
        lesson_id TEXT UNIQUE REFERENCES study_lessons(lesson_id) ON DELETE CASCADE,
        submission_id TEXT UNIQUE REFERENCES media_submissions(submission_id) ON DELETE CASCADE,
        proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
        PRIMARY KEY(kind,record_id)
      )`),
      runtime.db.prepare(`CREATE TABLE native_readback_nonces(nonce TEXT PRIMARY KEY CHECK(length(nonce)=64),expires_at INTEGER NOT NULL,
        generation INTEGER NOT NULL CHECK(generation>0),current_json TEXT NOT NULL CHECK(json_valid(current_json)))`),
      runtime.db.prepare(`CREATE TABLE native_binding_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1))`),
    ]);
    await initializeWeb2NativeOriginal(runtime.db, originalJson);
    const env = {
      DB: runtime.db,
      MEDIA: runtime.media,
      JOBS: { send: async () => {} },
      ASSETS: { fetch: async () => new Response("fixture application assets") },
      COMMUNITY_NAME: deployment.name,
      PLAN_ID: deployment.planId,
      APPLICATION_PROFILE_HASH: hashText("empty-directory-application"),
      COMMUNITY_PUBLISHER_PRIVATE_KEY: "0x" + "5".padStart(64, "0"),
      MANAGED_PROFILE_HASH: hashText("empty-directory-managed"),
      COMMUNITY_DEPLOYMENT_PROFILE_JSON: JSON.stringify(deployment),
      NATIVE_APPLICATION_ORIGINAL_JSON: originalJson,
    };

    ingress.setApplicationHandler(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = new Request("https://" + req.headers.host + req.url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: ["GET", "HEAD"].includes(req.method ?? "GET")
            ? undefined
            : Buffer.concat(chunks),
        });
        const response = await linuxApplication.fetch(request, env as never);
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        res.writeHead(response.status, headers);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
    });

    const probe = {
      enrollmentId: prepared.e.id,
      configuration: input.config,
      generation: installationPlan.generation,
      planId: installationPlan.planId,
      durableScope: installationPlan.durableScope,
      releaseArtifactDigest: installationPlan.releaseArtifactDigest,
      releaseSourceDigest: installationPlan.releaseSourceDigest,
      targetDigest: installationPlan.targetDigest,
      hostFingerprint: installationPlan.hostFingerprint,
    };
    // This is the same authenticated pre-registration probe the installer uses
    // before it starts its public edge.
    await waitForCommunityIngress(
      ingress.ingress,
      input.config.communityId,
      () => ingress.lease.assertHeld(),
      probe,
    );
    await retainPublicIngress(ingress.ingress, ingress.lease);
    await ingress.preflight();
    edge = await startPublicIngress(ingress.ingress, ingress.lease, () =>
      ingress.lease.assertHeld(),
    );
    await ingress.ready();
    // The running-state observation goes through the actual Caddy edge, not
    // the upstream shortcut, before registration is allowed.
    await inspectCommunityIngress(
      ingress.ingress,
      input.config.communityId,
      true,
      undefined,
      probe,
    );

    hosted.state.readInstallation = async (url) => {
      const selected = new URL(String(url));
      const response = await ingress.call(selected.pathname + selected.search);
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      return new Response(response.body, { status: response.status, headers });
    };
    const firstSignatures = hosted.state.registrarSignatures;
    const unavailableInstallation = hosted.state.readInstallation;
    hosted.state.readInstallation = async () =>
      Response.json(
        { error: "installation unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    assert.equal((await hosted.post("/redeem", prepared.registrationAuth)).status, 503);
    assert.equal(hosted.state.registrarSignatures, firstSignatures);
    assert.equal(hosted.state.sendCount, 0);
    hosted.state.readInstallation = unavailableInstallation;

    hosted.state.failRpc = true;
    assert.equal((await hosted.post("/redeem", prepared.registrationAuth)).status, 503);
    assert.equal(hosted.state.registrarSignatures, firstSignatures);
    assert.equal(hosted.state.sendCount, 0);
    hosted.state.failRpc = false;

    const chainReadback = async (nonce: string) =>
      ingress.call(
        `/.well-known/pirate-community.json?enrollmentId=${prepared.e.id}&communityId=${input.config.communityId}&installationId=${input.config.installationId}&nonce=${nonce}`,
        { timeout: 10000 },
      );
    await hosted.rpc("anvil_setChainId", [31337]);
    assert.equal((await chainReadback("0x" + "7".repeat(64))).status, 503);
    await hosted.rpc("anvil_setChainId", [6343]);
    const beforeFuture = await hosted.rpc("evm_snapshot");
    await hosted.rpc("anvil_setNextBlockTimestamp", [
      Math.floor(Date.now() / 1000) + 900,
    ]);
    await hosted.rpc("anvil_mine", ["0x8"]);
    const futureSafe = await hosted.client.getBlock({ blockTag: "safe" });
    assert(
      futureSafe.timestamp > BigInt(Math.floor(Date.now() / 1000)),
      `safe block is not future: ${futureSafe.number}:${futureSafe.timestamp}`,
    );
    assert.equal((await chainReadback("0x" + "8".repeat(64))).status, 503);
    assert.equal(await hosted.rpc("evm_revert", [beforeFuture]), true);

    const realInstallation = hosted.state.readInstallation;
    hosted.state.readInstallation = async (url) => {
      const requestUrl = new URL(String(url));
      const message = installationReadbackMessage({
        enrollmentId: requestUrl.searchParams.get("enrollmentId") as Hex,
        config: input.config,
        nonce: requestUrl.searchParams.get("nonce") as Hex,
        installation: { ...probe, generation: 2 },
      });
      return Response.json(
        {
          schema: "pirate.web2-installation-readback-response/1",
          configuration: input.config,
          proof: {
            schema: "pirate.web2-installation-readback/1",
            ...message,
            signature: await hosted.accounts.publisher.signTypedData(
              installationReadbackTypedData(input.config, message),
            ),
          },
        },
        { headers: { "cache-control": "no-store" } },
      );
    };
    const mismatched = await hosted.post("/redeem", prepared.registrationAuth);
    assert.equal(mismatched.status, 409);
    assert.equal(mismatched.body.error, "installation_plan_commitment_mismatch");
    assert.equal(hosted.state.registrarSignatures, firstSignatures);
    assert.equal(hosted.state.sendCount, 0);
    hosted.state.readInstallation = realInstallation;

    ingress.replaceUpstreamTrust(false);
    assert.equal((await hosted.post("/redeem", prepared.registrationAuth)).status, 503);
    assert.equal(hosted.state.registrarSignatures, firstSignatures);
    assert.equal(hosted.state.sendCount, 0);
    ingress.replaceUpstreamTrust(true);
    await ingress.ready();

    hosted.state.dropSend = 1;
    const redemption = await hosted.post("/redeem", prepared.registrationAuth);
    assert.equal(redemption.status, 200, JSON.stringify(redemption));
    assert.equal(hosted.state.registrarSignatures, firstSignatures + 1);
    assert.equal(hosted.state.sendCount, 1);
    const operation = (redemption.body.operations as Array<Record<string, unknown>>)
      .find((op) => op.kind === "registration");
    assert(operation);
    assert.equal(operation.state, "dispatched");
    const transactionHash = operation.transactionHash;
    assert.match(String(transactionHash), /^0x[0-9a-f]{64}$/);

    // A retry after the dropped broadcast acknowledgement reconciles the same
    // original registration and never signs or sends a replacement.
    await hosted.mine();
    const again = await hosted.post("/redeem", prepared.registrationAuth);
    assert.equal(again.status, 200, JSON.stringify(again));
    assert.equal(hosted.state.registrarSignatures, firstSignatures + 1);
    assert.equal(hosted.state.sendCount, 1);
    const recovered = (again.body.operations as Array<Record<string, unknown>>)
      .find((op) => op.kind === "registration");
    assert.equal(recovered?.state, "consumed");
    assert.equal(recovered?.transactionHash, transactionHash);

    const restartAuthority = {
      client: hosted.client,
      deployment: directoryDeployment,
      send: communityIpfsTransport(deployment),
      now: () => BigInt(Math.floor(Date.now() / 1000)),
      maxSafeBlockAgeSeconds: 600n,
      registrar: hosted.policy.registrar,
      registrarRevision: 1n,
    };
    const unregisteredDraft = linuxWeb2DraftFrom({
      schema: "pirate.linux-web2-draft/1",
      name: unregisteredInput.config.app.label,
      origin: deployment.origin,
      deployment: {
        ...deployment,
        directoryProfile: web2ProfileDocument(unregisteredInput.profile),
      },
      configuration: unregisteredInput.config,
      enrollment: {
        schema: "pirate.hosted-enrollment-status/1",
        enrollmentId: unregisteredPrepared.e.id,
        communityId: unregisteredInput.config.communityId,
        installationId: unregisteredInput.config.installationId,
        profile: web2ProfileDocument(unregisteredInput.profile),
        configurationUri: unregisteredInput.body.uri,
        operations: [],
      },
      authorization: {
        enrollment: enrollmentDocument(unregisteredPrepared.e),
        controllerSignature: unregisteredPrepared.auth.controllerSignature,
      },
    });
    const expiryWait = prepared.e.expiresAt * 1000 - Date.now() + 1000;
    if (expiryWait > 0) await new Promise((resolve) => setTimeout(resolve, expiryWait));
    const restartEvidence = await authenticateWeb2InstallEnrollment(restartAuthority, draft);
    assert.equal(restartEvidence.schema, "pirate.linux-web2-enrollment-evidence/1");
    assert.equal(restartEvidence.transactionHash, transactionHash);
    await assert.rejects(
      authenticateWeb2InstallEnrollment(restartAuthority, unregisteredDraft),
      /install_enrollment_authorization_expired/,
    );
    const { authorization: _authorization, ...withoutApproval } = draft;
    await assert.rejects(
      authenticateWeb2InstallEnrollment(restartAuthority, withoutApproval),
      /registration_not_confirmed/,
    );

    // After the receipt, a Directory outage is not bootstrap authority. The
    // installed application refuses the readback instead of re-signing stale
    // pre-registration evidence as current chain authority.
    hosted.state.failRpc = true;
    const outageNonce = "0x" + "9".repeat(64);
    const outageReadback = await ingress.call(
      `/.well-known/pirate-community.json?enrollmentId=${prepared.e.id}&communityId=${input.config.communityId}&installationId=${input.config.installationId}&nonce=${outageNonce}`,
      { timeout: 10000 },
    );
    assert.equal(outageReadback.status, 503);
    hosted.state.failRpc = false;

    await mkdir(".local/linux-web2-installation", { recursive: true });
    await writeFile(
      ".local/linux-web2-installation/empty-directory-registration.json",
      JSON.stringify({
        installationId: installationPlan.installationId,
        communityId: input.config.communityId,
        enrollmentId: prepared.e.id,
        transactionHash,
        registrarSignatures: hosted.state.registrarSignatures,
        sends: hosted.state.sendCount,
        recoveredWithoutReplacement: true,
        postReceiptDirectoryOutageRefused: true,
        preRegistrationHttpsReadback: true,
        outageTlsAndUnavailableChecksProducedZeroSignaturesAndBroadcasts: true,
        substitutedGenerationProducedZeroSignaturesAndBroadcasts: true,
        wrongChainAndFutureSafeBlockRefused: true,
        scope: "real application handler and pinned Caddy TLS edge on an empty disposable Directory; not full Docker installer acceptance",
      }, null, 2) + "\n",
    );
  },
);
