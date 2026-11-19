import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPublicClient, custom, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bytes32, canonical, hashJson, hashText } from "../packages/community/common.ts";
import { preparePin, publicGateways } from "../packages/community/ipfs.ts";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import { address } from "../packages/community/manifest-core.ts";
import { CATALOG_OWNER_POLICY_HASH, CATALOG_OWNER_POLICY_VERSION } from "../packages/community/owner-policy.ts";
import {
  prepareProtectedPostsFee,
  reserveProtectedPostsFee,
  settleProtectedPostsFee,
} from "../packages/community/protected-posts-fees.ts";
import type { ExternalOperation, PublicationJob } from "../packages/community/publication-store.ts";
import { publicationExecutionProfile } from "../packages/community/publication-profile.ts";
import type { PreparedOperation } from "../packages/community/publication.ts";
import { ownerGrantDigest, type OwnerBudgetGrant } from "../packages/release/owner-grant.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import {
  firstSongDriver, ownerPublicationRequestBinding, type FirstSongDriverPorts, type ProtectedPostsDriverPorts,
} from "../services/first-song-driver.ts";
import { protectedPostsJob } from "../services/protected-posts-job.ts";
import { readProtectedPostsPlanned, readProtectedPostsReady } from "../services/protected-posts-ready.ts";
import {
  nativePostsDispatchPath,
  nativePostsObservationPath,
  nativePostsPublicationResponse,
  nativePostsQuotePath,
  readNativePostsDispatchProof,
  readNativePostsDispatchRequest,
  readNativePostsPublicationReference,
  readNativePostsQuoteProof,
} from "../services/native-posts-publication.ts";
import { MemoryD1 } from "./learning-public-results-memory-fixture.ts";

