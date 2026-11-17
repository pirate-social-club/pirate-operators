import { createPrivatePracticeDance } from "../services/community-private-dance.ts";
import { communityMediaRender } from "../packages/community-media/processor-transport.ts";
import { danceCommunityApi } from "../services/dance-community-api.ts";
import { CommunityError } from "../packages/community/common.ts";
import { loopback } from "./fixtures/publication-app-http.ts";
import { DanceSource3Bindings, DANCE_SOURCE3_BINDINGS_SCHEMA_PROPOSAL } from "../services/dance-source3-bindings.ts";
import { MediaRepository } from "../packages/community-media/repository.ts";
import type { MediaIntent, MediaRecord, PublishedMediaSong } from "../packages/community-media/contracts.ts";
import { createDancePrivateCatalogue, type DancePrivatePolicyV2 } from "../services/dance-private-catalogue.ts";
import { hashPrivateDanceCaptureV2 } from "../packages/dance/capture-v2.ts";
/** UNRUN. Actual SQLite + original parser/hash/production readers. Stored facts,
 * recorded-signature admission and RPC are named fixture inputs, not provider proof. */
import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { getAddress, hashMessage, keccak256, type Hex, type Address } from "viem";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { danceAccountCommitment, danceSingletonId, danceSourceHash } from "../packages/dance-chain/wire.ts";
import { signInMessageV4 } from "../packages/protocol/learning-results-v4.ts";
import { DANCE_PRIVATE_MEDIA_POLICY } from "../packages/dance/contracts.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { UNREGISTERED_OWNER_POLICY_VERSION, UNREGISTERED_OWNER_POLICY_HASH } from "../packages/community/owner-policy.ts";
import { createDanceAccountFacts } from "../services/dance-account-facts.ts";
import { DANCE_HOST_INPUTS_SCHEMA_PROPOSAL, joinDanceFences, type DanceHostContext } from "../services/dance-account-facts-store.ts";
import { MemorySqliteD1 } from "./dance-sqlite-fixture.ts";
import { dh, dw } from "./dance-fixture.ts";

/** Future Root-gated REAL local D1/workerd execution, not a parameter-limit
 * simulation. The 101-bind canary must fail in that engine; never turn a
 * canary failure into a pass via a memory adapter or a transport clamp. */
async function genuineD1(seed: MemorySqliteD1) {
  const mf = new Miniflare({ modules: true,
    script: "export default { fetch() { return new Response('D1 test fixture'); } }",
    d1Databases: ["DB"], d1Persist: false });
  try {
    const native = await mf.getD1Database("DB");
    const canary = (n: number) => native.prepare("SELECT " +
      Array.from({ length: n }, (_, i) => "? AS p" + i).join(",")).bind(...Array.from({ length: n }, (_, i) => i)).all();
    await canary(100);
    await assert.rejects(async () => canary(101), /parameter|variable|bind|limit/i);
    const schema = seed.sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
      .all() as { type: string; name: string; sql: string }[];
    const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
    for (const item of schema.filter(s => s.type === "table")) await native.prepare(item.sql).run();
    // Snapshot an explicit fixture's existing bytes, with triggers installed
    // afterwards so imported head/generation values are neither reset nor replayed.
    for (const table of schema.filter(s => s.type === "table")) {
      const rows = seed.sqlite.prepare("SELECT * FROM " + quote(table.name)).all();
      for (const row of rows) {
        const keys = Object.keys(row), values = Object.values(row);
        await native.prepare("INSERT INTO " + quote(table.name) + "(" + keys.map(quote).join(",") +
          ") VALUES(" + keys.map(() => "?").join(",") + ")").bind(...values).run();
      }
    }
    for (const item of schema.filter(s => s.type !== "table")) await native.prepare(item.sql).run();
    const binds: number[] = [];
    // Observe counts while forwarding native D1 statements/results unchanged.
    const observed = new Proxy(native, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const stmt = target.prepare(sql);
        return new Proxy(stmt, { get(statement, key) {
          if (key === "bind") return (...values: unknown[]) => {
            binds.push(values.length); return statement.bind(...values);
          };
          const member = Reflect.get(statement, key);
          return typeof member === "function" ? member.bind(statement) : member;
        } });
      };
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    } });
    return { db: observed as unknown as D1Database, binds, dispose: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}


