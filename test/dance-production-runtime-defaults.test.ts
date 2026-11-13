/** PREPARED, UNRUN. Constructor simulations plus existing native Worker
 * harness for actual HTTP/queue/scheduled dispatch. Root owns execution slot.
 * This is not real MOSS, canonical chain, renderer or release acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { PublicClient, Address, Hex } from "viem";
import { hashJson, insist } from "../packages/community/common.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { danceSourceHash } from "../packages/dance-chain/wire.ts";
import { createDanceProductionDefaults, type DanceProductionRuntimeInputs, type DanceVerifiedHostInputs } from "../services/dance-production-defaults.ts";
import { requireDanceProductionSelection } from "../services/dance-production.ts";
import { CommunityPrivateDance, type CommunityQueueJob } from "../services/community-private-dance.ts";
import { communityFetch, communityPrivateDanceDefaults, communityQueue, communityScheduled,
  type CommunityDependencies, type CommunityEnv } from "../services/community-application.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { communityRuntime } from "./community-runtime.ts";
import { MemorySqliteD1 } from "./dance-sqlite-fixture.ts";

const config = validateConfig(JSON.parse(readFileSync(new URL(
  "../docs/deployments/first-song-managed-20261105.configuration.json", import.meta.url), "utf8")).configuration);
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
function selection() {
  // Explicit simulation source. No deployment or live readiness is asserted.
  const domain = { chainId: 6343n, verifier: address(1), communityId: config.communityId };
  const pin = { directory: config.directory, directoryRuntimeHash: word(10), v4: config.learningRecords!,
    v4RuntimeHash: word(11), posts: config.postsContract, postsRuntimeHash: word(12),
    fixedPublisher: config.publisher, publicityPolicyHash: word(13), rulesSha256: word(14),
    termsSha256: word(15), rubricSha256: word(16), mediaPolicySha256: word(17),
    runtimeCodeHash: word(18), deploymentBlock: 1n };
  const source: DanceCanonicalSource = { schema: "pirate.dance-verdict/1", domain, pin,
    sourceHash: danceSourceHash(domain, pin), capturePolicy: address(2), capturePolicyRuntimeHash: word(19) };
  const json = { ...source, domain: { ...domain, chainId: 6343 }, pin: { ...pin, deploymentBlock: "1" } };
  return { source, selectionJson: JSON.stringify(json), selectionHash: hashJson(json),
    reviewerConsent: { version: "explicit-constructor-simulation/1", publicityPolicyHash: pin.publicityPolicyHash,
      admission: "admitted" as const } };
}
const unavailable = async (): Promise<never> => { throw Error("required actual producer unavailable in constructor simulation"); };
function heldHost(): DanceVerifiedHostInputs {
  return { accounts: unavailable, song: unavailable,
    catalogue: { songKeyForPost() { throw Error("required actual mapping unavailable"); },
      list: unavailable, select: unavailable, rules: unavailable, songPostId: unavailable,
      guide: unavailable, reference: unavailable } };
}

test("selected source/config/reviewer consent are required; no policy or community fallback", () => {
  const selected = selection();
  assert.equal(requireDanceProductionSelection({ ...selected, config }).sourceHash, selected.source.sourceHash);
  assert.throws(() => requireDanceProductionSelection({ ...selected,
    config: { ...config, communityId: word(999) } }), /configuration_changed/);
  assert.throws(() => requireDanceProductionSelection({ ...selected,
    reviewerConsent: { ...selected.reviewerConsent, admission: "review_pending" }, config }), /consent_admission_held/);
  assert.throws(() => requireDanceProductionSelection({ ...selected,
    reviewerConsent: { ...selected.reviewerConsent, publicityPolicyHash: word(999) }, config }), /consent_admission_held/);
  assert.throws(() => requireDanceProductionSelection({ ...selected, selectionHash: word(999), config }), /selection_changed/);
});

test("actual factory constructs once from explicit host ports, then generation loss holds every entry before work", async t => {
  const db = new MemorySqliteD1(); t.after(() => db.close());
  const selected = selection(); let current = true, hosts = 0, renders = 0, sends = 0;
  const inputs: DanceProductionRuntimeInputs = { ...selected,
    client: {} as PublicClient,
    renderer: { async fetch() { renders++; throw Error("renderer must not execute"); } },
    async current() { insist(current, "simulated_admission_generation_changed", 503); },
    async host() { hosts++; return heldHost(); } };
  const make = createDanceProductionDefaults({ db: db.asD1(), bucket: {} as R2Bucket,
    selected: inputs, async enqueue() { sends++; } });
  const runtime = await make(config);
  assert.ok(runtime instanceof CommunityPrivateDance);
  assert.equal(hosts, 1);
  assert.equal(runtime.source3?.communityId, config.communityId);
  current = false;
  await assert.rejects(runtime.fetch(new Request(firstSong.origin + "/api/media"),
    { communityId: config.communityId, origin: firstSong.origin }, new Headers()), /generation_changed/);
  await assert.rejects(runtime.process({ kind: "community-media/1", communityId: config.communityId,
    mediaId: "00000000-0000-4000-8000-000000000001" }), /generation_changed/);
  await assert.rejects(runtime.tick(), /generation_changed/);
  assert.equal(renders, 0); assert.equal(sends, 0);
  assert.equal(db.executed.length, 0);
});

test("missing host, consent or changed config during intake refuses construction before any renderer/queue work", async t => {
  const db = new MemorySqliteD1(); t.after(() => db.close());
  const selected = selection();
  const inputs: DanceProductionRuntimeInputs = { ...selected, client: {} as PublicClient,
    renderer: { fetch: unavailable }, current: async () => { throw Error("actual intake not supplied"); }, host: unavailable };
  const base = { db: db.asD1(), bucket: {} as R2Bucket, enqueue: unavailable };
  await assert.rejects(createDanceProductionDefaults(base)(config), /inputs_unavailable/);
  await assert.rejects(createDanceProductionDefaults({ ...base, selected: inputs })(config), /actual intake not supplied/);
  const mutable = structuredClone(config);
  const changed = { ...inputs, current: async () => { mutable.configurationRevision++; }, host: async () => heldHost() };
  await assert.rejects(createDanceProductionDefaults({ ...base, selected: changed })(mutable), /configuration_changed/);
  await assert.rejects(createDanceProductionDefaults({ ...base, selected: { ...inputs,
    current: async () => { /* explicit simulated current admission for missing-host refusal */ },
    host: undefined as unknown as DanceProductionRuntimeInputs["host"] } })(config), /inputs_unavailable/);
});

