import { defaultContentProfile } from "../../packages/moderation/content-profile.ts";
// Explicit local provider simulation from the owned managed-service tests.
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashText, publicId } from "../../packages/community/common.ts";
import {
  communityId,
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
} from "../../packages/community/manifest-core.ts";
import { validateConfig } from "../../packages/community/config-manifest.ts";
import {
  managedPairings,
  signServiceRequest,
} from "../../packages/moderation/pairing.ts";
import {
  managedFetch,
  runAdmission,
} from "../../packages/moderation/service.ts";
import { getAdmission } from "../../packages/moderation/admission-store.ts";
import type { AdmissionPutOptions } from "../../packages/moderation/prepare-admission.ts";
import { verifyAdmission } from "../../packages/moderation/admission.ts";
import {
  categories,
  CLASSIFICATION_MODEL,
  MODERATION_MODEL,
} from "../../packages/moderation/openai.ts";

export const publisher = privateKeyToAccount(`0x${"11".repeat(32)}`),
  evaluator = privateKeyToAccount(`0x${"22".repeat(32)}`),
  address = (s: string) => `0x${s.repeat(40)}` as const,
  origin = "https://community.example",
  serviceOrigin = "https://moderation.example";
export const configuration = validateConfig({
  schema: "pirate.community-config/2",
  chainId: 6343,
  communityId: communityId(6343, address("1")),
  registry: address("1"),
  directory: address("2"),
  postsContract: address("3"),
  controller: address("4"),
  tld: "fixture",
  configurationRevision: 1,
  publisher: publisher.address.toLowerCase(),
  operatorPayments: address("0"),
  learningRecords: address("0"),
  app: {
    label: "app",
    tokenGeneration: "0",
    origin,
    httpsAlias: null,
    hnsIngress: "none",
  },
  feed: { endpoint: origin + "/api/feed", signingKeyId: "fixture" },
  policies: {
    admission: { version: RELEASE_POLICY, sha256: RELEASE_POLICY_HASH },
    recognitionSigner: evaluator.address.toLowerCase(),
    contentProfile: defaultContentProfile,
    moderationSigner: evaluator.address.toLowerCase(),
  },
  publisherRevocations: [],
});
export async function releaseAdmissionFixture(
  acrCode = 1001,
  responseLost = false,
) {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
    r2Buckets: ["MEDIA"],
  });
  try {
    const db = await mf.getD1Database("DB"),
      bucket = await mf.getR2Bucket("MEDIA");
    // Bridge Miniflare's RPC type mapping into the small storage contract.
    // Every operation still executes against its actual workerd R2 binding.
    const media = {
      async head(key: string) {
        const value = await bucket.head(key);
        return value
          ? { size: value.size, customMetadata: value.customMetadata }
          : null;
      },
      async get(key: string) {
        const value = await bucket.get(key, {});
        if (!value || !("arrayBuffer" in value)) return null;
        const bytes = new Uint8Array(await value.arrayBuffer());
        return {
          arrayBuffer: async () => bytes.buffer,
          body: new Response(bytes).body!,
        };
      },
      async put(key: string, value: Uint8Array, options?: AdmissionPutOptions) {
        return bucket.put(key, value, options);
      },
    };
    const sql = await readFile(
      new URL(
        "../../apps/managed-moderation/migrations/0001_managed.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.batch(
      sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
    const title = "Original test song",
      lyrics = "We sail away\nWe sail away";
    // Explicit protocol fixture, not provider or real MP3 acceptance evidence.
    const audio = new Uint8Array(1600 * 417);
    for (let i = 0; i < 1600; i++) audio.set([0xff, 0xfb, 0x90, 0], i * 417);
    const inputs = new Map<string, Uint8Array>([
      ["audio", audio],
      ["title", new TextEncoder().encode(title)],
      ["lyrics", new TextEncoder().encode(lyrics)],
    ]);
    const pairings = managedPairings([
      {
        communityId: configuration.communityId,
        registry: configuration.registry,
        directory: configuration.directory,
        controller: configuration.controller,
        communityOrigin: origin,
        serviceOrigin,
        enabled: true,
        budgetPeriod: "fixture-run",
        requestCap: 10,
      },
    ]);
    let sends = 0,
      current = configuration;
    const queued: string[] = [];
    const config = {
      serviceOrigin,
      pairings,
      serviceRequestCap: 10,
      serviceBudgetPeriod: "fixture-run",
      acr: {
        host: "identify-eu-west-1.acrcloud.com",
        accessKey: "fixture",
        accessSecret: "fixture",
      },
      openAiKey: "fixture",
      signer: evaluator,
      async currentConfiguration() {
        return current;
      },
      async wake(id: string) {
        queued.push(id);
      },
      async inputTransport(request: Request) {
        return new Response(
          new Uint8Array(
            inputs.get(new URL(request.url).pathname.split("/").at(-1)!)!,
          ),
        );
      },
      transport: {
        async request(request: Request) {
          sends++;
          if (responseLost) throw new Error("simulated lost upstream response");
          let body: unknown;
          if (new URL(request.url).host.includes("acrcloud"))
            body = {
              status: { code: acrCode },
              ...(acrCode === 0
                ? { metadata: { music: [{ acrid: "fixture-reference" }] } }
                : {}),
            };
          else if (new URL(request.url).pathname === "/v1/moderations") {
            const entry = {
              flagged: false,
              categories: Object.fromEntries(categories.map((c) => [c, false])),
              category_scores: Object.fromEntries(
                categories.map((c) => [c, 0]),
              ),
              category_applied_input_types: Object.fromEntries(
                categories.map((c) => [c, ["text"]]),
              ),
            };
            body = {
              id: "mod-fixture",
              model: MODERATION_MODEL,
              results: [entry, entry],
            };
          } else
            body = {
              id: "resp-fixture",
              model: CLASSIFICATION_MODEL,
              status: "completed",
              usage: {},
              output: [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({
                        titleRating: "general",
                        lyricsRating: "general",
                        explicit: false,
                        primaryLanguage: "en",
                      }),
                    },
                  ],
                },
              ],
            };
          return Response.json(body);
        },
      },
    };
    const submissionId = crypto.randomUUID(),
      jobId = "job-fixture";
    const capability = (kind: string, cap = "a".repeat(64)) => ({
      url: `${origin}/api/moderation/inputs/${submissionId}/${kind}?cap=${cap}`,
      sha256: sha256(inputs.get(kind)!),
      byteLength: inputs.get(kind)!.length,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    const body = {
      communityId: configuration.communityId,
      submissionId,
      jobId,
      checks: ["audio.identification", "title.rating", "lyrics.classification"],
      inputs: {
        song: capability("audio"),
        title: capability("title"),
        lyrics: capability("lyrics"),
      },
      declared: {
        songSha256: sha256(audio),
        titleSha256: hashText(title),
        lyricsSha256: hashText(lyrics),
      },
    };
    const send = async (
      action = "admit",
      value: Record<string, unknown> = body,
    ) => {
      const now = Math.floor(Date.now() / 1000);
      const signed = await signServiceRequest(
        publisher,
        {
          action: action as "admit",
          communityId: configuration.communityId,
          communityOrigin: origin,
          serviceOrigin,
          configurationRevision: 1,
          nonce: publicId(),
          issuedAt: now,
          expiresAt: now + 300,
        },
        value,
      );
      return managedFetch(
        new Request(
          serviceOrigin +
            "/v2/admissions" +
            (action === "admit" ? "" : "/" + action),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(signed),
          },
        ),
        db,
        config,
      );
    };
    return {
      db,
      media,
      config,
      body,
      send,
      queued,
      title,
      lyrics,
      audio,
      sends: () => sends,
      changeAuthority() {
        current = { ...current, publisher: address("5") };
      },
      replacePairing() {
        pairings[0] = {
          ...pairings[0]!,
          directory: address("6"),
          controller: address("7"),
        };
        current = {
          ...current,
          directory: address("6"),
          controller: address("7"),
        };
      },
      dispose: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