import { encodeAbiParameters, encodeEventTopics, type PublicClient } from "viem";
import { postsAbi } from "../packages/community/post-chain.ts";
import { validatePost, type PostManifest } from "../packages/community/post-manifest.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { songKeyOf } from "../packages/protocol/records.ts";
import { createDanceSelectedCatalogue, type DanceSelectedSong } from "../services/dance-selected-catalogue.ts";
import { danceOfferId } from "../packages/dance-chain/wire.ts";
import { type DanceCapture } from "../packages/dance/contracts.ts";
/** Explicit fixture projections/RPC, never production seed data or chain proof. */
function hostSimulation() {
  const db = new MemorySqliteD1();
  db.sqlite.exec("CREATE TABLE setup_schema(version INTEGER)");
  for (const name of ["0002_first_song.sql", "0013_learning_authorization.sql", "0018_learning_authority.sql"])
    db.sqlite.exec(readFileSync(new URL("../apps/community-wizard/infra/migrations/" + name, import.meta.url), "utf8"));
  db.sqlite.exec(readFileSync(new URL("../packages/dance/schema.sql", import.meta.url), "utf8"));
  db.sqlite.exec(DANCE_HOST_INPUTS_SCHEMA_PROPOSAL);
  db.sqlite.exec("CREATE TABLE host_fixture_acceptance(id TEXT PRIMARY KEY)");
  const origin = "https://community.invalid", code = "0x6000" as Hex;
  const domain = { chainId: 6343n, communityId: dh(1) as Hex, verifier: dw(20) as Address };
  const rulesDocument = "fixture rules", rubricText = "fixture categorical inspection";
  const mediaPolicyDocument = canonical(DANCE_PRIVATE_MEDIA_POLICY), terms = "fixture private consent";
  const pin = { directory: dw(21) as Address, directoryRuntimeHash: keccak256(code), v4: dw(22) as Address,
    v4RuntimeHash: keccak256(code), posts: dw(23) as Address, postsRuntimeHash: keccak256(code),
    fixedPublisher: dw(24) as Address, publicityPolicyHash: dh(25) as Hex, rulesSha256: hashText(rulesDocument),
    termsSha256: hashText(terms), rubricSha256: hashText(rubricText), mediaPolicySha256: hashText(mediaPolicyDocument),
    runtimeCodeHash: keccak256(code), deploymentBlock: 1n };
  const source: DanceCanonicalSource = { schema: "pirate.dance-verdict/1", domain, pin,
    sourceHash: danceSourceHash(domain, pin), capturePolicy: dw(26) as Address, capturePolicyRuntimeHash: keccak256(code) };
  const config: CommunityConfig = { schema: "pirate.community-config/1", chainId: 6343, directory: pin.directory,
    communityId: domain.communityId, registry: dw(27) as Address, tld: "fixture", configurationRevision: 1,
    postsContract: pin.posts, controller: dw(28) as Address, publisher: pin.fixedPublisher,
    operatorPayments: dw(29) as Address, learningRecords: pin.v4, app: { label: "fixture",
      tokenGeneration: "0", origin, httpsAlias: null, hnsIngress: "none" },
    feed: { endpoint: origin + "/feed", signingKeyId: "fixture" },
    policies: { admission: { version: UNREGISTERED_OWNER_POLICY_VERSION, sha256: UNREGISTERED_OWNER_POLICY_HASH },
      moderationSigner: dw(30) as Address }, publisherRevocations: [] };
  const now = Date.now();
  const context: DanceHostContext = { version: "pirate.dance-host-context/1", sourceHash: source.sourceHash,
    configurationRevision: 1, ownerEpoch: 1, rulesEpoch: 0, mediaEpoch: 0,
    owner: { accountId: "owner", wallet: dw(3), assignmentId: "assignment-original",
      validFromMs: now - 60000, expiresAtMs: now + 86400000 }, captureTtlMs: 600000,
    consent: { version: "fixture-consent", termsHash: pin.termsSha256,
      publicityPolicyHash: pin.publicityPolicyHash, text: terms, admission: "admitted" },
    rulesDocument, rubricText, mediaPolicyDocument };
  db.sqlite.prepare("INSERT INTO application_identity VALUES(1,?,?)").run(domain.communityId, origin);
  db.sqlite.prepare("INSERT INTO public_configurations VALUES(?,1,?,?,?,?,?,?,?)")
    .run(domain.communityId, config.publisher, "fixture-config-uri", hashJson(config), canonical(config), "90", dh(88), dh(89));
  db.sqlite.prepare("INSERT INTO dance_host_context VALUES(?,1,?)").run(domain.communityId, JSON.stringify(context));
  const ids = ["actor", "learner", "owner", "alias"], originals = new Map<string, string>();
  for (const [i, id] of ids.entries()) {
    const subject = dw(i + 1) as Address, binding = "binding-" + id;
    db.sqlite.prepare("INSERT INTO community_accounts VALUES(?,?,?)").run(id, dh(100 + i), now);
    db.sqlite.prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)").run(binding, id, subject, now);
    db.sqlite.prepare("INSERT INTO learning_authority_heads(account_id) VALUES(?)").run(id);
    const signIn = { learner: getAddress(subject), nonce: dh(200 + i) as Hex, issuedAt: BigInt(Math.floor(now / 1000) - 10) };
    const message = signInMessageV4({ origin, communityId: domain.communityId, chainId: 6343,
      contract: pin.v4, publicationPolicy: dh(250) as Hex }, signIn);
    const authorizationId = hashMessage(message);
    originals.set(id, authorizationId);
    db.sqlite.prepare(`INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,
      policy_hash,policy_version,issued_at,state,tx_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,4,?,'recorded',?,?,?)`).run(authorizationId, id, subject,
      JSON.stringify({ learner: signIn.learner, nonce: signIn.nonce, issuedAt: String(signIn.issuedAt) }), message,
      "0x" + "11".repeat(65), dh(250), Number(signIn.issuedAt), dh(300 + i), now, now);
    const commitment = danceAccountCommitment(domain, id, subject);
    const selection = { version: "pirate.dance-account-selection/1", sourceHash: source.sourceHash,
      bindingId: binding, authorizationId, identityEpoch: 1, groupId: danceSingletonId(domain, commitment),
      groupEpoch: 1, knownAliases: [id], active: true };
    db.sqlite.prepare("INSERT INTO dance_host_accounts VALUES(?,?,1,?)").run(domain.communityId, id, JSON.stringify(selection));
  }
  const accountFacts = createDanceAccountFacts({ db: db.asD1(), source, config });
  function change(table: "dance_host_context" | "dance_host_accounts", accountId: string | null,
    use: (body: Record<string, any>) => void) {
    const where = accountId === null ? "community_id=?" : "community_id=? AND account_id=?";
    const keys = accountId === null ? [domain.communityId] : [domain.communityId, accountId];
    const row = db.sqlite.prepare("SELECT body_json FROM " + table + " WHERE " + where).get(...keys)!;
    const body = JSON.parse(String(row.body_json)); use(body);
    db.sqlite.prepare("UPDATE " + table + " SET revision=revision+1,body_json=? WHERE " + where)
      .run(JSON.stringify(body), ...keys);
  }
  return { db, source, config, context, originals, accountFacts, change, code,
    store: new DanceStore(db.asD1()), close: () => db.close() };
}

