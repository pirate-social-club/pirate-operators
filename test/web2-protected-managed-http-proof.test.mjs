import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoverTypedDataAddress, sha256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashJson } from "../packages/community/common.ts";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import { CATALOG_OWNER_POLICY_HASH, CATALOG_OWNER_POLICY_VERSION } from "../packages/community/owner-policy.ts";
import { publicationData } from "../packages/community/post-chain.ts";
import { evidenceDomain } from "../packages/moderation/evidence.ts";
import { serviceRequestTypes } from "../packages/moderation/pairing.ts";
import { recognitionDomain, recognitionRequestTypes } from "../packages/recognition/authorization.ts";
import { reservationId } from "../packages/recognition/intent.ts";
import { signReservation } from "../packages/recognition/reservation-receipt.ts";
import { pinOperationId } from "../packages/release/artifacts.ts";
import { ownerReleaseKey } from "../packages/release/owner-release.ts";
import { createProtectedManagedHttpProof } from "../deploy/linux/web2-protected-managed-http-proof.ts";

const hash = name => hashJson({ fixture: name });
const account = () => privateKeyToAccount(generatePrivateKey());
const lower = key => key.address.toLowerCase();
const origin = "https://staging.jazleeuw.club";
const publishing = "https://pirate-managed-publishing-staging.piratesocialclub.workers.dev";
const recognition = "https://pirate-managed-publishing-staging-recognition.piratesocialclub.workers.dev";
const serviceOperationId = "web2-service-01234567-0123-4123-8123-0123456789ab";
const submissionId = "01234567-0123-4123-8123-0123456789ab";
const jobId = "publication:" + submissionId;
const issuedAt = 1_795_000_000;
const authorId = hash("author");