function feeFixture(maximumTotalFee = "200000000") {
  const fixture = new MemoryD1();
  for (const file of ["0001_setup.sql", "0002_first_song.sql", "0006_song_stems.sql", "0012_owner_budget_windows.sql"]) {
    const migration = new URL("../apps/community-wizard/infra/migrations/" + file, import.meta.url);
    fixture.sqlite.exec(readFileSync(migration, "utf8"));
  }
  const now = Date.now(), second = Math.floor(now / 1000);
  const grant: OwnerBudgetGrant = {
    schema: "pirate.owner-publishing-grant/1",
    sha256: "",
    communityId: "0x" + "a".repeat(64),
    communityOrigin: "https://staging.example",
    ownerWallet: "0x" + "b".repeat(40),
    policy: { version: CATALOG_OWNER_POLICY_VERSION, sha256: CATALOG_OWNER_POLICY_HASH },
    destination: { chainId: 6343, postsContract: "0x" + "d".repeat(40), publisher: "0x" + "e".repeat(40) },
    validFrom: second - 60,
    expiresAt: second + 600,
    limits: { songs: 1, pinAdds: 3, pinBytes: "10000000", recognitionRequests: 1, postFeeWei: "200000000" },
  };
  grant.sha256 = ownerGrantDigest(grant);
  const ports = { db: fixture.db, ownerGrant: grant, maximumTotalFee };
  const job: PublicationJob = {
    job_id: "publication:11111111-1111-4111-8111-111111111111",
    submission_id: "media",
    input_hash: hashJson("input"),
    authority_json: "{}",
    phase: "publication",
    progress_json: "{}",
    revision: 5,
    lease_token: "lease",
    lease_until: now + 90_000,
  };
  const postId = hashJson("catalog song");
  const request = {
    schema: "pirate.first-song-publication-request/1",
    grantHash: ownerPublicationRequestBinding(grant),
    serviceOrigin: "https://managed-staging.example",
    step: "publication",
    inputHash: job.input_hash,
    context: {},
    publication: {
      communityId: grant.communityId, postId, authorId: hashJson("first-song author"), configurationRevision: 1,
      manifestSha256: hashJson("first-song manifest"),
      manifestURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3fuylqabf3oclgtqy55fbzdi4",
    },
  };
  const operation: ExternalOperation = {
    operation_id: hashJson({ job: job.job_id, step: "publication" }),
    job_id: job.job_id,
    step: "publication",
    request_hash: hashJson(request),
    request_json: canonical(request),
    status: "prepared",
    prepared_json: null,
    result_json: null,
    provider_id: null,
  };
  const quote = {
    quoteSha256: hashJson("fee quote"),
    initiatingLeaseSha256: hashText(job.lease_token!),
    maximumFeeWei: "100002000",
    expiresAtMs: now + 60_000,
  };
  fixture.sqlite.exec(`
    INSERT INTO community_accounts(account_id,author_id,created_at) VALUES('account','author',0);
    INSERT INTO media_submissions(submission_id,account_id,author_id,post_id,idempotency_key,request_hash,
      metadata_json,captured_wallet,creator_json,audio_sha256,audio_bytes,object_key,upload_state,created_at)
    VALUES('media','account','author','post','media','request','{}','wallet','null','audio',1,'object','sealed',0);
    INSERT INTO media_stems(submission_id,slot,sha256,byte_length,state,object_key,object_etag,duration_ms,created_at)
    VALUES ('media','vocals','vocals',10,'sealed','vocals','vocals',1000,0),
           ('media','instrumental','instrumental',10,'sealed','instrumental','instrumental',1000,0);
  `);
  fixture.sqlite.prepare(`
    INSERT INTO publication_jobs(job_id,submission_id,input_hash,authority_json,phase,progress_json,
      revision,lease_token,lease_until,due_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,0,0,0)
  `).run(job.job_id, job.submission_id, job.input_hash, job.authority_json, job.phase,
    job.progress_json, job.revision, job.lease_token, job.lease_until);
  function start(prepared: PreparedOperation = prepareProtectedPostsFee(ports, operation, job, quote)) {
    operation.prepared_json = canonical(prepared);
    fixture.sqlite.prepare(`
      INSERT INTO external_operations(operation_id,job_id,step,request_hash,request_json,status,prepared_json)
      VALUES(?,?,?,?,?,'running',?)
      ON CONFLICT(operation_id) DO UPDATE SET status='running',prepared_json=excluded.prepared_json
    `).run(operation.operation_id, operation.job_id, operation.step, operation.request_hash,
      operation.request_json, operation.prepared_json);
  }
  const balance = () => {
    const row = fixture.sqlite.prepare("SELECT reserved,spent FROM spending_budgets WHERE asset='post_fee_wei'").get();
    return row && [row.reserved, row.spent];
  };
  const reservationCount = () =>
    fixture.sqlite.prepare("SELECT count(*) AS n FROM spending_reservations").get()!.n;
  return { fixture, ports, job, operation, quote, postId, request, start, balance, reservationCount };
}

test("protected Posts quotes, reserves, dispatches and observes the exact installed original", async () => {
  const { fixture, ports, operation, job, quote, postId, start, balance } = feeFixture();
  try {
    const paths: string[] = [];
    let dispatched = false;
    const terminal = {
      state: "confirmed" as const,
      transactionHash: hashJson("retained protected transaction"),
      blockHash: hashJson("safe receipt"),
      blockNumber: "123",
      revision: 1 as const,
      actualFeeWei: "100001052",
      postId,
    };
    const posting = protectedPostsJob(ports, {
      installationId: hashJson("installed directory identity"),
      releaseSha256: hashJson("installed release"),
      async exchange(path, body) {
        paths.push(path);
        if (path === nativePostsDispatchPath) {
          const request = readNativePostsDispatchRequest(body);
          assert.equal(request.reference.operationId, operation.operation_id);
          assert.equal(request.reference.requestHash, operation.request_hash);
          assert.equal(request.quoteSha256, quote.quoteSha256);
          assert.equal(request.initiatingLeaseSha256, quote.initiatingLeaseSha256);
          assert.deepEqual(balance(), [quote.maximumFeeWei, "0"]);
          dispatched = true;
          return nativePostsPublicationResponse(request.reference, {
            ...terminal, quoteSha256: request.quoteSha256, initiatingLeaseSha256: request.initiatingLeaseSha256,
          });
        }
        const reference = readNativePostsPublicationReference(body);
        return nativePostsPublicationResponse(reference, path === nativePostsQuotePath ? quote :
          dispatched ? terminal : { state: "no_attempt" });
      },
    });
    start(await posting.prepare(operation, job));
    const receipt = await posting.execute(operation, job);
    await posting.validate(operation, receipt, job);
    const reopened = { ...job, lease_token: "new observation lease" };
    assert.deepEqual(await posting.reconcile(operation, reopened), receipt);
    await posting.validate(operation, receipt, reopened);
    assert.equal(receipt.providerId, terminal.transactionHash);
    assert.deepEqual(balance(), ["0", terminal.actualFeeWei]);
    assert.deepEqual(paths, [
      nativePostsQuotePath, nativePostsObservationPath, nativePostsDispatchPath,
      nativePostsObservationPath, nativePostsObservationPath, nativePostsObservationPath,
    ]);
    terminal.actualFeeWei = "100001053";
    await assert.rejects(posting.validate(operation, receipt, reopened), /protected_posts_receipt_changed/);
    assert.deepEqual(balance(), ["0", "100001052"]);
  } finally {
    fixture.close();
  }
});

