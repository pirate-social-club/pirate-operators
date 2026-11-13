import { hashMessage, type Address, type PublicClient } from "viem";
import { bytes32, canonical, exact, hashJson, hashText, insist, object } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { fetchPublicIpfs } from "../packages/community/ipfs.ts";
import { indexedPublicPosts, type IndexedPost } from "../packages/community/post-index.ts";
import { postsAbi, verifiedPostsHead } from "../packages/community/post-chain.ts";
import { readSignInMessageV4 } from "../packages/protocol/learning-results-v4.ts";
import { songKeyOf } from "../packages/protocol/records.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { DANCE_PRIVATE_MEDIA_POLICY, type DanceFence } from "../packages/dance/contracts.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import { danceId, validateFence, wallet } from "../packages/dance/validation.ts";
import { observeCanonicalDanceRole } from "./dance-canonical-roles.ts";
import { capturedDanceAuthorization } from "./dance-v4-authorization.ts";
import type { PublicReadPorts } from "./community-public.ts";
// Interfaces composed against independently source-cleared Host v3. Source
// clearance is not acceptance of real producer facts or a mounted runtime.
import type { DanceHostContext, DanceAccountSelection } from "./dance-account-facts-store.ts";
import type { DanceSelectedSong } from "./dance-selected-catalogue.ts";
import { compactDanceFence } from "./dance-source3-bindings.ts";
import type { PublishedMediaSong } from "../packages/community-media/contracts.ts";

export interface DanceProjectionProducers {
  /** Current exact selected source/config/intake generation; Root admission. */
  admission(config: CommunityConfig, source: DanceCanonicalSource): Promise<DanceFence[]>;
  /** Actual private owner assignment; no wallet/public-author substitution. */
  owner(): Promise<{ accountId: string; bindingId: string; assignmentId: string; fences: DanceFence[] }>;
  /** Complete known-alias projection from the actual identity authority. */
  aliases(accountId: string): Promise<{ accountIds: string[]; fences: DanceFence[] }>;
  mediaEpoch(): Promise<{ epoch: number; fences: DanceFence[] }>;
  /** Exact selected reference/resource/revision/offer/drawing and lease guard. */
  selection(song: DanceSelectedSong): Promise<DanceFence[]>;
  /** A real measured decoder/probe. Bytes are canonical digest-verified audio.
   * No callback, no probe. A receipt hash alone is never a measured duration. */
  probe(bytes: Uint8Array): Promise<{ sampleRate: 48000; samples: number; receiptBytes: string }>;
}

const count = (n: number, min = 0) => {
  insist(Number.isSafeInteger(n) && n >= min, "dance_projection_integer_invalid", 503);
  return n;
};
const nonempty = (fences: DanceFence[]) => {
  insist(Array.isArray(fences) && fences.length > 0, "dance_projection_producer_missing", 503);
  fences.forEach(validateFence);
  return structuredClone(fences);
};
const freezeData = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
  return value;
};
type Row = { revision: number; body_json: string };

/** Writers consume actual producer facts, never bootstrap readiness rows. All
 * accepting writes repeat exact producer/CAS predicates in the SAME D1 batch.
 * Independent fences stay separate, retaining D1's <=100 binding budget. */
