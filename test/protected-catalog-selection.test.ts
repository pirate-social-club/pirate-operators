import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, custom, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { managedRequest, type ManagedClient } from "../packages/community/managed-client.ts";
import { address } from "../packages/community/manifest-core.ts";
import { CATALOG_OWNER_POLICY_HASH, CATALOG_OWNER_POLICY_VERSION } from "../packages/community/owner-policy.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import type { ExternalOperation, PublicationJob } from "../packages/community/publication-store.ts";
import { authorizeCanonicalRequest, canonicalResponse, signCanonicalRequest } from "../packages/recognition/canonical-protocol.ts";
import { canonicalCommunityClient } from "../packages/recognition/canonical-transport.ts";
import { acceptedIntent, reservationId } from "../packages/recognition/intent.ts";
import { signReservation, type ReservationReceipt } from "../packages/recognition/reservation-receipt.ts";
import { createProtectedCatalogSelector, type ProtectedCatalogOriginalSelection } from "../services/protected-catalog-selection.ts";
import { readProtectedCatalogReservation, type ProtectedCatalogTransport } from "../services/protected-catalog-reservation.ts";
import { nativePostsCatalogReservationPath } from "../services/native-posts-publication.ts";
import { protectedCanonicalFetch, protectedCanonicalSelectionFetch } from "../services/community-canonical.ts";