async function fixture(t) {
  const publisher = account(), owner = account(), receiptSigner = account(), proofSigner = account();
  const journalDirectory = await mkdtemp(join(tmpdir(), "pirate-managed-proof-"));
  t.after(() => rm(journalDirectory, { force: true, recursive: true }));
  const identity = { chainId: 6343, postsContract: lower(account()), communityId: hash("community"), postId: hash("post") };
  const admission = { version: CATALOG_OWNER_POLICY_VERSION, sha256: CATALOG_OWNER_POLICY_HASH };
  const profileOriginal = { schema: "pirate.recognition-profile/1", origin: recognition, namespace: hash("namespace"),
    signer: lower(receiptSigner), providerBindingSha256: hash("provider") };
  const profile = { ...profileOriginal, sha256: hashJson(profileOriginal) };
  const configuration = { schema: "pirate.community-config/4", chainId: 6343, app: { origin },
    communityId: identity.communityId, installationId: hash("installation"), postsContract: identity.postsContract,
    publisher: lower(publisher), configurationRevision: 4, policies: { admission } };
  const grantOriginal = { schema: "pirate.owner-publishing-grant/1", communityId: identity.communityId, communityOrigin: origin,
    ownerWallet: lower(owner), policy: admission, destination: { chainId: 6343, postsContract: identity.postsContract,
      publisher: lower(publisher) }, validFrom: issuedAt - 1, expiresAt: issuedAt + 900,
    limits: { songs: 1, pinAdds: 6, pinBytes: "10000", recognitionRequests: 4, postFeeWei: "800000" } };
  const grant = { ...grantOriginal, sha256: hashJson(grantOriginal) };
  const context = { jobId, postId: identity.postId, admissionId: hash("admission"), authorId, recipient: lower(owner),
    lineage: "root", lyrics: createLyrics(identity, "Staging lyric"), rating: "general" };
  const intent = { schema: "pirate.recognition-accepted-intent/1", namespace: profile.namespace, profileSha256: profile.sha256,
    communityId: identity.communityId, communityOrigin: origin, configurationRevision: 4, jobId, submissionId, inputHash: hash("input"),
    authoritySha256: hash("authority"), ownerAuthorizationSha256: hash("authorization"), creatorKey: "eip155:6343:" + lower(owner),
    postId: identity.postId, publicationRevision: 1, audioSha256: hash("audio"), audioBytes: 1024,
    audioObjectKey: "staging/fixture", audioRevision: 1, audioEtag: "fixture", metadataSha256: hash("metadata"),
    termsRevision: 1, termsSha256: hash("terms"), allowsDerivatives: true, acceptedAt: issuedAt * 1000 - 1 };
  const leaseIntentSha256 = hash("lease").slice(2);
  const live = { serviceOperationId, leaseIntentSha256, expiresAtMs: (issuedAt + 600) * 1000 };
  const controls = { now: issuedAt * 1000, entries: 0, signatures: 0, current: true, live, publisher, catalog: null,
    beforeKey: async () => {}, afterSign: async () => {} };
  function selected(action, change = {}) {
    const step = { release_pin: "pin_audio", release_pin_status: "pin_audio", intent_reserve: "catalog_reserve",
      intent_status: "catalog_reserve", intent_bind: "publication", intent_commit: "catalog_confirm" }[action];
    return { hostInstallationId: "pirate-staging-web2-6343-01", serviceOperationId, leaseIntentSha256,
      keyReference: "staging-fluence-web2-publisher-6343", generation: 1, configuration, grant,
      subject: action.startsWith("release") ? { action, context, role: "audio" }
        : { action, intent, profile },
      applicationStep: step, applicationOperationId: hashJson({ job: jobId, step }),
      applicationRequestHash: hash("app request:" + step), nonce: hash("nonce:" + action),
      issuedAt, expiresAt: issuedAt + 20, ...change };
  }
  function open(selection) {
    return createProtectedManagedHttpProof({
      selected: selection, now: () => controls.now, journalDirectory,
      async assertCurrent(scope) {
        assert(controls.current, "primary_changed");
        assert.equal(scope.applicationRequestHash, selection.applicationRequestHash);
        assert.equal(scope.grantSha256, grant.sha256);
        assert.equal(scope.configurationSha256, hashJson(configuration));
      },
      assertHeldSync: () => controls.live,
      readCurrentCatalog: async () => controls.catalog,
      async withPublisher(ref, generation, use) {
        controls.entries++;
        assert.equal(ref, "staging-fluence-web2-publisher-6343");
        assert.equal(generation, 1);
        await controls.beforeKey();
        return use({ ...controls.publisher, async signTypedData(message) {
          controls.signatures++;
          const signature = await controls.publisher.signTypedData(message);
          await controls.afterSign();
          return signature;
        } });
      },
    });
  }
  async function catalog() {
    const reference = { schema: "pirate.native-posts-publication-reference/1", installationId: configuration.installationId,
      releaseSha256: hash("release"), jobId, operationId: hashJson({ job: jobId, step: "publication" }), requestHash: hash("post request") };
    const publication = { communityId: identity.communityId, postId: identity.postId, configurationRevision: 4,
      authorId, manifestSha256: hash("manifest"), manifestURI: "ipfs://bafkreiabsnyic5vcde6vn37d3ljdpwqyxbyaqgjrkwqmbw4o545i6hpqfy" };
    const quote = { quoteSha256: hash("quote"), initiatingLeaseSha256: hash("initiating lease"),
      maximumFeeWei: "500000", expiresAtMs: (issuedAt + 30) * 1000 };
    const recordingId = hash("recording"), readyRequestSha256 = hash("ready request");
    const readyReceipt = await signReservation(receiptSigner, {
      schema: "pirate.recognition-reservation-receipt/1", purpose: "accepted_intent", namespace: profile.namespace,
      profileSha256: profile.sha256, communityId: identity.communityId, configurationRevision: 4,
      requestSha256: readyRequestSha256, intentSha256: hashJson(intent), reservationId: reservationId(intent),
      recordingId, state: "ready", recordingState: "ready", postingSha256: null, publicationSha256: null,
      issuedAt: issuedAt - 1, expiresAt: issuedAt + 30,
    });
    const transactionHash = hash("fixture transaction"), calldataSha256 = sha256(publicationData(publication));
    const retainedCustodySha256 = hash("custody");
    const applicationOriginalSha256 = hash("app original");
    const retainedOriginalSha256 = hashJson({ schema: "pirate.protected-posts-retained-original/1",
      retainedCustodySha256, reference, quoteSha256: quote.quoteSha256, initiatingLeaseSha256: quote.initiatingLeaseSha256,
      publisher: configuration.publisher, postsContract: configuration.postsContract, calldataSha256, transactionHash });
    const sign = async (primaryType, payload) => ({ payload, signature: await proofSigner.signTypedData({
      domain: { name: "Pirate Protected Posts Catalog", version: "1" },
      types: { [primaryType]: [{ name: "payloadSha256", type: "bytes32" }] }, primaryType,
      message: { payloadSha256: hashJson(payload) },
    }) });
    const original = await sign("Original", { schema: "pirate.protected-posts-catalog-original/1", reference,
      applicationOriginalSha256, grantSha256: grant.sha256, intentSha256: hashJson(intent), reservationId: reservationId(intent),
      quoteSha256: quote.quoteSha256, initiatingLeaseSha256: quote.initiatingLeaseSha256, maximumFeeWei: quote.maximumFeeWei,
      calldataSha256, transactionHash, retainedOriginalSha256, readyRequestSha256, readyReceiptSha256: hashJson(readyReceipt),
      recordingId, bindExpiresAtMs: (issuedAt + 25) * 1000 + 999 });
    const posting = { schema: "pirate.protected-posts-catalog-posting/1", operationId: reference.operationId,
      requestHash: reference.requestHash, transactionHash, originalSha256: hashJson(original.payload) };
    const facts = { state: "confirmed", transactionHash, blockHash: hash("block"), blockNumber: "69", actualFeeWei: "400000",
      postId: intent.postId, revision: 1 };
    const canonical = await sign("Canonical", { schema: "pirate.protected-posts-catalog-canonical/1", postingSha256: hashJson(posting), ...facts });
    controls.catalog = { reference, applicationOriginalSha256, grantSha256: grant.sha256, retainedCustodySha256, quote,
      publisher: configuration.publisher, postsContract: configuration.postsContract, proofSigner: lower(proofSigner), publication,
      recognition: profile, readCanonical: async () => facts };
    return { posting, original, readyReceipt, canonical };
  }
  return { open, selected, controls, context, profile, intent, grant, catalog, publisher };
}

