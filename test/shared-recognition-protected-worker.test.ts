import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, sha256 } from "viem";
import { bytes32, canonical, hashJson, hashText, object } from "../packages/community/common.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { publicationData } from "../packages/community/post-chain.ts";
import { reservationId } from "../packages/recognition/intent.ts";
import { verifyReservation } from "../packages/recognition/reservation-receipt.ts";
import type { ProtectedCatalogCanonical, ProtectedCatalogOriginal } from "../packages/recognition/protected-catalog.ts";
import { managedServicesFixture } from "./fixtures/managed-first-song-services.ts";

test("the bundled Recognition Worker authenticates the protected original before bind and verifies canonical promotion", async () => {
  const f = await managedServicesFixture({ protectedCatalog: true, typedOwnerAuthorization: true });
  try {
    assert.equal((await f.prepare()).status, 200);
    assert.equal((await f.attach()).status, 200);
    const intent = await f.acceptCanonicalIntent(), profile = f.chain.current().policies.recognition!;
    await assert.rejects(f.recognitionClient().reserve(intent));
    const ready = await f.waitRecognitionReady(intent);
    assert.equal(ready.state, "ready");
    const recordingId = bytes32(ready.recordingId);
    const postId = bytes32(intent.postId);
    const readyEvidence = await f.recognitionClient().statusEvidence(intent);
    const { pins, proofAccount, publisher } = f.protectedFixture;
    const frames = new Uint8Array(1600 * 417);
    for (let i = 0; i < frames.length; i += 417) frames.set([0xff, 0xfb, 0x90, 0], i);
    const audio = await preparePin(frames, "audio/mpeg");
    assert.equal(audio.sha256, intent.audioSha256);
    const authorId = hashText("retained integration author");
    const terms = { revision: 1, allowsDerivatives: false };
    const post = {
      schema: "pirate.community-post/4", chainId: 6343, postsContract: f.chain.current().postsContract,
      communityId: intent.communityId, postId, authorId, kind: "song",
      configurationRevision: 1, revision: 1, publishedAt: Math.floor(Date.now() / 1000),
      title: "Managed service original", language: "en", rating: "general", terms,
      media: [{ role: "audio", ...audio }],
      admission: { policyVersion: f.chain.current().policies.admission.version,
        policySha256: f.chain.current().policies.admission.sha256, decision: "publish", rating: "general",
        coverDisplayed: false, evidenceSha256: hashJson(intent), automatedContent: "deferred", declarationSource: "operator_declared" },
      recognition: { namespace: profile.namespace, profileSha256: profile.sha256, intentSha256: hashJson(intent),
        reservationId: reservationId(intent), recordingId },
      registration: { status: "absent", reason: "deferred_for_launch" },
    };
    const manifestBytes = new TextEncoder().encode(canonical(post));
    const manifest = await preparePin(manifestBytes, "application/json");
    f.chain.contents.set(manifest.uri.slice(7), manifestBytes);
    const publication = { communityId: f.chain.profile.communityId, postId,
      authorId, configurationRevision: 1, manifestSha256: manifest.sha256, manifestURI: manifest.uri };
    const reference = { schema: "pirate.native-posts-publication-reference/1" as const,
      installationId: f.chain.profile.installationId, releaseSha256: pins.releaseSha256, jobId: intent.jobId,
      operationId: hashJson({ job: intent.jobId, step: "publication" }), requestHash: hashText("test primary original") };
    const quote = { quoteSha256: hashText("test exact quote"), initiatingLeaseSha256: hashText("test exact lease"),
      maximumFeeWei: pins.feePolicy.maximumTotalFee, expiresAtMs: readyEvidence.payload.expiresAt * 1000 };
    const selection = { schema: "pirate.protected-catalog-selection/1", reference, quote, publication,
      applicationOriginalSha256: pins.applicationOriginalSha256, retainedCustodySha256: pins.retainedCustodySha256,
      grantSha256: bytes32(f.registration.grant.sha256), intentSha256: hashJson(intent), recordingId,
      proofSigner: pins.proofSigner, postsContract: f.chain.current().postsContract, publisher: f.chain.current().publisher };

    const calldata = publicationData(publication);
    const signedTransaction = await publisher.signTransaction({ chainId: 6343, type: "legacy",
      to: f.chain.current().postsContract, data: calldata, value: 0n, gas: 500000n, gasPrice: 1000000n,
      nonce: await f.chain.client.getTransactionCount({ address: publisher.address }) });
    const transactionHash = keccak256(signedTransaction);
    const common = { domain: { name: "Pirate Protected Posts Catalog", version: "1" },
      types: { Original: [{ name: "payloadSha256", type: "bytes32" }], Canonical: [{ name: "payloadSha256", type: "bytes32" }] } } as const;
    const payload: ProtectedCatalogOriginal = {
      schema: "pirate.protected-posts-catalog-original/1", reference,
      applicationOriginalSha256: selection.applicationOriginalSha256, grantSha256: selection.grantSha256,
      intentSha256: hashJson(intent), reservationId: reservationId(intent), quoteSha256: quote.quoteSha256,
      initiatingLeaseSha256: quote.initiatingLeaseSha256, maximumFeeWei: quote.maximumFeeWei,
      calldataSha256: sha256(calldata), transactionHash,
      retainedOriginalSha256: hashJson({ schema: "pirate.protected-posts-retained-original/1",
        retainedCustodySha256: selection.retainedCustodySha256, reference, quoteSha256: quote.quoteSha256,
        initiatingLeaseSha256: quote.initiatingLeaseSha256, publisher: selection.publisher,
        postsContract: selection.postsContract, calldataSha256: sha256(calldata), transactionHash }),
      readyRequestSha256: hashJson(readyEvidence.request), readyReceiptSha256: hashJson(readyEvidence.receipt),
      recordingId, bindExpiresAtMs: quote.expiresAtMs,
    };
    const original = { payload, signature: await proofAccount.signTypedData({ ...common,
      primaryType: "Original", message: { payloadSha256: hashJson(payload) } }) };
    const posting = { schema: "pirate.protected-posts-catalog-posting/1", operationId: reference.operationId,
      requestHash: reference.requestHash, transactionHash, originalSha256: hashJson(payload) };
    const bind = { jobId: intent.jobId, posting, original, readyReceipt: readyEvidence.receipt };

    const missing = await f.protectedFixture.send("intent_bind", bind);
    assert.equal(missing.response.status, 503);
    f.protectedFixture.select(selection);
    await f.protectedFixture.configuration("other-release");
    const mismatched = await f.protectedFixture.send("intent_bind", bind);
    assert.equal(mismatched.response.status, 503);
    assert.deepEqual(await mismatched.response.json(), { error: "protected_catalog_installation_changed" });
    await f.protectedFixture.configuration("missing");
    assert.equal((await f.protectedFixture.send("intent_bind", bind)).response.status, 503);
    await f.protectedFixture.configuration("legacy");
    assert.equal((await f.protectedFixture.send("intent_bind", bind)).response.ok, false);
    await f.protectedFixture.configuration("protected");
    assert.equal((await f.recognitionClient().status(intent)).state, "ready");

    const ack = await f.protectedFixture.send("intent_bind", bind);
    assert.equal(ack.response.status, 200, await ack.response.clone().text());
    const expected = { reservationId: reservationId(intent), intentSha256: hashJson(intent), communityId: intent.communityId,
      configurationRevision: 1, recordingId, postingSha256: hashJson(posting), recordingState: "ready" };
    const bound = await verifyReservation(object(await ack.response.json()).receipt, profile,
      { ...expected, purpose: "posting_bound", state: "committing", requestSha256: hashJson(ack.request) }, Math.floor(Date.now() / 1000));
    assert.equal(bound.publicationSha256, null);
    assert.equal(await f.chain.client.getTransactionReceipt({ hash: transactionHash }).catch(() => null), null);

    // Mine only the exact matched original on the disposable local chain after the signed acknowledgment.
    assert.equal(await f.chain.client.sendRawTransaction({ serializedTransaction: signedTransaction }), transactionHash);
    const mined = await f.chain.client.waitForTransactionReceipt({ hash: transactionHash });
    f.protectedFixture.postHash(transactionHash);
    await f.chain.rpc("anvil_mine", ["0x40", "0x0"]);
    const facts: ProtectedCatalogCanonical = { schema: "pirate.protected-posts-catalog-canonical/1",
      postingSha256: hashJson(posting), state: "confirmed", transactionHash, blockHash: mined.blockHash,
      blockNumber: mined.blockNumber.toString(), actualFeeWei: (mined.gasUsed * mined.effectiveGasPrice).toString(),
      postId: publication.postId, revision: 1 };
    const makeProof = async (payload: ProtectedCatalogCanonical) => ({ payload, signature: await proofAccount.signTypedData({
      ...common, primaryType: "Canonical", message: { payloadSha256: hashJson(payload) },
    }) });
    const promote = async (payload: ProtectedCatalogCanonical) =>
      f.protectedFixture.send("intent_commit", { jobId: intent.jobId, posting, original, canonical: await makeProof(payload) });
    const badFee = await promote({ ...facts, actualFeeWei: (BigInt(facts.actualFeeWei) + 1n).toString() });
    assert.equal(badFee.response.status, 409, await badFee.response.clone().text());
    assert.equal((await f.recognitionClient().status(intent)).state, "committing");
    const promoted = await promote(facts);
    assert.equal(promoted.response.status, 200, await promoted.response.clone().text());
    const receipt = await verifyReservation(object(await promoted.response.json()).receipt, profile,
      { ...expected, purpose: "publication_promoted", state: "committed", requestSha256: hashJson(promoted.request) },
      Math.floor(Date.now() / 1000));
    assert(receipt.publicationSha256);
    await f.restartRecognition();
    assert.equal((await f.recognitionClient().status(intent)).publicationSha256, receipt.publicationSha256);
  } finally { await f.close(); }
});
