import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, custom, numberToHex } from "viem";
import { canonical, hashJson } from "../packages/community/common.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { address } from "../packages/community/manifest-core.ts";
import { CATALOG_OWNER_POLICY_HASH, CATALOG_OWNER_POLICY_VERSION } from "../packages/community/owner-policy.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import { acceptedIntent, reservationId } from "../packages/recognition/intent.ts";
import { createProtectedCatalogSelector, type ProtectedCatalogOriginalSelection } from "../services/protected-catalog-selection.ts";

async function fixture() {
  const publisher = address("0x" + "1".repeat(40));
  const postsContract = address("0x" + "2".repeat(40));
  const proofSigner = address("0x" + "3".repeat(40));
  const communityId = hashJson("Catalog community"), postId = hashJson("Original song"),
    authorId = hashJson("Song author"), recordingId = hashJson("Catalog recording"),
    installationId = hashJson("Directory installation"), releaseSha256 = hashJson("Installed release");
  const profileBody = {
    schema: "pirate.recognition-profile/1" as const, namespace: hashJson("Namespace"),
    origin: "https://recognition.example", signer: address("0x" + "4".repeat(40)),
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
    policies: { admission: policy, moderationSigner: publisher, recognition }, publisherRevocations: [],
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
    resolver, authority, intent, selected, transactionHash, facts,
    noSelection: () => { selectedRead = null; }, useLegacy: () => { selectedRead = { kind: "legacy" }; },
    overcharge: () => { fee = "200000"; }, lowerSafe: () => { receiptSafe = false; },
    unavailable: () => { outcome = "unavailable"; },
    replaceManifest: () => { media = "{}"; }, revert: () => { outcome = "reverted"; },
  };
}

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
