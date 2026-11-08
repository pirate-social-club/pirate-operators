// Owner-only unregistered publication through the actual community and managed
// handlers. ACRCloud, IPFS and the MegaETH chain are explicit simulations. No
// creator service, registration signer, registration client or Aeneid client
// exists anywhere in these ports; any registration route request fails.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Effect } from "effect";
import { communityRuntime } from "../community-runtime.ts";
import { releaseFixture } from "./release-service.ts";
import {
  publisher,
  configuration as baselineConfiguration,
} from "./release-admission.ts";
import { releasePostsFixture } from "./release-posts.ts";
import {
  hashJson,
  hashText,
  publicId,
} from "../../packages/community/common.ts";
import { validateConfig } from "../../packages/community/config-manifest.ts";
import {
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../../packages/community/owner-policy.ts";
import { validateOwnerAuthorization } from "../../packages/community/owner-authorization.ts";
import {
  reserveOwnerSubmission,
  sealSubmission,
} from "../../packages/community/submissions.ts";
import { uploadAudio } from "../../packages/community/uploads.ts";
import {
  reserveStem,
  uploadStem,
  stemSlots,
} from "../../packages/community/stems.ts";
import { serveInputCapability } from "../../packages/community/input-capabilities.ts";
import { publicationStep } from "../../packages/community/publication.ts";
import {
  loadJob,
  resumeUncertainJob,
} from "../../packages/community/publication-store.ts";
import { publicationExecutionProfile } from "../../packages/community/publication-profile.ts";
import { managedFetch } from "../../packages/moderation/service.ts";
import {
  ownerGrantDigest,
  validateOwnerGrant,
  type OwnerBudgetGrant,
} from "../../packages/release/owner-grant.ts";
import { ownerReleaseFetch } from "../../packages/release/owner-release.ts";
import { firstSongDriver } from "../../services/first-song-driver.ts";
import type { AccountSession } from "../../packages/community/accounts.ts";

export const ownerController = privateKeyToAccount(`0x${"41".repeat(32)}`);

export async function ownerSongFixture(
  limits: Partial<OwnerBudgetGrant["limits"]> = {},
) {
  const configuration = validateConfig({
    ...baselineConfiguration,
    controller: ownerController.address.toLowerCase(),
    policies: {
      ...baselineConfiguration.policies,
      admission: {
        version: UNREGISTERED_OWNER_POLICY_VERSION,
        sha256: UNREGISTERED_OWNER_POLICY_HASH,
      },
    },
  });
  const community = await communityRuntime(),
    managed = await releaseFixture(1001, false, 3600, false);
  try {
    const apply = async (db: D1Database, path: string) => {
      const sql = await readFile(path, "utf8");
      await db.batch(
        sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    };
    // The shared community runtime stops at Study 0010; owner publishing sits
    // after rewards 0011 in the real chain, so apply both here.
    for (const name of [
      "0011_manual_rewards.sql",
      "0012_owner_budget_windows.sql",
    ])
      await apply(
        community.db,
        `apps/community-wizard/infra/migrations/${name}`,
      );
    await apply(
      managed.db,
      "apps/managed-moderation/migrations/0004_owner_budget_windows.sql",
    );
    managed.config.currentConfiguration = async () => configuration;
    managed.config.pairings[0]!.controller = configuration.controller;
    const now = Math.floor(Date.now() / 1000),
      session: AccountSession = {
        session_hash: hashText("owner-session"),
        account_id: crypto.randomUUID(),
        author_id: publicId(),
        binding_id: "owner-moss",
        wallet: publisher.address.toLowerCase() as `0x${string}`,
        csrf_token: "owner-csrf",
        expires_at: Date.now() + 900000,
      };
    // No creator binding is inserted for the owner: none is needed.
    await community.db
      .prepare("INSERT INTO community_accounts VALUES(?,?,?)")
      .bind(session.account_id, session.author_id, Date.now())
      .run();
    const draft = {
      schema: "pirate.owner-publishing-grant/1" as const,
      sha256: "0x" + "00".repeat(32),
      communityId: configuration.communityId,
      communityOrigin: configuration.app.origin,
      ownerWallet: session.wallet,
      policy: configuration.policies.admission,
      destination: {
        chainId: configuration.chainId,
        postsContract: configuration.postsContract,
        publisher: configuration.publisher,
      },
      validFrom: now - 60,
      expiresAt: now + 3600,
      limits: {
        songs: 3,
        pinAdds: 15,
        pinBytes: String(64 * 1024 * 1024),
        recognitionRequests: 12,
        postFeeWei: "90000000000000",
        ...limits,
      },
    };
    const grant = validateOwnerGrant({
      ...draft,
      sha256: ownerGrantDigest(draft),
    });
    (managed.config as { ownerGrant?: OwnerBudgetGrant }).ownerGrant = grant;
    const authorizationBody = {
      schema: "pirate.owner-publishing-authorization/1",
      communityId: configuration.communityId,
      ownerWallet: session.wallet,
      policy: configuration.policies.admission,
      validFrom: now - 60,
      expiresAt: now + 3600,
    };
    const ownerAuthorization = {
      authorization: authorizationBody,
      signature: await ownerController.signMessage({
        message: { raw: hashJson(authorizationBody) as `0x${string}` },
      }),
    };
    const authorization = (
      await validateOwnerAuthorization(ownerAuthorization, configuration)
    ).authorization;
    let registrationRequests = 0,
      remoteRequests = 0;
    const ownerService = {
      origin: managed.service.origin,
      ownerGrant: grant,
      pairings: managed.config.pairings,
      currentConfiguration: async () => configuration,
      filebaseCredential: "fixture-token",
      acrEndpoint: managed.service.acrEndpoint,
      pinTransport: managed.service.pinTransport,
    };
    const transport = (request: Request) => {
      remoteRequests++;
      const path = new URL(request.url).pathname;
      if (path.startsWith("/v1/releases/register")) {
        registrationRequests++;
        return Promise.resolve(
          Response.json({ error: "registration_unreachable" }, { status: 503 }),
        );
      }
      return path.startsWith("/v1/admissions")
        ? managedFetch(request, managed.db, managed.config)
        : ownerReleaseFetch(request, managed.db, managed.media, ownerService);
    };
    const posts = releasePostsFixture(publisher, configuration),
      client = {
        origin: managed.service.origin,
        publisher,
        configuration,
        transport,
      };
    const ports = {
      db: community.db,
      media: community.media,
      managed: client,
      release: {
        client,
        grantHash: grant.sha256,
        ownerGrant: grant,
        ipfs: managed.service.pinTransport,
      },
      posting: {
        db: community.db,
        client: posts.client,
        publisher,
        profile: posts.profile,
        config: configuration,
        currentConfiguration: async () => configuration,
        bounds: {
          period: "owner-fixture",
          maximumGas: "1000000",
          maximumGasPrice: "30000000",
          maximumTotalFee: "30000000000000",
          expiresAt: grant.expiresAt,
        },
        ownerGrant: grant,
      },
      acrEndpoint: managed.service.acrEndpoint,
      checkServices: async () => {},
      ownerAuthorization,
    };
    const profile = {
      execution: publicationExecutionProfile(ports),
      chainId: 6343,
      communityId: configuration.communityId,
      postsContract: configuration.postsContract,
      configurationRevision: 1,
      publisher: configuration.publisher,
      moderationSigner: configuration.policies.moderationSigner,
    };
    managed.config.inputTransport = (request) =>
      serveInputCapability(
        request,
        community.db,
        community.media,
        configuration.app.origin,
      );
    const addSong = async (title: string, key: string) => {
      const row = await reserveOwnerSubmission(
        community.db,
        session,
        profile,
        authorization,
        {
          title,
          language: "en",
          lyrics: managed.lyrics,
          original: true,
          acceptedPolicy: UNREGISTERED_OWNER_POLICY_VERSION,
          rating: "general",
          audioSha256: sha256(managed.audio),
          audioBytes: managed.audio.length,
        },
        key,
      );
      await uploadAudio(
        community.db,
        community.media,
        session.account_id,
        row.submission_id,
        new Request(configuration.app.origin + "/api/uploads/audio", {
          method: "PUT",
          headers: { "content-type": "audio/mpeg" },
          body: managed.audio,
        }),
      );
      for (const slot of stemSlots) {
        await reserveStem(
          community.db,
          session.account_id,
          row.submission_id,
          slot,
          { sha256: sha256(managed.audio), byteLength: managed.audio.length },
        );
        await uploadStem(
          community.db,
          community.media,
          session.account_id,
          row.submission_id,
          slot,
          new Request(configuration.app.origin + "/fixture", {
            method: "PUT",
            headers: { "content-type": "audio/mpeg" },
            body: managed.audio,
          }),
        );
      }
      const sealed = await sealSubmission(
        community.db,
        community.media,
        session,
        profile,
        row.submission_id,
        Date.now(),
        authorization,
      );
      return { row, sealed };
    };
    /** Runs a job until it settles; recovers uncertain steps like a wakeup would. */
    const history: string[] = [];
    const drive = async (jobId: string, rounds = 40) => {
      let offset = 0;
      for (let i = 0; i < rounds; i++) {
        const job = await loadJob(community.db, jobId);
        history.push(job.phase);
        if (["published", "blocked", "held", "failed"].includes(job.phase))
          return job;
        if (job.phase === "uncertain") {
          await managed.runQueued();
          if (JSON.parse(job.progress_json).resumePhase === "publication")
            posts.mine();
          await resumeUncertainJob(community.db, jobId, session.account_id);
          continue;
        }
        try {
          await Effect.runPromise(
            publicationStep(community.db, jobId, firstSongDriver(ports), {
              now: () => Date.now() + offset,
            }),
          );
        } catch (error) {
          history.push(
            `error:${(error as { code?: string }).code ?? String(error).slice(0, 120)}`,
          );
          offset += 180001;
        }
      }
      return loadJob(community.db, jobId);
    };
    return {
      community,
      managed,
      configuration,
      session,
      grant,
      authorization,
      ownerAuthorization,
      posts,
      ports,
      profile,
      addSong,
      drive,
      history: () => history,
      registrationRequests: () => registrationRequests,
      remoteRequests: () => remoteRequests,
      dispose: async () => {
        await community.dispose();
        await managed.dispose();
      },
    };
  } catch (error) {
    await community.dispose();
    await managed.dispose();
    throw error;
  }
}
