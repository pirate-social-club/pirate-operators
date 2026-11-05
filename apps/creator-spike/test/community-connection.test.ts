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

const original = JSON.parse(
    await readFile(
      "../../docs/deployments/first-song-managed-20261105.configuration.json",
      "utf8",
    ),
  ),
  configuration = validateConfig({
    ...original.configuration,
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