test("actual HTTP/queue/scheduled dispatch the same default factory and retain refusal/retry without provider activity", async t => {
  const native = await communityRuntime(); t.after(() => native.dispose());
  let sends = 0, calls = 0;
  const env = { DB: native.db, MEDIA: native.media, JOBS: { async send() { sends++; } },
    ASSETS: { fetch: unavailable } } as unknown as CommunityEnv;
  const factory = communityPrivateDanceDefaults(env);
  const ports: CommunityDependencies = { configuration: async () => config,
    verifyLogin: async () => false, creatorHealth: async () => false,
    privateDance: async c => { calls++; return factory(c); } };
  const response = await communityFetch(new Request(firstSong.origin + "/api/dance/catalogue"), env, ports);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "dance_production_inputs_unavailable" });
  let acks = 0, retries = 0;
  const message = { body: { kind: "community-media/1", communityId: config.communityId,
    mediaId: "00000000-0000-4000-8000-000000000001" },
    ack() { acks++; }, retry() { retries++; } } as unknown as Message<CommunityQueueJob>;
  await communityQueue({ messages: [message] }, env, ports);
  assert.equal(acks, 0); assert.equal(retries, 1);
  await assert.rejects(communityScheduled(env, ports), error => error instanceof AggregateError &&
    error.errors.some(e => e instanceof Error && e.message === "dance_production_inputs_unavailable"));
  assert.equal(calls, 3); assert.equal(sends, 0);
});

