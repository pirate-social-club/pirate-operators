import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashText, publicId } from "../packages/community/common.ts";
import {
  communityId,
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
} from "../packages/community/manifest-core.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import {
  managedPairings,
  signServiceRequest,
} from "../packages/moderation/pairing.ts";
import { managedFetch, runAdmission } from "../packages/moderation/service.ts";
import { getAdmission } from "../packages/moderation/admission-store.ts";
import type { AdmissionPutOptions } from "../packages/moderation/prepare-admission.ts";
import { verifyAdmission } from "../packages/moderation/admission.ts";
import {
  categories,
  CLASSIFICATION_MODEL,
  MODERATION_MODEL,
} from "../packages/moderation/openai.ts";

const publisher = privateKeyToAccount(`0x${"11".repeat(32)}`),
  evaluator = privateKeyToAccount(`0x${"22".repeat(32)}`),
  address = (s: string) => `0x${s.repeat(40)}` as const,
  origin = "https://community.example",
  serviceOrigin = "https://moderation.example";
const configuration = validateConfig({
  schema: "pirate.community-config/1",
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
    moderationSigner: evaluator.address.toLowerCase(),
  },
  publisherRevocations: [],
});
async function fixture(acrCode = 1001, responseLost = false) {
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
        "../apps/managed-moderation/migrations/0001_managed.sql",
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
            "/v1/admissions" +
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

test("managed HTTP, retained MP3 windows, provider receipts and signed admission compose without duplicate purchases", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send()).status, 202);
    const id = f.queued[0]!;
    await Promise.all([
      runAdmission(f.db, f.media, id, f.config),
      runAdmission(f.db, f.media, id, f.config),
    ]);
    const row = await getAdmission(f.db, id),
      result = JSON.parse(row.result_json!);
    assert.equal(row.state, "complete");
    assert.equal(f.sends(), 3);
    const decision = await verifyAdmission(
      {
        communityId: f.body.communityId,
        submissionId: f.body.submissionId,
        jobId: f.body.jobId,
        songSha256: sha256(f.audio),
        songByteLength: f.audio.length,
        title: f.title,
        lyrics: f.lyrics,
        songType: "original",
        declaredRating: "general",
        windows: result.windows,
        providerEndpoint: "https://identify-eu-west-1.acrcloud.com/v1/identify",
      },
      result.evidence,
      { operators: [evaluator.address], maxAgeSeconds: 3600 },
      Math.floor(Date.now() / 1000),
    );
    assert.equal(decision.decision, "publish");
    const renewed = structuredClone(f.body);
    renewed.inputs.song.url = renewed.inputs.song.url.replace(
      "a".repeat(64),
      "b".repeat(64),
    );
    assert.equal((await f.send("admit", renewed)).status, 200);
    await runAdmission(f.db, f.media, id, f.config);
    assert.equal(f.sends(), 3);
    assert.equal(
      (
        await f.send("admit", {
          ...renewed,
          declared: { ...renewed.declared, titleSha256: publicId() },
        })
      ).status,
      400,
    );
    f.changeAuthority();
    assert.equal((await f.send("status", { jobId: f.body.jobId })).status, 403);
  } finally {
    await f.dispose();
  }
});

test("unknown paid outcomes refuse a new wakeup and retain their quota", async () => {
  const f = await fixture(1001, true);
  try {
    await f.send();
    const id = f.queued[0]!;
    assert.equal(await runAdmission(f.db, f.media, id, f.config), "uncertain");
    assert.equal((await f.send("resume", { jobId: f.body.jobId })).status, 409);
    assert.equal(await runAdmission(f.db, f.media, id, f.config), "uncertain");
    assert.equal(f.sends(), 1);
    const budgets = await f.db
      .prepare("SELECT reserved,spent FROM spending_budgets")
      .all<{ reserved: string; spent: string }>();
    assert.ok(
      budgets.results.every((row) => row.reserved === "1" && row.spent === "0"),
    );
  } finally {
    await f.dispose();
  }
});

test("changed current authority stops a queued admission before input download or provider purchase", async () => {
  const f = await fixture();
  try {
    await f.send();
    f.changeAuthority();
    assert.equal(
      await runAdmission(f.db, f.media, f.queued[0]!, f.config),
      "held",
    );
    assert.equal(f.sends(), 0);
  } finally {
    await f.dispose();
  }
});

