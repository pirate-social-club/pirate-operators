import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { managedRequest } from "../../packages/community/managed-client.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import { createLyrics } from "../../packages/community/lyric-manifest.ts";
import { hashJson, publicId } from "../../packages/community/common.ts";
import {
  signServiceRequest,
  type ServiceAuthorization,
} from "../../packages/moderation/pairing.ts";
import {
  managedFetch,
  runAdmission,
} from "../../packages/moderation/service.ts";
import { releaseFetch } from "../../packages/release/service.ts";
import {
  releaseGrantDigest,
  validateReleaseGrant,
} from "../../packages/release/grant.ts";
import type { ReleaseGrant } from "../../packages/release/authority.ts";
import {
  publisher,
  configuration,
  releaseAdmissionFixture,
} from "./release-admission.ts";
import { releaseStoryFixture } from "./release-story.ts";
import type { Hex } from "viem";

export async function releaseFixture(
  acrCode = 1001,
  responseLost = false,
  lifetime = 3600,
  preAdmit = true,
) {
  const f = await releaseAdmissionFixture(acrCode, responseLost);
  try {
    for (const path of [
      "packages/release/authority-schema.sql",
      "packages/release/pin-schema.sql",
      "packages/release/registration-schema.sql",
    ]) {
      const sql = await readFile(path, "utf8");
      await f.db.batch(
        sql
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => f.db.prepare(s)),
      );
    }
    const admissionId = hashJson({
      communityId: configuration.communityId,
      jobId: f.body.jobId,
    });
    let admissionState = "not_started";
    if (preAdmit) {
      assert.equal((await f.send()).status, 202);
      admissionState = await runAdmission(f.db, f.media, admissionId, f.config);
    }
    const story = releaseStoryFixture(publisher),
      recipient = "0x2222222222222222222222222222222222222222",
      expiresAt = Math.floor(Date.now() / 1000) + lifetime,
      placeholder = publicId();
    const grant: ReleaseGrant = {
      sha256: placeholder,
      communityId: configuration.communityId,
      communityOrigin: configuration.app.origin,
      configurationRevision: 1,
      publisher: configuration.publisher,
      contentSha256: f.body.declared.songSha256,
      recipient,
      expiresAt,
      pins: { sha256: placeholder, period: "release-fixture", maximumAdds: 5 },
      registration: {
        sha256: placeholder,
        period: "release-fixture",
        operator: configuration.publisher,
        recipient,
        contentSha256: f.body.declared.songSha256,
        maximumGas: "2000000",
        maximumGasPrice: "2000000000",
        maximumTotalFee: "4000000000000000",
        expiresAt,
        codeHashes: {
          workflow: story.codeHash,
          nft: story.codeHash,
          registry: story.codeHash,
        },
      },
    };
    grant.sha256 = releaseGrantDigest(grant);
    grant.pins.sha256 = grant.sha256;
    grant.registration.sha256 = grant.sha256 as Hex;
    validateReleaseGrant(grant);
    const postId = publicId(),
      context = {
        jobId: f.body.jobId,
        admissionId,
        postId,
        authorId: publicId(),
        recipient,
        lineage: "root",
        lyrics: createLyrics(
          {
            chainId: 6343,
            postsContract: configuration.postsContract,
            communityId: configuration.communityId,
            postId,
          },
          f.lyrics,
          "en",
        ),
      };
    let beforeMedia: (() => void) | undefined;
    const releaseMedia = {
      ...f.media,
      get: async (key: string) => {
        beforeMedia?.();
        return f.media.get(key);
      },
    };
    const retained = new Map<string, Uint8Array>();
    let adds = 0;
    const service = {
      origin: f.config.serviceOrigin,
      grant,
      pairings: f.config.pairings,
      currentConfiguration: f.config.currentConfiguration,
      filebaseCredential: "fixture-token",
      registrationSigner: publisher,
      registrationClient: story.client,
      acrEndpoint: "https://identify-eu-west-1.acrcloud.com/v1/identify",
      pinTransport: async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v0/add") {
          adds++;
          const form = await request.formData(),
            file = form.get("file") as File,
            bytes = new Uint8Array(await file.arrayBuffer()),
            intent = await preparePin(
              bytes,
              file.type as "audio/mpeg" | "application/json",
            );
          retained.set(intent.uri.slice(7), bytes);
          return new Response(JSON.stringify({ Hash: intent.uri.slice(7) }));
        }
        if (url.pathname === "/api/v0/pin/ls") {
          const cid = url.searchParams.get("arg")!;
          return Response.json({
            Keys: retained.has(cid) ? { [cid]: { Type: "recursive" } } : {},
          });
        }
        const bytes = retained.get(url.pathname.slice("/ipfs/".length));
        return bytes
          ? new Response(new Uint8Array(bytes))
          : new Response("missing fixture content", { status: 404 });
      },
    };
    const send = async (path: string, body: Record<string, unknown>) => {
      const actions: Record<string, ServiceAuthorization["action"]> = {
        pin: "release_pin",
        "pin/status": "release_pin_status",
        register: "release_register",
        "register/status": "release_register_status",
      };
      const now = Math.floor(Date.now() / 1000),
        signed = await signServiceRequest(
          publisher,
          {
            action: actions[path]!,
            communityId: configuration.communityId,
            communityOrigin: configuration.app.origin,
            serviceOrigin: service.origin,
            configurationRevision: 1,
            nonce: publicId(),
            issuedAt: now,
            expiresAt: now + 300,
          },
          body,
        );
      return releaseFetch(
        new Request(service.origin + "/v1/releases/" + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(signed),
        }),
        f.db,
        releaseMedia,
        service,
      );
    };
    return {
      ...f,
      admissionState,
      service,
      grant,
      transport: (request: Request) =>
        new URL(request.url).pathname.startsWith("/v1/admissions")
          ? managedFetch(request, f.db, f.config)
          : releaseFetch(request, f.db, releaseMedia, service),
      runQueued: async () => {
        for (const id of f.queued.splice(0))
          await runAdmission(f.db, f.media, id, f.config);
      },
      beforeMedia: (hook: () => void) => {
        beforeMedia = hook;
      },
      sendRelease: send,
      clientRequest: (
        path: string,
        action: ServiceAuthorization["action"],
        body: Record<string, unknown>,
      ) =>
        managedRequest(
          {
            origin: service.origin,
            publisher,
            configuration,
            transport: (request) =>
              releaseFetch(request, f.db, releaseMedia, service),
          },
          path,
          action,
          body,
        ),
      context,
      retained,
      adds: () => adds,
      story,
    };
  } catch (error) {
    await f.dispose();
    throw error;
  }
}
