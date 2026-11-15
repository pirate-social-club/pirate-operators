// Actual application/managed/catalog handlers, D1/R2 and local V3/Posts RPC.
// External ACRCloud and IPFS/Filebase are explicit transport simulations.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { communityRuntime } from "../community-runtime.ts";
import {
  web2SongChain,
  web2Owner,
  web2Other,
  web2Controller,
  web2Publisher,
} from "./web2-first-song-chain.ts";
import {
  communityFetch,
  communityQueue,
  communityScheduled,
  type CommunityEnv,
} from "../../services/community-application.ts";
import managedModeration, {
  type ManagedEnv,
} from "../../services/managed-moderation.ts";
import { firstSongRuntime } from "../../services/first-song-runtime.ts";
import { readWeb2Community } from "../../packages/community/web2-directory-reader.ts";
import { communityIpfsTransport } from "../../services/community-deployment-profile.ts";
import {
  canonical,
  hashJson,
  hashText,
  insist,
} from "../../packages/community/common.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import {
  ownerGrantDigest,
  validateOwnerGrant,
} from "../../packages/release/owner-grant.ts";
import { CATALOG_OWNER_POLICY_VERSION } from "../../packages/community/owner-policy.ts";
import { catalogPhaseTransitionStatements } from "../../packages/community/catalog-phase-transition.ts";
import {
  loadJob,
  type ExternalOperation,
  type PublicationJob,
} from "../../packages/community/publication-store.ts";
import {
  sharedRecognitionRuntime,
  type RecognitionWake,
} from "../../services/shared-recognition-runtime.ts";
import {
  readCanonicalIntent,
  type CanonicalIntentPorts,
} from "../../packages/recognition/canonical-intent.ts";
import { reservationClient } from "../../packages/recognition/reservation-client.ts";
import type { ManagedCatalogBinding } from "../../packages/recognition/provider-binding.ts";
import type { RecognitionProfile } from "../../packages/recognition/intent.ts";
import { loginChallenge } from "../../packages/community/accounts.ts";
import { megaethReadClient } from "../../packages/community/chain.ts";
import { preparePosting } from "../../packages/community/publication-posting.ts";
import {
  signServiceRequest,
  type SignedServiceRequest,
} from "../../packages/moderation/pairing.ts";