async function fixture() {
  const publisherAccount = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
  const publisher = address(publisherAccount.address.toLowerCase());
  const postsContract = address("0x" + "2".repeat(40));
  const proofSigner = address("0x" + "3".repeat(40));
  const recognitionSigner = privateKeyToAccount(`0x${"4".padStart(64, "0")}`);
  const moderationSigner = privateKeyToAccount(`0x${"5".padStart(64, "0")}`);
  const communityId = hashJson("Catalog community"), postId = hashJson("Original song"),
    authorId = hashJson("Song author"), recordingId = hashJson("Catalog recording"),
    installationId = hashJson("Directory installation"), releaseSha256 = hashJson("Installed release");
  const profileBody = {
    schema: "pirate.recognition-profile/1" as const, namespace: hashJson("Namespace"),
    origin: "https://recognition.example", signer: address(recognitionSigner.address.toLowerCase()),
    providerBindingSha256: hashJson("Recognition provider"),
  };
  const recognition = { ...profileBody, sha256: hashJson(profileBody) };
  const policy = { version: CATALOG_OWNER_POLICY_VERSION, sha256: CATALOG_OWNER_POLICY_HASH };
  const config: Web2CommunityConfig = {
    schema: "pirate.community-config/4", chainId: 6343, directory: postsContract,
    communityId, communityKey: hashJson("Community key"), installationId,
    configurationRevision: 1, postsContract, controller: proofSigner, publisher,
    operatorPayments: postsContract, learningRecords: postsContract,
    app: { origin: "https://staging.example", label: "Stage" },
    feed: { endpoint: "https://staging.example/feed", signingKeyId: "fixture" },
    policies: { admission: policy, moderationSigner: address(moderationSigner.address.toLowerCase()), recognition }, publisherRevocations: [],
  };
  const authority = { namespace: recognition.namespace, profileSha256: recognition.sha256,
    communityId, communityOrigin: config.app.origin, publisher, configurationRevision: 1, enabled: true };
  const submissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", jobId = `publication:${submissionId}`;
  const terms = { revision: 1, allowsDerivatives: false };
  const audio = await preparePin(new TextEncoder().encode("Synthetic audio"), "audio/mpeg");
  const intent = acceptedIntent({
    schema: "pirate.recognition-accepted-intent/1", namespace: recognition.namespace, profileSha256: recognition.sha256,
    communityId, communityOrigin: config.app.origin, configurationRevision: 1, jobId, submissionId, inputHash: hashJson("Input"),
    authoritySha256: hashJson("Authority"), ownerAuthorizationSha256: hashJson("Owner"), creatorKey: `eip155:6343:${proofSigner}`,
    postId, publicationRevision: 1, audioSha256: audio.sha256, audioBytes: audio.byteLength, audioObjectKey: "staging/fixture",
    audioRevision: 1, audioEtag: "fixture", metadataSha256: hashJson("Metadata"), termsRevision: 1,
    termsSha256: hashJson(terms), allowsDerivatives: terms.allowsDerivatives, acceptedAt: Date.now(),
  });
  const post = canonical({
    schema: "pirate.community-post/4", chainId: 6343, postsContract, communityId, postId, authorId, kind: "song",
    configurationRevision: 1, revision: 1, publishedAt: Math.floor(Date.now() / 1000),
    title: "Synthetic test song", language: "en", rating: "general", terms, media: [{ role: "audio", ...audio }],
    admission: { policyVersion: policy.version, policySha256: policy.sha256, decision: "publish", rating: "general",
      coverDisplayed: false, evidenceSha256: hashJson(intent), automatedContent: "deferred", declarationSource: "operator_declared" },
    recognition: { namespace: recognition.namespace, profileSha256: recognition.sha256, intentSha256: hashJson(intent),
      reservationId: reservationId(intent), recordingId },
    registration: { status: "absent", reason: "deferred_for_launch" },
  });
  const manifest = await preparePin(new TextEncoder().encode(post), "application/json");
  const publication = { communityId, postId, authorId, configurationRevision: 1,
    manifestSha256: manifest.sha256, manifestURI: manifest.uri };
  const selected: ProtectedCatalogOriginalSelection = {
    kind: "protected",
    original: {
      reference: { schema: "pirate.native-posts-publication-reference/1", installationId, releaseSha256,
        jobId, operationId: hashJson({ job: jobId, step: "publication" }), requestHash: hashJson("App original") },
      applicationOriginalSha256: hashJson("Application original"), grantSha256: hashJson("Grant"),
      retainedCustodySha256: hashJson("Protected custody"), proofSigner, publication,
      intentSha256: hashJson(intent), recordingId, configuration: config,
      quote: { quoteSha256: hashJson("Quote"), initiatingLeaseSha256: hashJson("Lease"),
        maximumFeeWei: "100100", expiresAtMs: Date.now() - 1_000 },
    },
  };
  const transactionHash = hashJson("Exact transaction"), blockHash = hashJson("Receipt block");
  const facts = { state: "confirmed" as const, transactionHash, blockHash, blockNumber: "16",
    actualFeeWei: "70781", postId, revision: 1 as const };
  let fee = facts.actualFeeWei, receiptSafe = true, media = post;
  let outcome: "confirmed" | "reverted" | "unavailable" = "confirmed";
  const client = createPublicClient({ transport: custom({ async request({ method, params }) {
    if (method === "eth_getBlockByNumber") return {
      number: (params as string[])[0] === "safe" && !receiptSafe ? "0xf" : "0x10",
      hash: blockHash, timestamp: numberToHex(Math.floor(Date.now() / 1000)),
    };
    throw Error("unexpected RPC " + method);
  } }) });
  let selectedRead: ProtectedCatalogOriginalSelection | null = selected;
  const resolver = createProtectedCatalogSelector({
    async readAdmittedOriginal() { return selectedRead; },
    client,
    async readCanonicalOriginal(expected, hash, cap) {
      assert.deepEqual(expected, publication);
      assert.equal(hash, transactionHash);
      assert.equal(cap, 100100n);
      if (outcome === "unavailable") return null;
      if (outcome === "reverted")
        return { state: "reverted", transactionHash, blockHash, blockNumber: "16", actualFeeWei: fee };
      return { ...facts, actualFeeWei: fee };
    },
    limits: { maximumSafeAgeSeconds: 60n, maximumTotalFee: 100100n },
    async ipfs() { return new Response(media); },
  });
  return {
    resolver, authority, intent, selected, transactionHash, facts, config, recognitionSigner, moderationSigner,
    client, publisherAccount,
    noSelection: () => { selectedRead = null; }, useLegacy: () => { selectedRead = { kind: "legacy" }; },
    overcharge: () => { fee = "200000"; }, lowerSafe: () => { receiptSafe = false; },
    unavailable: () => { outcome = "unavailable"; },
    replaceManifest: () => { media = "{}"; }, revert: () => { outcome = "reverted"; },
  };
}