function primaryConfig({ ports }: ReturnType<typeof feeFixture>): Web2CommunityConfig {
  const installationId = hashJson("directory identity");
  return {
    schema: "pirate.community-config/4", chainId: 6343, configurationRevision: 1,
    communityId: bytes32(ports.ownerGrant.communityId), communityKey: hashJson("community"),
    installationId, directory: address(ports.ownerGrant.destination.postsContract),
    postsContract: address(ports.ownerGrant.destination.postsContract),
    publisher: address(ports.ownerGrant.destination.publisher), controller: address(ports.ownerGrant.ownerWallet),
    operatorPayments: address(ports.ownerGrant.destination.postsContract), learningRecords: address(ports.ownerGrant.destination.postsContract),
    app: { label: "Stage", origin: ports.ownerGrant.communityOrigin },
    feed: { endpoint: ports.ownerGrant.communityOrigin + "/feed", signingKeyId: "key" },
    policies: { admission: { version: CATALOG_OWNER_POLICY_VERSION, sha256: CATALOG_OWNER_POLICY_HASH },
      moderationSigner: address(ports.ownerGrant.destination.publisher) },
    publisherRevocations: [],
  };
}

function installPrimary(
  { fixture, ports, operation, job, quote, request }: ReturnType<typeof feeFixture>,
  config: Web2CommunityConfig,
) {
  const applicationOriginalSha256 = hashJson("original application");
  const releaseSha256 = hashJson("installed release");
  fixture.sqlite.exec("CREATE TABLE native_application_original(singleton INTEGER PRIMARY KEY,original_digest TEXT,original_json TEXT)");
  fixture.sqlite.exec(readFileSync(new URL("../packages/community/catalog-obligation.sql", import.meta.url), "utf8"));
  const catalogIntent = { jobId: job.job_id, inputHash: job.input_hash };
  fixture.sqlite.prepare("INSERT INTO publication_catalog_obligations(job_id,intent_json,intent_sha256,reservation_id,state) VALUES(?,?,?,?,'reserved')")
    .run(job.job_id, canonical(catalogIntent), hashJson(catalogIntent), hashJson("catalog reservation"));
  fixture.sqlite.prepare("UPDATE media_submissions SET captured_wallet=? WHERE submission_id='media'")
    .run(ports.ownerGrant.ownerWallet);
  fixture.sqlite.prepare(`
    INSERT INTO credential_bindings(binding_id,account_id,namespace,network,subject,created_at)
    VALUES('credential','account','moss',6343,?,0)
  `).run(ports.ownerGrant.ownerWallet);
  fixture.sqlite.prepare("INSERT INTO native_application_original VALUES(1,?,'{}')").run(applicationOriginalSha256.slice(2));
  fixture.sqlite.prepare("INSERT INTO application_identity VALUES(1,?,?)").run(config.communityId, config.app.origin);
  const ref = readNativePostsPublicationReference(canonical({
    schema: "pirate.native-posts-publication-reference/1", installationId: config.installationId, releaseSha256, jobId: job.job_id,
    operationId: operation.operation_id, requestHash: operation.request_hash,
  }));
  const proofRequest = { reference: ref, quoteSha256: quote.quoteSha256, initiatingLeaseSha256: quote.initiatingLeaseSha256 };
  const scope = {
    ...ports, applicationOriginalSha256, releaseSha256, configuration: config, expiresAtMs: quote.expiresAtMs,
    managedOrigin: request.serviceOrigin,
  };
  fixture.sqlite.prepare(`
    INSERT INTO external_operations(operation_id,job_id,step,request_hash,request_json,status)
    VALUES(?,?,?,?,?,'planned')
  `).run(operation.operation_id, operation.job_id, operation.step, operation.request_hash, operation.request_json);
  return { scope, ref, proofRequest };
}