// Media2 regression fixture: actual writer, original canonical helpers, IPFS
// digest/CID verification and actual SQLite statements. RPC, audio decoder and
// resource facts are explicit local simulations adapted from cleared Host v3
// dance-production-host-inputs.test.ts; none establishes a real producer.
import { canonical, hashText } from "../packages/community/common.ts";
import { encodeAbiParameters, encodeEventTopics, keccak256 } from "viem";
import { DANCE_PRIVATE_MEDIA_POLICY, type DanceFence } from "../packages/dance/contracts.ts";
import { DANCE_HOST_INPUTS_SCHEMA_PROPOSAL } from "../services/dance-account-facts-store.ts";
import { DanceHostProjectionWriter, type DanceProjectionProducers } from "../services/dance-host-projections.ts";
import { createDanceRealHostInputs } from "../services/dance-production.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { validatePost } from "../packages/community/post-manifest.ts";
import { postsAbi } from "../packages/community/post-chain.ts";
import { songKeyOf } from "../packages/protocol/records.ts";
import { UNREGISTERED_OWNER_POLICY_VERSION, UNREGISTERED_OWNER_POLICY_HASH } from "../packages/community/owner-policy.ts";
import type { DanceSelectedSong } from "../services/dance-selected-catalogue.ts";
import { danceAccountCommitment } from "../packages/dance-chain/wire.ts";
function media2Pause() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
}
async function projectionSimulation(t: { after(fn: () => void): void }) {
  const db = new MemorySqliteD1(); t.after(() => db.close());
  db.sqlite.exec("CREATE TABLE setup_schema(version INTEGER)");
  db.sqlite.exec(readFileSync(new URL("../apps/community-wizard/infra/migrations/0002_first_song.sql", import.meta.url), "utf8"));
  db.sqlite.exec(readFileSync(new URL("../packages/dance/schema.sql", import.meta.url), "utf8"));
  db.sqlite.exec(DANCE_HOST_INPUTS_SCHEMA_PROPOSAL);
  db.sqlite.exec("CREATE TABLE media2_producer_generation(revision INTEGER); INSERT INTO media2_producer_generation VALUES(1)");
  const cfg = structuredClone(config); cfg.app.origin = "https://community.invalid";
  cfg.feed.endpoint = cfg.app.origin + "/feed";
  cfg.policies.admission = { version: UNREGISTERED_OWNER_POLICY_VERSION, sha256: UNREGISTERED_OWNER_POLICY_HASH };
  const source = selection().source, code = "0x6000" as Hex, codeHash = keccak256(code);
  source.pin = { ...source.pin, directoryRuntimeHash: codeHash, v4RuntimeHash: codeHash,
    postsRuntimeHash: codeHash, runtimeCodeHash: codeHash };
  source.capturePolicyRuntimeHash = codeHash;
  const policy = { captureTtlMs: 600000, rulesDocument: "fixture rules", rubricText: "fixture categorical inspection",
    mediaPolicyDocument: canonical(DANCE_PRIVATE_MEDIA_POLICY), consent: { version: "fixture-consent",
      termsHash: hashText("fixture private consent"), publicityPolicyHash: source.pin.publicityPolicyHash,
      text: "fixture private consent", admission: "admitted" as const } };
  source.pin = { ...source.pin, rulesSha256: hashText(policy.rulesDocument), rubricSha256: hashText(policy.rubricText),
    termsSha256: policy.consent.termsHash, mediaPolicySha256: hashText(policy.mediaPolicyDocument) };
  source.sourceHash = danceSourceHash(source.domain, source.pin);
  const privateId = "owner_private_fixture", wallet = address(50), now = Math.floor(Date.now() / 1000);
  db.sqlite.prepare("INSERT INTO application_identity VALUES(1,?,?)").run(cfg.communityId, cfg.app.origin);
  db.sqlite.prepare("INSERT INTO public_configurations VALUES(?,1,?,?,?,?,?,?,?)")
    .run(cfg.communityId, cfg.publisher, "fixture-config-uri", hashJson(cfg), canonical(cfg), "90", word(88), word(89));
  // Retain the real config revision selected by the fixture, rather than
  // inventing a production revision. The actual table has a revision key.
  if (cfg.configurationRevision !== 1) db.sqlite.prepare("UPDATE public_configurations SET revision=?")
    .run(cfg.configurationRevision);
  db.sqlite.prepare("INSERT INTO community_accounts VALUES(?,?,?)").run(privateId, word(100), Date.now());
  db.sqlite.prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)")
    .run("binding_fixture", privateId, wallet, Date.now());
  const audioBytes = new TextEncoder().encode("explicit local canonical audio bytes");
  const audio = await preparePin(audioBytes, "audio/mpeg");
  const post = validatePost({ schema: "pirate.community-post/3", chainId: 6343, postsContract: source.pin.posts,
    communityId: source.domain.communityId, postId: word(400), authorId: word(401), kind: "song", revision: 1,
    configurationRevision: cfg.configurationRevision, publishedAt: Date.now(), title: "Fixture dance", language: "und", rating: "general",
    media: [{ role: "audio", ...audio }], admission: { policyVersion: UNREGISTERED_OWNER_POLICY_VERSION,
      policySha256: UNREGISTERED_OWNER_POLICY_HASH, decision: "publish", rating: "general", coverDisplayed: false,
      evidenceSha256: word(402), automatedContent: "deferred", declarationSource: "operator_declared" },
    registration: { status: "absent", reason: "deferred_for_launch" } });
  const manifest = await preparePin(new TextEncoder().encode(canonical(post)), "application/json");
  const key = songKeyOf({ chainId: 6343, communityId: source.domain.communityId, posts: source.pin.posts, postId: post.postId });
  db.sqlite.prepare("INSERT INTO public_post_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)")
    .run(cfg.communityId, post.postId, 1, post.authorId, cfg.configurationRevision,
      manifest.uri, manifest.sha256, canonical(post), "100", word(500), word(501), 0);
  const selected: DanceSelectedSong = { version: "pirate.dance-selected-song/1", postId: post.postId,
    songRevision: 1, manifestSha256: manifest.sha256, audioSha256: audio.sha256, songDurationSamples: 4800000,
    probeEvidenceSha256: word(999), startSample: 48000, durationSamples: 480000,
    reference: null, offerProgramId: null, offer: null };
  const hooks: { publication?: () => Promise<void>; download?: () => Promise<void>;
    probe?: () => Promise<void>; selection?: (s: DanceSelectedSong) => Promise<void>;
    admission?: () => void } = {};
  const safe = { number: 100n, hash: word(500), timestamp: BigInt(now), transactions: [] };
  const log = { address: source.pin.posts, blockNumber: 100n, blockHash: word(500), transactionHash: word(501),
    logIndex: 0, transactionIndex: 0, removed: false,
    topics: encodeEventTopics({ abi: postsAbi, eventName: "PostRevisionPublished",
      args: { communityId: cfg.communityId, postId: post.postId, authorId: post.authorId } }),
    data: encodeAbiParameters([{ type: "uint8" }, { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }, { type: "string" }],
      [0, 1n, BigInt(cfg.configurationRevision), manifest.sha256, manifest.uri]) };
  const client = { getChainId: async () => 6343, getBlockNumber: async () => 101n,
    getCode: async () => code, getBlock: async () => safe,
    getTransactionReceipt: async () => { await hooks.publication?.();
      return { status: "success", transactionHash: word(501), blockHash: word(500), blockNumber: 100n, logs: [log] }; },
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      switch (functionName) {
        case "directory": return cfg.directory;
        case "getPost": assert.equal(args?.[1], post.postId); return { authorId: post.authorId, kind: 0,
          revision: 1n, configurationRevision: BigInt(cfg.configurationRevision), manifestSha256: manifest.sha256, manifestURI: manifest.uri };
        case "sourceHash": return source.sourceHash;
        case "communityId": return cfg.communityId;
        case "VERSION": return 1;
        case "capturePolicy": return source.capturePolicy;
        case "capturePolicyRuntimeHash": return source.capturePolicyRuntimeHash;
        case "getCommunity": return { registry: cfg.registry, configurationRevision: BigInt(cfg.configurationRevision),
          configuration: { operatorPayments: cfg.operatorPayments, controller: cfg.controller,
            publisher: cfg.publisher, learningRecords: cfg.learningRecords } };
        case "ownerContext": return [7n, BigInt(cfg.configurationRevision), cfg.controller, wallet, BigInt(now - 60), BigInt(now + 86400)];
        case "rulesEpoch": return 0n;
        case "reviewerRoles": return [0n, 0n, 0n, false];
        case "identities": assert.equal(args?.[0], danceAccountCommitment(source.domain, privateId, wallet));
          return [wallet, 3n, word(600), 2n, true];
        case "groups": return [2n, 1n, 0n, 0n, true];
        default: throw Error("unsupported explicit projection simulation read " + functionName);
      }
    } } as unknown as PublicClient;
  const guard: DanceFence = { sql: "EXISTS(SELECT 1 FROM media2_producer_generation WHERE revision=?)", values: [1] };
  const measured = { sampleRate: 48000 as const, samples: 4800000, receiptBytes: "explicit decoder simulation receipt" };
  let owners = 0;
  const producers: DanceProjectionProducers = {
    async admission() { hooks.admission?.(); return [structuredClone(guard)]; },
    async owner() { owners++; return { accountId: privateId, bindingId: "binding_fixture", assignmentId: "assignment_fresh", fences: [structuredClone(guard)] }; },
    async aliases() { throw Error("real aliases unavailable in this bounded fixture"); },
    async mediaEpoch() { return { epoch: 4, fences: [structuredClone(guard)] }; },
    async selection(s) { await hooks.selection?.(s); return [structuredClone(guard)]; },
    async probe(bytes) { assert.deepEqual(bytes, audioBytes); await hooks.probe?.(); return measured; },
  };
  const reads = { client, profile: { address: source.pin.posts, runtimeCodeHash: codeHash, deploymentBlock: 1n },
    transport: async () => { await hooks.download?.(); return new Response(audioBytes.slice()); } };
  const writer = new DanceHostProjectionWriter({ db: db.asD1(), source, config: cfg, client, reads, producers });
  return { db, source, config: cfg, writer, reads, client, producers, guard, policy, selected, key,
    hooks, measured, privateId, wallet, owners: () => owners };
}