async function catalogueSimulation(options: { d1?: boolean; prepare?: (fixture: ReturnType<typeof hostSimulation>, selected: DanceSelectedSong, key: string) => void } = {}) {
  const f = hostSimulation(), { db, config, source } = f;
  db.sqlite.exec(readFileSync(new URL("../apps/community-wizard/infra/migrations/0011_manual_rewards.sql", import.meta.url), "utf8"));
  db.sqlite.exec("CREATE TABLE host_fixture_reference(resource_id TEXT PRIMARY KEY,revision INTEGER,active INTEGER)");
  const audio = await preparePin(new TextEncoder().encode("fixture canonical song bytes"), "audio/mpeg");
  const post = validatePost({ schema: "pirate.community-post/3", chainId: 6343, postsContract: source.pin.posts,
    communityId: source.domain.communityId, postId: dh(400), authorId: dh(401), kind: "song", revision: 1,
    configurationRevision: 1, publishedAt: Date.now(), title: "Fixture dance", language: "und", rating: "general",
    media: [{ role: "audio", ...audio }], admission: { policyVersion: UNREGISTERED_OWNER_POLICY_VERSION,
      policySha256: UNREGISTERED_OWNER_POLICY_HASH, decision: "publish", rating: "general", coverDisplayed: false,
      evidenceSha256: dh(402), automatedContent: "deferred", declarationSource: "operator_declared" },
    registration: { status: "absent", reason: "deferred_for_launch" } });
  const manifest = await preparePin(new TextEncoder().encode(canonical(post)), "application/json");
  const key = songKeyOf({ chainId: 6343, communityId: source.domain.communityId, posts: source.pin.posts, postId: post.postId });
  const probeReceipt = canonical({ fixtureOnly: true, audioSha256: audio.sha256, sampleCount: 4800000 });
  const selected: DanceSelectedSong = { version: "pirate.dance-selected-song/1", postId: post.postId,
    songRevision: 1, manifestSha256: manifest.sha256, audioSha256: audio.sha256, songDurationSamples: 4800000,
    probeEvidenceSha256: hashText(probeReceipt), startSample: 48000, durationSamples: 480000,
    reference: null, offerProgramId: null, offer: null };
  db.sqlite.prepare("INSERT INTO dance_host_song_keys VALUES(?,?,?)").run(source.domain.communityId, key, post.postId);
  db.sqlite.prepare("INSERT INTO dance_host_audio_probes VALUES(?,?,?,?,?)")
    .run(source.domain.communityId, audio.sha256, selected.probeEvidenceSha256, selected.songDurationSamples, probeReceipt);
  db.sqlite.prepare("INSERT INTO dance_host_selections VALUES(?,?, '', '',1,?)").run(source.domain.communityId, key, JSON.stringify(selected));
  db.sqlite.prepare("INSERT INTO public_post_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)")
    .run(source.domain.communityId, post.postId, 1, post.authorId, 1, manifest.uri, manifest.sha256, canonical(post),
      "100", dh(500), dh(501), 0);
  db.sqlite.prepare("INSERT INTO chain_scan_state VALUES(6343,?,'101',?)").run(source.pin.posts, dh(500));
  const safe = { number: 100n, hash: dh(500), timestamp: BigInt(Math.floor(Date.now()/1000)), transactions: [] };
  const faults = { codeChanged: false, revision: 1n, referenceEpoch: 1n, referenceActive: true, afterReceipt: null as (() => void) | null };
  const event = { communityId: source.domain.communityId, postId: post.postId, authorId: post.authorId,
    kind: 0, revision: 1n, configurationRevision: 1n, manifestSha256: manifest.sha256, manifestURI: manifest.uri };
  const log = { address: source.pin.posts, blockNumber: 100n, blockHash: dh(500), transactionHash: dh(501),
    logIndex: 0, transactionIndex: 0, removed: false,
    topics: encodeEventTopics({ abi: postsAbi, eventName: "PostRevisionPublished",
      args: { communityId: event.communityId, postId: event.postId, authorId: event.authorId } }),
    data: encodeAbiParameters([{type:"uint8"},{type:"uint64"},{type:"uint64"},{type:"bytes32"},{type:"string"}],
      [0,1n,1n,manifest.sha256,manifest.uri]) };
  const client = { getChainId: async () => 6343, getBlockNumber: async () => 101n,
    getCode: async () => faults.codeChanged ? "0x6001" : f.code, getBlock: async () => safe,
    getTransactionReceipt: async () => {
      const receipt = { status: "success", transactionHash: dh(501), blockHash: dh(500), blockNumber: 100n, logs: [log] };
      const after = faults.afterReceipt; faults.afterReceipt = null; after?.();
      return receipt;
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      switch(functionName) {
        case "directory": return config.directory;
        case "getPost": return { authorId: post.authorId, kind: 0, revision: faults.revision,
          configurationRevision: 1n, manifestSha256: manifest.sha256, manifestURI: manifest.uri };
        case "sourceHash": return source.sourceHash;
        case "communityId": return source.domain.communityId;
        case "VERSION": return 1;
        case "capturePolicy": return source.capturePolicy;
        case "capturePolicyRuntimeHash": return source.capturePolicyRuntimeHash;
        case "references": return [faults.referenceEpoch, 1n, dh(603), faults.referenceActive];
        default: throw Error("unsupported simulation read " + functionName);
      }
    } } as unknown as PublicClient;
  options.prepare?.(f, selected, key);
  const engine = options.d1 ? await genuineD1(db) : null;
  const usedDb = engine?.db ?? db.asD1();
  const accounts = engine ? createDanceAccountFacts({ db: usedDb, source, config }) : f.accountFacts;
  const calls: { resourceId: string; accountId: string }[] = [];
  const catalogue = createDanceSelectedCatalogue({ db: usedDb, source, config, accounts,
    reads: { client, profile: { address: source.pin.posts, runtimeCodeHash: source.pin.postsRuntimeHash, deploymentBlock: 1n } },
    referenceAccess: async request => {
      calls.push(request);
      assert.equal(request.mediaEpoch, 0);
      assert.equal(request.target.songKey, key); assert.equal(request.target.songRevision, 1);
      assert.equal(request.target.audioSha256, selected.audioSha256);
      assert.equal(request.interval.startSample, selected.startSample);
      assert.equal(request.interval.durationSamples, selected.durationSamples);
      const active = db.sqlite.prepare("SELECT * FROM host_fixture_reference WHERE resource_id=?").get(request.resourceId);
      assert.equal(active?.active, 1);
      return { url: config.app.origin + "/api/media/" + request.resourceId + "/playback",
        renewAt: Date.now()+30000, expiresAt: Date.now()+60000,
        fence: { sql: "EXISTS(SELECT 1 FROM host_fixture_reference WHERE resource_id=? AND revision=? AND active=1)",
          values: [request.resourceId, Number(active!.revision)] } };
    } });
  const selection = { songKey: key, referenceId: null, offerId: null };
  function updateSelected(use: (s: DanceSelectedSong) => void) {
    const row = db.sqlite.prepare("SELECT body_json FROM dance_host_selections WHERE song_key=? AND reference_id='' AND offer_id=''").get(key)!;
    const s: DanceSelectedSong = JSON.parse(String(row.body_json)); use(s);
    db.sqlite.prepare("UPDATE dance_host_selections SET revision=revision+1,body_json=? WHERE song_key=? AND reference_id='' AND offer_id=''")
      .run(JSON.stringify(s), key);
  }
  function captured(c: Awaited<ReturnType<typeof catalogue.select>>): DanceCapture {
    const now = Date.now();
    return { ...c.capture, captureId: "capture-original", captureHash: dh(700), reservedAtMs: now,
      consent: { version: c.consentPolicy.version, termsHash: c.consentPolicy.termsHash,
        publicityPolicyHash: c.consentPolicy.publicityPolicyHash, accepted: true, receiptId: "consent-original", accountId: "actor",
        captureId: "capture-original", captureHash: dh(700), acceptedAtMs: now } };
  }
  return { ...f, catalogue, key, post, selected, selection, faults, calls, updateSelected, captured,
    engine, client, usedDb, store: new DanceStore(usedDb) };
}

