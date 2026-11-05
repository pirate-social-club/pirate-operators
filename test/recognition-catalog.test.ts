import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import {
  enrollAcceptedRecording,
  claimRecording,
  recordingStore,
  recordingForMatch,
  type AcceptedRecording,
} from "../packages/recognition/catalog-store.ts";
import {
  advanceSongSourceRecordingAuthority,
  type SongSourceCatalogFile,
} from "../packages/recognition/catalog-workflow.ts";
import { decideRecordingMatch } from "../packages/recognition/match-policy.ts";
import { makeSongSourceAcrCloudCatalog } from "../packages/recognition/catalog-provider.ts";

const publication: AcceptedRecording = {
  assetId: "asset-one",
  creatorId: "creator-one",
  communityId: "community-one",
  postId: "post-one",
  publicationRevision: 1,
  audioRevision: 1,
  audioSha256: "a".repeat(64),
  immutableAudioRef: "private/audio-one",
  verificationSample: {
    objectKey: "private/sample-one",
    contentType: "audio/mpeg",
    byteLength: 4,
  },
  termsRevision: 1,
  termsHash: `0x${"b".repeat(64)}`,
  allowsDerivatives: false,
};
async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  await db.batch(
    (await readFile("packages/recognition/catalog-schema.sql", "utf8"))
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  return { mf, db };
}
test("every accepted license enrolls once; altered creator/publication authority cannot replace it", async () => {
  const { mf, db } = await fixture();
  try {
    const id = await enrollAcceptedRecording(
      db as unknown as D1Database,
      publication.assetId,
      "123",
      async () => publication,
    );
    assert.equal(
      await enrollAcceptedRecording(
        db as unknown as D1Database,
        publication.assetId,
        "123",
        async () => publication,
      ),
      id,
    );
    await assert.rejects(
      enrollAcceptedRecording(
        db as unknown as D1Database,
        publication.assetId,
        "123",
        async () => ({ ...publication, creatorId: "attacker" }),
      ),
      /recording_identity_conflict/,
    );
    await assert.rejects(
      enrollAcceptedRecording(
        db as unknown as D1Database,
        "unpublished",
        "123",
        async () => null,
      ),
      /accepted_recording_required/,
    );
    assert.equal(
      (await db
        .prepare("SELECT count(*) AS n FROM recognition_recordings")
        .first<{ n: number }>())!.n,
      1,
    );
  } finally {
    await mf.dispose();
  }
});
test("lost upload response reconciles the exact catalog record without another send and verifies project visibility", async () => {
  const { mf, db } = await fixture();
  try {
    const database = db as unknown as D1Database;
    const id = await enrollAcceptedRecording(
      database,
      publication.assetId,
      "123",
      async () => publication,
    );
    const claimed = await claimRecording(database, id, "worker");
    assert(claimed);
    assert.equal(await claimRecording(database, id, "other"), null);
    let file: SongSourceCatalogFile | null = null,
      uploads = 0,
      identifies = 0;
    const deps = {
      enabled: true,
      workerId: "worker",
      adapterRevision: "acr-v2",
      store: recordingStore(database),
      catalog: {
        async findExact() {
          return file
            ? { outcome: "exact" as const, file }
            : { outcome: "none" as const };
        },
        async get() {
          assert(file);
          return { outcome: "exact" as const, file };
        },
        async upload() {
          uploads++;
          assert.equal(
            (await recordingStore(database).get(id))!.state,
            "provider_outcome_unknown",
          );
          file = {
            providerFileId: "9",
            providerMatchId: "recording-9",
            bucketId: "123",
            opaqueTitle: claimed.opaqueTitle,
            registrationId: id,
            assetId: publication.assetId,
            canonicalAudioSha256: publication.audioSha256,
            state: "ready",
          };
          return { outcome: "ambiguous" as const, evidenceDigest: "lost" };
        },
      },
      audio: {
        async readCanonical() {
          return {
            bytes: new Uint8Array([1, 2, 3, 4]),
            filename: "audio.mp3",
            contentType: "audio/mpeg",
          };
        },
        async readVerificationSample() {
          return {
            bytes: new Uint8Array([1, 2, 3, 4]),
            filename: "sample.mp3",
            contentType: "audio/mpeg",
          };
        },
      },
      identification: {
        async identify() {
          identifies++;
          return {
            outcome: "retained_reference_match" as const,
            context: {
              operationId: id,
              audioRevision: 1,
              analysisRevision: 1,
              canonicalAudioSha256: publication.audioSha256,
              adapterRevision: "acr-v2",
            },
            evidence: {
              provider: "acrcloud" as const,
              matchKind: "custom",
              providerMatchId: "recording-9",
            },
          };
        },
      },
    };
    assert.equal(
      (await advanceSongSourceRecordingAuthority(deps, id)).outcome,
      "waiting",
    );
    assert.equal(
      (await advanceSongSourceRecordingAuthority(deps, id)).outcome,
      "progress",
    );
    assert.equal(
      (await advanceSongSourceRecordingAuthority(deps, id)).outcome,
      "ready",
    );
    assert.equal(
      (await advanceSongSourceRecordingAuthority(deps, id)).outcome,
      "ready",
    );
    assert.equal(uploads, 1);
    assert.equal(identifies, 1);
    assert.deepEqual(
      await recordingForMatch(database, "recording-9"),
      publication,
    );
  } finally {
    await mf.dispose();
  }
});
test("a process death after durable upload intent does not authorize a replacement even when listing finds nothing", async () => {
  const { mf, db } = await fixture();
  try {
    const database = db as unknown as D1Database,
      id = await enrollAcceptedRecording(
        database,
        publication.assetId,
        "123",
        async () => publication,
      );
    const claimed = await claimRecording(database, id, "worker");
    assert(claimed);
    const store = recordingStore(database);
    await store.markProviderOutcomeUnknown({
      registrationId: id,
      workerId: "worker",
      claimFence: claimed.claimFence,
      evidenceDigest: "crashed",
    });
    let sends = 0;
    const deps = {
      enabled: true,
      workerId: "worker",
      adapterRevision: "acr-v2",
      store,
      catalog: {
        async findExact() {
          return { outcome: "none" as const };
        },
        async get() {
          return { outcome: "none" as const };
        },
        async upload() {
          sends++;
          throw Error("must not send");
        },
      },
      audio: {
        async readCanonical() {
          throw Error("must not read");
        },
        async readVerificationSample() {
          throw Error("must not read");
        },
      },
      identification: {
        async identify() {
          throw Error("must not send");
        },
      },
    };
    assert.equal(
      (await advanceSongSourceRecordingAuthority(deps, id)).outcome,
      "waiting",
    );
    assert.equal(sends, 0);
  } finally {
    await mf.dispose();
  }
});
test("automatic matches reuse the authenticated creator identity and enforce declared source licenses", () => {
  assert.equal(
    decideRecordingMatch("creator-one", null, [publication]).decision,
    "reuse",
  );
  assert.equal(
    decideRecordingMatch("creator-two", null, [publication]).decision,
    "block",
  );
  assert.equal(
    decideRecordingMatch("creator-two", "asset-one", [publication]).decision,
    "block",
  );
  assert.equal(
    decideRecordingMatch("creator-two", "asset-one", [
      { ...publication, allowsDerivatives: true },
    ]).decision,
    "source_allowed",
  );
  assert.equal(
    decideRecordingMatch("creator-two", "other", [
      { ...publication, allowsDerivatives: true },
    ]).decision,
    "block",
  );
  assert.equal(
    decideRecordingMatch("creator-one", null, [publication, publication])
      .decision,
    "block",
  );
});
test("catalog adapter refuses credential-bearing URLs and never redirects a credential-bearing upload", async () => {
  let requests = 0;
  const options = {
    origin: "https://user:pass@api-v2.acrcloud.com",
    bucketId: "123",
    token: "fixture-secret",
    maxResponseBytes: 1024,
    maxAudioBytes: 1024,
    async request() {
      requests++;
      throw Error("must not request");
    },
  };
  const provider = makeSongSourceAcrCloudCatalog(options);
  const registration = {
    registrationId: "id",
    assetId: "asset",
    bucketId: "123",
  } as any;
  assert.equal(
    (await provider.findExact(registration, new AbortController().signal))
      .outcome,
    "rejected",
  );
  assert.equal(requests, 0);
});