test("Media2 rejects a malicious full context instead of spreading stale owner/source/epoch into verified facts", async t => {
  const f = await projectionSimulation(t);
  const malicious = { ...f.policy, version: "pirate.dance-host-context/1", sourceHash: word(999),
    configurationRevision: 99, ownerEpoch: 99, rulesEpoch: 99, mediaEpoch: 99,
    owner: { accountId: "obsolete_private_owner", wallet: address(99), assignmentId: "obsolete", validFromMs: 1, expiresAtMs: 2 } };
  await assert.rejects(f.writer.context(null, malicious, f.guard), /invalid_fields/);
  assert.equal(f.owners(), 0); assert.equal(f.db.count("dance_host_context"), 0);
  await f.writer.context(null, structuredClone(f.policy), f.guard);
  const saved = JSON.parse(String(f.db.sqlite.prepare("SELECT body_json FROM dance_host_context").get()!.body_json));
  assert.equal(saved.sourceHash, f.source.sourceHash); assert.equal(saved.owner.accountId, f.privateId);
  assert.equal(saved.ownerEpoch, 7); assert.equal(saved.mediaEpoch, 4);
});

test("Media2 snapshots permitted nested policy fields before owner/binding awaits", async t => {
  const f = await projectionSimulation(t), policy = structuredClone(f.policy), original = structuredClone(policy), pause = media2Pause();
  f.db.beforeRead = async sql => {
    if (!sql.includes("SELECT b.subject")) return;
    f.db.beforeRead = null; await pause.wait();
  };
  const pending = f.writer.context(null, policy, f.guard);
  await pause.entered;
  policy.captureTtlMs = 1; policy.consent.text = "changed consent"; policy.consent.termsHash = word(999);
  policy.rulesDocument = "changed rules"; pause.release(); await pending;
  const saved = JSON.parse(String(f.db.sqlite.prepare("SELECT body_json FROM dance_host_context").get()!.body_json));
  assert.equal(saved.captureTtlMs, original.captureTtlMs); assert.deepEqual(saved.consent, original.consent);
  assert.equal(saved.rulesDocument, original.rulesDocument); assert.equal(saved.owner.accountId, f.privateId);
});