export class DanceHostProjectionWriter {
  readonly input: {
    db: D1Database; source: DanceCanonicalSource; config: CommunityConfig;
    client: PublicClient; reads: PublicReadPorts; producers: DanceProjectionProducers;
  };
  readonly store: DanceStore;
  constructor(input: DanceHostProjectionWriter["input"]) {
    this.input = Object.freeze({ ...input, source: freezeData(structuredClone(input.source)),
      config: freezeData(structuredClone(input.config)),
      reads: Object.freeze({ ...input.reads, profile: freezeData(structuredClone(input.reads.profile)) }),
      producers: Object.freeze({ ...input.producers }) });
    input = this.input;
    this.store = new DanceStore(input.db);
    for (const method of ["admission", "owner", "aliases", "mediaEpoch", "selection", "probe"] as const)
      insist(typeof input.producers?.[method] === "function", "dance_projection_producer_missing", 503);
    const { source: s, config: c, reads } = input;
    insist(c.communityId === s.domain.communityId && c.chainId === 6343 &&
      c.directory === s.pin.directory && c.postsContract === s.pin.posts &&
      c.learningRecords === s.pin.v4 && c.publisher === s.pin.fixedPublisher &&
      reads.profile.address === s.pin.posts && reads.profile.runtimeCodeHash === s.pin.postsRuntimeHash,
      "dance_projection_source_changed", 503);
  }
  private get community() { return this.input.config.communityId; }
  private async admission() {
    return [await this.configurationFence(), ...nonempty(await this.input.producers.admission(
      structuredClone(this.input.config), structuredClone(this.input.source)))];
  }
  private async configurationFence(): Promise<DanceFence> {
    const config = this.input.config;
    const row = await this.input.db.prepare(`SELECT manifest_json,manifest_sha256,publisher,manifest_uri,
      block_number,block_hash,transaction_hash FROM public_configurations WHERE community_id=? AND revision=?`)
      .bind(this.community, config.configurationRevision).first<{
        manifest_json: string; manifest_sha256: string; publisher: string; manifest_uri: string;
        block_number: string; block_hash: string; transaction_hash: string;
      }>();
    insist(row && canonical(JSON.parse(row.manifest_json)) === canonical(config) &&
      hashText(row.manifest_json) === row.manifest_sha256 && row.publisher === config.publisher,
      "dance_projection_configuration_missing", 503);
    return { sql: `EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision=?
      AND manifest_json=? AND manifest_sha256=? AND publisher=? AND manifest_uri=? AND block_number=?
      AND block_hash=? AND transaction_hash=?)
      AND NOT EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision>?)`,
      values: [this.community, config.configurationRevision, row.manifest_json, row.manifest_sha256,
        row.publisher, row.manifest_uri, row.block_number, row.block_hash, row.transaction_hash,
        this.community, config.configurationRevision] };
  }
  private async binding(account: string, binding: string) {
    const row = await this.input.db.prepare(`SELECT b.subject,b.created_at,a.author_id,a.created_at account_created
      FROM credential_bindings b JOIN community_accounts a ON a.account_id=b.account_id
      WHERE b.binding_id=? AND b.account_id=? AND b.namespace='moss' AND b.network=6343`)
      .bind(danceId(binding), danceId(account))
      .first<{ subject: string; created_at: number; author_id: string; account_created: number }>();
    insist(row && row.subject === wallet(row.subject), "dance_projection_private_account_missing", 403);
    bytes32(row.author_id);
    return { subject: row.subject as Address, fence: {
      sql: `EXISTS(SELECT 1 FROM credential_bindings b JOIN community_accounts a ON a.account_id=b.account_id
        WHERE b.binding_id=? AND b.account_id=? AND b.namespace='moss' AND b.network=6343
        AND b.subject=? AND b.created_at=? AND a.author_id=? AND a.created_at=?)
        AND (SELECT count(*) FROM credential_bindings WHERE namespace='moss' AND network=6343
          AND subject=? COLLATE NOCASE)=1`,
      values: [binding, account, row.subject, row.created_at, row.author_id, row.account_created, row.subject],
    } satisfies DanceFence };
  }
  private async write(table: "dance_host_context" | "dance_host_accounts" | "dance_host_selections",
    columns: string[], keys: string[], expectedRevision: number | null, body: unknown, fences: DanceFence[]) {
    // Snapshot every caller-owned value before admission or D1 can yield.
    columns = [...columns]; keys = [...keys];
    const bytes = canonical(structuredClone(body)), capturedFences = structuredClone(fences);
    fences = nonempty([...await this.admission(), ...capturedFences]).map(f => compactDanceFence([f]));
    const where = columns.map(c => c + "=?").join(" AND ");
    const read = () => this.input.db.prepare(`SELECT revision,body_json FROM ${table} WHERE ${where}`)
      .bind(...keys).first<Row>();
    const before = structuredClone(await read());
    const reassert = (saved: Row) => this.store.assert([...fences, compactDanceFence([{
      sql: `EXISTS(SELECT 1 FROM ${table} WHERE ${where} AND revision=? AND body_json=?)`,
      values: [...keys, saved.revision, bytes],
    }])]);
    if (before?.body_json === bytes) { await reassert(before); return before.revision; }
    insist((before?.revision ?? null) === expectedRevision, "dance_projection_cas_changed", 409);
    const statement = before
      ? this.input.db.prepare(`UPDATE ${table} SET revision=revision+1,body_json=? WHERE ${where} AND revision=? AND body_json=?`)
        .bind(bytes, ...keys, before.revision, before.body_json)
      : this.input.db.prepare(`INSERT INTO ${table} (${columns.join(",")},revision,body_json)
        SELECT ${columns.map(() => "?").join(",")},1,? WHERE NOT EXISTS(SELECT 1 FROM ${table} WHERE ${where})`)
        .bind(...keys, bytes, ...keys);
    let reconciled = false;
    try { await this.store.atomic(fences, [statement, this.store.changed()]); }
    catch (error) {
      const saved = structuredClone(await read());
      if (!saved || saved.body_json !== bytes) throw error;
      // Lost D1 acknowledgement: canonical exact bytes, not cleanup/reseed.
      // Matching bytes may be a concurrent writer's. They do not establish
      // that THIS admission passed. Retain them, but reassert every captured
      // fence before reporting a reconciled revision.
      reconciled = true;
    }
    const saved = structuredClone(await read());
    insist(saved && saved.body_json === bytes, "dance_projection_outcome_unknown", 503);
    if (reconciled) await reassert(saved);
    return saved.revision;
  }
  async context(expectedRevision: number | null, selected: Pick<DanceHostContext,
    "captureTtlMs" | "consent" | "rulesDocument" | "rubricText" | "mediaPolicyDocument">,
    configurationFence: DanceFence) {
    selected = structuredClone(selected);
    configurationFence = structuredClone(configurationFence);
    exact(object(selected), ["captureTtlMs", "consent", "rulesDocument", "rubricText", "mediaPolicyDocument"]);
    exact(object(selected.consent), ["version", "termsHash", "publicityPolicyHash", "text", "admission"]);
    const { source, config, client, producers } = this.input;
    count(selected.captureTtlMs, 1);
    insist(hashText(selected.rulesDocument) === source.pin.rulesSha256 &&
      hashText(selected.rubricText) === source.pin.rubricSha256 &&
      hashText(selected.consent.text) === source.pin.termsSha256 &&
      selected.consent.termsHash === source.pin.termsSha256 &&
      selected.consent.publicityPolicyHash === source.pin.publicityPolicyHash &&
      ["review_pending", "admitted"].includes(selected.consent.admission) && !!selected.consent.version &&
      hashText(selected.mediaPolicyDocument) === source.pin.mediaPolicySha256 &&
      canonical(JSON.parse(selected.mediaPolicyDocument)) === canonical(DANCE_PRIVATE_MEDIA_POLICY),
      "dance_projection_policy_changed", 409);
    const owner = structuredClone(await producers.owner()), bound = await this.binding(owner.accountId, owner.bindingId);
    danceId(owner.assignmentId);
    const role = structuredClone(await observeCanonicalDanceRole({ source, config, client,
      actor: { accountId: owner.accountId, wallet: bound.subject },
      learner: { accountId: owner.accountId, wallet: bound.subject } }));
    insist(role.owner.wallet === bound.subject, "dance_projection_owner_changed", 403);
    const media = structuredClone(await producers.mediaEpoch()); count(media.epoch);
    const body: DanceHostContext = { version: "pirate.dance-host-context/1", sourceHash: source.sourceHash,
      configurationRevision: config.configurationRevision, ownerEpoch: role.owner.epoch,
      rulesEpoch: role.rulesEpoch, mediaEpoch: media.epoch,
      owner: { accountId: owner.accountId, wallet: bound.subject, assignmentId: owner.assignmentId,
        validFromMs: role.owner.validFromMs, expiresAtMs: role.owner.expiresAtMs },
      captureTtlMs: selected.captureTtlMs, consent: structuredClone(selected.consent),
      rulesDocument: selected.rulesDocument, rubricText: selected.rubricText,
      mediaPolicyDocument: selected.mediaPolicyDocument };
    return this.write("dance_host_context", ["community_id"], [this.community], expectedRevision, body,
      [await this.configurationFence(), configurationFence, bound.fence, ...nonempty(owner.fences), ...nonempty(media.fences), {
        sql: `${DANCE_DB_NOW}>=? AND ${DANCE_DB_NOW}<?`,
        values: [role.owner.validFromMs, role.owner.expiresAtMs],
      }]);
  }
  async account(accountId: string, bindingId: string, authorizationId: string,
    expectedRevision: number | null, contextFence: DanceFence) {
    contextFence = structuredClone(contextFence);
    const { source, config, client, producers, db } = this.input;
    const bound = await this.binding(accountId, bindingId);
    const role = await observeCanonicalDanceRole({ source, config, client,
      actor: { accountId, wallet: bound.subject }, learner: { accountId, wallet: bound.subject } });
    const aliases = structuredClone(await producers.aliases(accountId));
    insist(aliases.accountIds.length > 0 && aliases.accountIds.length <= 128 && aliases.accountIds.includes(accountId) &&
      new Set(aliases.accountIds).size === aliases.accountIds.length, "dance_projection_aliases_missing", 403);
    const original = await db.prepare(`SELECT message,subject,issued_at,sign_in_json,signature,authority_epoch,
      policy_hash,policy_version,tx_hash,updated_at FROM learning_authorizations
      WHERE authorization_id=? AND account_id=? AND state='recorded'`)
      .bind(bytes32(authorizationId), accountId).first<{
        message: string; subject: string; issued_at: number; sign_in_json: string; signature: string;
        authority_epoch: number; policy_hash: string; policy_version: number; tx_hash: string; updated_at: number;
      }>();
    const parsed = original && readSignInMessageV4(original.message);
    insist(original && parsed && hashMessage(original.message) === authorizationId && original.policy_version === 4 &&
      original.subject === bound.subject && parsed.context.chainId === 6343 &&
      parsed.context.communityId === this.community && parsed.context.origin === config.app.origin &&
      parsed.context.contract === source.pin.v4 && parsed.context.publicationPolicy === original.policy_hash &&
      parsed.signIn.learner.toLowerCase() === bound.subject && parsed.signIn.issuedAt === BigInt(original.issued_at) &&
      canonical(JSON.parse(original.sign_in_json)) === canonical({ learner: parsed.signIn.learner,
        nonce: parsed.signIn.nonce, issuedAt: String(original.issued_at) }),
      "dance_projection_original_missing", 403);
    bytes32(original.tx_hash);
    const authorization = await capturedDanceAuthorization({ db, source, client })({
      accountId, wallet: bound.subject, authorizationId, atMs: await this.store.now(),
    });
    const readinessSql = `SELECT json_object('revision',COALESCE(h.revision,0),
      'permission',COALESCE(h.permission_revision,0),'pending',h.pending_operation,
      'withdrawn',s.public_results_withdrawn_at,'last',s.last_withdrawn_at,
      'original',COALESCE((SELECT revision FROM learning_authority_original_heads WHERE account_id=?1),0),
      'credential',COALESCE((SELECT revision FROM learning_authority_credentials WHERE account_id=?1),0),
      'dirty',EXISTS(SELECT 1 FROM learning_authority_dirty WHERE account_id=?1)) body
      FROM (SELECT ?1 account_id) a LEFT JOIN learning_authority_heads h ON h.account_id=a.account_id
      LEFT JOIN learning_settings s ON s.account_id=a.account_id`;
    const readiness = await db.prepare(readinessSql).bind(accountId).first<{ body: string }>();
    insist(readiness, "dance_projection_authority_missing", 403);
    const r = JSON.parse(readiness.body);
    insist(r.pending === null && r.withdrawn === null && r.dirty === 0 &&
      r.revision === original.authority_epoch && original.issued_at * 1000 > (r.last ?? -1),
      "dance_projection_authority_held", 403);
    const body: DanceAccountSelection = { version: "pirate.dance-account-selection/1", sourceHash: source.sourceHash,
      bindingId, authorizationId, identityEpoch: role.actor.identityEpoch, groupId: role.actor.groupId,
      groupEpoch: role.actor.groupEpoch, knownAliases: [...aliases.accountIds].sort(), active: true };
    return this.write("dance_host_accounts", ["community_id", "account_id"], [this.community, accountId],
      expectedRevision, body, [contextFence, bound.fence, authorization, ...nonempty(aliases.fences), {
        sql: `(${readinessSql.replaceAll("?1", "?")})=?`,
        values: [...Array((readinessSql.match(/\?1/g) ?? []).length).fill(accountId), readiness.body],
      }, {
        sql: `EXISTS(SELECT 1 FROM learning_authorizations WHERE authorization_id=? AND account_id=?
          AND message=? AND sign_in_json=? AND signature=? AND authority_epoch=? AND policy_hash=?
          AND policy_version=4 AND tx_hash=? AND updated_at=? AND state='recorded')`,
        values: [authorizationId, accountId, original.message, original.sign_in_json, original.signature,
          original.authority_epoch, original.policy_hash, original.tx_hash, original.updated_at],
      }]);
  }
  private async publication(selected: Pick<DanceSelectedSong, "postId" | "songRevision" | "manifestSha256" | "audioSha256">) {
    selected = structuredClone(selected);
    const { db, source, config, reads } = this.input;
    const row = await db.prepare(`SELECT * FROM public_post_revisions WHERE community_id=? AND post_id=? AND revision=?`)
      .bind(this.community, bytes32(selected.postId), count(selected.songRevision, 1)).first<IndexedPost>();
    insist(row && row.quarantined === 0 && row.manifest_sha256 === selected.manifestSha256,
      "dance_projection_publication_missing", 503);
    const head = await verifiedPostsHead(reads.client, reads.profile, config);
    const history = structuredClone(reads.configurationHistory ? [...await reads.configurationHistory()] : [config]);
    // Restrict the canonical helper's ACTUAL D1 query to this captured tuple.
    // No fake row/data is returned. If its pinned query shape changes, hold.
    const pinned = new Proxy(db, { get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
      insist(sql.startsWith("SELECT r.* FROM public_post_revisions r WHERE ") &&
        sql.includes(" ORDER BY "), "dance_projection_reader_shape_changed", 503);
      const exact = sql.replace(" ORDER BY ", ` AND r.author_id=? AND r.configuration_revision=?
        AND r.manifest_uri=? AND r.manifest_sha256=? AND r.manifest_json=? AND r.block_number=?
        AND r.block_hash=? AND r.transaction_hash=? AND r.log_index=? AND r.quarantined=0 ORDER BY `);
      return { bind(...values: (string | number | null)[]) {
        return db.prepare(exact).bind(...values, row.author_id, row.configuration_revision,
          row.manifest_uri, row.manifest_sha256, row.manifest_json, row.block_number,
          row.block_hash, row.transaction_hash, row.log_index);
      } };
      };
    } });
    const records = await indexedPublicPosts(pinned, reads.client, reads.profile, history, config, head, selected.postId);
    const post = records[0]?.post;
    insist(records.length === 1 && post && records[0].transactionHash === row.transaction_hash &&
      records[0].blockNumber === row.block_number && canonical(post) === canonical(JSON.parse(row.manifest_json)) &&
      hashJson(post) === selected.manifestSha256, "dance_projection_publication_changed", 409);
    // Explicitly compare the original row's complete on-chain tuple as well as
    // the helper result; no adoption of a second mutable provenance snapshot.
    const chain = await reads.client.readContract({ address: source.pin.posts, abi: postsAbi,
      functionName: "getPost", args: [source.domain.communityId, bytes32(selected.postId)], blockNumber: head });
    insist(chain.authorId === row.author_id && chain.kind === 0 && chain.revision === BigInt(row.revision) &&
      chain.configurationRevision === BigInt(row.configuration_revision) && chain.manifestURI === row.manifest_uri &&
      chain.manifestSha256 === row.manifest_sha256, "dance_projection_publication_changed", 409);
    const audio = post.media.filter(m => m.role === "audio");
    insist(audio.length === 1 && audio[0].sha256 === selected.audioSha256, "dance_projection_audio_changed", 409);
    const fence: DanceFence = {
      sql: `EXISTS(SELECT 1 FROM public_post_revisions WHERE community_id=? AND post_id=? AND revision=?
        AND author_id=? AND configuration_revision=? AND manifest_uri=? AND manifest_sha256=? AND manifest_json=?
        AND block_number=? AND block_hash=? AND transaction_hash=? AND log_index=? AND quarantined=0)
        AND NOT EXISTS(SELECT 1 FROM public_post_revisions WHERE community_id=? AND post_id=? AND revision>?)`,
      values: [this.community, row.post_id, row.revision, row.author_id, row.configuration_revision, row.manifest_uri,
        row.manifest_sha256, row.manifest_json, row.block_number, row.block_hash, row.transaction_hash, row.log_index,
        this.community, row.post_id, row.revision],
    };
    return { audio: audio[0], fence };
  }
  async audioProbe(selected: Pick<DanceSelectedSong, "postId" | "songRevision" | "manifestSha256" | "audioSha256">) {
    selected = structuredClone(selected);
    const published = await this.publication(selected);
    const { bytes } = await fetchPublicIpfs(published.audio.uri, published.audio.sha256,
      published.audio.byteLength, this.input.reads.transport, this.input.reads.contentCache);
    const measured = structuredClone(await this.input.producers.probe(bytes.slice()));
    insist(measured.sampleRate === 48000 && count(measured.samples, 1) > 0 &&
      typeof measured.receiptBytes === "string" && measured.receiptBytes.length > 0 &&
      measured.receiptBytes.length <= 64 * 1024, "dance_projection_probe_unavailable", 503);
    const receipt = canonical({ version: "pirate.dance-measured-audio/1", audioSha256: selected.audioSha256,
      sampleRate: measured.sampleRate, samples: measured.samples, producerReceipt: measured.receiptBytes });
    const evidence = hashText(receipt);
    const fences = [...await this.admission(), published.fence].map(f => compactDanceFence([f]));
    const read = () => this.input.db.prepare(`SELECT samples,receipt_bytes FROM dance_host_audio_probes
      WHERE community_id=? AND audio_sha256=? AND evidence_sha256=?`)
      .bind(this.community, selected.audioSha256, evidence).first<{ samples: number; receipt_bytes: string }>();
    try { await this.store.atomic(fences, [this.input.db.prepare(`INSERT INTO dance_host_audio_probes
      (community_id,audio_sha256,evidence_sha256,samples,receipt_bytes) SELECT ?,?,?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM dance_host_audio_probes WHERE community_id=? AND audio_sha256=? AND evidence_sha256=?)`)
      .bind(this.community, selected.audioSha256, evidence, measured.samples, receipt,
        this.community, selected.audioSha256, evidence)]); }
    catch (error) { if (!(await read())) throw error; }
    const row = await read();
    insist(row && row.samples === measured.samples && row.receipt_bytes === receipt, "dance_projection_probe_changed", 409);
    await this.store.assert(fences);
    return { evidenceSha256: evidence, samples: measured.samples };
  }
  async selection(selected: DanceSelectedSong, expectedRevision: number | null, contextFence: DanceFence) {
    selected = structuredClone(selected);
    contextFence = structuredClone(contextFence);
    const { source } = this.input;
    const key = songKeyOf({ chainId: 6343, posts: source.pin.posts,
      communityId: source.domain.communityId, postId: bytes32(selected.postId) });
    const published = await this.publication(selected),
      producer = nonempty(await this.input.producers.selection(structuredClone(selected)));
    const probe = await this.input.db.prepare(`SELECT samples,receipt_bytes FROM dance_host_audio_probes
      WHERE community_id=? AND audio_sha256=? AND evidence_sha256=?`)
      .bind(this.community, selected.audioSha256, selected.probeEvidenceSha256)
      .first<{ samples: number; receipt_bytes: string }>();
    insist(probe && hashText(probe.receipt_bytes) === selected.probeEvidenceSha256 &&
      probe.samples === selected.songDurationSamples && count(selected.startSample) >= 0 &&
      selected.durationSamples >= DANCE_PRIVATE_MEDIA_POLICY.minSamples &&
      selected.durationSamples <= DANCE_PRIVATE_MEDIA_POLICY.maxSamples && selected.durationSamples % 48 === 0 &&
      Number.isSafeInteger(selected.startSample + selected.durationSamples) &&
      selected.startSample + selected.durationSamples <= probe.samples, "dance_projection_probe_missing", 503);
    const fences = [contextFence, published.fence, ...producer, {
      sql: `EXISTS(SELECT 1 FROM dance_host_audio_probes WHERE community_id=? AND audio_sha256=?
        AND evidence_sha256=? AND samples=? AND receipt_bytes=?)`,
      values: [this.community, selected.audioSha256, selected.probeEvidenceSha256, probe.samples, probe.receipt_bytes],
    } satisfies DanceFence];
    await this.store.atomic([...await this.admission(), ...fences].map(f => compactDanceFence([f])), [this.input.db.prepare(`INSERT INTO dance_host_song_keys
      (community_id,song_key,post_id) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM dance_host_song_keys
      WHERE community_id=? AND (song_key=? OR post_id=?))`)
      .bind(this.community, key, selected.postId, this.community, key, selected.postId)]);
    const mapping: DanceFence = { sql: `EXISTS(SELECT 1 FROM dance_host_song_keys WHERE community_id=? AND song_key=? AND post_id=?)`,
      values: [this.community, key, selected.postId] };
    return this.write("dance_host_selections", ["community_id", "song_key", "reference_id", "offer_id"],
      [this.community, key, selected.reference?.id ?? "", selected.offer?.offerId ?? ""],
      expectedRevision, structuredClone(selected), [...fences, mapping]);
  }
  /** Canonical song producer for the EXISTING source3 pipeline. The exact
   * immutable post mapping and requested revision identify public audio; a
   * real probe measures its bytes. No ready recording, target approximation,
   * arbitrary selection row or most-recent probe supplies these facts. */
  async publishedSong(songKey: string, revision: number): Promise<PublishedMediaSong> {
    const mapped = await this.input.db.prepare(`SELECT post_id FROM dance_host_song_keys
      WHERE community_id=? AND song_key=?`).bind(this.community, bytes32(songKey))
      .first<{ post_id: string }>();
    insist(mapped && songKeyOf({ chainId: 6343, posts: this.input.source.pin.posts,
      communityId: this.input.source.domain.communityId, postId: bytes32(mapped.post_id) }) === songKey,
      "dance_projection_song_mapping_missing", 503);
    const row = await this.input.db.prepare(`SELECT manifest_json,manifest_sha256 FROM public_post_revisions
      WHERE community_id=? AND post_id=? AND revision=? AND quarantined=0`)
      .bind(this.community, mapped.post_id, count(revision, 1))
      .first<{ manifest_json: string; manifest_sha256: string }>();
    insist(row, "dance_projection_publication_missing", 503);
    const post = JSON.parse(row.manifest_json), audio = post.media?.filter((m: { role: string }) => m.role === "audio");
    insist(Array.isArray(audio) && audio.length === 1, "dance_projection_audio_changed", 409);
    const measured = await this.audioProbe({ postId: mapped.post_id, songRevision: revision,
      manifestSha256: row.manifest_sha256, audioSha256: bytes32(audio[0].sha256) });
    await this.store.assert([{ sql: `EXISTS(SELECT 1 FROM dance_host_song_keys WHERE community_id=? AND song_key=? AND post_id=?)`,
      values: [this.community, songKey, mapped.post_id] }]);
    return { communityId: this.community, songKey, songRevision: revision,
      audioSha256: bytes32(audio[0].sha256).slice(2), durationSamples: measured.samples, title: post.title };
  }
}
