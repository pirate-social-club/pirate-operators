// New integration composition; reuses existing local chain/HTTP/D1 helpers.
// Public test keys are disposable-chain-only. SOURCE ONLY / ALL UNRUN.
// Provider shape / MP3 construction adapted from recognition-reservation-fixture.ts
// and web2-first-song.ts at da6cdf3f90f27cebb3d30783d4ced3df853dac64;
// originals remain unchanged. No success result is supplied by these fixtures.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, hashJson, hashText } from "../../packages/community/common.ts";
import { address } from "../../packages/community/manifest-core.ts";
import { web2SongChain, web2Owner, web2Controller, web2Publisher } from "./web2-first-song-chain.ts";
import { canonicalHttpFixture } from "./canonical-http.ts";
import { ownerGrantDigest, ownerBudgetKey, ownerWindowCondition, validateOwnerGrant, type OwnerBudgetGrant } from "../../packages/release/owner-grant.ts";
import { authenticatedManagedRegistration, provisionManagedPublishingInputs, revokeManagedPublishingAdmission,
  type ManagedPublishingRegistration, type ManagedPublishingConfiguration } from "../../packages/release/managed-publishing-admission.ts";
import { provisionSharedRecognitionInputs, type SharedRecognitionConfiguration } from "../../services/shared-recognition-configuration.ts";
import { readPrivateJSON, signRecord, type SignedRecord, type TrustAnchor } from "../../deploy/linux/installed-records.ts";
import { createManagedKeyClient, startManagedKeyAgent } from "../../deploy/linux/managed-key-channel.ts";
import { acquireOperation, privateDirectory, processIdentity } from "../../deploy/linux/backend-state.ts";
import { provisionWeb2ManagedServiceInputs, type InstalledWeb2ManagedServiceInputs } from "../../deploy/linux/web2-managed-service-inputs.ts";
import { policyDocument, planDocument, enrollmentTypedData, type HostedPolicy } from "../../packages/community/hosted-enrollment.ts";
import { checkedHostedPreparation } from "../../packages/community-setup/hosted-enrollment-client.ts";
import type { RecognitionProfile } from "../../packages/recognition/intent.ts";
import type { ManagedCatalogBinding } from "../../packages/recognition/provider-binding.ts";
import { RecognitionStore } from "../../packages/recognition/store.ts";
import { communityRuntime } from "../community-runtime.ts";
import { ownerSongRuntime } from "../../services/first-song-runtime.ts";
import { communityCanonicalFetch } from "../../services/community-canonical.ts";
import { reserveBudget, type ReservationCondition } from "../../packages/community/budgets.ts";
import { configuredPublishingAdmission } from "../../services/managed-publishing-admission.ts";
import { signServiceRequest } from "../../packages/moderation/pairing.ts";
import { readPinnedManagedCommunity } from "../../services/shared-recognition-configuration.ts";
import { catalogPhaseTransitionStatements } from "../../packages/community/catalog-phase-transition.ts";
import { reserveOwnerSubmission, sealSubmission } from "../../packages/community/submissions.ts";
import { uploadAudio } from "../../packages/community/uploads.ts";
import { reserveStem, uploadStem, stemSlots } from "../../packages/community/stems.ts";
import { publicationExecutionProfile } from "../../packages/community/publication-profile.ts";
import { readCanonicalIntent } from "../../packages/recognition/canonical-intent.ts";
import { reservationClient } from "../../packages/recognition/reservation-client.ts";
import { reservationId, type AcceptedIntent } from "../../packages/recognition/intent.ts";
import { validateOwnerAuthorization } from "../../packages/community/owner-authorization.ts";
import { leaseJob } from "../../packages/community/publication-store.ts";
import type { CatalogPublicationPorts } from "../../packages/community/catalog-publication.ts";
import type { AccountSession } from "../../packages/community/accounts.ts";
import type { Recording, VerifiedPublication } from "../../packages/recognition/model.ts";