for (const stage of ["publication", "download", "probe"] as const)
  test(`Media2 snapshots canonical post/audio identity before ${stage} await`, async t => {
    const f = await projectionSimulation(t), original = structuredClone(f.selected), input = structuredClone(original), pause = media2Pause();
    f.hooks[stage] = pause.wait;
    const pending = f.writer.audioProbe(input);
    await pause.entered;
    input.postId = word(998); input.songRevision = 77; input.manifestSha256 = word(997); input.audioSha256 = word(996);
    pause.release(); const result = await pending;
    const row = f.db.sqlite.prepare("SELECT audio_sha256,samples,receipt_bytes FROM dance_host_audio_probes").get()!;
    assert.equal(row.audio_sha256, original.audioSha256);
    assert.equal(row.samples, 4800000); assert.equal(result.samples, 4800000);
    assert.equal(JSON.parse(String(row.receipt_bytes)).audioSha256, original.audioSha256);
    assert.equal(f.db.count("dance_host_audio_probes"), 1);
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM dance_host_audio_probes WHERE audio_sha256=?").get(input.audioSha256)!.n, 0);
  });

test("Media2 snapshots returned measurement and deep selection before callbacks can mutate their objects", async t => {
  const f = await projectionSimulation(t);
  f.hooks.admission = () => { f.measured.samples = 123; };
  const probe = await f.writer.audioProbe(f.selected);
  assert.equal(probe.samples, 4800000);
  const probed = f.db.sqlite.prepare("SELECT samples,receipt_bytes FROM dance_host_audio_probes").get()!;
  assert.equal(probed.samples, JSON.parse(String(probed.receipt_bytes)).samples);
  f.hooks.admission = undefined;
  const input = { ...structuredClone(f.selected), probeEvidenceSha256: probe.evidenceSha256,
    reference: { id: word(610), revision: 2, epoch: 3, segmentId: word(611), segmentLayoutSha256: word(612), resourceId: "resource_original" } };
  const original = structuredClone(input), pause = media2Pause();
  f.hooks.selection = async received => {
    assert.notEqual(received, input); assert.notEqual(received.reference, input.reference);
    received.postId = word(900); received.reference!.resourceId = "callback_changed_resource";
    await pause.wait();
  };
  const pending = f.writer.selection(input, null, f.guard);
  await pause.entered; input.postId = word(901); input.audioSha256 = word(902);
  input.reference.resourceId = "caller_changed_resource"; input.reference.revision = 99;
  pause.release(); await pending;
  const mapped = f.db.sqlite.prepare("SELECT song_key,post_id FROM dance_host_song_keys").get()!;
  assert.equal(mapped.song_key, f.key); assert.equal(mapped.post_id, original.postId);
  const saved = JSON.parse(String(f.db.sqlite.prepare("SELECT body_json FROM dance_host_selections").get()!.body_json));
  assert.deepEqual(saved, original); assert.equal(f.db.count("dance_host_song_keys"), 1);
});

