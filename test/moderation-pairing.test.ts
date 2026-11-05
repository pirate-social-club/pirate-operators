import { defaultContentProfile } from "../packages/moderation/content-profile.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { privateKeyToAccount } from "viem/accounts";
import { publicId } from "../packages/community/common.ts";
import {
  communityId,
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
} from "../packages/community/manifest-core.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import {
  authorizeServiceRequest,
  managedPairings,
  signServiceRequest,
} from "../packages/moderation/pairing.ts";

const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const addr = (s: string) => `0x${s.repeat(40)}` as const;
const id = communityId(6343, addr("1")),
  origin = "https://community.example",
  serviceOrigin = "https://moderation.example";
const current = validateConfig({
  schema: "pirate.community-config/2",
  chainId: 6343,
  directory: addr("2"),
  registry: addr("1"),
  communityId: id,
  tld: "fixture",
  configurationRevision: 1,
  postsContract: addr("3"),
  controller: addr("4"),
  publisher: signer.address.toLowerCase(),
  operatorPayments: addr("0"),
  learningRecords: addr("0"),
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
    contentProfile: defaultContentProfile,
    recognitionSigner: addr("5"),
    moderationSigner: addr("5"),
  },
  publisherRevocations: [],
});
const pairings = managedPairings([
  {
    communityId: id,
    registry: addr("1"),
    directory: addr("2"),
    controller: addr("4"),
    communityOrigin: origin,
    serviceOrigin,
    enabled: true,
    budgetPeriod: "fixture-run",
    requestCap: 10,
  },
]);
async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await mf.getD1Database("DB");
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
    return { db, dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
const authorization = () => {
  const time = Math.floor(Date.now() / 1000);
  return {
    action: "admit" as const,
    communityId: id,
    communityOrigin: origin,
    serviceOrigin,
    configurationRevision: 1,
    nonce: publicId(),
    issuedAt: time,
    expiresAt: time + 300,
  };
};

test("a signed paired community request is scoped to current chain authority and replays the same wire only", async () => {
  const f = await fixture();
  try {
    const a = authorization(),
      request = await signServiceRequest(signer, a, {
        jobId: "fixture-job",
        audioSha256: publicId(),
      });
    const verify = () =>
      authorizeServiceRequest(
        f.db,
        request,
        "admit",
        serviceOrigin,
        pairings,
        async () => current,
      );
    assert.equal((await verify()).pairing.communityId, id);
    await verify();
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM moderation_request_nonces")
        .first<{ n: number }>())!.n,
      1,
    );
    const reused = await signServiceRequest(signer, a, {
      jobId: "different-job",
    });
    await assert.rejects(
      authorizeServiceRequest(
        f.db,
        reused,
        "admit",
        serviceOrigin,
        pairings,
        async () => current,
      ),
      /service_nonce_reused/,
    );
  } finally {
    await f.dispose();
  }
});

test("wrong service, origin, community, revoked pairing and changed publisher fail before work", async () => {
  const f = await fixture();
  try {
    const request = await signServiceRequest(signer, authorization(), {
      jobId: "fixture-job",
    });
    for (const scope of [
      { ...request, body: { jobId: "altered" } },
      await signServiceRequest(
        signer,
        { ...authorization(), serviceOrigin: "https://other.example" },
        request.body,
      ),
      await signServiceRequest(
        signer,
        { ...authorization(), communityOrigin: "https://other.example" },
        request.body,
      ),
      await signServiceRequest(
        signer,
        { ...authorization(), communityId: publicId() },
        request.body,
      ),
    ])
      await assert.rejects(
        authorizeServiceRequest(
          f.db,
          scope,
          "admit",
          serviceOrigin,
          pairings,
          async () => current,
        ),
      );
    await assert.rejects(
      authorizeServiceRequest(
        f.db,
        request,
        "status",
        serviceOrigin,
        pairings,
        async () => current,
      ),
      /wrong_service_request_scope/,
    );
    await assert.rejects(
      authorizeServiceRequest(
        f.db,
        request,
        "admit",
        serviceOrigin,
        [{ ...pairings[0]!, enabled: false }],
        async () => current,
      ),
      /managed_pairing_unavailable/,
    );
    await assert.rejects(
      authorizeServiceRequest(
        f.db,
        request,
        "admit",
        serviceOrigin,
        pairings,
        async () => ({ ...current, publisher: addr("a") }),
      ),
      /community_authority_changed/,
    );
    await assert.rejects(
      authorizeServiceRequest(
        f.db,
        request,
        "admit",
        serviceOrigin,
        pairings,
        async () => ({ ...current, configurationRevision: 2 }),
      ),
      /community_authority_changed/,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM moderation_request_nonces")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("expiry during an asynchronous authority read cannot accept a request", async () => {
  const f = await fixture(),
    realNow = Date.now,
    a = authorization();
  try {
    const request = await signServiceRequest(
      signer,
      { ...a, expiresAt: a.issuedAt + 1 },
      { jobId: "fixture-job" },
    );
    await assert.rejects(
      authorizeServiceRequest(
        f.db,
        request,
        "admit",
        serviceOrigin,
        pairings,
        async () => {
          Date.now = () => (a.issuedAt + 2) * 1000;
          return current;
        },
        a.issuedAt,
      ),
      /expired_service_request/,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM moderation_request_nonces")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    Date.now = realNow;
    await f.dispose();
  }
});
