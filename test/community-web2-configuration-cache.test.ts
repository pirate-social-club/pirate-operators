// Failure cases written before the cache producer: invented safe-head metadata,
// duplicate writes changing evidence, wrong installation/origin, failed RPC or
// IPFS verification writing any cache row, stale reader overwriting a newer row,
// conflicting same-revision provenance, and identity changing in the D1 batch.
// RPC/IPFS are explicit fixtures; migrations and accepting D1 batches are real.
import test from "node:test";
import assert from "node:assert/strict";
import { canonical } from "../packages/community/common.ts";
import { web2DirectoryFixture, h } from "./fixtures/web2-directory.ts";
import { appDatabase } from "./fixtures/publication-app-http.ts";
import { readAndCacheWeb2Configuration } from "../services/community-web2-configuration-cache.ts";

test("authenticated Web2 configuration caches its original event provenance and repeats without replacing it", async () => {
  const app = await appDatabase();
  try {
    const f = await web2DirectoryFixture();
    const input = {
      db: app.db,
      client: f.client,
      profile: f.profile,
      policy: f.policy,
      transport: f.transport,
      origin: f.config.app.origin,
    };
    const first = await readAndCacheWeb2Configuration(input);
    const row = await app.native
      .prepare("SELECT * FROM public_configurations")
      .first();
    assert.deepEqual(row, {
      community_id: f.config.communityId,
      revision: 1,
      publisher: f.config.publisher,
      manifest_uri: f.records[0]!.pin.uri,
      manifest_sha256: f.records[0]!.pin.sha256,
      manifest_json: canonical(f.config),
      block_number: String(f.records[0]!.block),
      block_hash: first.configurationEvidence.log.blockHash,
      transaction_hash: first.configurationEvidence.log.transactionHash,
    });
    const duplicate = await readAndCacheWeb2Configuration(input);
    assert.deepEqual(
      duplicate.configurationEvidence,
      first.configurationEvidence,
    );
    assert.deepEqual(
      await app.native.prepare("SELECT * FROM public_configurations").first(),
      row,
    );
    assert.equal(
      await app.native
        .prepare("SELECT count(*) AS n FROM public_configurations")
        .first("n"),
      1,
    );
    // A stale read must not become current, and a same-revision conflict must
    // remain visible rather than silently replacing original evidence.
    await app.native
      .prepare("UPDATE public_configurations SET revision=2")
      .run();
    await assert.rejects(
      readAndCacheWeb2Configuration(input),
      /web2_configuration_cache_changed/,
    );
    assert.equal(
      await app.native
        .prepare("SELECT revision FROM public_configurations")
        .first("revision"),
      2,
    );
    await app.native
      .prepare("UPDATE public_configurations SET revision=1,transaction_hash=?")
      .bind(h("9"))
      .run();
    await assert.rejects(
      readAndCacheWeb2Configuration(input),
      /web2_configuration_cache_changed/,
    );
    assert.equal(
      await app.native
        .prepare("SELECT transaction_hash FROM public_configurations")
        .first("transaction_hash"),
      h("9"),
    );
  } finally {
    await app.runtime.dispose();
  }
});

test("unverified or differently-bound Web2 reads leave the configuration cache empty", async () => {
  const app = await appDatabase();
  try {
    for (const fault of ["receipt", "origin", "identity"] as const) {
      const f = await web2DirectoryFixture();
      const input = {
        db: app.db,
        client: f.client,
        profile: f.profile,
        policy: f.policy,
        transport: f.transport,
        origin: f.config.app.origin,
      };
      if (fault === "receipt") f.state.receiptStatus = "0x0";
      if (fault === "origin") input.origin = "https://other.example";
      if (fault === "identity")
        await app.native
          .prepare("INSERT INTO application_identity VALUES(1,?,?)")
          .bind(h("7"), f.config.app.origin)
          .run();
      await assert.rejects(readAndCacheWeb2Configuration(input));
      assert.equal(
        await app.native
          .prepare("SELECT count(*) AS n FROM public_configurations")
          .first("n"),
        0,
      );
    }
  } finally {
    await app.runtime.dispose();
  }
});

test("configuration cache insertion checks the actual application identity in its accepting transaction", async () => {
  const app = await appDatabase();
  try {
    const f = await web2DirectoryFixture();
    const hold = app.holdMutation("INSERT INTO public_configurations");
    const pending = readAndCacheWeb2Configuration({
      db: app.db,
      client: f.client,
      profile: f.profile,
      policy: f.policy,
      transport: f.transport,
      origin: f.config.app.origin,
    });
    try {
      await hold.entered;
      await app.native
        .prepare("UPDATE application_identity SET community_id=? WHERE id=1")
        .bind(h("8"))
        .run();
    } finally {
      hold.release();
    }
    await assert.rejects(pending, /web2_configuration_cache_changed/);
    assert.equal(
      await app.native
        .prepare("SELECT count(*) AS n FROM public_configurations")
        .first("n"),
      0,
    );
  } finally {
    await app.runtime.dispose();
  }
});
