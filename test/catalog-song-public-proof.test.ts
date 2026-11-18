import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashJson } from "../packages/community/common.ts";
import { publicationData } from "../packages/community/post-chain.ts";
import type { PostManifest } from "../packages/community/post-manifest.ts";
import type { RecognitionProfile } from "../packages/recognition/intent.ts";
import { signReservation } from "../packages/recognition/reservation-receipt.ts";
import {
  catalogSongPublicProof, verifyCatalogSongPublicProof,
} from "../services/catalog-song-public-proof.ts";

const hex = (digit: string): Hex => ("0x" + digit.repeat(64)) as Hex;
const clock = 2_000_000;
const publicationSigner = privateKeyToAccount(hex("2"));
const recognitionSigner = privateKeyToAccount(hex("3"));

test("portable catalog proof binds a historical managed signature to the exact mined public song", async () => {
  const input = {
    schema: "pirate.recognition-profile/1" as const,
    namespace: hex("1"),
    signer: recognitionSigner.address.toLowerCase(),
    origin: "https://recognition.example",
    providerBindingSha256: hex("4"),
  };
  const profile: RecognitionProfile = { ...input, sha256: hashJson(input) };
  const ref = {
    communityId: hex("5"), postId: hex("6"), authorId: hex("7"), configurationRevision: 1,
    manifestURI: "ipfs://bafkreif42jl3w5sfjqelqdqlbd4zqol6e53eriuziihqo25m5hanowj4ee",
  };
  const postsContract = "0x" + "9".repeat(40) as `0x${string}`;
  const post = {
    communityId: ref.communityId, postId: ref.postId, authorId: ref.authorId,
    configurationRevision: 1, postsContract, revision: 1, schema: "pirate.community-post/4",
    recognition: {
      namespace: profile.namespace, profileSha256: profile.sha256,
      intentSha256: hex("a"), reservationId: hex("b"), recordingId: hex("c"),
    },
  } as PostManifest;
  const raw = await publicationSigner.signTransaction({
    data: publicationData({ ...ref, manifestSha256: hashJson(post) }), to: postsContract, type: "legacy",
    chainId: 6343, gas: 50_000n, gasPrice: 7n, nonce: 3,
  });
  const posting = {
    transactionHash: keccak256(raw), signedTransaction: raw, nonce: 3,
    operationId: hex("d"), requestHash: hex("e"),
  };
  const receiptPayload = {
    schema: "pirate.recognition-reservation-receipt/1" as const,
    purpose: "accepted_intent" as const,
    namespace: profile.namespace, profileSha256: profile.sha256, communityId: ref.communityId,
    configurationRevision: 1, requestSha256: hex("f"),
    intentSha256: post.recognition!.intentSha256, reservationId: post.recognition!.reservationId,
    recordingId: post.recognition!.recordingId, state: "committed", recordingState: "ready",
    postingSha256: hashJson(posting), publicationSha256: hex("a"), issuedAt: 1_100, expiresAt: 1_133,
  };
  const receipt = await signReservation(recognitionSigner, receiptPayload);
  const record = { post, transactionHash: posting.transactionHash, blockNumber: "150" };
  const chain = {
    ...ref, blockHash: hex("b"), transactionHash: posting.transactionHash, blockNumber: "150",
  };
  const expected = { record, profile, now: clock };
  const row = {
    posting_json: JSON.stringify(posting), promotion_receipt_json: JSON.stringify(receipt),
    chain_receipt_json: JSON.stringify({ ...chain, revision: 1 }),
  };
  const proof = await catalogSongPublicProof(row, expected);
  assert.deepEqual(await verifyCatalogSongPublicProof(proof, expected), proof);
  assert.deepEqual(Object.keys(proof).sort(), ["posting", "receipt", "schema"]);
  await assert.rejects(verifyCatalogSongPublicProof({
    ...proof, posting: { ...posting, operationId: hex("2") },
  }, expected));
  await assert.rejects(verifyCatalogSongPublicProof({
    ...proof, receipt: await signReservation(publicationSigner, receiptPayload),
  }, expected));
  await assert.rejects(verifyCatalogSongPublicProof({
    ...proof, receipt: await signReservation(recognitionSigner, { ...receiptPayload, state: "committing" }),
  }, expected));
  await assert.rejects(verifyCatalogSongPublicProof({
    ...proof, receipt: await signReservation(recognitionSigner, { ...receiptPayload, issuedAt: clock + 1, expiresAt: clock + 31 }),
  }, expected));
  await assert.rejects(catalogSongPublicProof({
    ...row, chain_receipt_json: JSON.stringify({ ...chain, transactionHash: hex("3") }),
  }, expected));
  await assert.rejects(verifyCatalogSongPublicProof(proof, {
    ...expected, record: { ...record, transactionHash: hex("3") },
  }));
  await assert.rejects(verifyCatalogSongPublicProof(proof, {
    ...expected, record: { ...record, post: { ...post, recognition: { ...post.recognition!, reservationId: hex("4") } } },
  }));
});