async function checkWire(adapter, url, body, publisher) {
  const output = await adapter.produce(adapter.reference);
  assert.equal(output.url, url);
  assert.deepEqual(output.envelope.body, body);
  const { authorization, signature } = output.envelope;
  assert.equal(authorization.action, adapter.reference.action);
  assert.equal(authorization.nonce, adapter.reference.nonce);
  assert.equal(authorization.expiresAt, adapter.reference.expiresAt);
  assert.equal(authorization.requestSha256 ?? authorization.bodySha256, hashJson(body));
  const service = "requestSha256" in authorization;
  const signer = await recoverTypedDataAddress({
    domain: service ? evidenceDomain : recognitionDomain, types: service ? serviceRequestTypes : recognitionRequestTypes,
    primaryType: service ? "ServiceRequest" : "RecognitionRequest",
    message: { ...authorization, configurationRevision: BigInt(authorization.configurationRevision),
      issuedAt: BigInt(authorization.issuedAt), expiresAt: BigInt(authorization.expiresAt) }, signature,
  });
  assert.equal(signer.toLowerCase(), lower(publisher));
  return output;
}

test("release pin and pin status bind only the exact staged context and role", async t => {
  const f = await fixture(t);
  for (const [action, path] of [["release_pin", "/pin"], ["release_pin_status", "/pin/status"]]) {
    const adapter = f.open(f.selected(action));
    assert.equal(adapter.reference.operationId, pinOperationId(ownerReleaseKey(f.grant, jobId), "audio"));
    await checkWire(adapter, publishing + "/v1/owner-releases" + path, { context: f.context, role: "audio" }, f.publisher);
  }
  assert.equal(f.controls.signatures, 2);
});