test("compact reservation evidence requires an exact live exchange and independently signed absence", async (t) => {
  const f = await fixture();
  const now = Math.floor(Date.now() / 1000);
  t.mock.method(Date, "now", () => now * 1000 + 500);
  const { jobId, installationId, releaseSha256 } = f.selected.original.reference;
  const profile = f.config.policies.recognition!;
  const lease = "synthetic accepting lease";
  const original = { jobId, content: "Exact catalog reserve" };
  const operation: ExternalOperation = {
    operation_id: hashJson({ job: jobId, step: "catalog_reserve" }),
    job_id: jobId, step: "catalog_reserve", request_hash: hashJson(original), request_json: canonical(original),
    status: "running", provider_id: null, result_json: null, prepared_json: null,
  };
  let state: "ready" | "absent" = "ready";
  let status = 200, requestExpiresAt = now + 3, wrongEcho = false, calls = 0;
  const transport: ProtectedCatalogTransport = {
    installationId, releaseSha256,
    async exchange(path, raw) {
      ++calls;
      assert.equal(path, nativePostsCatalogReservationPath);
      const request = JSON.parse(raw);
      assert.deepEqual(request.reference, { installationId, releaseSha256, jobId, step: operation.step,
        operationId: operation.operation_id, requestHash: operation.request_hash });
      assert.equal(request.initiatingLeaseSha256, request.purpose === "reserve" ? hashText(lease) : undefined);
      const requestSha256 = hashJson({ nonce: calls });
      const payload: ReservationReceipt = {
        schema: "pirate.recognition-reservation-receipt/1",
        purpose: state === "ready" ? "accepted_intent" : "reservation_absent",
        namespace: profile.namespace, profileSha256: profile.sha256, communityId: f.intent.communityId,
        configurationRevision: f.intent.configurationRevision, requestSha256, intentSha256: hashJson(f.intent),
        reservationId: reservationId(f.intent), recordingId: state === "ready" ? f.selected.original.recordingId : null,
        state, recordingState: state === "ready" ? "ready" : null, postingSha256: null, publicationSha256: null,
        issuedAt: now, expiresAt: now + 10,
      };
      const receipt = await signReservation(f.recognitionSigner, payload);
      return new Response(canonical({ reference: wrongEcho ? hashJson("Other command") : hashJson(request),
        result: { requestSha256, requestExpiresAt, receipt } }), { status, headers: { "content-type": "application/json" } });
    },
  };
  const reserve = () => readProtectedCatalogReservation(transport, "reserve", operation, f.intent, profile, lease);
  const readStatus = () => readProtectedCatalogReservation(transport, "status", operation, f.intent, profile);
  const accepted = await reserve();
  assert.equal(accepted.receipt.recordingId, f.selected.original.recordingId);
  assert.equal(accepted.expiresAtMs, (now + 3) * 1000);
  state = "absent";
  assert.equal((await readStatus()).receipt.purpose, "reservation_absent");
  await assert.rejects(reserve, /recognition_reservation_scope_mismatch/);
  status = 202;
  await assert.rejects(readStatus, /protected_catalog_owner_unavailable/);
  status = 200;
  wrongEcho = true;
  await assert.rejects(readStatus, /protected_catalog_reply_changed/);
  wrongEcho = false;
  requestExpiresAt = now;
  await assert.rejects(readStatus, /invalid_integer/);
  const beforeInvalidStep = calls;
  await assert.rejects(readProtectedCatalogReservation(transport, "ready", { ...operation, step: "pin_audio" },
    f.intent, profile, lease), /protected_catalog_original_changed/);
  assert.equal(calls, beforeInvalidStep);
});

