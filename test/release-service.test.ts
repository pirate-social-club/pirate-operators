import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { managedRequest } from "../packages/community/managed-client.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import { publicId } from "../packages/community/common.ts";
import {
  signServiceRequest,
  type ServiceAuthorization,
} from "../packages/moderation/pairing.ts";
import { runAdmission } from "../packages/moderation/service.ts";
import { releaseFetch } from "../packages/release/service.ts";
import {
  releaseGrantDigest,
  validateReleaseGrant,
} from "../packages/release/grant.ts";
import type { ReleaseGrant } from "../packages/release/authority.ts";
import {
  publisher,
  configuration,
  releaseAdmissionFixture,
} from "./fixtures/release-admission.ts";
import { releaseStoryFixture } from "./fixtures/release-story.ts";
import type { Hex } from "viem";

async function releaseFixture(
  acrCode = 1001,
  responseLost = false,
  lifetime = 3600,
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
    assert.equal((await f.send()).status, 202);
    const admissionId = f.queued[0]!;
    const admissionState = await runAdmission(
      f.db,
      f.media,
      admissionId,
      f.config,
    );
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
test("managed ROOT release composes admitted sealed content, canonical metadata, capped mint and retrievable manifest; status and retries buy nothing", async () => {
  const f = await releaseFixture();
  try {
    const absent = await f.clientRequest(
      "/v1/releases/pin/status",
      "release_pin_status",
      { context: f.context, role: "audio" },
    );
    assert.equal(absent.status, 404);
    let response = await f.sendRelease("pin/status", {
      context: f.context,
      role: "audio",
    });
    assert.equal(response.status, 404);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM managed_releases")
        .first())!.n,
      0,
    );
    response = await f.sendRelease("pin", {
      context: f.context,
      role: "audio",
      metadataUri: "ipfs://caller-chosen",
    });
    assert.equal(response.status, 400);
    assert.equal(f.adds(), 0);
    for (const role of ["audio", "lyrics", "ip_metadata", "nft_metadata"]) {
      response = await f.sendRelease("pin", { context: f.context, role });
      assert.equal(
        response.status,
        200,
        JSON.stringify(await response.clone().json()),
      );
    }
    assert.equal(f.adds(), 4);
    const noMint = await f.clientRequest(
      "/v1/releases/register/status",
      "release_register_status",
      { context: f.context },
    );
    assert.equal(noMint.status, 404);
    response = await f.sendRelease("register/status", { context: f.context });
    assert.equal(response.status, 404);
    assert.equal(f.story.broadcasts(), 0);
    response = await f.sendRelease("register", { context: f.context });
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    assert.equal(f.story.mints(), 1);
    response = await f.sendRelease("register/status", { context: f.context });
    assert.equal(response.status, 200);
    assert.equal(f.story.broadcasts(), 1);
    response = await f.sendRelease("pin", {
      context: f.context,
      role: "post_manifest",
    });
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    const value = (await response.json()) as {
        result: { pin: { uri: string } };
      },
      manifest = JSON.parse(
        new TextDecoder().decode(f.retained.get(value.result.pin.uri.slice(7))),
      );
    assert.equal(manifest.postId, f.context.postId);
    assert.equal(manifest.registration.recipient, f.context.recipient);
    assert.equal(
      manifest.registration.contentSha256,
      f.body.declared.songSha256,
    );
    assert.equal(manifest.media.length, 2);
    assert.equal(f.adds(), 5);
    for (const path of ["pin/status", "pin"]) {
      response = await f.sendRelease(path, {
        context: f.context,
        role: "post_manifest",
      });
      assert.equal(response.status, 200);
    }
    assert.equal(f.adds(), 5);
    assert.equal(f.story.mints(), 1);
  } finally {
    await f.dispose();
  }
});
test("identified reference audio cannot consume a release grant, pin or mint", async () => {
  const f = await releaseFixture(0);
  try {
    const response = await f.sendRelease("pin", {
      context: f.context,
      role: "audio",
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "release_rejected" });
    assert.equal(f.adds(), 0);
    assert.equal(f.story.broadcasts(), 0);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM managed_releases")
        .first())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});

for (const scenario of ["held", "provider_failure", "stale"] as const) {
  test(`${scenario} admission cannot buy pins or a root mint`, async () => {
    const f = await releaseFixture(
        scenario === "held" ? 2004 : 1001,
        scenario === "provider_failure",
        7200,
      ),
      realNow = Date.now;
    try {
      if (scenario === "stale") Date.now = () => realNow() + 3601000;
      const response = await f.sendRelease("pin", {
        context: f.context,
        role: "audio",
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error:
          scenario === "provider_failure"
            ? "release_admission_unavailable"
            : "release_held",
      });
      assert.equal(f.adds(), 0);
      assert.equal(f.story.broadcasts(), 0);
      assert.equal(
        (await f.db
          .prepare("SELECT COUNT(*) AS n FROM managed_releases")
          .first())!.n,
        0,
      );
    } finally {
      Date.now = realNow;
      await f.dispose();
    }
  });
}
test("missing public media holds registration before allocating a mint or fee", async () => {
  const f = await releaseFixture();
  try {
    for (const role of ["audio", "lyrics", "ip_metadata", "nft_metadata"]) {
      const response = await f.sendRelease("pin", { context: f.context, role });
      assert.equal(response.status, 200);
    }
    const audio = await preparePin(f.audio, "audio/mpeg");
    f.retained.delete(audio.uri.slice(7));
    const response = await f.sendRelease("register", { context: f.context });
    assert.equal(response.status, 503);
    assert.equal(f.story.broadcasts(), 0);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM funded_registrations")
        .first())!.n,
      0,
    );
    assert.equal(f.adds(), 4);
  } finally {
    await f.dispose();
  }
});

test("publisher rotation during retained-media access prevents a new add", async () => {
  const f = await releaseFixture();
  try {
    f.beforeMedia(() => f.changeAuthority());
    const response = await f.sendRelease("pin", {
      context: f.context,
      role: "audio",
    });
    assert.equal(response.status, 202);
    assert.equal(f.adds(), 0);
    assert.equal(f.story.broadcasts(), 0);
  } finally {
    await f.dispose();
  }
});
test("publisher rotation during registration preflight prevents a new broadcast", async () => {
  const f = await releaseFixture();
  try {
    for (const role of ["audio", "lyrics", "ip_metadata", "nft_metadata"]) {
      const response = await f.sendRelease("pin", { context: f.context, role });
      assert.equal(response.status, 200);
    }
    f.story.beforeEstimate(() => f.changeAuthority());
    const response = await f.sendRelease("register", { context: f.context });
    assert.equal(response.status, 202);
    assert.equal(f.story.broadcasts(), 0);
    assert.equal(f.story.mints(), 0);
    assert.equal(f.adds(), 4);
  } finally {
    await f.dispose();
  }
});