test("Media2 concurrent matching bytes plus failed accepting fence remain held without deleting the committed row", async t => {
  const f = await projectionSimulation(t);
  f.db.beforeBatch = statements => {
    const insert = statements.find(s => s.sql.startsWith("INSERT INTO dance_host_context"))!;
    assert.ok(insert);
    f.db.sqlite.prepare("INSERT INTO dance_host_context VALUES(?,1,?)").run(f.config.communityId, String(insert.values[1]));
    f.db.sqlite.exec("UPDATE media2_producer_generation SET revision=2");
  };
  await assert.rejects(f.writer.context(null, f.policy, f.guard), /dance_fence_changed/);
  assert.equal(f.db.count("dance_host_context"), 1);
  const row = f.db.sqlite.prepare("SELECT revision,body_json FROM dance_host_context").get()!;
  assert.equal(row.revision, 1); assert.equal(JSON.parse(String(row.body_json)).owner.accountId, f.privateId);
});

test("Media2 valid committed lost ACK reconciles only after captured fences pass, with no reseed/new revision", async t => {
  const f = await projectionSimulation(t);
  f.db.afterBatch = () => { throw Error("simulated valid commit acknowledgement lost"); };
  const revision = await f.writer.context(null, f.policy, f.guard);
  assert.equal(revision, 1); assert.equal(f.db.count("dance_host_context"), 1);
  assert.equal(await f.writer.context(null, f.policy, f.guard), 1);
  assert.equal(f.db.count("dance_host_context"), 1);
  const acceptingGuards = f.db.executed.filter(sql => sql.startsWith("INSERT INTO dance_transaction_guards SELECT"));
  assert.ok(acceptingGuards.length >= 2); // Observes actual post-commit reassertion statements when Root runs this case.
});

