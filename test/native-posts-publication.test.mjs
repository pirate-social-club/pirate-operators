import assert from "node:assert/strict";
import test from "node:test";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { publicationData } from "../packages/community/post-chain.ts";
import {
  assertNativePostsDispatchProofCurrent,
  nativePostsPublicationResponse,
  readNativePostsDispatchProof,
  readNativePostsDispatchRequest,
  readNativePostsDispatchStatus,
  readNativePostsPublicationReference,
  readNativePostsPublicationStatus,
  readNativePostsQuote,
} from "../services/native-posts-publication.ts";

const jobId = "publication:66ad615c-830a-430d-9c3f-ce71f4a1c4a9";
const reference = {
  schema: "pirate.native-posts-publication-reference/1",
  installationId: hashText("installed Directory original"),
  releaseSha256: hashText("selected release"),
  jobId,
  operationId: hashJson({ job: jobId, step: "publication" }),
  requestHash: hashText("original request"),
};
const pins = { quoteSha256: hashText("quote"), initiatingLeaseSha256: hashText("lease A") };
const execute = { reference, ...pins };
const transactionHash = hashText("retained original");
const blockHash = hashText("canonical block");
const postId = hashText("original Post");
const retained = { state: "retained_unsent", transactionHash };
const terminal = { transactionHash, blockHash, blockNumber: "35379147", actualFeeWei: "42" };
const wire = (result, ref = reference) => canonical({ reference: hashJson(ref), result });

test("requests are closed and a dispatch must carry both pins", () => {
  assert.deepEqual(readNativePostsPublicationReference(canonical(reference)), reference);
  assert.deepEqual(readNativePostsDispatchRequest(canonical(execute)), execute);
  assert.throws(() => readNativePostsDispatchRequest(canonical({ reference, quoteSha256: pins.quoteSha256 })));
  assert.throws(() => readNativePostsPublicationReference(canonical({
    ...reference, operationId: hashText("foreign operation"),
  })));
  assert.throws(() => readNativePostsPublicationReference(canonical({ ...reference, fee: "5" })));
  assert.throws(() => readNativePostsDispatchRequest(JSON.stringify(execute)));
});

test("quote and dispatch replies refuse a foreign original, lease or quote", () => {
  const quoted = { ...pins, maximumFeeWei: "80", expiresAtMs: 1720000000020 };
  assert.deepEqual(readNativePostsQuote(wire(quoted), reference), quoted);
  assert.throws(() => readNativePostsQuote(wire({ ...quoted, maximumFeeWei: "0" }), reference));
  for (const field of ["installationId", "releaseSha256", "requestHash"]) {
    assert.throws(() => readNativePostsPublicationStatus(wire(
      { state: "no_attempt" }, { ...reference, [field]: hashText("another original") },
    ), reference));
  }
  assert.deepEqual(readNativePostsDispatchStatus(wire({ ...retained, ...pins }), execute), retained);
  assert.throws(() => readNativePostsDispatchStatus(wire({ ...retained, ...pins,
    initiatingLeaseSha256: hashText("still-current lease B") }), execute));
  assert.throws(() => readNativePostsDispatchStatus(wire({ ...retained, ...pins,
    quoteSha256: hashText("replacement quote") }), execute));
  assert.throws(() => readNativePostsDispatchStatus(wire(retained), execute));
  assert.throws(() => readNativePostsPublicationStatus(wire({ ...retained, ...pins }), reference));
});

test("closed custody and canonical outcomes keep clean, held and retained distinct", async () => {
  for (const status of [
    { state: "no_attempt" },
    { state: "held" },
    retained,
    { state: "attempt_unknown", transactionHash },
    { state: "confirmed", ...terminal, postId, revision: 1 },
    { state: "reverted", ...terminal },
  ]) {
    const response = nativePostsPublicationResponse(reference, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(readNativePostsPublicationStatus(await response.text(), reference), status);
  }
  assert.throws(() => nativePostsPublicationResponse(reference, { ...retained, raw: "0x1234" }));
  for (const status of [
    { state: "awaiting_publisher" },
    { state: "held", transactionHash },
    { state: "no_attempt", transactionHash },
    { ...retained, raw: "0x1234" },
    { ...retained, nonce: 5 },
    { ...terminal, state: "confirmed", postId },
    { ...terminal, state: "confirmed", postId, revision: 2 },
    { ...terminal, state: "reverted", postId },
    { ...terminal, state: "reverted", actualFeeWei: "0042" },
  ]) {
    assert.throws(() => readNativePostsPublicationStatus(wire(status), reference));
  }
});

test("reverse proof requires the typed call selector and pins and expires at the exact deadline", t => {
  const expiresAtMs = 1720000000000;
  const clock = t.mock.method(Date, "now", () => expiresAtMs - 1);
  const publication = {
    communityId: hashText("community"),
    postId,
    authorId: hashText("author"),
    configurationRevision: 1,
    manifestSha256: hashText("manifest"),
    manifestURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3fuylqabf3oclgtqy55fbzdi4",
  };
  const calldata = publicationData(publication);
  const proof = { ...pins, calldata, maximumFeeWei: "80", expiresAtMs };
  const raw = wire(proof);
  assert.deepEqual(readNativePostsDispatchProof(raw, execute), proof);
  assert.throws(() => readNativePostsDispatchProof(wire({ ...proof, calldata: "0xabcdef0011" }), execute));
  assert.throws(() => readNativePostsDispatchProof(wire({
    ...proof, initiatingLeaseSha256: hashText("other lease"),
  }), execute));
  clock.mock.mockImplementation(() => expiresAtMs);
  assert.throws(() => readNativePostsDispatchProof(raw, execute), /native_posts_dispatch_proof_expired/);
  assert.throws(() => assertNativePostsDispatchProofCurrent(expiresAtMs), /native_posts_dispatch_proof_expired/);
});
