import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createPublicClient, custom, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bytes32, canonical, hashJson, hashText } from "../packages/community/common.ts";
import { preparePin, publicGateways } from "../packages/community/ipfs.ts";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import { address } from "../packages/community/manifest-core.ts";
import { intentFromSealed } from "../packages/community/catalog-outbox.ts";
import { publicationInput } from "../packages/community/publication-input.ts";
import { CATALOG_OWNER_POLICY_HASH, CATALOG_OWNER_POLICY_VERSION } from "../packages/community/owner-policy.ts";
import {
  prepareProtectedPostsFee,
  reserveProtectedPostsFee,
  settleProtectedPostsFee,
} from "../packages/community/protected-posts-fees.ts";
import type { ExternalOperation, PublicationJob } from "../packages/community/publication-store.ts";
import { publicationExecutionProfile } from "../packages/community/publication-profile.ts";
import type { PreparedOperation } from "../packages/community/publication.ts";
import { ownerGrantDigest, reserveOwnerBudget, type OwnerBudgetGrant } from "../packages/release/owner-grant.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import {
  firstSongDriver, ownerPublicationRequestBinding, type FirstSongDriverPorts, type ProtectedPostsDriverPorts,
} from "../services/first-song-driver.ts";
import { protectedPostsJob } from "../services/protected-posts-job.ts";
import { readProtectedPostsPlanned, readProtectedPostsReady } from "../services/protected-posts-ready.ts";
import { protectedPostsPrimaryFetch } from "../services/linux-web2-protected-posts.ts";
import { protectedPostsPrimarySelection } from "../services/protected-posts-primary-selection.ts";
import { signCanonicalRequest } from "../packages/recognition/canonical-protocol.ts";
import { reservationId, type AcceptedIntent } from "../packages/recognition/intent.ts";
import {
  nativePostsDispatchPath,
  nativePostsObservationPath,
  nativePostsPublicationResponse,
  nativePostsQuotePath,
  nativePostsQuoteReadyPath,
  nativePostsAuxiliaryPrimaryPath,
  nativePostsCanonicalPrimaryPath,
  nativePostsTerminalPrimaryPath,
  readNativePostsDispatchProof,
  readNativePostsDispatchRequest,
  readNativePostsPublicationReference,
  readNativePostsQuoteProof,
} from "../services/native-posts-publication.ts";
import { MemoryD1 } from "./learning-public-results-memory-fixture.ts";