test("reverse proof binds the sealed primary original and both live authority deadlines", async () => {
  const f = feeFixture();
  const { fixture, ports, operation, job, quote, start, reservationCount } = f;
  try {
    const { scope, ref, proofRequest } = installPrimary(f, primaryConfig(f));
    const ownerExpiresAtMs = quote.expiresAtMs - 1_000;
    const catalogExpiresAtMs = ownerExpiresAtMs - 1_000;
    const authority = { ownerExpiresAtMs, catalogExpiresAtMs };
    const planned = await readProtectedPostsPlanned(scope, ref, async (captured) => {
      assert.equal(captured.status, "planned");
      assert.equal(captured.prepared_json, null);
      return authority;
    });
    assert.equal(planned.initiatingLeaseSha256, quote.initiatingLeaseSha256);
    assert.equal(planned.expiresAtMs, catalogExpiresAtMs);
    assert.equal(planned.applicationOriginalSha256, scope.applicationOriginalSha256);
    assert.equal(planned.grantSha256, ports.ownerGrant.sha256);
    const plannedReply = await nativePostsPublicationResponse(ref, planned).text();
    assert.deepEqual(readNativePostsQuoteProof(plannedReply, ref), planned);
    assert.throws(() => readNativePostsDispatchProof(plannedReply, proofRequest));
    const expired = canonical({ reference: hashJson(ref), result: { ...planned, expiresAtMs: Date.now() } });
    assert.throws(() => readNativePostsQuoteProof(expired, ref), /native_posts_quote_proof_expired/);
    assert.equal(reservationCount(), 0);
    await assert.rejects(readProtectedPostsPlanned(scope, ref, async () => {
      fixture.sqlite.exec("UPDATE publication_jobs SET lease_token='other still-live lease'");
      return authority;
    }), /protected_posts_primary_original_changed/);
    fixture.sqlite.prepare("UPDATE publication_jobs SET lease_token=?").run(job.lease_token);
    start();
    await reserveProtectedPostsFee(ports, operation, job);
    await assert.rejects(readProtectedPostsPlanned(scope, ref, async () => authority),
      /protected_posts_primary_original_unavailable/);
    fixture.sqlite.exec("UPDATE external_operations SET status='planned',prepared_json=NULL");
    await assert.rejects(readProtectedPostsPlanned(scope, ref, async () => authority),
      /protected_posts_primary_original_unavailable/);
    fixture.sqlite.prepare("UPDATE external_operations SET status='running',prepared_json=?").run(operation.prepared_json);
    const proof = await readProtectedPostsReady(scope, proofRequest, async (captured) => {
      assert.equal(captured.request_json, operation.request_json);
      assert.equal(captured.prepared_json, operation.prepared_json);
      return authority;
    });
    assert.equal(proof.expiresAtMs, catalogExpiresAtMs);
    assert.equal(proof.maximumFeeWei, quote.maximumFeeWei);
    assert.match(proof.calldata, /^0x2307eea1/);
    await assert.rejects(readProtectedPostsReady(scope, proofRequest, async () => ({ ownerExpiresAtMs })),
      /protected_posts_catalog_authority_unavailable/);
    await assert.rejects(readProtectedPostsReady(scope, proofRequest, async () => {
      fixture.sqlite.exec("UPDATE publication_catalog_obligations SET state='pending'");
      return authority;
    }), /protected_posts_primary_original_changed/);
    fixture.sqlite.exec("UPDATE publication_catalog_obligations SET state='reserved'");
    await assert.rejects(readProtectedPostsReady(scope, proofRequest, async () => {
      fixture.sqlite.exec("DELETE FROM credential_bindings WHERE binding_id='credential'");
      return authority;
    }), /protected_posts_primary_original_changed/);
    fixture.sqlite.prepare(`
      INSERT INTO credential_bindings(binding_id,account_id,namespace,network,subject,created_at)
      VALUES('credential','account','moss',6343,?,0)
    `).run(ports.ownerGrant.ownerWallet);
    await assert.rejects(readProtectedPostsReady(scope, proofRequest, async () => {
      fixture.sqlite.exec("UPDATE media_stems SET object_etag='replacement' WHERE slot='vocals'");
      return authority;
    }), /protected_posts_primary_original_changed/);
  } finally {
    fixture.close();
  }
});

