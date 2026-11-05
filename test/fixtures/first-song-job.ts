import assert from "node:assert/strict";
import { preparePin } from "../../packages/community/ipfs.ts";
import { publicationInput } from "../../packages/community/publication-input.ts";
import { validateReleaseResult } from "../../packages/community/publication-release.ts";
import { sha256 } from "viem";
import { Effect } from "effect";
import { communityRuntime } from "../community-runtime.ts";
import { releaseFixture } from "./release-service.ts";
import {
  publisher,
  configuration as baselineConfiguration,
} from "./release-admission.ts";
import { releasePostsFixture } from "./release-posts.ts";
import { hashText, publicId } from "../../packages/community/common.ts";
import {
  reserveSubmission,
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
import type { ExternalOperation } from "../../packages/community/publication-store.ts";
import {
  loadJob,
  resumeUncertainJob,
} from "../../packages/community/publication-store.ts";
import {
  syncPublicPosts,
  indexedPublicPosts,
} from "../../packages/community/post-index.ts";
import { publicationExecutionProfile } from "../../packages/community/publication-profile.ts";
import { firstSongDriver } from "../../services/first-song-driver.ts";
import type { AccountSession } from "../../packages/community/accounts.ts";

export async function firstSongJobFixture(
  options: {
    loseFirstPinResponse?: boolean;
    responseLost?: boolean;
    controller?: `0x${string}`;
  } = {},
) {
  const configuration = options.controller
    ? { ...baselineConfiguration, controller: options.controller }
    : baselineConfiguration;
  const community = await communityRuntime(),
    managed = await releaseFixture(
      1001,
      options.responseLost ?? false,
      3600,
      false,
    );
  try {
    if (options.controller) {
      managed.config.currentConfiguration = async () => configuration;
      managed.service.currentConfiguration = async () => configuration;
      managed.config.pairings[0]!.controller = configuration.controller;
    }
    // Explicit completed authentication/native-binding fixture. Their real
    // cryptography/device acceptance is owned by their separate tests and pilot.
    const session: AccountSession = {
      session_hash: hashText("fixture-session"),
      account_id: crypto.randomUUID(),
      author_id: publicId(),
      binding_id: "fixture-moss",
      wallet: publisher.address.toLowerCase() as `0x${string}`,
      csrf_token: "fixture-csrf",
      expires_at: Date.now() + 900000,
    };
    await community.db.batch([
      community.db
        .prepare("INSERT INTO community_accounts VALUES(?,?,?)")
        .bind(session.account_id, session.author_id, Date.now()),
      community.db
        .prepare(
          "INSERT INTO creator_bindings VALUES(?,'https://wallet.example','fixture-credential','fixture-sui','fixture-dwallet','fixture-cap','fixture-share',?,'{}',?)",
        )
        .bind(session.account_id, managed.context.recipient, Date.now()),
    ]);
    let remoteRequests = 0;
    const posts = releasePostsFixture(publisher, configuration),
      client = {
        origin: managed.service.origin,
        publisher,
        configuration,
        transport: (request: Request) => {
          remoteRequests++;
          return managed.transport(request);
        },
      };
    const originalPinTransport = managed.service.pinTransport;
    let lostPinResponse = false;
    managed.service.pinTransport = async (request) => {
      const response = await originalPinTransport(request);
      if (
        options.loseFirstPinResponse &&
        !lostPinResponse &&
        new URL(request.url).pathname === "/api/v0/add"
      ) {
        lostPinResponse = true;
        throw new Error("fixture response lost after retained pin");
      }
      return response;
    };
    const ports = {
      db: community.db,
      media: community.media,
      managed: client,
      release: {
        client,
        grantHash: managed.grant.sha256,
        registrationOperator: managed.grant.registration.operator,
        story: managed.story.client,
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
          period: "fixture-first-song",
          maximumGas: "1000000",
          maximumGasPrice: "30000000",
          maximumTotalFee: "30000000000000",
          expiresAt: managed.grant.expiresAt,
        },
      },
      acrEndpoint: managed.service.acrEndpoint,
      checkServices: async () => {},
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
    const row = await reserveSubmission(
      community.db,
      session,
      profile,
      {
        title: managed.title,
        language: "en",
        lyrics: managed.lyrics,
        original: true,
        acceptedPolicy: "pirate-release/2026-08-29",
        audioSha256: sha256(managed.audio),
        audioBytes: managed.audio.length,
      },
      "fixture-durable-first-song-key",
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
    );
    managed.config.inputTransport = (request) =>
      serveInputCapability(
        request,
        community.db,
        community.media,
        configuration.app.origin,
      );
    return {
      community,
      configuration,
      managed,
      session,
      row,
      sealed,
      posts,
      ports,
      lostPinResponse: () => lostPinResponse,
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
