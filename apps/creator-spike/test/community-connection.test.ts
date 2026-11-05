import { configurationV2 } from "../../../test/fixtures/configuration-v2.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import {
  creatorPublisherFixture as publisher,
  otherCreatorPublisherFixture as other,
} from "../../../test/creator-connection-keys.ts";
import {
  communityConnection,
  scopedConnectionInfo,
} from "../src/server/community-connection.ts";
import { hash, randomToken, walletOrigin } from "../src/shared.ts";
import type { Env } from "../src/server/store.ts";
import { signCreatorRequest } from "../../../packages/community/creator-service.ts";
import { validateConfig } from "../../../packages/community/config-manifest.ts";
import { hashJson } from "../../../packages/community/common.ts";
import { claimCommunityCredential } from "../src/server/community-claims.ts";
import { bindActiveCredential } from "../src/server/binding.ts";

const original = JSON.parse(
    await readFile(
      "../../docs/deployments/first-song-managed-20261105.configuration.json",
      "utf8",
    ),
  ),
  configuration = validateConfig({
    ...configurationV2(original.configuration),
    publisher: publisher.address.toLowerCase(),
  });

test("scoped native connections preserve one launch and refuse changed identity, nonce, origin and PKCE before activation", async () => {
  const mf = new Miniflare({
    modules: true,
    script:
      "export default {fetch(){return new Response('explicit native fixture')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    bindings: { SUI_OPERATOR_SECRET_KEY: "" },
    serviceBindings: {
      ASSETS: async () => new Response("explicit asset fixture"),
    },
  });
  try {
    const env = await mf.getBindings<Env>();
    await env.DB.exec(
      (await readFile("schema.sql", "utf8")).replaceAll("\n", " "),
    );
    const state = randomToken(),
      verifier = randomToken(),
      body = {
        connectionId: crypto.randomUUID(),
        accountRef: `0x${"a".repeat(64)}`,
        state,
        verifierHash: await hash(verifier),
      };
    const wire = async (
      action: "creator_launch" | "creator_exchange",
      data: Record<string, unknown>,
      nonce = `0x${crypto.randomUUID().replaceAll("-", "").repeat(2)}` as `0x${string}`,
      signer = publisher,
    ) => {
      const now = Math.floor(Date.now() / 1000);
      return signCreatorRequest(
        signer,
        {
          action,
          communityId: configuration.communityId,
          communityOrigin: configuration.app.origin,
          serviceOrigin: walletOrigin,
          configurationRevision: 1,
          nonce,
          issuedAt: now,
          expiresAt: now + 300,
        },
        data,
      );
    };
    // Explicit canonical-configuration fixture. No public network or funded
    // native transaction is used by this handler/state qualification.
    const current = async () => configuration;
    const launch = await wire("creator_launch", body),
      first = await communityConnection(env, "creator_launch", launch, current),
      repeated = await communityConnection(
        env,
        "creator_launch",
        launch,
        current,
      );
    assert.deepEqual(repeated, first);
    const id = String(first.requestId);
    assert.equal(
      id,
      hashJson({
        communityId: configuration.communityId,
        connectionId: body.connectionId,
      }).slice(2),
    );
    assert.equal(
      (await scopedConnectionInfo(env, id))!.communityOrigin,
      configuration.app.origin,
    );
    assert.equal(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM links").first<{
        n: number;
      }>())!.n,
      1,
    );
    await assert.rejects(
      communityConnection(
        env,
        "creator_launch",
        await wire("creator_launch", { ...body, state: randomToken() }),
        current,
      ),
      /changed_or_expired/,
    );
    await assert.rejects(
      communityConnection(
        env,
        "creator_launch",
        await wire(
          "creator_launch",
          { ...body, state: randomToken() },
          launch.authorization.nonce,
        ),
        current,
      ),
      /nonce_reused/,
    );
    await assert.rejects(
      communityConnection(
        env,
        "creator_launch",
        await wire("creator_launch", body, undefined, other),
        current,
      ),
      /authority_changed/,
    );
    const exchange = {
      requestId: id,
      connectionId: body.connectionId,
      accountRef: body.accountRef,
      state,
      verifier,
    };
    assert.deepEqual(
      await communityConnection(
        env,
        "creator_exchange",
        await wire("creator_exchange", exchange),
        current,
      ),
      { state: "waiting" },
    );
    for (const changed of [
      { ...exchange, verifier: randomToken() },
      { ...exchange, state: randomToken() },
      { ...exchange, accountRef: `0x${"b".repeat(64)}` },
    ])
      await assert.rejects(
        communityConnection(
          env,
          "creator_exchange",
          await wire("creator_exchange", changed),
          current,
        ),
        /scope_mismatch/,
      );
    assert.equal(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts").first<{
        n: number;
      }>())!.n,
      0,
    );
    assert.equal(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions").first<{
        n: number;
      }>())!.n,
      0,
    );
    assert.equal(
      (await env.DB.prepare("SELECT consumed FROM links WHERE id=?")
        .bind(id)
        .first<{ consumed: number }>())!.consumed,
      0,
    );
  } finally {
    await mf.dispose();
  }
});

test("a same-community credential claim cannot pin a rejected account; another credential and other communities remain independent", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('claim fixture')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec((await readFile("schema.sql", "utf8")).replaceAll("\n", " "));
    for (const [id, address] of [
      ["credential-C", `0x${"1".repeat(64)}`],
      ["credential-C2", `0x${"2".repeat(64)}`],
    ])
      await db
        .prepare(
          "INSERT INTO credentials(id,cose_key,counter,sui_public_key,sui_address,sealed_seed,created,status) VALUES(?,'explicit fixture',0,'explicit fixture',?,'{}',?,'active')",
        )
        .bind(id, address, Date.now())
        .run();
    const community = configuration.communityId,
      accountA = `0x${"a".repeat(64)}`,
      accountB = `0x${"b".repeat(64)}`,
      nativeA = `community:${community}:${accountA}`,
      nativeB = `community:${community}:${accountB}`;
    await claimCommunityCredential(db, community, accountA, "credential-C");
    await bindActiveCredential(db, nativeA, "credential-C");
    await assert.rejects(
      claimCommunityCredential(db, community, accountB, "credential-C"),
      /creator_credential_claimed/,
    );
    assert.equal(
      await db
        .prepare("SELECT credential_id FROM bindings WHERE account=?")
        .bind(nativeB)
        .first(),
      null,
    );
    await claimCommunityCredential(db, community, accountB, "credential-C2");
    await bindActiveCredential(db, nativeB, "credential-C2");
    assert.equal(
      (await db
        .prepare("SELECT credential_id FROM bindings WHERE account=?")
        .bind(nativeB)
        .first<{ credential_id: string }>())!.credential_id,
      "credential-C2",
    );
    await claimCommunityCredential(
      db,
      `0x${"c".repeat(64)}`,
      accountB,
      "credential-C",
    );
    assert.equal(
      (await db
        .prepare(
          "SELECT COUNT(*) AS n FROM scoped_creator_claims WHERE credential_id='credential-C'",
        )
        .first<{ n: number }>())!.n,
      2,
    );
    assert.equal(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM submissions")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