const wizardRequire = createRequire(new URL("../../apps/community-wizard/package.json", import.meta.url));
async function schema(db: D1Database, path: string) {
  const owned = createRequire(wizardRequire.resolve("@alchemy.run/cloudflare/D1/Database"));
  // Reuse the pinned Alchemy trigger-aware parser, not a SQL imitation.
  const parser = await import(pathToFileURL(owned.resolve("@alchemy.run/sql/SqlFile")).href);
  const statements: string[] = parser.splitSqliteStatements(await readFile(path, "utf8"));
  await db.batch(statements.map(statement => db.prepare(statement)));
}
async function bundle(entry: string) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "browser", format: "esm",
    target: "es2024", external: ["node:*"], logLevel: "silent" });
  return result.outputFiles[0]!.text;
}
export async function managedServicesFixture(options: { grantSeconds?: number } = {}) {
  const cleanups: Array<() => Promise<void>> = []; let closed = false;
  async function close() {
    if (closed) return; closed = true;
    const results = await Promise.allSettled(cleanups.reverse().map(cleanup => cleanup()));
    const failed = results.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed, "managed_fixture_cleanup_failed");
  }
  try {
  const runId = randomUUID(), publisherKey = new Uint8Array(Buffer.from("11".repeat(32), "hex")),
    signerKey: Hex = `0x${"73".repeat(32)}`, signer = privateKeyToAccount(signerKey),
    credentials = { host: "identify-eu-west-1.acrcloud.com", accessKey: "explicit-fixture-key", accessSecret: "explicit-fixture-secret" },
    namespace = hashText("new managed-service integration namespace"),
    binding: ManagedCatalogBinding = { schema: "pirate.managed-recognition-binding/1", namespace,
      catalogOrigin: "https://api-v2.acrcloud.com", bucketId: "123", projectId: "explicit-fixture-project", identifyHost: credentials.host,
      accessKeySha256: hashJson({ accessKey: credentials.accessKey }), associationEvidenceSha256: hashText("explicit outside-provider project fixture") },
    profileBody = { schema: "pirate.recognition-profile/1" as const, namespace, origin: "https://recognition.web2.example",
      signer: signer.address.toLowerCase(), providerBindingSha256: hashJson(binding) },
    profile: RecognitionProfile = { ...profileBody, sha256: hashJson(profileBody) };
  const chain = await web2SongChain(profile); cleanups.push(() => chain.close());
  const pair = generateKeyPairSync("ed25519"),
    privateIssuer = pair.privateKey.export({ format: "der", type: "pkcs8" }),
    trust: TrustAnchor = { keyId: "fixture-pirate-issuer", spki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") },
    sign = <T>(body: T): SignedRecord<T> => signRecord(body, trust, privateIssuer),
    now = Math.floor(Date.now() / 1000), installationId = "fixture-host-" + randomUUID(), credential = randomBytes(32).toString("base64url"),
    inviteId = hashText("retained managed-service fixture invitation"), custodyBody = { keyReference: "publisher", generation: 1,
      installationId, publisher: chain.current().publisher },
    draft = { schema: "pirate.owner-publishing-grant/1" as const, sha256: hashText("digest placeholder unused by digest projection"),
      communityId: chain.profile.communityId, communityOrigin: chain.deployment.origin, ownerWallet: address(web2Owner.address),
      policy: chain.current().policies.admission, destination: { chainId: 6343, postsContract: chain.deployment.posts.address,
        publisher: chain.current().publisher }, validFrom: now - 30, expiresAt: now + (options.grantSeconds ?? 1800),
      limits: { songs: 2, pinAdds: 10, pinBytes: "16777216", recognitionRequests: 8, postFeeWei: "90000000000000" } },
    grant = validateOwnerGrant({ ...draft, sha256: ownerGrantDigest(draft) }),
    registration: ManagedPublishingRegistration = { schema: "pirate.managed-publishing-registration/1", issuerKeyId: trust.keyId,
      admissionReference: "manual-pilot:" + randomUUID(), serviceOrigin: chain.deployment.managedOrigin,
      scope: { schema: "pirate.web2-owner-grant-scope/1", enrollmentId: hashText(`hosted-enrollment:${inviteId}`), installationId: chain.profile.installationId,
        hostInstallationId: installationId, deploymentDigest: hashJson(chain.deployment), communityId: chain.profile.communityId,
        origin: chain.deployment.origin, controller: chain.current().controller, ownerWallet: address(web2Owner.address),
        policy: chain.current().policies.admission, chainId: 6343, postsContract: chain.deployment.posts.address, publisher: chain.current().publisher },
      grant, deployment: chain.deployment, configurationSha256: hashJson(chain.current()),
      registrationOriginal: { plan: planDocument(chain.original.plan), rawTransaction: chain.original.rawTransaction,
        transactionHash: chain.original.transactionHash }, custody: { ...custodyBody, custodyBindingDigest: hashJson(custodyBody) },
      credential: { keyReference: "service-auth", generation: 1, sha256: hashText(credential) },
      moderation: { budgetPeriod: "managed-fixture", requestCap: 8 } },
    journal = { epoch: hashText("fixture exact original epoch"), restoreAnchorSha256: hashText("explicit fresh fixture empty admission") },
    publishing: ManagedPublishingConfiguration = { schema: "pirate.managed-publishing-service/1", origin: registration.serviceOrigin,
      journal, registrations: [sign(registration)], disabledAdmissionReferences: [] },
    recognition: SharedRecognitionConfiguration = { schema: "pirate.shared-recognition-service/1", profile, binding, journal,
      quotas: { service: 16, community: 8 }, communities: [sign(registration)] };
  const managedCode = await bundle("services/managed-publishing-worker.ts"), recognitionCode = await bundle("services/shared-recognition-worker.ts");
  const managedBindings = { MANAGED_PUBLISHING_PROFILE: "managed-web2", MANAGED_PUBLISHING_CONFIGURATION_JSON: canonical(publishing),
    SERVICE_CONFIGURATION_TRUST_JSON: canonical(trust), SERVICE_ORIGIN: registration.serviceOrigin, SERVICE_PROFILE_HASH: hashText("managed fixture profile"),
    SERVICE_BUDGET_PERIOD: "managed-fixture", SERVICE_REQUEST_CAP: "8", ACRCLOUD_HOST: credentials.host, ACRCLOUD_ACCESS_KEY: credentials.accessKey,
    ACRCLOUD_ACCESS_SECRET: credentials.accessSecret, OPENAI_API_KEY: "excluded", MODERATION_SIGNER_PRIVATE_KEY: `0x${"41".repeat(32)}`,
    FILEBASE_IPFS_TOKEN: "explicit-outside-provider-fixture-token" };
  const recognitionBindings = { MANAGED_PUBLISHING_CONFIGURATION_JSON: canonical(publishing), RECOGNITION_CONFIGURATION_JSON: canonical(sign(recognition)), SERVICE_CONFIGURATION_TRUST_JSON: canonical(trust),
    RECOGNITION_SIGNER_PRIVATE_KEY: signerKey, ACRCLOUD_HOST: credentials.host, ACRCLOUD_ACCESS_KEY: credentials.accessKey,
    ACRCLOUD_ACCESS_SECRET: credentials.accessSecret, ACRCLOUD_CATALOG_TOKEN: "explicit-outside-provider-fixture-token" };
  const community = await communityRuntime(); cleanups.push(() => community.dispose());
  let providerRequests = 0, uploads = 0, identifies = 0, lostUpload = false, lostIdentify = false, providerOutage = false, consume = true, pinAdds = 0;
  let canonicalActionHook: { action: string; run(): Promise<unknown> } | undefined;
  const files = new Map<string, { id: number; bucket_id: number; title: string; acr_id: string; state: number; user_defined: unknown }>();
  let canonicalPorts: CatalogPublicationPorts | undefined, afterRead: (() => Promise<unknown>) | undefined;
  const outbound = async (request: { url: string; method: string; headers: Iterable<[string, string]>; arrayBuffer(): Promise<ArrayBuffer> }) => {
    const url = new URL(request.url);
    if (url.origin === new URL(chain.deployment.rpcUrl).origin) {
      const response = await fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        ...(!["GET", "HEAD"].includes(request.method) ? { body: await request.arrayBuffer() } : {}), redirect: "manual" });
      const hook = afterRead; afterRead = undefined; await hook?.(); return response;
    }
    if (url.origin === chain.deployment.origin) {
      const bytes = await request.arrayBuffer(), wire = JSON.parse(new TextDecoder().decode(bytes)),
        response = await http!.transport(new Request(request.url, { method: request.method,
          headers: Object.fromEntries(request.headers), body: bytes, redirect: "manual" }));
      if (canonicalActionHook?.action === wire.payload?.action) { const hook = canonicalActionHook; canonicalActionHook = undefined; await hook.run(); }
      return response;
    }
    if (url.pathname === "/api/v0/add") { pinAdds++; return new Response(null, { status: 503 }); }
    // Only outside ACRCloud transport is simulated. All provider adapters,
    // signatures, canonical HTTP and durable journals are the actual owners.
    providerRequests++;
    if (url.hostname === credentials.host) {
      identifies++;
      if (lostIdentify) { lostIdentify = false; throw Error("explicit lost outside identification reply"); }
      if (providerOutage) return new Response(null, { status: 503 });
      const row = [...files.values()][0];
      return Response.json({ status: { code: row ? 0 : 1001 }, metadata: { custom_files: row ? [{ acrid: row.acr_id }] : [] } });
    }
    assert.equal(url.origin, binding.catalogOrigin);
    if (request.method === "POST") {
      uploads++;
      const form = await new Request(request.url, { method: "POST", headers: Object.fromEntries(request.headers), body: await request.arrayBuffer() }).formData(),
        title = String(form.get("title")), row = { id: uploads, bucket_id: 123, title, acr_id: "custom-" + uploads, state: 1,
          user_defined: JSON.parse(String(form.get("user_defined"))) };
      files.set(title, row);
      if (lostUpload) { lostUpload = false; throw Error("explicit provider lost upload reply after retained outside effect"); }
      return Response.json({ data: row });
    }
    return Response.json({ data: [...files.values()].filter(row => row.title === url.searchParams.get("search")), next_page_url: null });
  };
  const managedOptions = () => ({ modules: true, script: managedCode, compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "managed-db" }, r2Buckets: ["MEDIA"], queueProducers: { JOBS: "managed" },
    bindings: managedBindings, outboundService: outbound });
  const recognitionOptions = () => ({ modules: true, script: recognitionCode, compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "recognition-db", ADMISSION_DB: "managed-db" }, queueProducers: { JOBS: "recognition" },
    ...(consume ? { queueConsumers: { recognition: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 1 } } } : {}),
    bindings: recognitionBindings, outboundService: outbound });
  const optionsForRuntime = () => ({ workers: [{ name: "managed", ...managedOptions() }, { name: "recognition", ...recognitionOptions() }] });
  const runtime = new Miniflare(optionsForRuntime()), updateRuntime = () => runtime.setOptions(optionsForRuntime());
  cleanups.push(() => runtime.dispose());
  const recognitionFetch = async (url: string, init: RequestInit) => (await runtime.getWorker("recognition")).fetch(url, init);
  let agent: Awaited<ReturnType<typeof startManagedKeyAgent>> | undefined,
    key: Awaited<ReturnType<typeof createManagedKeyClient>> | undefined,
    lease: Awaited<ReturnType<typeof acquireOperation>> | undefined,
    installed: SignedRecord<InstalledWeb2ManagedServiceInputs> | undefined, lost: string | undefined,
    redirect = false, attachCalls = 0, crossed = 0, root: string | undefined;
  const db = await runtime.getD1Database("DB", "managed"), recognitionDb = await runtime.getD1Database("DB", "recognition");
  const rows = async () => (await db.prepare("SELECT * FROM managed_publishing_admissions ORDER BY original_id").all()).results;
  const budgets = async () => (await db.prepare("SELECT * FROM spending_budgets ORDER BY scope,period,asset").all()).results;
  let http: Awaited<ReturnType<typeof canonicalHttpFixture>> | undefined;
  try {
    for (const name of ["0001_managed.sql", "0002_release_operations.sql", "0003_owner_curated.sql", "0004_owner_budget_windows.sql"])
      await schema(db, "apps/managed-moderation/migrations/" + name);
    await schema(db, "packages/release/schema/managed-publishing-admission.sql");
    await schema(recognitionDb, "packages/recognition/schema.sql");
    await provisionManagedPublishingInputs(db, publishing, trust);
    await provisionSharedRecognitionInputs(recognitionDb, sign(recognition), trust);
    for (const name of ["0011_manual_rewards.sql", "0012_owner_budget_windows.sql"])
      await schema(community.db, "apps/community-wizard/infra/migrations/" + name);
    await community.db.batch(catalogPhaseTransitionStatements(community.db, await readFile("packages/community/catalog-phase-rebuild.sql", "utf8")));
    await schema(community.db, "packages/community/catalog-obligation.sql");
    http = await canonicalHttpFixture(new Map([
      [registration.serviceOrigin, async (request: Request) => runtime.dispatchFetch(request.url, {
        method: request.method, headers: Object.fromEntries(request.headers), body: await request.arrayBuffer(), redirect: "manual" })],
      [registration.scope.origin, async (request: Request) => {
        assert(canonicalPorts);
        try { return await communityCanonicalFetch(request, canonicalPorts); }
        catch { return Response.json({ error: "canonical_source_unavailable" }, { status: 403 }); }
      }],
      [profile.origin, async (request: Request) => recognitionFetch(request.url, {
        method: request.method, headers: Object.fromEntries(request.headers), body: await request.arrayBuffer(), redirect: "manual" })],
    ]));
    cleanups.push(() => http!.close());
    const transport = async (request: Request) => {
      if (new URL(request.url).origin !== registration.serviceOrigin) { crossed++; throw Error("crossed origin"); }
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      if (action === "attach") attachCalls++;
      const response = await http!.transport(request);
      if (lost === action) { lost = undefined; throw Error("explicit lost HTTP response after actual handler completed"); }
      if (redirect) { redirect = false; return new Response(null, { status: 302, headers: { location: "https://unadmitted.invalid/" } }); }
      return response;
    };
    const selectionBody = { schema: "pirate.web2-configured-owner-grant/1" as const, scope: registration.scope,
      grant: registration.grant, admissionReference: registration.admissionReference };
    const selection = { ...selectionBody, selectionDigest: hashJson(selectionBody) };
    const request = (action: string, body: unknown, headers: Record<string, string> = {}) => transport(new Request(registration.serviceOrigin + "/v1/managed-publishing/" + action, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + credential,
        "x-pirate-installation": installationId, "x-pirate-admission": registration.admissionReference, ...headers }, body: canonical(body),
    }));
    const publisherPolicy: HostedPolicy = { schema: "pirate.hosted-enrollment-policy/1", pilotId: "managed-service-local-fixture",
      serviceOrigin: "https://enrollment.fixture.example", deployment: { schema: "pirate.web2-directory/3", chainId: 6343,
        directory: chain.profile.directory, directoryCodeHash: chain.profile.directoryCodeHash, directoryAbiSha256: chain.profile.directoryAbiSha256,
        sourceCommit: chain.profile.sourceCommit, deploymentBlock: chain.profile.deploymentBlock },
      registrar: chain.original.plan.registrar, funder: chain.original.plan.registrar, registrarRevision: "1", noticeSha256: hashText("explicit local fixture notice"),
      inviteMaxSeconds: 1800, challengeSeconds: 600, maxSafeBlockAgeSeconds: 600, broadcastRetrySeconds: 10, maxBroadcastAttempts: 2,
      registrationGas: "3000000", topupGas: "50000", maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000", extraFeeCeiling: "0", extraFeeField: "none",
      globalCeiling: "1000000000000000000", communityCeiling: "500000000000000000", recipientCeiling: "200000000000000000",
      controllerInitialWei: "10000000000000000", publisherInitialWei: "10000000000000000" };
    const authorizationBody = { schema: "pirate.owner-publishing-authorization/1", communityId: grant.communityId,
      ownerWallet: grant.ownerWallet, policy: grant.policy, validFrom: grant.validFrom, expiresAt: grant.expiresAt },
      signedOwner = { authorization: authorizationBody, signature: await web2Controller.signMessage({ message: { raw: hashJson(authorizationBody) } }) },
      authorization = (await validateOwnerAuthorization(signedOwner, chain.current())).authorization,
      current = () => readPinnedManagedCommunity(registration),
      ports = ownerSongRuntime({ DB: community.db, MEDIA: community.media, COMMUNITY_PUBLISHER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
        MANAGED_PROFILE_HASH: managedBindings.SERVICE_PROFILE_HASH, OWNER_GRANT_JSON: canonical(grant), OWNER_AUTHORIZATION_JSON: canonical(signedOwner),
        RECOGNITION_PROFILE_JSON: canonical(profile), CATALOG_TRANSPORT: request => http!.transport(request),
        CATALOG_ACCOUNT_FENCE: async (account, wallet, author) => {
          const row = await community.db.prepare(`SELECT a.account_id FROM community_accounts a JOIN credential_bindings b ON b.account_id=a.account_id
            WHERE a.account_id=? AND a.author_id=? AND b.subject=? AND b.network=6343`).bind(account, author, wallet).first();
          assert(row, "actual account binding changed");
        } }, chain.current(), current, async () => {
          const response = await runtime.dispatchFetch(registration.serviceOrigin + "/health", { headers: {
            "x-pirate-community": grant.communityId, "x-pirate-owner-grant": grant.sha256 } });
          const body = await response.json() as { ownerRelease?: { configured: boolean } };
          return response.ok && body.ownerRelease?.configured === true;
        }, chain.deployment);
    assert(ports.catalog); canonicalPorts = ports.catalog;
    const client = () => reservationClient({ profile, publisher: web2Publisher, transport: request => http!.transport(request),
      current: async intent => assert.deepEqual((await readCanonicalIntent(canonicalPorts!, intent.jobId)).intent, intent),
      beforeSend: async intent => {
        const job = await community.db.prepare("SELECT job_id FROM publication_jobs WHERE job_id=? AND lease_token IS NOT NULL AND lease_until>?")
          .bind(intent.jobId, Date.now()).first(); assert(job, "actual publication lease lost");
      } });
    let generation = 1;
    const installedBody = (): InstalledWeb2ManagedServiceInputs => {
      const r = structuredClone(registration); r.custody.generation = generation;
      const { custodyBindingDigest: _digest, ...body } = r.custody; r.custody.custodyBindingDigest = hashJson(body);
      return { schema: "pirate.linux-web2-managed-service-inputs/1", installationId, serviceTrust: trust, registration: sign(r), publisherPolicy: policyDocument(publisherPolicy) };
    };
    return {
      db, chain, registration, selection, publisherKey, credential, rows, budgets,
      afterNextCanonicalRead: (hook: () => Promise<unknown>) => { afterRead = hook; },
      afterCanonicalAction: (action: string, run: () => Promise<unknown>) => { canonicalActionHook = { action, run }; }, pinAdds: () => pinAdds,
      health: (headers: Record<string, string> = {}) => runtime.dispatchFetch(registration.serviceOrigin + "/health", { headers }),
      async activeRegistry(state: "disabled" | "removed") {
        managedBindings.MANAGED_PUBLISHING_CONFIGURATION_JSON = canonical({ ...publishing,
          registrations: state === "removed" ? [] : publishing.registrations,
          disabledAdmissionReferences: state === "disabled" ? [registration.admissionReference] : [] });
        recognitionBindings.MANAGED_PUBLISHING_CONFIGURATION_JSON = managedBindings.MANAGED_PUBLISHING_CONFIGURATION_JSON; await updateRuntime();
      },
      async provisionChangedOriginal(change: (value: ManagedPublishingRegistration) => void) {
        const r = structuredClone(registration); r.scope.enrollmentId = hashText(randomUUID()); r.admissionReference += ":" + randomUUID(); change(r);
        return provisionManagedPublishingInputs(db, { ...publishing, registrations: [sign(r)] }, trust);
      },
      admissionGate: () => configuredPublishingAdmission({ DB: db, MANAGED_PUBLISHING_CONFIGURATION_JSON: managedBindings.MANAGED_PUBLISHING_CONFIGURATION_JSON,
        SERVICE_CONFIGURATION_TRUST_JSON: canonical(trust) }).gate(registration),
      async reserveWithGateCondition(original: { operationId: string; requestHash: Hex; asset: "pin_adds"; requested: string }, condition: ReservationCondition) {
        const owner = ownerWindowCondition(grant);
        // Tests the adapter predicate against actual existing D1 transaction
        // guards, not W1's still-pending lazy supplier call signature.
        await reserveBudget(db, original.operationId, original.requestHash, [ownerBudgetKey(grant, original.asset)], original.requested,
          { clause: `(${owner.clause}) AND (${condition.clause})`, binds: [...owner.binds, ...condition.binds], code: condition.code });
      },
      async reservationCount(id: string) { return (await db.prepare("SELECT count(*) AS n FROM spending_reservations WHERE reservation_id=?").bind(id).first<{ n: number }>())!.n; },
      async pinAudioOriginal(intent: AcceptedIntent) {
        const context = (await readCanonicalIntent(canonicalPorts!, intent.jobId)).input.context,
          issuedAt = Math.floor(Date.now() / 1000), signed = await signServiceRequest(web2Publisher, { action: "release_pin", communityId: chain.profile.communityId,
            communityOrigin: grant.communityOrigin, serviceOrigin: registration.serviceOrigin, configurationRevision: 1,
            nonce: hashText(randomUUID()), issuedAt, expiresAt: issuedAt + 120 }, { context, role: "audio" });
        return http!.transport(new Request(registration.serviceOrigin + "/v1/owner-releases/pin", { method: "POST",
          headers: { "content-type": "application/json" }, body: canonical(signed) }));
      },
      waitPastGrantExpiry: () => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, (grant.expiresAt + 1) * 1000 - Date.now()))),
      async replaceActualPublisherKey() { assert(root); await writeFile(join(root, "keys/publisher"), Buffer.from("52".repeat(32), "hex"), { mode: 0o600 }); },
      async replaceActualServiceCredential() { assert(root); await writeFile(join(root, "keys/service-auth"), randomBytes(32).toString("base64url"), { mode: 0o600 }); },
      prepare: (scope: Record<string, unknown> = {}, headers?: Record<string, string>) => request("prepare", { scope: { ...registration.scope, ...scope } }, headers),
      attach: () => request("attach", { selectionDigest: selection.selectionDigest }),
      reconcile: () => request("reconcile", { selectionDigest: selection.selectionDigest }),
      ownerRequest: () => runtime.dispatchFetch(registration.serviceOrigin + "/health", { headers: {
        "x-pirate-community": registration.scope.communityId, "x-pirate-owner-grant": registration.grant.sha256 } }),
      loseReply: (action: string) => { lost = action; }, redirectNextReply: () => { redirect = true; }, attachCalls: () => attachCalls,
      crossOriginRequests: () => crossed, restart: () => updateRuntime(),
      revoke: () => revokeManagedPublishingAdmission(db, registration.admissionReference),
      markAttaching: () => db.prepare("UPDATE managed_publishing_admissions SET state='attaching' WHERE selection_digest=?").bind(selection.selectionDigest).run(),
      async withChangedRegistration(change: "scope" | "grant" | "custody" | "issuer", action: () => Promise<Response>) {
        const r = structuredClone(registration);
        if (change === "scope") r.scope.controller = address(web2Owner.address);
        if (change === "grant") { r.grant.limits.songs++; r.grant.sha256 = ownerGrantDigest(r.grant); }
        if (change === "custody") { r.custody.generation++; const { custodyBindingDigest: _digest, ...c } = r.custody; r.custody.custodyBindingDigest = hashJson(c); }
        if (change === "issuer") r.issuerKeyId = "unadmitted-issuer";
        const before = managedBindings.MANAGED_PUBLISHING_CONFIGURATION_JSON;
        managedBindings.MANAGED_PUBLISHING_CONFIGURATION_JSON = canonical({ ...publishing, registrations: [sign(r)] });
        await updateRuntime();
        try { return await action(); } finally { managedBindings.MANAGED_PUBLISHING_CONFIGURATION_JSON = before; await updateRuntime(); }
      },
      async provisionReplacement(limits: OwnerBudgetGrant["limits"]) {
        const r = structuredClone(registration); r.scope.enrollmentId = hashText("distinct replacement original"); r.admissionReference += ":replacement";
        r.grant.limits = limits; r.grant.sha256 = ownerGrantDigest(r.grant);
        return provisionManagedPublishingInputs(db, { ...publishing, registrations: [sign(r)] }, trust);
      },
      async linuxInputs() {
        if (!key || !lease) {
          root = await mkdtemp(join(tmpdir(), "pirate-managed-services-")); await privateDirectory(root);
          const leases = join(root, "lease"), keys = join(root, "keys"); await privateDirectory(leases); await privateDirectory(keys);
          const identity = await processIdentity(process.pid); assert(identity);
          lease = await acquireOperation(leases, "managed-service-fixture", installationId, { selection: selection.selectionDigest }, identity.pidNamespace);
          const material = [{ ref: "publisher", bytes: publisherKey }, { ref: "service-auth", bytes: Buffer.from(credential) }, { ref: "host-issuer", bytes: privateIssuer }];
          for (const item of material) await writeFile(join(keys, item.ref), item.bytes, { mode: 0o600 });
          const authenticationKey = randomBytes(32), socket = join(keys, "agent.sock");
          agent = await startManagedKeyAgent({ socket, directory: keys, installationId, authenticationKey, lease,
            keys: material.map(item => ({ ref: item.ref, generation: 1, path: join(keys, item.ref), bytes: item.bytes.length })),
            signingKeyFile: join(keys, "host-issuer"), trust, permittedProfileDigests: new Set(), capturedRoots: [join(root, "never-key-payload")] });
          cleanups.push(() => agent!.close());
          key = await createManagedKeyClient({ socket, installationId, authenticationKey, lease });
          cleanups.push(async () => { key!.dispose(); });
          installed = await provisionWeb2ManagedServiceInputs({ body: installedBody(), trust, signing: key, keyReference: "host-issuer", generation: 1 });
          await writeFile(join(root, "installed-inputs.json"), canonical(installed), { mode: 0o600 });
        }
        const selectedLease = lease, selectedKey = key; assert(selectedLease && selectedKey && installed);
        return { record: installed, trust, key: selectedKey, lease: selectedLease, now: () => Math.floor(Date.now() / 1000),
          currentInstalled: async () => { assert(root); return readPrivateJSON<SignedRecord<InstalledWeb2ManagedServiceInputs>>(join(root, "installed-inputs.json")); }, transport };
      },
      async mutateCustodyGeneration() {
        assert(root); generation++;
        await writeFile(join(root, "installed-inputs.json"), canonical(sign(installedBody())), { mode: 0o600 });
      }, async breakLease() {
        assert(lease);
        await writeFile(join(lease.directory, "active-operation.json"), "{}\n", { mode: 0o600 });
      },
      async publisherChallenge() {
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        const e = { schema: "pirate.hosted-enrollment/1" as const, id: registration.scope.enrollmentId, inviteId,
          allowanceId: hashText("retained fixture allowance"), expiresAt, policyHash: hashJson(policyDocument(publisherPolicy)),
          noticeSha256: publisherPolicy.noticeSha256, plan: chain.original.plan };
        const typedData = JSON.parse(JSON.stringify(enrollmentTypedData(e), (_k, value) => typeof value === "bigint" ? String(value) : value));
        const prepared = checkedHostedPreparation({ schema: e.schema, enrollmentId: e.id, expiresAt, typedData }, e.plan, publisherPolicy, Math.floor(Date.now() / 1000));
        return { operationId: hashJson({ enrollmentId: e.id, purpose: "publisher-enrollment-proof", custodyBindingDigest: registration.custody.custodyBindingDigest }), prepared };
      },
      recognitionWorker: () => runtime.getWorker("recognition"), restartRecognition: () => updateRuntime(),
      async setWakeDelivery(enabled: boolean) { consume = enabled; await updateRuntime(); },
      recognitionClient: client, providerEffects: () => ({ uploads, identifies }), loseNextUploadReply: () => { lostUpload = true; },
      loseNextIdentifyReply: () => { lostIdentify = true; }, setProviderOutage: (value: boolean) => { providerOutage = value; },
      async waitForUploadCall() {
        for (let attempt = 0; attempt < 200 && uploads === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
        assert(uploads > 0, "actual catalog upload transport was never reached");
      },
      async waitForIdentifyCall() {
        for (let attempt = 0; attempt < 200 && identifies === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
        assert(identifies > 0, "actual provider transport was never reached");
      },
      async acceptCanonicalIntent() {
        const session: AccountSession = { account_id: randomUUID(), author_id: hashText("retained integration author"), binding_id: randomUUID(),
          wallet: address(web2Owner.address), session_hash: hashText("retained integration session"), csrf_token: "fixture-csrf", expires_at: Date.now() + 600000 };
        await community.db.prepare("INSERT INTO community_accounts VALUES(?,?,?)").bind(session.account_id, session.author_id, Date.now()).run();
        await community.db.prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)").bind(session.binding_id, session.account_id, session.wallet, Date.now()).run();
        const submissionProfile = { execution: publicationExecutionProfile(ports), chainId: 6343, communityId: grant.communityId,
          postsContract: grant.destination.postsContract, configurationRevision: 1, publisher: grant.destination.publisher,
          moderationSigner: chain.current().policies.moderationSigner, recognition: profile, communityOrigin: grant.communityOrigin },
          audio = new Uint8Array(1600 * 417);
        for (let frame = 0; frame < 1600; frame++) audio.set([0xff, 0xfb, 0x90, 0], frame * 417);
        const reserved = await reserveOwnerSubmission(community.db, session, submissionProfile, authorization, { title: "Managed service original",
          language: "en", lyrics: "Sail away", original: true, acceptedPolicy: grant.policy.version, rating: "general",
          audioSha256: sha256(audio), audioBytes: audio.length, terms: { revision: 1, allowsDerivatives: false } }, randomUUID()),
          upload = () => new Request(grant.communityOrigin + "/upload", { method: "PUT", headers: { "content-type": "audio/mpeg" }, body: audio });
        await uploadAudio(community.db, community.media, session.account_id, reserved.submission_id, upload());
        for (const slot of stemSlots) {
          await reserveStem(community.db, session.account_id, reserved.submission_id, slot, { sha256: sha256(audio), byteLength: audio.length });
          await uploadStem(community.db, community.media, session.account_id, reserved.submission_id, slot, upload());
        }
        const sealed = await sealSubmission(community.db, community.media, session, submissionProfile, reserved.submission_id, Date.now(), authorization);
        await leaseJob(community.db, sealed.jobId, Date.now());
        return (await readCanonicalIntent(canonicalPorts!, sealed.jobId)).intent;
      },
      reservationOriginal: (intent: AcceptedIntent) => recognitionDb.prepare("SELECT reservation_id,intent_json FROM shared_recognition_reservations WHERE reservation_id=?")
        .bind(reservationId(intent)).first<{ reservation_id: string; intent_json: string }>(),
      reservationIdentity: (intent: AcceptedIntent) => recognitionDb.prepare("SELECT reservation_id,intent_json FROM shared_recognition_reservations WHERE reservation_id=?")
        .bind(reservationId(intent)).first<{ reservation_id: string; intent_json: string }>(),
      async waitRecognitionReady(intent: AcceptedIntent) {
        for (let attempt = 0; attempt < 200; attempt++) {
          const status = await client().status(intent);
          if (status.state === "ready") return status;
          if (attempt % 10 === 0) await (await runtime.getWorker("recognition")).scheduled();
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw Error("actual recognition original did not become ready");
      },
      async seedDueRecording() {
        const store = new RecognitionStore(recognitionDb, namespace), p: VerifiedPublication = { namespace, communityId: registration.scope.communityId,
          postId: hashText("incomplete canonical source post"), publicationRevision: 1, configurationRevision: 1,
          creatorKey: `eip155:6343:${registration.scope.ownerWallet}`, audioSha256: hashText("unpublished fixture audio"), audioBytes: 16,
          audioObjectKey: "sealed/incomplete-source", audioRevision: 1, termsRevision: 1, termsSha256: hashText("fixture original terms"),
          allowsDerivatives: false, publicationEvidenceSha256: hashText("explicit incomplete-source negative fixture") };
        const result = await store.enroll(p, await store.catalogRevision()); return result.recording;
      },
      async recordingOriginal() { return recognitionDb.prepare("SELECT * FROM shared_recognition_recordings LIMIT 1").first<Recording>(); },
      async recordingIdentity() { return recognitionDb.prepare("SELECT recording_id,audio_sha256 FROM shared_recognition_recordings LIMIT 1").first(); },
      async providerReceiptCount() { return (await recognitionDb.prepare("SELECT count(*) AS n FROM shared_recognition_events WHERE kind LIKE 'receipt:%'").first<{ n: number }>())!.n; },
      async recognitionFault(fault: "installation" | "profile" | "schema" | "database-schema" | "credentials" | "issuer", action: (worker: Awaited<ReturnType<Miniflare["getWorker"]>>) => Promise<void>) {
        const before = { ...recognitionBindings }, r = JSON.parse(recognitionBindings.RECOGNITION_CONFIGURATION_JSON);
        if (fault === "installation") await recognitionDb.prepare("UPDATE shared_recognition_installation SET journal_epoch=?").bind(hashText("wrong installation")).run();
        if (fault === "database-schema") await recognitionDb.prepare("ALTER TABLE shared_recognition_installation RENAME TO deliberately_unavailable_installation").run();
        if (fault === "profile") { r.body.profile.sha256 = hashText("wrong profile"); recognitionBindings.RECOGNITION_CONFIGURATION_JSON = canonical(sign(r.body)); }
        if (fault === "schema") { r.body.schema = "unsupported"; recognitionBindings.RECOGNITION_CONFIGURATION_JSON = canonical(sign(r.body)); }
        if (fault === "credentials") recognitionBindings.ACRCLOUD_ACCESS_KEY = "wrong key";
        if (fault === "issuer") { r.signature = Buffer.alloc(64).toString("base64url"); recognitionBindings.RECOGNITION_CONFIGURATION_JSON = canonical(r); }
        await updateRuntime();
        try { await action(await runtime.getWorker("recognition")); } finally {
          if (fault === "database-schema") await recognitionDb.prepare("ALTER TABLE deliberately_unavailable_installation RENAME TO shared_recognition_installation").run();
          Object.assign(recognitionBindings, before); await recognitionDb.prepare("UPDATE shared_recognition_installation SET journal_epoch=?").bind(journal.epoch).run();
          await updateRuntime();
        }
      },
      async artifact(label: string) {
        const directory = `.local/managed-first-song-service-tests/${runId}`;
        await mkdir(directory, { recursive: true });
        await writeFile(`${directory}/${label}.json`, JSON.stringify({ schema: "pirate.managed-service-integration-evidence/1",
          label, runId, pinAdds, sourceRevision: (await promisify(execFile)("git", ["rev-parse", "HEAD"])).stdout.trim(),
          sourceStatus: (await promisify(execFile)("git", ["status", "--short"])).stdout,
          runnerOutcome: "external test runner completion and cleanup required", providerEffects: { uploads, identifies }, registrationTransaction: chain.original.transactionHash, selectionDigest: selection.selectionDigest, grantDigest: grant.sha256,
          admissions: await rows(), budgets: await budgets(), providerRequests, attachCalls, crossed, http: http!.evidence }, null, 2));
      }, close,
    };
  } catch (error) { await close(); throw error; }
  } catch (error) { await close(); throw error; }
}