test("recognition reserve and status use exactly the selected reservation and job", async t => {
  const f = await fixture(t);
  for (const [action, path] of [["intent_reserve", ""], ["intent_status", "/status"]]) {
    const adapter = f.open(f.selected(action));
    assert.equal(adapter.reference.operationId, reservationId(f.intent));
    const proof = await checkWire(adapter, recognition + "/v1/reservations" + path, { jobId }, f.publisher);
    assert.equal(proof.envelope.authorization.issuedAt, issuedAt);
    assert.equal(f.intent.acceptedAt, issuedAt * 1000 - 1);
  }
});

test("a same-second intent can sign at its actual seal time and a later-second intent is refused", async t => {
  const f = await fixture(t);
  const selected = f.selected("intent_reserve");
  const acceptedAt = issuedAt * 1000 + 17;
  const sameSecond = f.open({ ...selected, subject: { ...selected.subject, intent: { ...f.intent, acceptedAt } } });
  f.controls.now = acceptedAt - 1;
  await assert.rejects(sameSecond.produce(sameSecond.reference), /managed_proof_intent_changed/);
  assert.equal(f.controls.entries, 0);
  f.controls.now = acceptedAt;
  await checkWire(sameSecond, recognition + "/v1/reservations", { jobId }, f.publisher);
  assert.throws(() => f.open({ ...selected, subject: { ...selected.subject,
    intent: { ...f.intent, acceptedAt: (issuedAt + 1) * 1000 } } }), /managed_proof_intent_changed/);
});

test("wire expiry cannot overrun a held millisecond deadline or be replayed at expiry", async t => {
  const f = await fixture(t);
  const selected = f.selected("intent_status");
  const adapter = f.open(selected);
  const deadline = selected.expiresAt * 1000;
  f.controls.live.expiresAtMs = deadline - 1;
  await assert.rejects(adapter.produce(adapter.reference), /managed_proof_authority_expired/);
  assert.equal(f.controls.entries, 0);
  f.controls.live.expiresAtMs = deadline;
  f.controls.now = deadline - 1;
  await checkWire(adapter, recognition + "/v1/reservations/status", { jobId }, f.publisher);
  f.controls.now = deadline;
  await assert.rejects(adapter.produce(adapter.reference), /managed_proof_authority_expired/);
  assert.equal(f.controls.signatures, 1);
});

test("recognition bind and commit use the exact selected Rollout wire and original", async t => {
  const f = await fixture(t);
  const { posting, original, readyReceipt, canonical } = await f.catalog();
  const scope = { intent: f.intent, profile: f.profile, posting, original };
  const bind = f.open(f.selected("intent_bind", { expiresAt: issuedAt + 25,
    subject: { ...scope, action: "intent_bind", readyReceipt } }));
  await checkWire(bind, recognition + "/v1/reservations/bind", { jobId, posting, original, readyReceipt }, f.publisher);
  f.controls.now = (issuedAt + 40) * 1000;
  const commit = f.open(f.selected("intent_commit", { issuedAt: issuedAt + 40, expiresAt: issuedAt + 60,
    subject: { ...scope, action: "intent_commit", canonical, retainedReadyReceipt: readyReceipt } }));
  await checkWire(commit, recognition + "/v1/reservations/commit", { jobId, posting, original, canonical }, f.publisher);
  assert.equal(f.controls.signatures, 2);
});