test("real selected snapshot + canonical post reader produces exact capture, public guide and retained post mapping", async () => {
  const f = await catalogueSimulation();
  try {
    const page = await f.catalogue.list(f.source.domain.communityId, "actor", f.key, null);
    assert.equal(page.page.choices[0].title, f.post.title);
    assert.equal(page.page.choices[0].playback, "unavailable"); // No reference was invented.
    const admitted = await f.catalogue.select(f.source.domain.communityId, "actor", f.selection);
    const c = f.captured(admitted);
    assert.equal(c.learner.accountId, "actor"); assert.equal(c.songRevision, 1);
    assert.equal(c.audioSha256, f.selected.audioSha256); assert.equal(c.reference, null); assert.equal(c.offer, null);
    assert.equal(c.consent!.termsHash, f.source.pin.termsSha256);
    const grant = await f.catalogue.guide(c);
    assert.equal(grant.access, "public"); assert.equal(grant.expires_at, undefined);
    assert.equal(grant.playback_url, f.config.app.origin + "/api/public/posts/" + f.post.postId + "/audio");
    assert.equal(await f.catalogue.songPostId(c), f.post.postId);
    f.db.sqlite.prepare("DELETE FROM dance_host_selections").run();
    assert.equal(await f.catalogue.songPostId(c), f.post.postId); // Historical mapping survives selected-policy retirement.
    await assert.rejects(f.catalogue.rules(c));
    assert.throws(() => f.db.sqlite.prepare("DELETE FROM dance_host_song_keys").run(), /immutable/);
  } finally { f.close(); }
});
test("selected revision/audio/probe/interval and changed canonical publication fail closed", async () => {
  const f = await catalogueSimulation();
  try {
    f.faults.revision = 2n;
    await assert.rejects(f.catalogue.select(f.source.domain.communityId, "actor", f.selection));
    f.faults.revision = 1n;
    for (const mutate of [
      (s: DanceSelectedSong) => { s.songRevision = 2; },
      (s: DanceSelectedSong) => { s.audioSha256 = dh(999); },
      (s: DanceSelectedSong) => { s.probeEvidenceSha256 = dh(998); },
      (s: DanceSelectedSong) => { s.durationSamples = 1; },
    ]) {
      f.updateSelected(s => Object.assign(s, structuredClone(f.selected)));
      f.updateSelected(mutate);
      await assert.rejects(f.catalogue.select(f.source.domain.communityId, "actor", f.selection));
    }
  } finally { f.close(); }
});
test("same SQL fence rejects changed selected metadata/config/owner/media at final acceptance without partial write", async () => {
  const f = await catalogueSimulation();
  try {
    for (const [name, mutate] of [
      ["selection", () => f.updateSelected(s => { s.startSample += 48; })],
      ["owner", () => f.change("dance_host_context", null, body => { body.ownerEpoch++; body.owner.assignmentId = "owner-next"; })],
      ["configuration", () => f.change("dance_host_context", null, body => { body.configurationRevision++; })],
      ["media", () => f.change("dance_host_context", null, body => { body.mediaEpoch++; })],
    ] as const) {
      const admitted = await f.catalogue.select(f.source.domain.communityId, "actor", f.selection);
      f.db.beforeBatch = mutate;
      await assert.rejects(f.store.atomic([admitted.fence],
        [f.db.asD1().prepare("INSERT INTO host_fixture_acceptance VALUES(?)").bind(name)]));
      assert.equal(f.db.count("host_fixture_acceptance"), 0);
      // Restore fixture-only context to permit the next independently captured fence.
      f.change("dance_host_context", null, body => { body.configurationRevision=1; body.mediaEpoch=0; });
    }
  } finally { f.close(); }
});
test("explicit original reference resource + canonical epoch and lease fence, never guessed capture/media linkage", async () => {
  const f = await catalogueSimulation();
  try {
    const s = structuredClone(f.selected);
    s.reference = { id: dh(600), revision: 1, epoch: 1, segmentId: dh(602),
      segmentLayoutSha256: dh(603), resourceId: "reference-original" };
    f.db.sqlite.prepare("INSERT INTO dance_host_selections VALUES(?,?,?,'',1,?)")
      .run(f.source.domain.communityId, f.key, s.reference.id, JSON.stringify(s));
    f.db.sqlite.prepare("INSERT INTO host_fixture_reference VALUES('reference-original',1,1)").run();
    const t = { communityId: f.source.domain.communityId, songKey: f.key, songRevision: 1, audioSha256: s.audioSha256,
      reference: { id: s.reference.id, revision: 1 }, offerId: null };
    const grant = await f.catalogue.reference("actor", t);
    assert.equal(f.calls[0].resourceId, "reference-original"); assert.equal(f.calls[0].accountId, "actor");
    f.db.beforeBatch = () => { f.db.sqlite.prepare("UPDATE host_fixture_reference SET active=0").run(); };
    await assert.rejects(f.store.assert([grant.fence]));
    f.db.sqlite.prepare("UPDATE host_fixture_reference SET active=1").run();
    f.faults.referenceEpoch = 2n;
    await assert.rejects(f.catalogue.reference("actor", t), /reference_changed/);
    f.faults.referenceEpoch = 1n;
    await assert.rejects(f.catalogue.reference("actor", { ...t, reference: { ...t.reference, revision: 2 } }));
  } finally { f.close(); }
});
test("frozen actual offerInput SHA256/source/window is fenced; no fake score/reward or no-offer substitution", async () => {
  const f = await catalogueSimulation();
  try {
    const input = { offerId: "offer-original", drawingId: "drawing", songKey: f.key, opensAt: Date.now()-10000,
      cutoffAt: Date.now()+600000, purchaseHash: dh(801), ticketIds: ["ticket"],
      resultSources: [f.source.sourceHash] };
    const inputHash = hashJson(input), evidence = JSON.stringify({ mode: "live-testnet", resultSources: input.resultSources });
    f.db.sqlite.prepare("INSERT INTO reward_programs VALUES('program',?,0)").run(dh(800));
    f.db.sqlite.prepare(`INSERT INTO reward_offers(program_id,offer_id,drawing_id,song_key,cutoff_at,opens_at,purchase_hash,
      ticket_ids_json,input_hash,purchase_evidence,state) VALUES('program',?,?,?,?,?,?,?,?,?,'open')`)
      .run(input.offerId, input.drawingId, f.key, input.cutoffAt, input.opensAt, input.purchaseHash,
        JSON.stringify(input.ticketIds), inputHash, evidence);
    const s = structuredClone(f.selected);
    s.offerProgramId = "program"; s.offer = { offerId: input.offerId, inputHash, sourceHash: f.source.sourceHash,
      offerIdCommitment: danceOfferId(f.source.domain, input.offerId), opensAtMs: input.opensAt, cutoffAtMs: input.cutoffAt };
    f.db.sqlite.prepare("INSERT INTO dance_host_selections VALUES(?,?,'',?,1,?)")
      .run(f.source.domain.communityId, f.key, input.offerId, JSON.stringify(s));
    const admitted = await f.catalogue.select(f.source.domain.communityId, "actor", { ...f.selection, offerId: input.offerId });
    assert.equal(admitted.capture.offer!.inputHash, inputHash);
    f.db.beforeBatch = () => { f.db.sqlite.prepare("UPDATE reward_offers SET input_hash=?").run(dh(899)); };
    await assert.rejects(f.store.assert([admitted.fence]));
    await assert.rejects(f.catalogue.select(f.source.domain.communityId, "actor", { ...f.selection, offerId: input.offerId }));
    const noOffer = await f.catalogue.select(f.source.domain.communityId, "actor", f.selection);
    assert.equal(noOffer.capture.offer, null);
  } finally { f.close(); }
});
test("wrong community/account and stale source/cursor are refused; read handlers never create a command", async () => {
  const f = await catalogueSimulation();
  try {
    await assert.rejects(f.catalogue.list(dh(99), "actor", f.key, null));
    await assert.rejects(f.catalogue.select(f.source.domain.communityId, dh(100), f.selection));
    await assert.rejects(f.catalogue.list(f.source.domain.communityId, "actor", f.key,
      JSON.stringify({ communityId: f.source.domain.communityId, songKey: f.key, contextRevision: 0, after: "" })));
    f.change("dance_host_context", null, body => { body.sourceHash = dh(999); });
    await assert.rejects(f.catalogue.select(f.source.domain.communityId, "actor", f.selection));
    assert.equal(f.db.count("dance_captures"), 0); assert.equal(f.db.count("dance_receipts"), 0);
  } finally { f.close(); }
});