/** Boundary-only static assets. This is not W1's MOSS page or handshake. */
export async function signingHelperBoundaryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "pirate-signing-static-")), assets = join(directory, "assets"),
    entry = new TextEncoder().encode('<!doctype html><script type="module" src="/assets/helper-fixture.js"></script>'),
    chunk = new TextEncoder().encode('document.documentElement.dataset.fixture="static-boundary";'),
    origin = "https://managed-signing.fixture.example";
  await mkdir(assets); await writeFile(join(directory, "operator-signing"), entry); await writeFile(join(assets, "helper-fixture.js"), chunk);
  const script = await bundle("services/managed-publishing-worker.ts"), profile = { schema: "pirate.operator-signing-closure/1", origin,
    contentSecurityPolicy: "default-src 'none'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    files: [{ path: "/operator-signing", sha256: sha256(entry), contentType: "text/html" },
      { path: "/assets/helper-fixture.js", sha256: sha256(chunk), contentType: "text/javascript" }] };
  const options = () => ({ modules: true, script, compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"],
    assets: { directory, binding: "ASSETS", routerConfig: { invoke_user_worker_ahead_of_assets: true },
      assetConfig: { html_handling: "none" as const, not_found_handling: "none" as const } },
    bindings: { MANAGED_PUBLISHING_PROFILE: "operator-signing-only", OPERATOR_SIGNING_PROFILE_JSON: canonical(profile) } });
  const runtime = new Miniflare(options());
  return { entry, fetch: (path: string, init?: RequestInit) => runtime.dispatchFetch(origin + path, init),
    async tamperChunk() { await writeFile(join(assets, "helper-fixture.js"), "changed bytes"); await runtime.setOptions(options()); },
    async artifact(label: string) {
      const output = `.local/managed-first-song-service-tests/static-${randomUUID()}`; await mkdir(output, { recursive: true });
      await writeFile(join(output, label + ".json"), JSON.stringify({ label, profile, bundleSha256: hashText(script),
        sourceRevision: (await promisify(execFile)("git", ["rev-parse", "HEAD"])).stdout.trim(),
        limitation: "static boundary only; final W1 asset contract and actual MOSS prompt UNRUN" }, null, 2));
    }, close: () => runtime.dispose() };
}