test("mutated reference fields and application originals never enter custody", async t => {
  const f = await fixture(t);
  const selection = f.selected("release_pin");
  const adapter = f.open(selection);
  for (const change of [{ operationId: hash("bad") }, { bodySha256: hash("bad") }, { nonce: hash("bad") },
    { expiresAt: issuedAt + 21 }, { action: "release_pin_status" }, { hostInstallationId: "wrong" },
    { leaseIntentSha256: "1".repeat(64) }, { body: {} }]) {
    await assert.rejects(adapter.produce({ ...adapter.reference, ...change }), /managed_proof_original_changed|invalid_fields/);
  }
  assert.throws(() => f.open({ ...selection, applicationOperationId: hash("bad") }), /managed_proof_application_original_changed/);
  assert.throws(() => f.open({ ...selection, issuedAt: issuedAt + 0.5 }), /managed_proof_expiry_invalid/);
  assert.throws(() => f.open({ ...selection, expiresAt: issuedAt + 301 }), /managed_proof_expiry_invalid/);
  assert.throws(() => f.open(f.selected("intent_status", { expiresAt: issuedAt + 121 })), /managed_proof_expiry_invalid/);
  f.controls.current = false;
  await assert.rejects(adapter.produce(adapter.reference), /primary_changed/);
  assert.equal(f.controls.entries, 0);
});

test("retained nonce returns the same scoped proof after reopen and rejects a second action", async t => {
  const f = await fixture(t);
  const selected = f.selected("release_pin");
  const first = f.open(selected);
  const result = await first.produce(first.reference);
  const reopened = f.open(selected);
  assert.deepEqual(await reopened.produce(reopened.reference), result);
  const other = f.open(f.selected("release_pin_status", { nonce: selected.nonce }));
  await assert.rejects(other.produce(other.reference), /managed_proof_nonce_conflict/);
  assert.equal(f.controls.signatures, 1);
});

test("concurrent proof attempt and expiry during key acquisition keep nonce held", async t => {
  const f = await fixture(t);
  const selected = f.selected("release_pin");
  const first = f.open(selected), second = f.open(selected);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.controls.beforeKey = async () => { entered.resolve(); await release.promise; };
  const pending = first.produce(first.reference);
  await entered.promise;
  try { await assert.rejects(second.produce(second.reference), /managed_proof_nonce_held/); }
  finally { f.controls.now = selected.expiresAt * 1000; release.resolve(); }
  await assert.rejects(pending, /managed_proof_authority_expired/);
  f.controls.now = issuedAt * 1000;
  await assert.rejects(second.produce(second.reference), /managed_proof_nonce_held/);
  assert.equal(f.controls.entries, 1);
  assert.equal(f.controls.signatures, 0);
});

test("wrong publisher and post-sign lease loss hold each attempted nonce", async t => {
  const f = await fixture(t);
  const wrong = f.open(f.selected("intent_reserve"));
  f.controls.publisher = account();
  await assert.rejects(wrong.produce(wrong.reference), /managed_proof_publisher_changed/);
  assert.equal(f.controls.signatures, 0);
  f.controls.publisher = f.publisher;
  const valid = f.open(f.selected("intent_status"));
  f.controls.afterSign = async () => { f.controls.live = { ...f.controls.live, leaseIntentSha256: "1".repeat(64) }; };
  await assert.rejects(valid.produce(valid.reference), /managed_proof_lease_changed/);
  assert.equal(f.controls.signatures, 1);
});

test("expired ready bind, legacy posting, and divergent safe read fail before the publisher", async t => {
  const f = await fixture(t);
  const { posting, original, readyReceipt, canonical } = await f.catalog();
  const base = { intent: f.intent, profile: f.profile, posting, original };
  const expired = f.open(f.selected("intent_bind", { expiresAt: issuedAt + 26,
    subject: { ...base, action: "intent_bind", readyReceipt } }));
  await assert.rejects(expired.produce(expired.reference), /managed_proof_authority_expired/);
  const legacy = f.open(f.selected("intent_bind", { subject: { ...base, action: "intent_bind", readyReceipt,
    posting: { signedTransaction: "fixture", nonce: 7 } } }));
  await assert.rejects(legacy.produce(legacy.reference), /invalid_fields/);
  f.controls.catalog.readCanonical = async () => ({ state: "unavailable" });
  const commit = f.open(f.selected("intent_commit", {
    subject: { ...base, action: "intent_commit", canonical, retainedReadyReceipt: readyReceipt } }));
  await assert.rejects(commit.produce(commit.reference), /protected_catalog_canonical_mismatch/);
  assert.equal(f.controls.entries, 0);
});