test("exact publication snapshot survives no replacement-provenance reread: every mutation after receipt verification refuses", async () => {
  const f = await catalogueSimulation();
  try {
    const before = f.db.sqlite.prepare("SELECT * FROM public_post_revisions").get()!;
    const vectors: [string, string | number][] = [["transaction_hash", dh(901)], ["block_hash", dh(902)],
      ["block_number", "101"], ["configuration_revision", 2], ["author_id", dh(903)],
      ["manifest_uri", "ipfs://unverified-replacement"], ["log_index", 9], ["manifest_json", String(before.manifest_json) + "\n"]];
    for (const [field, value] of vectors) {
      let rowReads = 0;
      f.db.beforeRead = async sql => { if (sql.includes("SELECT * FROM public_post_revisions WHERE")) rowReads++; };
      f.faults.afterReceipt = () => { f.db.sqlite.prepare("UPDATE public_post_revisions SET " + field + "=?").run(value); };
      await assert.rejects(f.catalogue.select(f.source.domain.communityId, "actor", f.selection));
      assert.equal(rowReads, 1, "verified row must be the sole index snapshot");
      assert.equal(f.db.count("host_fixture_acceptance"), 0);
      f.db.sqlite.prepare("UPDATE public_post_revisions SET " + field + "=?").run(before[field] as string | number);
    }
    f.db.beforeRead = null;
  } finally { f.close(); }
});

test("all verified publication fields remain guarded immediately before accepting the actual atomic batch", async () => {
  const f = await catalogueSimulation();
  try {
    const before = f.db.sqlite.prepare("SELECT * FROM public_post_revisions").get()!;
    const vectors: [string, string | number][] = [["transaction_hash", dh(911)], ["block_hash", dh(912)],
      ["block_number", "101"], ["configuration_revision", 2], ["author_id", dh(913)], ["manifest_uri", "changed-uri"], ["log_index", 4]];
    for (const [field, value] of vectors) {
      const admitted = await f.catalogue.select(f.source.domain.communityId, "actor", f.selection);
      f.db.beforeBatch = () => { f.db.sqlite.prepare("UPDATE public_post_revisions SET " + field + "=?").run(value); };
      await assert.rejects(f.store.atomic([admitted.fence],
        [f.db.asD1().prepare("INSERT INTO host_fixture_acceptance VALUES(?)").bind(field)]));
      assert.equal(f.db.count("host_fixture_acceptance"), 0);
      f.db.sqlite.prepare("UPDATE public_post_revisions SET " + field + "=?").run(before[field] as string | number);
    }
  } finally { f.close(); }
});

test("drawing-only offer mutation keeps old input hash yet refuses acceptance and rolls back the marker", async () => {
  const f = await catalogueSimulation();
  try {
    const input = { offerId: "drawing-fence", drawingId: "drawing-original", songKey: f.key,
      opensAt: Date.now()-10000, cutoffAt: Date.now()+600000, purchaseHash: dh(921), ticketIds: ["ticket"], resultSources: [f.source.sourceHash] };
    const hash = hashJson(input), evidence = JSON.stringify({ mode: "live-testnet", resultSources: input.resultSources });
    f.db.sqlite.prepare("INSERT INTO reward_programs VALUES('program',?,0)").run(dh(920));
    f.db.sqlite.prepare(`INSERT INTO reward_offers(program_id,offer_id,drawing_id,song_key,cutoff_at,opens_at,purchase_hash,
      ticket_ids_json,input_hash,purchase_evidence,state) VALUES('program',?,?,?,?,?,?,?,?,?,'open')`)
      .run(input.offerId, input.drawingId, f.key, input.cutoffAt, input.opensAt, input.purchaseHash, JSON.stringify(input.ticketIds), hash, evidence);
    const selected = structuredClone(f.selected); selected.offerProgramId = "program";
    selected.offer = { offerId: input.offerId, offerIdCommitment: danceOfferId(f.source.domain, input.offerId),
      inputHash: hash, sourceHash: f.source.sourceHash, opensAtMs: input.opensAt, cutoffAtMs: input.cutoffAt };
    f.db.sqlite.prepare("INSERT INTO dance_host_selections VALUES(?,?,'',?,1,?)")
      .run(f.source.domain.communityId, f.key, input.offerId, JSON.stringify(selected));
    const admitted = await f.catalogue.select(f.source.domain.communityId, "actor", { ...f.selection, offerId: input.offerId });
    f.db.beforeBatch = () => { f.db.sqlite.prepare("UPDATE reward_offers SET drawing_id='drawing-replaced'").run(); };
    await assert.rejects(f.store.atomic([admitted.fence], [f.db.asD1().prepare("INSERT INTO host_fixture_acceptance VALUES('drawing')")]));
    assert.equal(f.db.sqlite.prepare("SELECT input_hash FROM reward_offers").get()!.input_hash, hash);
    assert.equal(f.db.count("host_fixture_acceptance"), 0);
  } finally { f.close(); }
});

test("recursive_triggers OFF still refuses every REPLACE/INSERT OR REPLACE collision and retains exact immutable bytes", async () => {
  const f = await catalogueSimulation();
  try {
    f.db.sqlite.exec("PRAGMA recursive_triggers=OFF");
    assert.equal(Number(f.db.sqlite.prepare("PRAGMA recursive_triggers").get()!.recursive_triggers), 0);
    const songs = JSON.stringify(f.db.sqlite.prepare("SELECT * FROM dance_host_song_keys ORDER BY song_key").all());
    const probes = JSON.stringify(f.db.sqlite.prepare("SELECT * FROM dance_host_audio_probes ORDER BY evidence_sha256").all());
    for (const command of ["INSERT OR REPLACE", "REPLACE"]) {
      assert.throws(() => f.db.sqlite.prepare(command + " INTO dance_host_song_keys VALUES(?,?,?)")
        .run(f.source.domain.communityId, f.key, dh(931)), /immutable/);
      assert.throws(() => f.db.sqlite.prepare(command + " INTO dance_host_song_keys VALUES(?,?,?)")
        .run(f.source.domain.communityId, dh(932), f.post.postId), /immutable/);
      assert.throws(() => f.db.sqlite.prepare(command + " INTO dance_host_audio_probes VALUES(?,?,?,?,?)")
        .run(f.source.domain.communityId, f.selected.audioSha256, f.selected.probeEvidenceSha256, 1, "replacement bytes"), /immutable/);
      assert.equal(JSON.stringify(f.db.sqlite.prepare("SELECT * FROM dance_host_song_keys ORDER BY song_key").all()), songs);
      assert.equal(JSON.stringify(f.db.sqlite.prepare("SELECT * FROM dance_host_audio_probes ORDER BY evidence_sha256").all()), probes);
    }
  } finally { f.close(); }
});