test("real Posts driver limits both proofs to the sampled owner safe block", async (t) => {
  const f = feeFixture();
  const { fixture, ports, operation, job, quote, postId, request, start } = f;
  t.after(() => fixture.close());
  const second = Math.floor(Date.now() / 1000);
  let nowMs = second * 1000;
  const safeExpiresAtMs = nowMs + 1000;
  t.mock.method(Date, "now", () => nowMs);
  const publisher = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
  const grant = ports.ownerGrant;
  grant.destination.publisher = publisher.address.toLowerCase();
  grant.sha256 = ownerGrantDigest(grant);
  const config = primaryConfig(f);
  const recognition = {
    schema: "pirate.recognition-profile/1" as const,
    namespace: hashJson("catalog namespace"), origin: "https://recognition.example",
    signer: config.postsContract, providerBindingSha256: hashJson("recognition provider"),
  };
  config.policies.recognition = { ...recognition, sha256: hashJson(recognition) };

  const client = createPublicClient({ transport: custom({ async request({ method, params }) {
    if (method === "eth_chainId") return numberToHex(6343);
    if (method === "eth_getBlockByNumber") {
      assert(["safe", "0x11"].includes((params as string[])[0]!));
      return { number: "0x11", hash: hashJson("sampled safe block"), timestamp: numberToHex(second - 18) };
    }
    if (method === "eth_call") {
      assert.equal((params as unknown[])[1], "0x11");
      // The disposable RPC supplies the account validator's read-only verdict.
      return "0x01";
    }
    throw new Error("unexpected RPC " + method);
  } }) });
  const authorization = {
    schema: "pirate.owner-publishing-authorization/2", communityId: config.communityId,
    ownerWallet: grant.ownerWallet, policy: grant.policy, validFrom: grant.validFrom, expiresAt: grant.expiresAt,
  };
  const ownerAuthorization = { authorization, signature: "0x01" };
  const identity = { chainId: 6343 as const, postsContract: config.postsContract, communityId: config.communityId, postId };
  const lyrics = createLyrics(identity, "An unpublished test lyric", "en");
  const terms = { revision: 1, allowsDerivatives: false };
  const metadata = {
    title: "Test recording", language: "en", lyrics, original: true,
    acceptedPolicy: grant.policy.version, rating: "general", terms,
  };
  const publicContent = new Map<string, Uint8Array>();
  const pin = async (value: string, mediaType: "audio/mpeg" | "application/json") => {
    const bytes = new TextEncoder().encode(value);
    const intent = await preparePin(bytes, mediaType);
    publicContent.set(intent.uri.slice(7), bytes);
    return { ...intent, retained: true, gateway: publicGateways[0], verifiedAt: second };
  };
  const audio = await pin("synthetic recording", "audio/mpeg");
  const lyricsPin = await pin(canonical(lyrics), "application/json");
  const { authorId } = request.publication;
  const catalog = {
    decision: { rating: "general" }, evidenceSha256: hashJson("catalog evidence"),
    reservationId: hashJson("catalog reservation"), recordingId: hashJson("catalog recording"),
  };
  const mediaRef = (role: "audio" | "lyrics", { uri, sha256, byteLength, mediaType }: typeof audio) =>
    ({ role, uri, sha256, byteLength, mediaType });
  const manifest = await pin(canonical({
    ...identity, schema: "pirate.community-post/4", authorId, kind: "song",
    revision: 1, configurationRevision: 1, publishedAt: second, title: metadata.title,
    language: metadata.language, rating: metadata.rating, terms,
    recognition: {
      namespace: recognition.namespace, profileSha256: config.policies.recognition.sha256,
      intentSha256: catalog.evidenceSha256, reservationId: catalog.reservationId, recordingId: catalog.recordingId,
    },
    admission: {
      policyVersion: grant.policy.version, policySha256: grant.policy.sha256, decision: "publish",
      rating: metadata.rating, coverDisplayed: false, evidenceSha256: catalog.evidenceSha256,
      automatedContent: "deferred", declarationSource: "operator_declared",
    },
    media: [mediaRef("audio", audio), mediaRef("lyrics", lyricsPin)],
    registration: { status: "absent", reason: "deferred_for_launch" },
  }), "application/json");
  const managed = { origin: request.serviceOrigin, configuration: config, publisher };
  const unexpectedMedia = () => { throw new Error("the reverse proof only reads media metadata"); };
  const driverPorts: FirstSongDriverPorts<ProtectedPostsDriverPorts> = {
    db: ports.db,
    media: {
      async head(key) {
        const { etag, size, sha256 } = key === "object" ?
          { etag: "master", size: audio.byteLength, sha256: audio.sha256 } : { etag: key, size: 10, sha256: key };
        return {
          key, etag, size, version: "fixture", httpEtag: `"${etag}"`,
          checksums: { toJSON: () => ({}) }, uploaded: new Date(second * 1000),
          storageClass: "Standard", customMetadata: { sha256 }, writeHttpMetadata: unexpectedMedia,
        };
      },
      get: unexpectedMedia, put: unexpectedMedia, list: unexpectedMedia, delete: unexpectedMedia,
      createMultipartUpload: unexpectedMedia, resumeMultipartUpload: unexpectedMedia,
    },
    managed,
    release: {
      client: managed, grantHash: grant.sha256, ownerGrant: grant,
      async ipfs(request) {
        const bytes = publicContent.get(new URL(request.url).pathname.split("/").at(-1)!);
        assert(bytes);
        return new Response(new Uint8Array(bytes));
      },
    },
    posting: {
      ownerGrant: grant, config, profile: { address: config.postsContract, deploymentBlock: 1n, runtimeCodeHash: hashJson("Posts") },
      bounds: { period: "fixture", maximumGas: "1000000", maximumGasPrice: "30000000",
        maximumTotalFee: ports.maximumTotalFee, expiresAt: grant.expiresAt },
      protectedPosts: protectedPostsJob(ports, {
        installationId: config.installationId, releaseSha256: hashJson("installed release"),
        async exchange() { throw new Error("quote and ready proofs have no owner effect"); },
      }),
    },
    acrEndpoint: "https://acr.example",
    async checkServices() {},
    ownerAuthorization,
    ownerVerification: { client, currentConfiguration: async () => config, now: () => Math.floor(Date.now() / 1000), maxSafeBlockAgeSeconds: 18n },
  };
  const authority = {
    execution: publicationExecutionProfile(driverPorts), chainId: config.chainId, communityId: config.communityId,
    postsContract: config.postsContract, configurationRevision: 1, publisher: config.publisher,
    moderationSigner: config.policies.moderationSigner, accountId: "account", authorId, wallet: grant.ownerWallet,
    creator: null, policy: grant.policy, ownerAuthorizationSha256: hashJson(authorization), recognition: config.policies.recognition,
    communityOrigin: config.app.origin,
  };
  job.input_hash = hashJson({ metadata, audioSha256: audio.sha256, audioBytes: audio.byteLength, authority });
  job.authority_json = canonical(authority);
  job.progress_json = canonical({ catalog_reserve: catalog, pin_audio: { pin: audio },
    pin_lyrics: { pin: lyricsPin }, pin_manifest: { pin: manifest } });
  fixture.sqlite.prepare("UPDATE publication_jobs SET input_hash=?,authority_json=?,progress_json=?,created_at=?")
    .run(job.input_hash, job.authority_json, job.progress_json, nowMs);
  fixture.sqlite.prepare(`
    UPDATE media_submissions SET author_id=?,post_id=?,metadata_json=?,captured_wallet=?,audio_sha256=?,audio_bytes=?,object_etag='master'
  `).run(authorId, postId, canonical(metadata), grant.ownerWallet, audio.sha256, audio.byteLength);
  fixture.sqlite.prepare("UPDATE community_accounts SET author_id=?").run(authorId);
  const driver = firstSongDriver(driverPorts);
  const publication = await driver.request(job, "publication");
  operation.request_json = canonical(publication);
  operation.request_hash = hashJson(publication);
  const { scope, ref, proofRequest } = installPrimary(f, config);
  const revalidate = async (captured: ExternalOperation) => ({
    ...await driver.revalidateProtectedPostsOwner(captured),
    catalogExpiresAtMs: quote.expiresAtMs,
  });
  async function assertCutoff(prove: () => Promise<{ expiresAtMs: number }>) {
    let primaryReads = 0;
    fixture.afterResponse = ({ kind, sql }) => {
      if (kind === "first" && sql.includes("AS sealedStems") && ++primaryReads === 2)
        nowMs = safeExpiresAtMs;
    };
    await assert.rejects(prove(), /protected_posts_proof_expired/);
    assert.equal(primaryReads, 2);
    fixture.afterResponse = undefined;
    nowMs = safeExpiresAtMs - 1;
    assert.equal((await prove()).expiresAtMs, safeExpiresAtMs);
  }
  await assertCutoff(() => readProtectedPostsPlanned(scope, ref, revalidate));
  start();
  await reserveProtectedPostsFee(ports, operation, job);
  await assertCutoff(() => readProtectedPostsReady(scope, proofRequest, revalidate));
});

