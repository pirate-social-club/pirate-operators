import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPublicClient, custom, type Hex } from "viem";
import { directoryInstanceId } from "../packages/community/shared-identity.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { canonical, digest } from "../packages/protocol/index.ts";
import { preparePublicationGrant } from "../packages/protocol/publication-consent.ts";
import type { ConsentCommandReceiptV1, PreparedConsentCommandV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { dancePublicationMediaAccess } from "../services/dance-publication-media-access.ts";
import { publicationSelectionHash, publicationSelectionSource, type PublicationAppRelease } from "../services/publication-app-selection.ts";
import { PublicationOperatorTransport } from "../services/publication-app-transport.ts";
import type { PublicationApplicationPorts } from "../services/publication-app.ts";
import { commandId, sourceId } from "../services/publication-command-contract.ts";
import { installPublicationSelection } from "../services/publication-installed-selection.ts";
import { installedDanceParticipants } from "../services/web2-installed-dance-participants.ts";
import { MemorySqliteD1 } from "./dance-sqlite-fixture.ts";
import { addr, scriptedPublicationAuthority } from "./fixtures/publication-app-rpc.ts";

const migration = (name: string) =>
  readFileSync(new URL("../apps/community-wizard/infra/migrations/" + name + ".sql", import.meta.url), "utf8");

test("selected installed grants fence both exact accounts and original D1 activation", async (t) => {
  // Offline SQL evidence using real migrations, selection, typed grant digest
  // and the existing scripted release. No chain, signing or delivery.
  const sqlite = new MemorySqliteD1();
  t.after(() => sqlite.close());
  sqlite.sqlite.exec("CREATE TABLE setup_schema(version INTEGER)");
  for (const name of ["0002_first_song", "0020_publication_consent", "0021_publication_installed_selection"])
    sqlite.sqlite.exec(migration(name));
  sqlite.sqlite.exec(readFileSync(new URL("../packages/dance/schema.sql", import.meta.url), "utf8"));
  const db = sqlite.asD1(), store = new DanceStore(db);
  const now = BigInt(Math.floor(Date.now() / 1000)), chainId = 6343;
  const initial = scriptedPublicationAuthority("https://documents.fixture.invalid", now, { issuer: addr(80), operator: addr(81) }).release;
  const communityId = directoryInstanceId(chainId, initial.configuration.communityKey);
  const release: PublicationAppRelease = {
    ...initial,
    source: { ...initial.source, chainId, communityId },
    profile: { ...initial.profile, chainId, communityId },
    configuration: { ...initial.configuration, chainId, communityId },
    fee: { ...initial.fee, chainId },
  };
  const context = release.configuration;
  sqlite.sqlite.prepare("INSERT INTO application_identity VALUES (1,?,?)").run(communityId, context.app.origin);
  const installed = await installPublicationSelection(db, {
    schema: "pirate.publication-installation/1", communityId, origin: context.app.origin,
    installationId: context.installationId, incarnation: "1",
    installedBindingSha256: digest("native installed predecessor"),
    active: publicationSelectionHash(release), entries: [{ release, transportRef: "selected" }], previous: null,
  });
  const unreachable = async (): Promise<never> => assert.fail("read-only D1 test attempted external access");
  const ports: PublicationApplicationPorts = {
    db, installation: installed, catalog: installed.catalog,
    client: createPublicClient({ transport: custom({ request: unreachable }) }),
    transport: new PublicationOperatorTransport({ fetch: unreachable }, {
      address: release.issuer, signMessage: unreachable,
    }, () => Number(now), 1000, 1024),
    nowMs: Date.now, clock: { now: () => now, maxSafeBlockAgeSeconds: 100n },
    retryDelayMs: 250, observationDelayMs: 500, documentTimeoutMs: 5000, maxDocumentBytes: 65536,
  };
  const source = publicationSelectionSource(release), sid = sourceId(source);
  const [learner, reviewer] = (["dance-verdict", "dance-review-attribution"] as const).map((purpose, index) => {
    const choice = release.policies[purpose]!, accountId = `00000000-0000-4000-8000-00000000000${index + 1}`,
      wallet = addr(100 + index), author = digest("author-" + index), bindingId = "binding-" + index,
      requestId = "grant-" + index, nonce = digest("nonce-" + index);
    const id = commandId({ source, accountId, requestId, action: "grant", purpose });
    const message = {
      communityId, learner: wallet, purpose, publicationTarget: choice.target,
      publicationTargetRuntimeHash: choice.runtimeHash, permissionRevision: choice.permissionRevision,
      policyHash: choice.policyHash, withdrawalEpoch: "0", nonce,
      issuedAt: String(now - 3n), validAfter: String(now - 2n),
      submitBefore: String(now + 60n), expiresAt: String(now + 120n),
    };
    const grant = preparePublicationGrant(BigInt(chainId), source.registry, message, "0x");
    const command: PreparedConsentCommandV1 = {
      schema: "pirate.publication-command/1", commandId: id, accountId, requestId, action: "grant",
      source, message, digest: grant.digest, preparedAtMs: Date.now() - 3000, localFenceGeneration: "0",
    };
    const request = {
      source, accountId, requestId, purpose, action: "grant", capture: {
        schema: "pirate.publication-app-original/1", accountId, bindingId, authorId: author,
        learner: wallet, origin: context.app.origin, releaseSelectionSha256: source.releaseSelectionSha256,
        sourceCommandId: null,
      },
    };
    const receipt: ConsentCommandReceiptV1 = {
      schema: "pirate.publication-command-receipt/1", commandId: id, digest: grant.digest,
      action: "grant", purpose, source, state: "recorded", transactionIndex: 0,
      transactionHash: digest("fixture-tx-" + index),
      observed: { blockNumber: "50", blockHash: digest("fixture-block"), timestampS: String(now - 1n) },
    };
    sqlite.sqlite.prepare("INSERT INTO community_accounts VALUES (?,?,?)").run(accountId, author, 1);
    sqlite.sqlite.prepare("INSERT INTO credential_bindings VALUES (?,?,'moss',6343,?,?)").run(bindingId, accountId, wallet, 1);
    sqlite.sqlite.prepare("INSERT INTO publication_v1_heads VALUES (?,?,?,?,0,0,NULL)").run(communityId, accountId, sid, purpose);
    sqlite.sqlite.prepare(`INSERT INTO publication_v1_commands (command_id,community_id,account_id,source_id,purpose,
      action,request_id,request_hash,request_json,nonce_hex,fence_generation,phase,version,created_at,due_ms,typed_json,digest,signature,
      accepted_json,result_state,observation_hash) VALUES (?,?,?,?,?,'grant',?,?,?,?,0,'accepted',1,1,1,?,?,'0x11','{}','recorded',?)`)
      .run(id, communityId, accountId, sid, purpose, requestId, digest(request), canonical(request), nonce,
        canonical(command), grant.digest, digest(receipt));
    sqlite.sqlite.prepare("INSERT INTO publication_v1_observations VALUES (?,?,?)").run(id, digest(receipt), canonical(receipt));
    return {
      commandId: id, accountId, purpose, grantId: grant.digest,
      original: {
        plan: { accountId, wallet, publisher: context.publisher, sourceHash: digest("selected V2"),
          ownerEpoch: 1n, configurationRevision: 1n, commandId: digest("fixture-bind-" + index) },
        hash: digest("fixture-bind-tx-" + index), nonce: index, raw: "0x11" as Hex,
      },
    };
  });
  assert(learner && reviewer);
  await t.test("private owner playback and an unrelated recording do not open installed authority", async () => {
    const activePrivate = digest("normal private take"), bound = digest("different person's submitted take");
    const captures = sqlite.sqlite.prepare("INSERT INTO dance_captures VALUES (?,?,?,?,?,?)");
    captures.run(activePrivate, communityId, learner.accountId, "private", digest("private-request"),
      canonical({ publication: { kind: "private" } }));
    captures.run(bound, communityId, reviewer.accountId, "submitted", digest("submitted-request"),
      canonical({ publication: { kind: "publication-bound" } }));
    for (const id of [activePrivate, bound])
      sqlite.sqlite.prepare("INSERT INTO dance_consents VALUES (?, '{}')").run(id);
    const lazy = dancePublicationMediaAccess({ db, open: unreachable }, context, {
      client: ports.client, profile: { address: context.postsContract, runtimeCodeHash: digest("fixture posts"), deploymentBlock: 1n },
    }, unreachable);
    assert.equal(await lazy.owned({ accountId: learner.accountId }, activePrivate), null);
    assert.equal(await lazy.owned({ accountId: learner.accountId }, bound), null);
  });
  const active = await installedDanceParticipants(ports, [learner, reviewer], async () => {});
  assert.deepEqual(active.pair.map(entry => [entry.accountId, entry.grantId]),
    [[learner.accountId, learner.grantId], [reviewer.accountId, reviewer.grantId]]);
  const fences = await active.privateOriginalFences(active.pair);
  await store.assert([...fences]);
  await assert.rejects(installedDanceParticipants(ports, [reviewer, learner], async () => {}), /dance_installed_grant_scope_unavailable/);
  await assert.rejects(active.privateOriginalFences([active.pair[1], active.pair[0]]), /dance_installed_grant_scope_changed/);

  const alias = "another-binding";
  sqlite.sqlite.prepare("INSERT INTO credential_bindings VALUES (?,?,'moss',6343,?,?)").run(alias, reviewer.accountId, addr(200), 2);
  await assert.rejects(store.assert([...fences]), /dance.*fence/);
  sqlite.sqlite.prepare("DELETE FROM credential_bindings WHERE binding_id=?").run(alias);
  await store.assert([...fences]);
  sqlite.sqlite.prepare(`INSERT INTO publication_v1_commands (command_id,community_id,account_id,source_id,purpose,
    action,request_id,request_hash,request_json,nonce_hex,phase,version,created_at,due_ms)
    VALUES (?,?,?,?,?,'withdraw','stop-request',?,'{}',?,'preparing',0,2,2)`)
    .run(digest("stop"), communityId, reviewer.accountId, sid, reviewer.purpose, digest("{}"), digest("stop-nonce"));
  await assert.rejects(store.assert([...fences]), /dance.*fence/);
  await assert.rejects(active.privateOriginalFences(active.pair), /dance_installed_grant_not_active/);
});