test("genuine D1 ordinary select plus maximum aliases and complete pagination retain all guards below the 100-bind engine limit", async () => {
  const f = await catalogueSimulation({ d1: true, prepare(model, selected, key) {
    const aliases = Array.from({ length: 127 }, (_, i) => "page_alias_" + String(i).padStart(3, "0"));
    for (const [i, id] of aliases.entries()) model.db.sqlite.prepare("INSERT INTO community_accounts VALUES(?,?,?)").run(id, dh(6000+i), Date.now());
    model.change("dance_host_accounts", "actor", body => { body.knownAliases = ["actor", ...aliases].sort(); });
    model.db.sqlite.prepare("INSERT INTO host_fixture_reference VALUES('reference-original',1,1)").run();
    for (let i=0; i<20; i++) {
      const s = structuredClone(selected); s.reference = { id: dh(1000+i), revision: 1, epoch: 1,
        segmentId: dh(602), segmentLayoutSha256: dh(603), resourceId: "reference-original" };
      model.db.sqlite.prepare("INSERT INTO dance_host_selections VALUES(?,?,?,'',1,?)")
        .run(model.source.domain.communityId, key, s.reference.id, JSON.stringify(s));
    }
  } });
  try {
    const admitted = await f.catalogue.select(f.source.domain.communityId, "actor", f.selection);
    assert.equal(admitted.capture.learner.knownAliases.length, 128);
    await f.store.atomic([admitted.fence], [f.engine!.db.prepare("INSERT INTO host_fixture_acceptance VALUES('ordinary')").bind()]);
    const page = await f.catalogue.list(f.source.domain.communityId, "actor", f.key, null);
    assert.equal(page.page.choices.length, 20); assert.ok(page.page.cursor); assert.equal(page.fence.values.length, 1);
    await f.store.atomic([page.fence], [f.engine!.db.prepare("INSERT INTO host_fixture_acceptance VALUES('page')").bind()]);
    const next = await f.catalogue.list(f.source.domain.communityId, "actor", f.key, page.page.cursor);
    assert.equal(next.page.choices.length, 1); assert.equal(next.page.cursor, null);
    await f.engine!.db.prepare("UPDATE host_fixture_reference SET active=0").run();
    await assert.rejects(f.store.atomic([page.fence], [f.engine!.db.prepare("INSERT INTO host_fixture_acceptance VALUES('must-refuse')").bind()]));
    assert.equal(await f.engine!.db.prepare("SELECT id FROM host_fixture_acceptance WHERE id='must-refuse'").first(), null);
    assert.ok(f.engine!.binds.every(n => n <= 100));
  } finally { await f.engine?.dispose(); f.close(); }
});