test("the full quote, including the additional charge, must fit before fee reservation", () => {
  const { fixture, start, reservationCount } = feeFixture("100000000");
  try {
    assert.throws(start, /protected_posts_all_in_fee_exceeds_cap/);
    assert.equal(reservationCount(), 0);
  } finally {
    fixture.sqlite.close();
  }
});

test("protected fee reservation requires the exact live initiating job lease", async () => {
  const { fixture, ports, job, operation, start, reservationCount } = feeFixture();
  try {
    start();
    fixture.sqlite.exec("UPDATE publication_jobs SET lease_token='replacement'");
    await assert.rejects(reserveProtectedPostsFee(ports, operation, job), /protected_posts_fee_authority_changed/);
    assert.equal(reservationCount(), 0);
  } finally {
    fixture.sqlite.close();
  }
});

for (const [state, charged] of [["confirmed", "100001052"], ["reverted", "87001052"]] as const) {
  test(`a canonical ${state} charges its all-in fee once against the exact reservation`, async () => {
    const { fixture, ports, operation, job, start, balance, reservationCount } = feeFixture();
    try {
      start();
      await reserveProtectedPostsFee(ports, operation, job);
      await reserveProtectedPostsFee(ports, operation, job);
      assert.deepEqual(balance(), ["100002000", "0"]);
      await settleProtectedPostsFee(ports, operation, charged);
      await settleProtectedPostsFee(ports, operation, charged);
      assert.deepEqual(balance(), ["0", charged]);
      assert.equal(reservationCount(), 1);
      await assert.rejects(settleProtectedPostsFee(ports, operation, "100000000"), /settlement_conflict/);
      assert.deepEqual(balance(), ["0", charged]);
    } finally {
      fixture.sqlite.close();
    }
  });
}