export async function web2FirstSongFixture() {
  const community = await communityRuntime(),
    mf = new Miniflare({
      modules: true,
      script: "export default {fetch(){throw Error('unused')}}",
      compatibilityDate: "2026-08-06",
      d1Databases: ["MANAGED", "RECOGNITION"],
      r2Buckets: ["MANAGED_MEDIA"],
    });
  let chain: Awaited<ReturnType<typeof web2SongChain>> | undefined;
  const close = async () => {
    const results = await Promise.allSettled([
      chain?.close(),
      community.dispose(),
      mf.dispose(),
    ]);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length)
      throw new AggregateError(failures, "fixture_cleanup_failed");
  };
  try {
    const managedDb = await mf.getD1Database("MANAGED"),
      recognitionDb = await mf.getD1Database("RECOGNITION"),
      managedMedia = (await mf.getR2Bucket(
        "MANAGED_MEDIA",
      )) as unknown as R2Bucket;
    const apply = async (db: D1Database, path: string) => {
      const sql = await readFile(path, "utf8");
      await db.batch(
        sql
          .replace(/^--.*$/gm, "")
          .split(/;\s*(?=(?:CREATE|INSERT|DROP|ALTER|PRAGMA)\s|$)/)
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => db.prepare(v)),
      );
    };
    for (const name of [
      "0011_manual_rewards.sql",
      "0012_owner_budget_windows.sql",
    ])
      await apply(
        community.db,
        `apps/community-wizard/infra/migrations/${name}`,
      );
    await community.db.batch(
      catalogPhaseTransitionStatements(
        community.db,
        await readFile("packages/community/catalog-phase-rebuild.sql", "utf8"),
      ),
    );
    await apply(community.db, "packages/community/catalog-obligation.sql");
    for (const name of [
      "0001_managed.sql",
      "0002_release_operations.sql",
      "0003_owner_curated.sql",
      "0004_owner_budget_windows.sql",
    ])
      await apply(managedDb, `apps/managed-moderation/migrations/${name}`);
    await apply(recognitionDb, "packages/recognition/schema.sql");
    const signer = privateKeyToAccount(`0x${"73".repeat(32)}`),
      namespace = hashText("actual Web2 first-song recognition"),
      credentials = {
        host: "identify-eu-west-1.acrcloud.com",
        accessKey: "explicit-fixture-key",
        accessSecret: "explicit-fixture-secret",
      },
      binding: ManagedCatalogBinding = {
        schema: "pirate.managed-recognition-binding/1",
        namespace,
        catalogOrigin: "https://api-v2.acrcloud.com",
        bucketId: "123",
        projectId: "reviewed-fixture-project",
        identifyHost: credentials.host,
        accessKeySha256: hashJson({ accessKey: credentials.accessKey }),
        associationEvidenceSha256: hashText(
          "explicit simulated same-project association",
        ),
      },
      publicProfile = {
        schema: "pirate.recognition-profile/1" as const,
        namespace,
        origin: "https://recognition.web2.example",
        signer: signer.address.toLowerCase(),
        providerBindingSha256: hashJson(binding),
      },
      recognition: RecognitionProfile = {
        ...publicProfile,
        sha256: hashJson(publicProfile),
      },
      journal = {
        epoch: hashText("fresh fixture epoch"),
        restoreAnchorSha256: hashText("explicit empty fixture installation"),
      };
    await recognitionDb
      .prepare("INSERT INTO shared_recognition_installation VALUES(?,?,?,?)")
      .bind(
        namespace,
        recognition.sha256,
        journal.epoch,
        journal.restoreAnchorSha256,
      )
      .run();
    chain = await web2SongChain(recognition);
    const c = chain;
    const deployment = c.deployment,
      now = Math.floor(Date.now() / 1000),
      draft = {
        schema: "pirate.owner-publishing-grant/1" as const,
        sha256: "0x" + "00".repeat(32),
        communityId: c.profile.communityId,
        communityOrigin: deployment.origin,
        ownerWallet: web2Owner.address.toLowerCase(),
        policy: c.current().policies.admission,
        destination: {
          chainId: 6343,
          postsContract: deployment.posts.address,
          publisher: web2Publisher.address.toLowerCase(),
        },
        validFrom: now - 60,
        expiresAt: now + 3600,
        limits: {
          songs: 3,
          pinAdds: 15,
          pinBytes: String(64 * 1024 * 1024),
          recognitionRequests: 12,
          postFeeWei: "90000000000000",
        },
      },
      grant = validateOwnerGrant({ ...draft, sha256: ownerGrantDigest(draft) }),
      authorization = {
        schema: "pirate.owner-publishing-authorization/1",
        communityId: c.profile.communityId,
        ownerWallet: grant.ownerWallet,
        policy: grant.policy,
        validFrom: now - 60,
        expiresAt: now + 3600,
      },
      ownerAuthorization = {
        authorization,
        signature: await web2Controller.signMessage({
          message: { raw: hashJson(authorization) as Hex },
        }),
      };
    let losePinAck = false,
      lostPin = false,
      restarts = 0;
    const originalBeforeRestart = new Map<string, string>(),
      wakes: RecognitionWake[] = [],
      jobs: Array<{ jobId: string }> = [],
      files = new Map<string, Record<string, unknown>>();
    const pinTransport = async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v0/add") {
        const form = await request.formData(),
          file = form.get("file") as File,
          bytes = new Uint8Array(await file.arrayBuffer()),
          intent = await preparePin(
            bytes,
            file.type as "audio/mpeg" | "application/json",
          );
        c.effects.pinAdds++;
        c.contents.set(intent.uri.slice(7), bytes);
        if (losePinAck) {
          losePinAck = false;
          lostPin = true;
          throw Error("explicit pin effect before lost acknowledgement");
        }
        return Response.json({ Hash: intent.uri.slice(7) });
      }
      if (url.pathname === "/api/v0/pin/ls") {
        const cid = url.searchParams.get("arg")!;
        return Response.json({
          Keys: c.contents.has(cid) ? { [cid]: { Type: "recursive" } } : {},
        });
      }
      const bytes = c.contents.get(url.pathname.slice("/ipfs/".length));
      return bytes
        ? new Response(new Uint8Array(bytes))
        : new Response(null, { status: 404 });
    };
    const provider = {
      async request(request: Request) {
        const url = new URL(request.url);
        if (url.hostname.startsWith("identify-")) {
          const row = [...files.values()][0];
          return Response.json(
            row
              ? {
                  status: { code: 0 },
                  metadata: { custom_files: [{ acrid: row.acr_id }] },
                }
              : { status: { code: 1001 } },
          );
        }
        if (request.method === "POST") {
          c.effects.catalogUploads++;
          const form = await request.formData(),
            title = String(form.get("title")),
            row = {
              id: c.effects.catalogUploads,
              bucket_id: 123,
              title,
              acr_id: `explicit-custom-${c.effects.catalogUploads}`,
              state: 1,
              user_defined: JSON.parse(String(form.get("user_defined"))),
            };
          files.set(title, row);
          return Response.json({ data: row });
        }
        if (request.method === "DELETE")
          throw Error("deletion is outside first-song proof");
        return Response.json({
          data: [...files.values()].filter(
            (row) => row.title === url.searchParams.get("search"),
          ),
          next_page_url: null,
        });
      },
    };
    const read = () =>
      readWeb2Community(
        megaethReadClient(undefined, deployment.rpcUrl),
        c.profile,
        {
          now: () => BigInt(Math.floor(Date.now() / 1000)),
          maxSafeBlockAgeSeconds: BigInt(
            deployment.freshness.maxSafeBlockAgeSeconds,
          ),
        },
        communityIpfsTransport(deployment),
      );
    const current = async () => {
      const value = await read();
      insist(
        value.eligibility.status === "available",
        "community_authority_unavailable",
        503,
      );
      return value.config;
    };
    const currentAccount = async (
      account: string,
      wallet: string,
      author: string,
    ) => {
      const row = await community.db
        .withSession("first-primary")
        .prepare(
          "SELECT a.account_id FROM community_accounts a JOIN credential_bindings b ON b.account_id=a.account_id WHERE a.account_id=? AND a.author_id=? AND b.subject=? AND b.network=6343",
        )
        .bind(account, author, wallet)
        .first();
      insist(row, "owner_account_fence_changed", 403);
    };
    let catalog: ReturnType<typeof sharedRecognitionRuntime>;
    const env = {
      DB: community.db,
      MEDIA: community.media,
      JOBS: {
        send: async (job: { jobId: string }) => {
          jobs.push(job);
        },
      },
      ASSETS: { fetch: async () => new Response("fixture application assets") },
      COMMUNITY_NAME: deployment.name,
      PLAN_ID: deployment.planId,
      APPLICATION_PROFILE_HASH: hashText("actual Web2 fixture application"),
      COMMUNITY_PUBLISHER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      MANAGED_PROFILE_HASH: hashText("actual Web2 fixture managed"),
      OWNER_GRANT_JSON: JSON.stringify(grant),
      OWNER_AUTHORIZATION_JSON: JSON.stringify(ownerAuthorization),
      RECOGNITION_PROFILE_JSON: JSON.stringify(recognition),
      CATALOG_ACCOUNT_FENCE: currentAccount,
      CATALOG_TRANSPORT: (request: Request) => catalog.fetch(request),
      COMMUNITY_DEPLOYMENT_PROFILE_JSON: JSON.stringify(deployment),
    } as unknown as CommunityEnv;
    const canonicalPorts = () =>
      firstSongRuntime(env, c.current(), current, deployment).catalog!;
    // The private registry delegates to actual persisted community inputs and fresh chain reads.
    const communities = new Map<string, CanonicalIntentPorts>([
      [c.profile.communityId, canonicalPorts()],
    ]);
    const build = () =>
      sharedRecognitionRuntime({
        db: recognitionDb,
        profile: recognition,
        binding,
        credentials,
        catalogToken: "explicit-fixture-token",
        signer,
        communities,
        quotas: { service: 100, community: 60 },
        journal,
        queue: {
          send: async (wake) => {
            wakes.push(wake);
          },
        },
        providerTransport: provider,
        cancellation: async () => {
          throw Error("cancellation not admitted in first-song proof");
        },
        withdrawal: async () => {
          throw Error("withdrawal not admitted in first-song proof");
        },
      });
    catalog = build();
    const managedEnv = {
      DB: managedDb,
      MEDIA: managedMedia,
      JOBS: {
        send: async () => {
          throw Error("legacy automated moderation is forbidden");
        },
      },
      SERVICE_ORIGIN: deployment.managedOrigin,
      SERVICE_PROFILE_HASH: env.MANAGED_PROFILE_HASH,
      PAIRINGS_JSON: JSON.stringify([
        {
          schema: "pirate.managed-pairing/2",
          chainId: 6343,
          communityKey: c.profile.communityKey,
          installationId: c.profile.installationId,
          communityId: c.profile.communityId,
          directory: c.profile.directory,
          controller: c.current().controller,
          communityOrigin: deployment.origin,
          serviceOrigin: deployment.managedOrigin,
          enabled: true,
          budgetPeriod: "web2-fixture",
          requestCap: 30,
        },
      ]),
      DIRECTORY_PROFILES_JSON: JSON.stringify([deployment]),
      SERVICE_BUDGET_PERIOD: "web2-fixture",
      SERVICE_REQUEST_CAP: "60",
      ACRCLOUD_HOST: credentials.host,
      ACRCLOUD_ACCESS_KEY: credentials.accessKey,
      ACRCLOUD_ACCESS_SECRET: credentials.accessSecret,
      OPENAI_API_KEY: "excluded",
      MODERATION_SIGNER_PRIVATE_KEY: `0x${"41".repeat(32)}`,
      OWNER_GRANT_JSON: JSON.stringify(grant),
      FILEBASE_IPFS_TOKEN: "explicit-fixture-token",
      PIN_TRANSPORT: pinTransport,
      CATALOG_RELEASE_INPUTS: {
        canonical: async () => canonicalPorts(),
        recognition: async () =>
          reservationClient({
            profile: recognition,
            publisher: web2Publisher,
            transport: (request) => catalog.fetch(request),
            current: async (intent) => {
              assert.equal(
                (await readCanonicalIntent(canonicalPorts(), intent.jobId))
                  .intent.inputHash,
                intent.inputHash,
              );
            },
            beforeSend: async (intent) => {
              const row = await community.db
                .withSession("first-primary")
                .prepare(
                  "SELECT job_id FROM publication_jobs WHERE job_id=? AND lease_token IS NOT NULL AND lease_until>?",
                )
                .bind(intent.jobId, Date.now())
                .first();
              insist(row, "publication_lease_lost", 409);
            },
          }),
      },
    } as unknown as ManagedEnv;
    // Node's real Request has no incoming Cloudflare metadata; handlers do not read it.
    let acceptedPin: SignedServiceRequest | undefined;
    env.MANAGED_RELEASE_SERVICE = {
      async fetch(request: Request) {
        const wire =
          new URL(request.url).pathname === "/v1/owner-releases/pin"
            ? ((await request.clone().json()) as SignedServiceRequest)
            : undefined;
        const response = await managedModeration.fetch(
          request as Parameters<typeof managedModeration.fetch>[0],
          managedEnv,
        );
        if (wire && response.ok) acceptedPin = wire;
        return response;
      },
    } as Fetcher;
    const call = (path: string, init: RequestInit = {}) =>
      communityFetch(new Request(deployment.origin + path, init), env);
    async function login(role = "owner") {
      const account = role === "other" ? web2Other : web2Owner,
        headers = {
          origin: deployment.origin,
          "content-type": "application/json",
        };
      const response = await call("/api/auth/challenge", {
        method: "POST",
        headers,
        body: JSON.stringify({ address: account.address }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const challenge = (await response.json()) as {
        id: string;
        message: string;
        kind?: string;
      };
      const verified = await call("/api/auth/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: challenge.id,
          signature: await account.signMessage({ message: challenge.message }),
        }),
      });
      assert.equal(verified.status, 200, await verified.clone().text());
      const cookie = verified.headers.get("set-cookie")!.split(";")[0]!,
        sessionResponse = await call("/api/session", { headers: { cookie } });
      assert.equal(
        sessionResponse.status,
        200,
        await sessionResponse.clone().text(),
      );
      const session = (await sessionResponse.json()) as { csrf: string };
      return {
        challenge,
        cookie,
        write: (
          path: string,
          method: string,
          body: BodyInit,
          extra: Record<string, string> = {},
        ) =>
          call(path, {
            method,
            body,
            headers: {
              cookie,
              origin: deployment.origin,
              "x-csrf-token": session.csrf,
              ...extra,
            },
          }),
      };
    }
    type Account = Awaited<ReturnType<typeof login>>;
    const audio = new Uint8Array(1600 * 417);
    for (let i = 0; i < 1600; i++) audio.set([0xff, 0xfb, 0x90, 0], i * 417);
    const reserve = (account: Account) =>
      account.write(
        "/api/uploads",
        "POST",
        JSON.stringify({
          title: "Actual Web2 first song",
          language: "en",
          lyrics: "We sail away\nWe sail away",
          original: true,
          acceptedPolicy: CATALOG_OWNER_POLICY_VERSION,
          rating: "general",
          terms: { revision: 1, allowsDerivatives: false },
          audioSha256: sha256(audio),
          audioBytes: audio.length,
        }),
        {
          "content-type": "application/json",
          "idempotency-key": "web2-first-song-" + crypto.randomUUID(),
        },
      );
    async function operations(jobId: string) {
      return (
        await community.db
          .prepare(
            "SELECT * FROM external_operations WHERE job_id=? ORDER BY step",
          )
          .bind(jobId)
          .all<ExternalOperation>()
      ).results;
    }
    async function publish(account: Account, { restart = false } = {}) {
      if (restart) c.loseNextBroadcastAcknowledgement();
      const reserved = await reserve(account);
      assert.equal(reserved.status, 201, await reserved.clone().text());
      const { submissionId } = (await reserved.json()) as {
        submissionId: string;
      };
      const uploaded = await account.write(
        `/api/uploads/${submissionId}/audio`,
        "PUT",
        audio,
        { "content-type": "audio/mpeg" },
      );
      assert.equal(uploaded.status, 200, await uploaded.clone().text());
      for (const slot of ["instrumental", "vocals"]) {
        const reservedStem = await account.write(
          `/api/uploads/${submissionId}/stems/${slot}`,
          "POST",
          JSON.stringify({ sha256: sha256(audio), byteLength: audio.length }),
          { "content-type": "application/json" },
        );
        assert.equal(
          reservedStem.status,
          201,
          await reservedStem.clone().text(),
        );
        const stem = await account.write(
          `/api/uploads/${submissionId}/stems/${slot}`,
          "PUT",
          audio,
          { "content-type": "audio/mpeg" },
        );
        assert.equal(stem.status, 200, await stem.clone().text());
      }
      const sealed = await account.write(
        `/api/uploads/${submissionId}/seal`,
        "POST",
        "{}",
        { "content-type": "application/json" },
      );
      assert.equal(sealed.status, 202, await sealed.clone().text());
      const { jobId } = (await sealed.json()) as { jobId: string };
      let job: PublicationJob = await loadJob(community.db, jobId);
      for (
        let round = 0;
        round < 60 &&
        !["published", "held", "failed", "blocked"].includes(job.phase);
        round++
      ) {
        await catalog.scheduled();
        for (let n = 0; n < 6 && wakes.length; n++) {
          const wake = wakes.shift()!;
          await catalog.queue({
            messages: [
              {
                body: wake,
                ack() {},
                retry() {
                  wakes.push(wake);
                },
              } as Message<RecognitionWake>,
            ],
          });
        }
        await c.rpc("evm_mine");
        await communityQueue(
          {
            messages: [
              { body: { jobId }, ack() {}, retry() {} } as Message<{
                jobId: string;
              }>,
            ],
          },
          env,
        );
        job = await loadJob(community.db, jobId);
        if (
          restart &&
          ((lostPin && restarts === 0) ||
            (c.broadcastAcknowledgementLost() && restarts === 1))
        ) {
          for (const op of await operations(jobId))
            if (op.prepared_json) {
              if (originalBeforeRestart.has(op.operation_id))
                assert.equal(
                  op.prepared_json,
                  originalBeforeRestart.get(op.operation_id),
                );
              else originalBeforeRestart.set(op.operation_id, op.prepared_json);
            }
          catalog = build();
          restarts++;
          await communityScheduled(env);
        }
      }
      if (job.phase !== "published") {
        const ops = await operations(jobId);
        let diagnostic: string | undefined;
        const planned = ops.find(
          (op) => op.step === "publication" && op.status === "planned",
        );
        // Diagnose the same saved original read/sign preparation, with no send or state repair.
        if (planned)
          try {
            await preparePosting(
              planned,
              firstSongRuntime(env, await current(), current, deployment)
                .posting,
            );
          } catch (error) {
            diagnostic = error instanceof Error ? error.stack : String(error);
          }
        await mkdir(".local/web2-first-song", { recursive: true });
        await writeFile(
          `.local/web2-first-song/failed-${submissionId}.json`,
          JSON.stringify({ job, operations: ops, diagnostic }, null, 2),
        );
        assert.fail(
          JSON.stringify({
            phase: job.phase,
            diagnostic,
            operations: ops.map((op) => ({ step: op.step, status: op.status })),
          }),
        );
      }
      await c.rpc("evm_mine");
      return { job, jobId, submissionId, audio };
    }
    type Song = Awaited<ReturnType<typeof publish>>;
    async function assertPublicSong(song: Song) {
      const response = await call("/api/feed");
      assert.equal(response.status, 200, await response.clone().text());
      const feed = (await response.json()) as {
        posts: Array<{
          manifest: { postId: string };
          audioUrl: string;
          transactionHash: Hex;
        }>;
      };
      assert.equal(feed.posts.length, 1);
      const post = feed.posts[0]!;
      const receipt = await c.client.getTransactionReceipt({
        hash: post.transactionHash,
      });
      assert.equal(receipt.status, "success");
      assert.equal(receipt.to?.toLowerCase(), deployment.posts.address);
      const media = await call(post.audioUrl);
      assert.equal(media.status, 200, await media.clone().text());
      assert.deepEqual(new Uint8Array(await media.arrayBuffer()), song.audio);
      const proof = await call(
        `/api/public/posts/${post.manifest.postId}/proof`,
      );
      assert.equal(proof.status, 200, await proof.clone().text());
      return { post, receipt, proof: await proof.json() };
    }
    return {
      close,
      login,
      publish,
      reserve,
      effects: c.effects,
      async discovery() {
        const value = await read();
        assert.equal(value.eligibility.status, "available");
        return value.eligibility;
      },
      setDiscovery: async (_value: "expired") => {
        await c.expireDiscovery();
        const value = await read();
        assert.equal(value.verificationSnapshot.web2.verifiedAtBlock, true);
        assert.equal(value.eligibility.status, "available");
        assert.equal(value.eligibility.web2Verified, false);
      },
      async setAuthority(value: "unavailable" | "stale") {
        c.unavailable(value === "unavailable");
        if (value === "stale")
          deployment.freshness.maxSafeBlockAgeSeconds = "0";
        env.COMMUNITY_DEPLOYMENT_PROFILE_JSON = JSON.stringify(deployment);
        managedEnv.DIRECTORY_PROFILES_JSON = JSON.stringify([deployment]);
      },
      loseNextPinAcknowledgement() {
        losePinAck = true;
      },
      assertPublicSong,
      async assertManagedAuthorityRefusal() {
        assert.ok(
          acceptedPin,
          "the real managed handler must first accept a correctly signed pin request",
        );
        const before = { ...c.effects };
        const request = async () => {
          const issuedAt = Math.floor(Date.now() / 1000),
            signed = await signServiceRequest(
              web2Publisher,
              {
                ...acceptedPin!.authorization,
                nonce: hashText(crypto.randomUUID()),
                issuedAt,
                expiresAt: issuedAt + 120,
              },
              acceptedPin!.body,
            );
          return managedModeration.fetch(
            new Request(deployment.managedOrigin + "/v1/owner-releases/pin", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: canonical(signed),
            }) as Parameters<typeof managedModeration.fetch>[0],
            managedEnv,
          );
        };
        managedEnv.DIRECTORY_PROFILES_JSON = JSON.stringify([
          { ...deployment, freshness: { maxSafeBlockAgeSeconds: "0" } },
        ]);
        const stale = await request();
        assert.equal(stale.status, 503);
        assert.equal(
          ((await stale.json()) as { error: string }).error,
          "community_authority_unavailable",
        );
        managedEnv.DIRECTORY_PROFILES_JSON = JSON.stringify([deployment]);
        c.unavailable(true);
        const unavailable = await request();
        assert.equal(unavailable.status, 503);
        assert.deepEqual(c.effects, before);
        c.unavailable(false);
      },
      async learningAuthorizations() {
        const table = await community.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='learning_authorizations'",
          )
          .first();
        return table
          ? (await community.db
              .prepare("SELECT count(*) AS count FROM learning_authorizations")
              .first<{ count: number }>())!.count
          : 0;
      },
      async assertOriginalsRetained(song: Song) {
        assert.equal(restarts, 2);
        assert.ok(originalBeforeRestart.size > 0);
        const ops = await operations(song.jobId);
        for (const [id, prepared] of originalBeforeRestart)
          assert.equal(
            ops.find((op) => op.operation_id === id)?.prepared_json,
            prepared,
          );
        const publication = ops.filter((op) => op.step === "publication");
        assert.equal(publication.length, 1);
        const prepared = JSON.parse(publication[0]!.prepared_json!);
        assert.equal(prepared.replay.kind, "same_signed_transaction");
        assert.deepEqual(c.broadcastTransactions, [
          prepared.replay.signedTransaction,
        ]);
        assert.equal(c.effects.pinAdds, 3);
      },
      async configurationHistory() {
        return (await read()).history;
      },
      configureNextRevision: () => c.nextRevision(),
      async writeArtifact(label: string, song: Song) {
        const facts = await assertPublicSong(song),
          ops = await operations(song.jobId);
        const artifact = {
          schema: "pirate.web2-first-song-evidence/1",
          scope:
            "actual application integration; runtime objects reconstructed, no installed Linux or backup/restore claim",
          externalSimulations: [
            "ACRCloud identify/catalog",
            "Filebase add/pin and IPFS gateway",
          ],
          deployment,
          configurationSha256: hashJson(c.current()),
          audioSha256: sha256(audio),
          registrationTransaction: c.original.transactionHash,
          postTransaction: facts.post.transactionHash,
          receipt: hashJson(
            JSON.parse(
              JSON.stringify(facts.receipt, (_key, v) =>
                typeof v === "bigint" ? String(v) : v,
              ),
            ),
          ),
          jobId: song.jobId,
          operations: ops.map((op) => ({
            id: op.operation_id,
            step: op.step,
            requestHash: op.request_hash,
            preparedSha256: op.prepared_json
              ? hashText(op.prepared_json)
              : null,
          })),
          effects: c.effects,
        };
        await mkdir(".local/web2-first-song", { recursive: true });
        await writeFile(
          `.local/web2-first-song/${label}.json`,
          JSON.stringify(artifact, null, 2),
        );
      },
      async assertExcludedFeatures() {
        await community.applyV4();
        Object.assign(env, {
          STUDY_RESULTS_V4_CONTRACT: web2Other.address,
          STUDY_RESULTS_V3_CONTRACT: web2Other.address,
          KARAOKE_SERVICE_MODE: "internal",
          DANCE_REWARD_SOURCE_JSON: "injected old binding",
          REWARDS_PROFILE_JSON: "injected old binding",
        });
        const account = await login();
        assert.equal(account.challenge.kind, undefined);
        const before = { ...c.effects };
        for (const path of [
          "/api/study/lessons",
          "/api/karaoke/tickets",
          "/api/learning/public-results/on",
          "/api/media",
          "/api/dance/rooms",
          "/api/member-name",
          "/api/community/join",
          `/api/public/posts/${hashText("post")}/karaoke`,
        ])
          assert.equal((await call(path)).status, 404, path);
        assert.equal(
          (
            await call("/api/session", {
              headers: { "X-Pirate-Native-Request": "injected old envelope" },
            })
          ).status,
          503,
        );
        const old = await loginChallenge(
          community.db,
          { communityId: c.profile.communityId, origin: deployment.origin },
          web2Owner.address,
          Date.now(),
          {
            chainId: 6343,
            contract: web2Other.address,
            communityId: c.profile.communityId,
            publicationPolicy: hashText("retained old V4 policy"),
            policyVersion: 1,
          },
        );
        assert.ok("kind" in old);
        assert.equal(old.kind, "sign-in-v4");
        const rejected = await call("/api/auth/verify", {
          method: "POST",
          headers: {
            origin: deployment.origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id: old.id,
            signature: await web2Owner.signMessage({ message: old.message }),
          }),
        });
        assert.equal(rejected.status, 403, await rejected.clone().text());
        assert.equal(
          (await community.db
            .prepare(
              "SELECT consumed FROM login_challenges WHERE challenge_id=?",
            )
            .bind(old.id)
            .first<{ consumed: number }>())!.consumed,
          0,
        );
        const capabilities = (await (
          await call("/api/capabilities")
        ).json()) as { study: boolean; learningPolicy?: unknown };
        assert.equal(capabilities.study, false);
        assert.equal(capabilities.learningPolicy, undefined);
        await communityQueue(
          {
            messages: [
              {
                body: { kind: "community-media/1" },
                ack() {
                  throw Error(
                    "excluded private media cannot be acknowledged as work",
                  );
                },
                retry() {},
              } as unknown as Message<never>,
            ],
          },
          env,
        );
        await communityScheduled(env);
        assert.deepEqual(c.effects, before);
        assert.equal(
          (await community.db
            .prepare("SELECT count(*) AS count FROM learning_authorizations")
            .first<{ count: number }>())!.count,
          0,
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