// Fresh private admission runs on the same selected song and native D1, without
// invoking the historical catalogue's V4 account/owner permission machinery.
function privatePolicy(
  f: ReturnType<typeof hostSimulation>,
): DancePrivatePolicyV2 {
  return {
    version: "pirate.dance-private-policy/2",
    configurationRevision: 1,
    rulesEpoch: 0,
    mediaEpoch: 0,
    captureTtlMs: 600000,
    consent: structuredClone(f.context.consent),
    rulesDocument: f.context.rulesDocument,
    rubricText: f.context.rubricText,
    mediaPolicyDocument: f.context.mediaPolicyDocument,
  };
}
function publicPermissionTrap(db: D1Database) {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          assert.doesNotMatch(
            sql,
            /learning_authorizations|learning_authority|publication_v1_|dance_host_accounts/,
          );
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function privateCatalogueFixture() {
  const f = await catalogueSimulation({
    d1: true,
    prepare(f) {
      f.db.sqlite
        .prepare(
          "UPDATE dance_host_context SET revision=revision+1,body_json=? WHERE community_id=?",
        )
        .run(canonical(privatePolicy(f)), f.config.communityId);
    },
  });
  const policy = privatePolicy(f),
    db = publicPermissionTrap(f.usedDb);
  const catalogue = createDancePrivateCatalogue({
    db,
    config: f.config,
    reads: {
      client: f.client,
      profile: {
        address: f.source.pin.posts,
        runtimeCodeHash: f.source.pin.postsRuntimeHash,
        deploymentBlock: 1n,
      },
    },
    policy,
  });
  const actor = {
    accountId: "actor",
    wallet: dw(1) as Address,
    bindingId: "binding-actor",
    authorId: dh(100) as Hex,
  };
  const target = {
    communityId: f.config.communityId,
    songKey: f.key,
    songRevision: 1,
    audioSha256: f.selected.audioSha256,
    reference: null,
    offerId: null,
  };
  return { ...f, policy, db, catalogue, actor, target };
}
test("fresh private catalogue proves canonical song/real probe and accepts native capture without public permission reads", async () => {
  const f = await privateCatalogueFixture();
  try {
    const chosen = await f.catalogue.select(f.actor, f.target),
      now = await f.store.now();
    const snapshot = {
      ...chosen.capture,
      captureId: dh(901) as Hex,
      reservedAtMs: now,
    };
    const capture = {
      ...snapshot,
      captureHash: hashPrivateDanceCaptureV2(snapshot),
      consent: null,
    };
    assert.equal(capture.publication.kind, "private");
    assert.equal(capture.canonical, null);
    assert.equal("authorizationId" in capture.learner, false);
    assert.equal(capture.audioSha256, f.selected.audioSha256);
    await f.store.reserveCaptureV2(
      capture,
      "actor",
      "private-song-native",
      dh(902),
      chosen.fences,
      { kind: "private" },
    );
    const fences = await f.catalogue.current(f.actor, capture);
    const accepted = await f.store.acceptConsentV2(
      capture,
      {
        accepted: true,
        ...(({ version, termsHash, publicityPolicyHash }) => ({
          version,
          termsHash,
          publicityPolicyHash,
        }))(chosen.consentPolicy),
      },
      "private-song-native",
      fences,
    );
    assert.ok(accepted.consent);
    assert.equal(
      (await f.store.storedCapture(capture.captureId)).captureHash,
      capture.captureHash,
    );
  } finally {
    await f.engine?.dispose();
    f.close();
  }
});
test("fresh private target cannot substitute a new revision/audio or ignore RPC failure", async () => {
  const f = await privateCatalogueFixture();
  try {
    await assert.rejects(
      f.catalogue.select(f.actor, { ...f.target, songRevision: 2 }),
      /target|binding|changed/,
    );
    await assert.rejects(
      f.catalogue.select(f.actor, { ...f.target, audioSha256: dh(911) }),
      /target|binding|changed/,
    );
    f.faults.codeChanged = true;
    await assert.rejects(f.catalogue.select(f.actor, f.target));
  } finally {
    await f.engine?.dispose();
    f.close();
  }
});
test("fresh private same-batch resource fence rejects changed context without partial capture", async () => {
  const f = await privateCatalogueFixture();
  try {
    const selected = await f.catalogue.select(f.actor, f.target),
      now = await f.store.now();
    const snapshot = {
      ...selected.capture,
      captureId: dh(921) as Hex,
      reservedAtMs: now,
    };
    const capture = {
      ...snapshot,
      captureHash: hashPrivateDanceCaptureV2(snapshot),
      consent: null,
    };
    const row = await f.usedDb
      .prepare("SELECT body_json FROM dance_host_context WHERE community_id=?")
      .bind(f.config.communityId)
      .first<{ body_json: string }>();
    const next = JSON.parse(row!.body_json);
    next.mediaEpoch++;
    await f.usedDb
      .prepare(
        "UPDATE dance_host_context SET revision=revision+1,body_json=? WHERE community_id=?",
      )
      .bind(canonical(next), f.config.communityId)
      .run();
    await assert.rejects(
      f.store.reserveCaptureV2(
        capture,
        "actor",
        "private-context-race",
        dh(922),
        selected.fences,
        { kind: "private" },
      ),
    );
    assert.equal(
      await f.usedDb
        .prepare("SELECT count(*) AS n FROM dance_captures")
        .first("n"),
      0,
    );
    await assert.rejects(
      f.catalogue.select(f.actor, f.target),
      /policy|context|changed/,
    );
  } finally {
    await f.engine?.dispose();
    f.close();
  }
});

test("fresh private capture reserves original media and previews after reload without a public command",async()=>{
  const f=await privateCatalogueFixture();
  try {
    await f.usedDb.batch(readFileSync(new URL("../packages/community-media/schema.sql",import.meta.url),"utf8").replace(/--[^\n]*/g,"").split(";").filter(s=>s.trim()).map(s=>f.usedDb.prepare(s)));
    await f.usedDb.batch(DANCE_SOURCE3_BINDINGS_SCHEMA_PROPOSAL.split(/;\n/).map(s=>s.trim()).filter(Boolean).map(s=>f.usedDb.prepare(s)));
    const selected=await f.catalogue.select(f.actor,f.target),now=await f.store.now();
    const snapshot={...selected.capture,captureId:dh(931) as Hex,reservedAtMs:now};
    const capture={...snapshot,captureHash:hashPrivateDanceCaptureV2(snapshot),consent:null};
    await f.store.reserveCaptureV2(capture,"actor","private-source3",dh(932),selected.fences,{kind:"private"});
    const {version,termsHash,publicityPolicyHash}=selected.consentPolicy;
    const accepted=await f.store.acceptConsentV2(capture,{accepted:true,version,termsHash,publicityPolicyHash},"private-source3",selected.fences);
    const bindings=new DanceSource3Bindings({db:f.db,communityId:f.config.communityId,privateV2:{current:(actor,c)=>f.catalogue.mediaAccess(actor,c)}});
    const actor={accountId:f.actor.accountId};
    const intent:MediaIntent={requestId:"private-recording-original",songKey:capture.songKey,songRevision:capture.songRevision,recordingSha256:"a".repeat(64),bytes:12,startSample:capture.startSample,durationSamples:capture.durationSamples,purpose:"private-review",publicConsent:false};
    await bindings.bindIntent(actor,accepted.captureId,accepted.captureHash,intent);
    await bindings.bindIntent(actor,accepted.captureId,accepted.captureHash,intent);
    const song:PublishedMediaSong={communityId:capture.communityId,songKey:capture.songKey,songRevision:capture.songRevision,audioSha256:capture.audioSha256.slice(2),durationSamples:capture.songDurationSamples,title:"Canonical fixture"};
    const record:MediaRecord={...song,version:"pirate.community-media/1",id:crypto.randomUUID(),requestId:intent.requestId,revision:1,state:"ready",purpose:"private-review",publicConsent:false,accountId:actor.accountId,recordingSha256:intent.recordingSha256,sourceBytes:intent.bytes,startSample:intent.startSample,durationSamples:intent.durationSamples,mediaPolicyVersion:capture.mediaPolicyVersion,createdAt:now,uploadExpiresAt:now+60000,expiresAt:now+60000,attempts:0};
    const repository=new MediaRepository(f.usedDb,capture.communityId);
    const saved=await repository.reserve(record,undefined,await bindings.reservation(actor,intent,song));
    assert.equal((await repository.reserve({...record,id:crypto.randomUUID()},undefined,await bindings.reservation(actor,intent,song))).id,saved.id);
    const reloaded=new DanceSource3Bindings({db:f.db,communityId:f.config.communityId,privateV2:{current:(actor,c)=>f.catalogue.mediaAccess(actor,c)}});
    assert.equal(await reloaded.preview(actor,saved),true);
    await assert.rejects(reloaded.bindIntent(actor,capture.captureId,capture.captureHash,{...intent,recordingSha256:"b".repeat(64)}),/original_conflict/);
    await assert.rejects(reloaded.preview({accountId:"other"},saved));
    await f.usedDb.prepare("DELETE FROM credential_bindings WHERE binding_id=?").bind(f.actor.bindingId).run();
    await assert.rejects(reloaded.preview(actor,saved));
    assert.equal(await f.usedDb.prepare("SELECT count(*) AS n FROM community_media").first("n"),1);
    assert.equal(await f.usedDb.prepare("SELECT count(*) AS n FROM dance_source3_requests").first("n"),1);
  } finally {await f.engine?.dispose();f.close();}
});

test("normal private Dance HTTP reserves and reloads capture with exact plain session and no V4 fallback",async()=>{
  const f=await privateCatalogueFixture();let http:Awaited<ReturnType<typeof loopback>>|undefined;
  try {
    const token="f1".repeat(32),csrf="private-dance-http-csrf",context={communityId:f.config.communityId,origin:f.config.app.origin};
    await f.usedDb.prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)").bind(hashText(token),context.communityId,context.origin,f.actor.accountId,f.actor.bindingId,csrf,Date.now()+600000).run();
    http=await loopback(async request=>{
      try {return await danceCommunityApi(request,{db:f.db,privateV2:f.catalogue},context,new Headers())??new Response("not_found",{status:404});}
      catch(e){return Response.json({error:e instanceof CommunityError?e.code:"unknown"},{status:e instanceof CommunityError?e.status:503});}
    },context.origin);
    const headers={cookie:"__Host-community_session="+token,origin:context.origin,"x-csrf-token":csrf,"x-dance-account":f.actor.accountId,"content-type":"application/json"};
    const body={version:"pirate.dance-capture-request/2",commandId:"private-normal-http",target:f.target,publication:{kind:"private"},consent:{accepted:true,version:f.policy.consent.version,termsHash:f.policy.consent.termsHash,publicityPolicyHash:f.policy.consent.publicityPolicyHash}};
    const captureResponse=await fetch(http.origin+"/api/dance/captures",{method:"POST",headers,body:JSON.stringify(body)});
    assert.equal(captureResponse.status,200,await captureResponse.clone().text());
    const capture=await captureResponse.json() as import("../packages/dance/capture-v2.ts").PrivateCaptureV2;
    assert.equal(capture.version,"pirate.dance/2");assert.equal(capture.publication.kind,"private");assert.ok(capture.consent);
    assert.match(capture.captureId,/^0x[0-9a-f]{64}$/);assert.notEqual(capture.captureId,dh(0));
    const retry=await fetch(http.origin+"/api/dance/captures",{method:"POST",headers,body:JSON.stringify(body)});
    assert.equal(retry.status,200);assert.deepEqual(await retry.json(),capture);
    const reloaded=await fetch(http.origin+"/api/dance/captures/"+capture.captureId+"/access",{headers});
    assert.equal(reloaded.status,200);assert.deepEqual((await reloaded.json() as {capture:unknown}).capture,capture);
    const guide=await fetch(http.origin+"/api/dance/captures/"+capture.captureId+"/guide",{headers});
    assert.equal(guide.status,200);assert.equal((await guide.json() as {playback_url:string}).playback_url,context.origin+"/api/public/posts/"+f.post.postId+"/audio");
    const other=await fetch(http.origin+"/api/dance/captures",{method:"POST",headers,body:JSON.stringify({...body,target:{...body.target,songRevision:2}})});
    assert.equal(other.status,409);assert.equal(await f.usedDb.prepare("SELECT count(*) AS n FROM dance_captures").first("n"),1);
    const forbidden=await fetch(http.origin+"/api/dance/captures",{method:"POST",headers:{...headers,"x-csrf-token":"changed"},body:JSON.stringify({...body,commandId:"must-not-start"})});
    assert.equal(forbidden.status,403);
  }finally{await http?.close();await f.engine?.dispose();f.close();}
});