test("the protected selection route consumes only the authenticated exact response and issuer", async () => {
  const f = await fixture();
  const original = f.selected.original;
  const { configuration, ...binding } = original;
  let replyStatus = 200;
  let proofSigner = original.proofSigner;
  const consumer = canonicalCommunityClient({
    signer: f.recognitionSigner,
    async currentConfiguration() { return f.config; },
    chain: { client: f.client, posts: { address: f.config.postsContract,
      runtimeCodeHash: hashJson("Posts runtime"), deploymentBlock: 1n } },
    async transport(request) {
      const response = await protectedCanonicalSelectionFetch(request, f.config, async (wire) => {
        assert.deepEqual(wire.body, { jobId: f.intent.jobId, intentSha256: hashJson(f.intent),
          reservationId: reservationId(f.intent) });
        return canonicalResponse(wire, configuration, f.publisherAccount, {
          schema: "pirate.protected-catalog-selection/1",
          ...binding, publisher: configuration.publisher, postsContract: configuration.postsContract, proofSigner,
        });
      });
      assert(response);
      return replyStatus === 200 ? response : new Response(response.body, { status: replyStatus, headers: response.headers });
    },
  });
  assert.deepEqual(await consumer.protectedSelection(f.intent, original.proofSigner), f.selected);
  replyStatus = 202;
  await assert.rejects(consumer.protectedSelection(f.intent, original.proofSigner), /canonical_community_unavailable/);
  replyStatus = 200;
  proofSigner = configuration.publisher;
  await assert.rejects(consumer.protectedSelection(f.intent, original.proofSigner), /protected_catalog_selection_changed/);
});

test("only the current recognition signer can authorize the exact protected selection request", async () => {
  const f = await fixture();
  const body = { jobId: f.intent.jobId, intentSha256: hashJson(f.intent), reservationId: reservationId(f.intent) };
  const request = await signCanonicalRequest(f.recognitionSigner, f.config, "protected_selection", body);
  assert.deepEqual(await authorizeCanonicalRequest(request, f.config), request);
  const moderator = await signCanonicalRequest(f.moderationSigner, f.config, "protected_selection", body);
  await assert.rejects(authorizeCanonicalRequest(moderator, f.config), /canonical_caller_forbidden/);
  const extra = await signCanonicalRequest(f.recognitionSigner, f.config, "protected_selection", { ...body, selection: "caller" });
  await assert.rejects(authorizeCanonicalRequest(extra, f.config));
});

test("the protected canonical bridge preserves roles, exact response evidence and binary audio", async () => {
  const f = await fixture();
  const operationId = hashJson({ purpose: "original-identification/1", reservationId: reservationId(f.intent) });
  const audio = new Uint8Array([1, 2, 3]);
  const actions: string[] = [];
  let budgetCalls = 0;
  const app: Parameters<typeof protectedCanonicalFetch>[2] = {
    async currentConfiguration() { return f.config; },
    async authorize(source, id) {
      assert.deepEqual(source, f.intent);
      assert.equal(id, operationId);
      ++budgetCalls;
    },
    async respond(wire) {
      actions.push(wire.payload.action);
      return canonicalResponse(wire, f.config, f.publisherAccount, wire.payload.action === "audio" ? audio : { matched: true });
    },
  };
  const call = async (
    signer: Parameters<typeof signCanonicalRequest>[0],
    action: Parameters<typeof signCanonicalRequest>[2],
    body: Record<string, unknown>,
  ) => {
    const wire = await signCanonicalRequest(signer, f.config, action, body);
    return protectedCanonicalFetch(new Request(f.config.app.origin + "/api/internal/catalog", {
      method: "POST", headers: { "content-type": "application/json" }, body: canonical(wire),
    }), f.config, app);
  };
  const read = await call(f.recognitionSigner, "read", { jobId: f.intent.jobId });
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.deepEqual(await read.json(), { matched: true });
  const binary = await call(f.moderationSigner, "audio", { source: f.intent });
  assert.equal(binary.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await binary.arrayBuffer()), audio);
  await call(f.moderationSigner, "ready", { intent: f.intent });
  await assert.rejects(call(f.recognitionSigner, "ready", { intent: f.intent }), /canonical_caller_forbidden/);
  await assert.rejects(call(f.moderationSigner, "source", { source: f.intent }), /canonical_caller_forbidden/);
  await assert.rejects(call(f.moderationSigner, "authorize", { source: f.intent, operationId }), /canonical_caller_forbidden/);
  await call(f.recognitionSigner, "source", { source: f.intent });
  await call(f.recognitionSigner, "authorize", { source: f.intent, operationId });
  assert.deepEqual(actions, ["read", "audio", "ready", "source", "authorize"]);
  assert.equal(budgetCalls, 1);
});