test("Media2 Host v3 composition returns song from the same actual writer/resources and refuses a different writer", async t => {
  const f = await projectionSimulation(t), other = await projectionSimulation(t);
  const input = { db: f.writer.input.db, source: f.source, config: f.config, client: f.client, reads: f.reads,
    referenceAccess: unavailable, reviewerConsent: { version: "fixture-consent", admission: "admitted" as const,
      publicityPolicyHash: f.source.pin.publicityPolicyHash }, writer: f.writer };
  assert.throws(() => createDanceRealHostInputs({ ...input, writer: other.writer }), /writer_resources_changed/);
  const host = createDanceRealHostInputs(input);
  await f.writer.selection({ ...f.selected, probeEvidenceSha256: (await f.writer.audioProbe(f.selected)).evidenceSha256 }, null, f.guard);
  const song = await host.song(f.key, f.selected.songRevision);
  assert.equal(song.communityId, f.config.communityId); assert.equal(song.songKey, f.key);
  assert.equal(song.audioSha256, f.selected.audioSha256.slice(2)); assert.equal(song.durationSamples, 4800000);
});

test("Media2 hash-only configured selection refuses scheduled through the same factory as HTTP/queue", async t => {
  const native = await communityRuntime(); t.after(() => native.dispose());
  let sends = 0, configurations = 0;
  const env = { DB: native.db, MEDIA: native.media, JOBS: { async send() { sends++; } },
    DANCE_REWARD_SOURCE_SELECTION_HASH: word(99) } as unknown as CommunityEnv;
  const ports: CommunityDependencies = { configuration: async () => { configurations++; return config; },
    verifyLogin: async () => false, creatorHealth: async () => false };
  await assert.rejects(communityScheduled(env, ports), error => error instanceof AggregateError &&
    error.errors.some(e => e instanceof Error && e.message === "dance_production_inputs_unavailable"));
  assert.equal(configurations, 1); // Proves the selected branch was entered without provided.privateDance.
  const factory = communityPrivateDanceDefaults(env);
  await assert.rejects(factory(config), /source_selection_changed/);
  let calls = 0, retries = 0;
  ports.privateDance = async c => { calls++; return factory(c); };
  const response = await communityFetch(new Request(firstSong.origin + "/api/dance/catalogue"), env, ports);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "dance_production_source_selection_changed" });
  await communityQueue({ messages: [{ body: { kind: "community-media/1", communityId: config.communityId,
    mediaId: "00000000-0000-4000-8000-000000000001" }, ack() { throw Error("must not ACK a refusal"); },
    retry() { retries++; } } as unknown as Message<CommunityQueueJob>] }, env, ports);
  await assert.rejects(communityScheduled(env, ports), error => error instanceof AggregateError &&
    error.errors.some(e => e instanceof Error && e.message === "dance_production_source_selection_changed"));
  assert.equal(calls, 3); assert.equal(retries, 1); assert.equal(sends, 0);
});

test("Media2 ordinary unconfigured community schedules no private factory or configuration work", async t => {
  const native = await communityRuntime(); t.after(() => native.dispose());
  let configurations = 0, sends = 0;
  const env = { DB: native.db, MEDIA: native.media, JOBS: { async send() { sends++; } } } as unknown as CommunityEnv;
  const ports: CommunityDependencies = { configuration: async () => { configurations++; throw Error("no private work expected"); },
    verifyLogin: async () => false, creatorHealth: async () => false };
  await communityScheduled(env, ports);
  assert.equal(configurations, 0); assert.equal(sends, 0);
});