test("normal private Dance HTTP uses existing media upload, queued renderer and private R2 playback",async()=>{
  const f=await privateCatalogueFixture();let http:Awaited<ReturnType<typeof loopback>>|undefined;
  const storage=new Miniflare({modules:true,script:"export default {fetch(){return new Response('R2 fixture')}}",compatibilityDate:"2026-08-06",r2Buckets:["MEDIA"]});
  try {
    await f.usedDb.batch(readFileSync(new URL("../packages/community-media/schema.sql",import.meta.url),"utf8").replace(/--[^\n]*/g,"").split(";").filter(s=>s.trim()).map(s=>f.usedDb.prepare(s)));
    await f.usedDb.batch(DANCE_SOURCE3_BINDINGS_SCHEMA_PROPOSAL.split(/;\n/).map(s=>s.trim()).filter(Boolean).map(s=>f.usedDb.prepare(s)));
    const token="f2".repeat(32),csrf="private-upload-csrf",context={communityId:f.config.communityId,origin:f.config.app.origin};
    await f.usedDb.prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)").bind(hashText(token),context.communityId,context.origin,f.actor.accountId,f.actor.bindingId,csrf,Date.now()+600000).run();
    const source=new TextEncoder().encode("explicit recording/renderer transport fixture, not device or codec acceptance"),hash=hashText(new TextDecoder().decode(source)).slice(2);
    const jobs:import("../services/community-private-dance.ts").PrivateMediaJob[]=[];
    let mounted:ReturnType<typeof createPrivatePracticeDance>;
    const renderer={fetch:async(url:string|Request,init?:RequestInit)=>communityMediaRender(new Request(url,{...init,duplex:"half"} as RequestInit),{
      render:async()=>({bytes:source,facts:{sha256:hash,bytes:source.length,durationMs:f.selected.durationSamples/48,width:320,height:240,videoCodec:"h264",audioCodec:"aac"}}),
    },{authorize:async()=>true,current:async(_community,id)=>mounted.media.ports.repository.get(id),song:async(_community,key,revision)=>mounted.media.ports.song(key,revision),now:Date.now})} as Pick<Fetcher,"fetch">;
    mounted=createPrivatePracticeDance({db:f.db,bucket:await storage.getR2Bucket("MEDIA") as unknown as R2Bucket,config:f.config,reads:{client:f.client,profile:{address:f.source.pin.posts,runtimeCodeHash:f.source.pin.postsRuntimeHash,deploymentBlock:1n}},policy:f.policy,renderer,enqueue:async job=>{jobs.push(job);}});
    http=await loopback(async request=>{try{return await mounted.fetch(request,context,new Headers())??new Response("not_found",{status:404});}catch(e){return Response.json({error:e instanceof CommunityError?e.code:"unknown"},{status:e instanceof CommunityError?e.status:503});}},context.origin);
    const headers={cookie:"__Host-community_session="+token,origin:context.origin,"x-csrf-token":csrf,"x-dance-account":f.actor.accountId,"content-type":"application/json"};
    const r=await fetch(http.origin+"/api/dance/captures",{method:"POST",headers,body:JSON.stringify({version:"pirate.dance-capture-request/2",commandId:"private-upload-normal",target:f.target,publication:{kind:"private"},consent:{accepted:true,version:f.policy.consent.version,termsHash:f.policy.consent.termsHash,publicityPolicyHash:f.policy.consent.publicityPolicyHash}})});
    assert.equal(r.status,200,await r.clone().text());const capture=await r.json() as import("../packages/dance/capture-v2.ts").PrivateCaptureV2;
    const intent={requestId:"normal-recording-original",songKey:capture.songKey,songRevision:capture.songRevision,recordingSha256:hash,bytes:source.length,startSample:capture.startSample,durationSamples:capture.durationSamples,purpose:"private-review",publicConsent:false};
    const reserveHeaders={...headers,"x-dance-capture-id":capture.captureId,"x-dance-capture-hash":capture.captureHash};
    const reserved=await fetch(http.origin+"/api/media",{method:"POST",headers:reserveHeaders,body:JSON.stringify(intent)});
    assert.equal(reserved.status,201,await reserved.clone().text());const media=await reserved.json() as MediaRecord;
    const duplicate=await fetch(http.origin+"/api/media",{method:"POST",headers:reserveHeaders,body:JSON.stringify(intent)});assert.equal(duplicate.status,201);assert.equal((await duplicate.json() as MediaRecord).id,media.id);
    const upload=await fetch(http.origin+"/api/media/"+media.id+"/upload",{method:"PUT",headers:{...headers,"content-type":"application/octet-stream"},body:source});assert.equal(upload.status,200,await upload.clone().text());
    assert.equal(jobs.length,1);await mounted.process(jobs[0]);
    const record=await mounted.media.ports.repository.get(media.id);assert.equal(record.state,"ready",record.error);
    const playback=await fetch(http.origin+"/api/media/"+media.id+"/playback",{headers});assert.equal(playback.status,200);assert.deepEqual(new Uint8Array(await playback.arrayBuffer()),source);
    const anonymous=await fetch(http.origin+"/api/media/"+media.id+"/playback");assert.equal(anonymous.status,401);
    assert.deepEqual((await mounted.media.feed()).items,[]);
    const deletion=await fetch(http.origin+"/api/media/"+media.id,{method:"DELETE",headers});assert.equal(deletion.status,200);
    const denied=await fetch(http.origin+"/api/media/"+media.id+"/playback",{headers});assert.equal(denied.status,410);assert.deepEqual(await denied.json(),{error:"media_unavailable"});
    assert.equal(await f.usedDb.prepare("SELECT count(*) AS n FROM dance_source3_requests").first("n"),1);
    assert.equal(await f.usedDb.prepare("SELECT count(*) AS n FROM community_media").first("n"),1);
  }finally{await http?.close();await storage.dispose();await f.engine?.dispose();f.close();}
});