test("an old queued job issues fresh evidence from durable provider acquisition, not enqueue time", async () => {
  const f = await fixture();
  try {
    await f.send();
    const id = f.queued[0]!;
    await f.db
      .prepare(
        "UPDATE managed_admissions SET created_at=? WHERE admission_id=?",
      )
      .bind(Date.now() - 7200000, id)
      .run();
    assert.equal(await runAdmission(f.db, f.media, id, f.config), "complete");
    const result = JSON.parse((await getAdmission(f.db, id)).result_json!);
    const acquired = await f.db
      .prepare(
        "SELECT MIN(started_at) AS first_started FROM moderation_provider_calls WHERE admission_id=?",
      )
      .bind(id)
      .first<{ first_started: number }>();
    for (const record of result.evidence) {
      assert.equal(
        record.envelope.issuedAt,
        Math.floor(acquired!.first_started / 1000),
      );
      assert.ok(record.envelope.expiresAt > Math.floor(Date.now() / 1000));
    }
  } finally {
    await f.dispose();
  }
});

test("a replacement pairing with the same publisher and revision cannot take over captured work", async () => {
  const f = await fixture();
  try {
    await f.send();
    const id = f.queued[0]!;
    f.replacePairing();
    assert.equal(await runAdmission(f.db, f.media, id, f.config), "held");
    assert.equal(
      (await getAdmission(f.db, id)).error_code,
      "managed_pairing_changed",
    );
    assert.equal(f.sends(), 0);
  } finally {
    await f.dispose();
  }
});

test("stale retained provider facts hold on resume without refreshing age or buying another check", async () => {
  const f = await fixture();
  try {
    await f.send();
    const id = f.queued[0]!;
    await runAdmission(f.db, f.media, id, f.config);
    const original = (await getAdmission(f.db, id)).result_json;
    const old = Date.now() - 7200000;
    await f.db
      .prepare(
        "UPDATE moderation_provider_calls SET started_at=? WHERE admission_id=?",
      )
      .bind(old, id)
      .run();
    // Model an interruption after retained results but before final job advancement.
    await f.db
      .prepare(
        "UPDATE managed_admissions SET state='queued',result_json=NULL WHERE admission_id=?",
      )
      .bind(id)
      .run();
    assert.equal(await runAdmission(f.db, f.media, id, f.config), "held");
    assert.equal(
      (await getAdmission(f.db, id)).error_code,
      "moderation_evidence_stale",
    );
    assert.equal(f.sends(), 3);
    const retained = await f.db
      .prepare(
        "SELECT MIN(started_at) AS first_started FROM moderation_provider_calls WHERE admission_id=?",
      )
      .bind(id)
      .first<{ first_started: number }>();
    assert.equal(retained!.first_started, old);
    assert.ok(original);
  } finally {
    await f.dispose();
  }
});

for (const [code, decision] of [
  [0, "block"],
  [2004, "hold"],
] as const)
  test(`real handler composes retained provider-code ${code} fixtures into ${decision}`, async () => {
    const f = await fixture(code);
    try {
      await f.send();
      const id = f.queued[0]!;
      await runAdmission(f.db, f.media, id, f.config);
      const row = await getAdmission(f.db, id),
        result = JSON.parse(row.result_json!);
      assert.equal(row.state, "complete");
      const checked = await verifyAdmission(
        {
          communityId: f.body.communityId,
          submissionId: f.body.submissionId,
          jobId: f.body.jobId,
          songSha256: sha256(f.audio),
          songByteLength: f.audio.length,
          title: f.title,
          lyrics: f.lyrics,
          songType: "original",
          declaredRating: "general",
          windows: result.windows,
          providerEndpoint:
            "https://identify-eu-west-1.acrcloud.com/v1/identify",
        },
        result.evidence,
        { operators: [evaluator.address], maxAgeSeconds: 3600 },
        Math.floor(Date.now() / 1000),
      );
      assert.equal(checked.decision, decision);
      assert.equal(f.sends(), code === 2004 ? 4 : 3);
    } finally {
      await f.dispose();
    }
  });