test("a keyless owner pin submits only the exact app original and live lease", async () => {
  const f = await fixture();
  const origin = "https://managed.example";
  const body = { context: { jobId: f.intent.jobId }, role: "audio" };
  const jobId = f.intent.jobId;
  const operation: ExternalOperation = {
    job_id: jobId, operation_id: hashJson({ job: jobId, step: "pin_audio" }), request_hash: hashJson("Saved pin request"),
    request_json: "{}", prepared_json: "{}", step: "pin_audio", status: "running", result_json: null, provider_id: null,
  };
  const job: PublicationJob = {
    job_id: jobId, submission_id: f.intent.submissionId, input_hash: f.intent.inputHash, phase: "pin_audio",
    authority_json: "{}", progress_json: "{}", lease_token: "selected lease", lease_until: Date.now() + 10000, revision: 1,
  };
  let sends = 0;
  const client: ManagedClient = {
    origin, configuration: f.config,
    async protectedPin(request) {
      sends++;
      assert.deepEqual(request, {
        purpose: "pin", reference: { jobId, operationId: operation.operation_id, requestHash: operation.request_hash, step: "pin_audio" },
        initiatingLeaseSha256: hashText(job.lease_token!),
      });
      return { status: 200, body: { state: "retained" } };
    },
    async transport() { throw new Error("no provider signing or HTTPS fetch in Workerd"); },
  };
  const send = () => managedRequest(client, "/v1/owner-releases/pin", "release_pin", body, { operation, job });
  assert.deepEqual(await send(), { status: 200, body: { state: "retained" } });
  job.lease_until = Date.now();
  await assert.rejects(send(), /protected_managed_pin_lease_unavailable/);
  assert.equal(sends, 1);
});

test("selector permits only an independently selected original or explicit legacy", async () => {
  const f = await fixture();
  await assert.rejects(f.resolver(f.authority, { ...f.intent, postId: hashJson("Other song") }), /protected_catalog_original_changed/);
  f.noSelection();
  await assert.rejects(f.resolver(f.authority, f.intent), /protected_catalog_selection_unavailable/);
  f.useLegacy();
  assert.equal(await f.resolver(f.authority, f.intent), null);
});

test("selector independently checks exact mined publication, all-in facts and public manifest", async () => {
  const f = await fixture();
  const selected = await f.resolver(f.authority, f.intent);
  assert(selected);
  assert.deepEqual(await selected.readCanonical(f.transactionHash), f.facts);
  f.unavailable();
  assert.deepEqual(await selected.readCanonical(f.transactionHash), { state: "unavailable" });
  f.revert();
  assert.deepEqual(await selected.readCanonical(f.transactionHash), { state: "reverted" });
  f.overcharge();
  await assert.rejects(selected.readCanonical(f.transactionHash), /protected_catalog_receipt_changed/);
});

test("readback refuses late safe-head displacement and unverifiable public bytes", async () => {
  const f = await fixture();
  const selected = await f.resolver(f.authority, f.intent);
  assert(selected);
  f.lowerSafe();
  await assert.rejects(selected.readCanonical(f.transactionHash), /protected_catalog_receipt_not_safe/);
  f.replaceManifest();
  await assert.rejects(selected.readCanonical(f.transactionHash), /public_ipfs_unavailable/);
});