function feeFixture(maximumTotalFee = "200000000", catalogSchema = false) {
  const fixture = new MemoryD1();
  const migrations = new URL("../apps/community-wizard/infra/migrations/", import.meta.url);
  const files = catalogSchema ? readdirSync(migrations).sort().filter(file => /^00(?:0[1-9]|1[0-9])_.*\.sql$/.test(file)) :
    ["0001_setup.sql", "0002_first_song.sql", "0006_song_stems.sql", "0012_owner_budget_windows.sql"];
  for (const file of files) {
    const migration = new URL(file, migrations);
    fixture.sqlite.exec(readFileSync(migration, "utf8"));
  }
  if (catalogSchema) {
    const phase = readFileSync(new URL("../packages/community/catalog-phase-rebuild.sql", import.meta.url), "utf8");
    fixture.sqlite.exec("BEGIN;\n" + phase + "\nCOMMIT;");
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
  const submissionId = "11111111-1111-4111-8111-111111111111";
  const job: PublicationJob = {
    job_id: "publication:" + submissionId,
    submission_id: submissionId,
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
    VALUES('${submissionId}','account','author','post','media','request','{}','wallet','null','audio',1,'staging/object','sealed',0);
    INSERT INTO media_stems(submission_id,slot,sha256,byte_length,state,object_key,object_etag,duration_ms,created_at)
    VALUES ('${submissionId}','vocals','vocals',10,'sealed','vocals','vocals',1000,0),
           ('${submissionId}','instrumental','instrumental',10,'sealed','instrumental','instrumental',1000,0);
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
  intent?: AcceptedIntent,
) {
  const applicationOriginalSha256 = hashJson("original application");
  const releaseSha256 = hashJson("installed release");
  fixture.sqlite.exec("CREATE TABLE native_application_original(singleton INTEGER PRIMARY KEY,original_digest TEXT,original_json TEXT)");
  fixture.sqlite.exec(readFileSync(new URL("../packages/community/catalog-obligation.sql", import.meta.url), "utf8"));
  const catalogIntent = intent ?? { jobId: job.job_id, inputHash: job.input_hash };
  fixture.sqlite.prepare("INSERT INTO publication_catalog_obligations(job_id,intent_json,intent_sha256,reservation_id,state) VALUES(?,?,?,?,'reserved')")
    .run(job.job_id, canonical(catalogIntent), hashJson(catalogIntent), intent ? reservationId(intent) : hashJson("catalog reservation"));
  fixture.sqlite.prepare("UPDATE media_submissions SET captured_wallet=? WHERE submission_id=?")
    .run(ports.ownerGrant.ownerWallet, job.submission_id);
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
    const reverse = "a".repeat(64);
    let opened = 0;
    const reverseRequest = (credential: string) => new Request(scope.configuration.app.origin + nativePostsQuoteReadyPath, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + credential },
      body: canonical(ref),
    });
    const mount = {
      origin: scope.configuration.app.origin,
      reverse,
      async open() { opened++; return { scope, async revalidate() { return authority; } }; },
    };
    assert.equal((await protectedPostsPrimaryFetch(reverseRequest("b".repeat(64)), mount)).status, 404);
    assert.equal(opened, 0);
    const privateReply = await protectedPostsPrimaryFetch(reverseRequest(reverse), mount);
    assert.equal(privateReply.status, 200);
    assert.equal(readNativePostsQuoteProof(await privateReply.text(), ref).expiresAtMs, catalogExpiresAtMs);
    assert.equal(opened, 1);
    assert.equal(reservationCount(), 0);
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
  const f = feeFixture(undefined, true);
  const { fixture, ports, operation, job, quote, postId, request, start } = f;
  t.after(() => fixture.close());
  const second = Math.floor(Date.now() / 1000);
  let nowMs = second * 1000;
  let safeTimestamp = second - 18;
  const safeExpiresAtMs = nowMs + 1000;
  t.mock.method(Date, "now", () => nowMs);
  const publisher = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
  const recognizer = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
  const grant = ports.ownerGrant;
  grant.destination.publisher = publisher.address.toLowerCase();
  grant.sha256 = ownerGrantDigest(grant);
  const config = primaryConfig(f);
  const recognition = {
    schema: "pirate.recognition-profile/1" as const,
    namespace: hashJson("catalog namespace"), origin: "https://recognition.example",
    signer: address(recognizer.address.toLowerCase()), providerBindingSha256: hashJson("recognition provider"),
  };
  config.policies.recognition = { ...recognition, sha256: hashJson(recognition) };

  const client = createPublicClient({ transport: custom({ async request({ method, params }) {
    if (method === "eth_chainId") return numberToHex(6343);
    if (method === "eth_getBlockByNumber") {
      assert(["safe", "0x11"].includes((params as string[])[0]!));
      return { number: "0x11", hash: hashJson("sampled safe block"), timestamp: numberToHex(safeTimestamp) };
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
  const managed = {
    origin: request.serviceOrigin, configuration: config,
    async protectedPin() { throw new Error("the reverse proof never calls managed pinning"); },
  };
  const unexpectedMedia = () => { throw new Error("unexpected media access"); };
  let retainedAudio = new TextEncoder().encode("synthetic recording");
  let audioOpens = 0;
  const driverPorts: FirstSongDriverPorts<ProtectedPostsDriverPorts> = {
    db: ports.db,
    media: {
      async head(key) {
        const { etag, size, sha256 } = key === "staging/object" ?
          { etag: "master", size: audio.byteLength, sha256: audio.sha256 } : { etag: key, size: 10, sha256: key };
        return {
          key, etag, size, version: "fixture", httpEtag: `"${etag}"`,
          checksums: { toJSON: () => ({}) }, uploaded: new Date(second * 1000),
          storageClass: "Standard", customMetadata: { sha256 }, writeHttpMetadata: unexpectedMedia,
        };
      },
      async get(key, options) {
        ++audioOpens;
        assert.equal(key, "staging/object");
        assert.deepEqual(options, { onlyIf: { etagMatches: "master" } });
        const response = new Response(retainedAudio);
        return {
          ...(await driverPorts.media.head(key))!, writeHttpMetadata: unexpectedMedia, body: response.body!, bodyUsed: false,
          arrayBuffer: () => response.arrayBuffer(), bytes: () => response.bytes(),
          text: () => response.text(), json: <T>() => response.json() as Promise<T>, blob: () => response.blob(),
        };
      },
      put: unexpectedMedia, list: unexpectedMedia, delete: unexpectedMedia,
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
  const sealed = await publicationInput(fixture.db, driverPorts.media, job.job_id, config);
  const intent = intentFromSealed({ jobId: job.job_id, inputHash: job.input_hash, authority: sealed.authority,
    row: sealed.row, metadata: sealed.metadata, acceptedAt: sealed.createdAt });
  const { scope, ref, proofRequest } = installPrimary(f, config, intent);
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

  await t.test("scoped approval reads bind the current lease and exact retained primary state", async () => {
    safeTimestamp = second - 5;
    const forwardKey = "a".repeat(64);
    const selection = protectedPostsPrimarySelection(scope, driverPorts, {
      db: fixture.db, media: driverPorts.media, currentConfiguration: async () => config,
      ownerAuthorization: async () => ownerAuthorization, ownerVerification: driverPorts.ownerVerification,
      async currentAccount(account, wallet, author) {
        assert.deepEqual([account, wallet, author], ["account", grant.ownerWallet, authorId]);
      },
    });
    let opens = 0;
    const mount = { origin: config.app.origin, reverse: forwardKey,
      async open() { ++opens; return { scope, selection, revalidate }; } };
    const call = (path: string, body: unknown, bearer = forwardKey, extra: Record<string, string> = {}) => protectedPostsPrimaryFetch(
      new Request(config.app.origin + path, { method: "POST", body: canonical(body),
        headers: { authorization: "Bearer " + bearer, "content-type": "application/json", ...extra } }), mount,
    );
    const setPhase = (phase: string, lease = job.lease_token!, until = job.lease_until) =>
      fixture.sqlite.prepare("UPDATE publication_jobs SET phase=?,lease_token=?,lease_until=? WHERE job_id=?")
        .run(phase, lease, until, job.job_id);
    const addOperation = async (step: "pin_audio" | "catalog_confirm") => {
      const body = await driver.request(job, step);
      const operationId = hashJson({ job: job.job_id, step });
      const requestHash = hashJson(body);
      fixture.sqlite.prepare(`INSERT INTO external_operations(operation_id,job_id,step,request_hash,request_json,status)
        VALUES(?,?,?,?,?,'running')`).run(operationId, job.job_id, step, requestHash, canonical(body));
      return { installationId: ref.installationId, releaseSha256: ref.releaseSha256, jobId: job.job_id,
        operationId, requestHash, step };
    };
    const reference = await addOperation("pin_audio");
    setPhase("pin_audio");
    const pin = { version: "pirate.protected-managed-http/1", purpose: "pin", reference,
      initiatingLeaseSha256: hashText(job.lease_token!) };
    assert.equal((await call(nativePostsAuxiliaryPrimaryPath, pin, "b".repeat(64))).status, 404);
    assert.equal((await call(nativePostsAuxiliaryPrimaryPath, { ...pin, extra: true })).status, 503);
    assert.equal(opens, 0);
    const accepted = await call(nativePostsAuxiliaryPrimaryPath, pin);
    assert.equal(accepted.status, 200);
    const pinBody = await accepted.json() as { reference: string; result: Record<string, unknown> };
    assert.equal(pinBody.reference, hashJson(pin));
    assert.equal(pinBody.result.initiatingLeaseSha256, pin.initiatingLeaseSha256);
    assert(!Object.hasOwn(pinBody.result, "leaseToken"));
    assert.equal((pinBody.result.subject as { action: string }).action, "release_pin");
    assert.deepEqual(pinBody.result.callbackIntent, intent);
    fixture.afterResponse = ({ kind, sql }) => {
      if (kind === "first" && sql.includes("AS media")) setPhase("pin_audio", "late-replacement");
    };
    assert.equal((await call(nativePostsAuxiliaryPrimaryPath, pin)).status, 503);
    fixture.afterResponse = undefined;
    setPhase("pin_audio");
    const acceptedAt = nowMs;
    fixture.afterResponse = ({ kind, sql }) => {
      if (kind === "batch" && sql.includes("AS media")) nowMs = Number(pinBody.result.expiresAtMs);
    };
    assert.equal((await call(nativePostsAuxiliaryPrimaryPath, pin)).status, 503);
    fixture.afterResponse = undefined;
    nowMs = acceptedAt;
    assert.equal((await call(nativePostsAuxiliaryPrimaryPath, { ...pin, initiatingLeaseSha256: hashText("other") })).status, 503);
    setPhase("pin_lyrics", "reopened", 0);
    assert.equal((await call(nativePostsAuxiliaryPrimaryPath, pin)).status, 503);
    assert.equal((await call(nativePostsAuxiliaryPrimaryPath, { version: pin.version, purpose: "pin_status", reference })).status, 200);

    const read = await signCanonicalRequest(recognizer, config, "read", { jobId: job.job_id });
    const canonicalRead = { version: "pirate.native-posts-canonical-primary-request/1", wire: read };
    const parent = { reference, initiatingLeaseSha256: pin.initiatingLeaseSha256 };
    assert.equal((await call(nativePostsCanonicalPrimaryPath, { ...canonicalRead, parent })).status, 503);
    setPhase("pin_audio");
    assert.equal((await call(nativePostsCanonicalPrimaryPath, { ...canonicalRead, parent })).status, 200);
    const unrelated = await signCanonicalRequest(recognizer, config, "source", { source: intent });
    assert.equal((await call(nativePostsCanonicalPrimaryPath, { ...canonicalRead, wire: unrelated, parent })).status, 503);
    const observed = await call(nativePostsCanonicalPrimaryPath, canonicalRead);
    assert.equal(observed.status, 200);
    const body = await observed.json() as { result: { snapshot: { intent: AcceptedIntent } } };
    assert.deepEqual(body.result.snapshot.intent, intent);

    const signedAudio = await signCanonicalRequest(publisher, config, "audio", { source: intent });
    const audioRead = { ...canonicalRead, wire: signedAudio, parent };
    const metadataResponse = await call(nativePostsCanonicalPrimaryPath, audioRead);
    assert.equal(metadataResponse.status, 200);
    assert.equal(audioOpens, 0);
    const { result: audioProof } = await metadataResponse.json() as {
      result: { snapshot: { intent: AcceptedIntent }; audio: { sha256: string; byteLength: number; etag: string } };
    };
    assert.deepEqual(audioProof.snapshot.intent, intent);
    assert.deepEqual(audioProof.audio, { sha256: intent.audioSha256, byteLength: intent.audioBytes, etag: intent.audioEtag });
    const binaryHeaders = { accept: "application/octet-stream", "if-match": '"master"' };
    assert.equal((await call(nativePostsCanonicalPrimaryPath, audioRead, forwardKey,
      { ...binaryHeaders, "if-match": '"other"' })).status, 503);
    assert.equal((await call(nativePostsCanonicalPrimaryPath, { ...canonicalRead, parent }, forwardKey, binaryHeaders)).status, 503);
    assert.equal(audioOpens, 0);
    const raw = await call(nativePostsCanonicalPrimaryPath, audioRead, forwardKey, binaryHeaders);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), "application/octet-stream");
    assert.equal(raw.headers.get("x-pirate-primary-request-sha256"), hashJson(audioRead));
    assert.equal(raw.headers.get("x-pirate-primary-audio-sha256"), intent.audioSha256);
    assert.equal(raw.headers.get("x-pirate-primary-expires-at-ms"), String(pinBody.result.expiresAtMs));
    assert.equal(raw.headers.get("etag"), binaryHeaders["if-match"]);
    assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), retainedAudio);
    retainedAudio = new Uint8Array(retainedAudio.byteLength);
    assert.equal((await call(nativePostsCanonicalPrimaryPath, audioRead, forwardKey, binaryHeaders)).status, 503);
    assert.equal(audioOpens, 2);

    const confirmation = await addOperation("catalog_confirm");
    setPhase("catalog_confirm");
    const receipt = { transactionHash: hashJson("test canonical transaction"), blockHash: hashJson("test canonical block"),
      blockNumber: "17", actualFeeWei: "10000", postId, revision: 1 };
    fixture.sqlite.prepare("UPDATE external_operations SET status='confirmed',provider_id=?,result_json=? WHERE operation_id=?")
      .run(receipt.transactionHash, canonical(receipt), operation.operation_id);
    const terminal = { version: "pirate.native-posts-catalog-request/1", publication: ref,
      confirmation: { operationId: confirmation.operationId, requestHash: confirmation.requestHash },
      initiatingLeaseSha256: pin.initiatingLeaseSha256 };
    const response = await call(nativePostsTerminalPrimaryPath, terminal);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { result: { receipt: unknown } }).result.receipt, receipt);
    assert.equal(f.reservationCount(), 1);

    const identificationId = hashJson({ purpose: "original-identification/1", reservationId: reservationId(intent) });
    const budgetRequest = { ...canonicalRead, wire: await signCanonicalRequest(recognizer, config, "authorize",
      { source: intent, operationId: identificationId }) };
    assert.equal((await call(nativePostsCanonicalPrimaryPath, budgetRequest)).status, 503);
    assert.equal(f.reservationCount(), 1);
    await reserveOwnerBudget(fixture.db, grant, "recognition_requests", identificationId, hashJson(intent), "1");
    const budgetProof = await call(nativePostsCanonicalPrimaryPath, budgetRequest);
    assert.equal(budgetProof.status, 200);
    const { result: observedBudget } = await budgetProof.json() as { result: {
      reservation: { reservation_id: string }; effect: { kind: string };
    } };
    assert.equal(observedBudget.reservation.reservation_id, identificationId);
    assert.deepEqual(observedBudget.effect, { kind: "identify" });
    assert.equal(f.reservationCount(), 2);
  });
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
