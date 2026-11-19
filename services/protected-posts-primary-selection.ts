import { sha256 } from "viem";
import { bytes32, canonical, exact, hashJson, hashText, insist, object } from "../packages/community/common.ts";
import { decimal, ipfsUri } from "../packages/community/manifest-core.ts";
import { requireAuthorizedOwnerWithFreshness, requireOwnerIdentity } from "../packages/community/owner-authorization.ts";
import { preparedProtectedPostsFee, protectedPostsDbClock } from "../packages/community/protected-posts-fees.ts";
import type { ExternalOperation } from "../packages/community/publication-store.ts";
import { ownerBudgetKey, requireOwnerGrantTime } from "../packages/release/owner-grant.ts";
import { readCanonicalIntent, type CanonicalIntentReadPorts } from "../packages/recognition/canonical-intent.ts";
import { readCanonicalSource, requireSameCanonicalSource } from "../packages/recognition/canonical-community.ts";
import { authorizeCanonicalRequest, readCanonicalBytes, readProtectedSelectionRequest } from "../packages/recognition/canonical-protocol.ts";
import { acceptedIntent, reservationId } from "../packages/recognition/intent.ts";
import { verifiedPublication } from "../packages/recognition/model.ts";
import { firstSongDriver, type FirstSongDriverPorts, type ProtectedPostsDriverPorts } from "./first-song-driver.ts";
import { protectedPostsPinRoles, type readPostsAuxiliaryPrimaryRequest,
  type readPostsCanonicalPrimaryRequest, type readPostsTerminalPrimaryRequest } from "./native-posts-primary-reference.ts";
import { readNativePostsJobId } from "./native-posts-publication.ts";
import type { ProtectedPostsPrimaryScope } from "./protected-posts-ready.ts";

type AuxiliaryRequest = ReturnType<typeof readPostsAuxiliaryPrimaryRequest>;
type TerminalRequest = ReturnType<typeof readPostsTerminalPrimaryRequest>;
type CanonicalRequest = ReturnType<typeof readPostsCanonicalPrimaryRequest>;
type Reference = AuxiliaryRequest["reference"];
type LeaseDigest = AuxiliaryRequest["initiatingLeaseSha256"];
type PrimarySession = ReturnType<D1Database["withSession"]>;
type PrimaryBudgetRow = {
  reservation_id: string; request_hash: string; scope: string; period: string; asset: string; amount: string; status: string;
};
type SelectedOperation = ExternalOperation & {
  dbNow: number; leaseToken: string | null; leaseUntil: number; phase: string;
  inputHash: string; authority: string; progress: string; submission: string;
  intent: string; intentHash: string; reservationId: string; catalogState: string; credential: string; media: string;
};

export function protectedPostsPrimarySelection(
  scope: Readonly<ProtectedPostsPrimaryScope>,
  runtime: FirstSongDriverPorts<ProtectedPostsDriverPorts>,
  readPorts: CanonicalIntentReadPorts,
) {
  const { db, configuration, ownerGrant } = scope;
  const { installationId, communityId, configurationRevision } = configuration;
  const configurationSha256 = hashJson(configuration);
  const driver = firstSongDriver(runtime);
  const accountJoin = `JOIN community_accounts a ON a.account_id=s.account_id AND a.author_id=s.author_id
    JOIN credential_bindings b ON b.account_id=a.account_id AND b.namespace='moss' AND b.network=6343
      AND b.subject=s.captured_wallet`;
  const identityFence = `EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)
    AND EXISTS(SELECT 1 FROM native_application_original WHERE singleton=1 AND original_digest=?)`;
  const identity = [communityId, configuration.app.origin, scope.applicationOriginalSha256.slice(2)];
  const credentialProjection = "json_array(a.account_id,a.author_id,b.binding_id,b.subject,b.created_at)";

  async function operation(reference: Reference, lease: LeaseDigest, states: readonly ExternalOperation["status"][]) {
    insist(reference.installationId === installationId && reference.releaseSha256 === scope.releaseSha256 &&
      Date.now() < scope.expiresAtMs, "protected_posts_primary_scope_changed", 403);
    const statement = (session: PrimarySession) => session.prepare(`SELECT e.*,
      ${protectedPostsDbClock} AS dbNow, j.phase, j.lease_token AS leaseToken, j.lease_until AS leaseUntil,
      j.input_hash AS inputHash, j.authority_json AS authority, j.progress_json AS progress,
      json_array(s.submission_id,s.account_id,s.author_id,s.post_id,s.metadata_json,s.object_key,s.object_etag,
        s.audio_sha256,s.audio_bytes,s.sealed_at,s.captured_wallet,s.request_hash,s.creator_json,
        c.posting_json,c.chain_receipt_json,c.promotion_receipt_json) AS submission,
      c.intent_json AS intent,c.intent_sha256 AS intentHash,c.reservation_id AS reservationId,c.state AS catalogState,
      ${credentialProjection} AS credential,
      (SELECT json_group_array(json_array(slot,state,sha256,object_key,object_etag,byte_length,duration_ms,sealed_at))
        FROM (SELECT * FROM media_stems WHERE submission_id=s.submission_id ORDER BY slot)) AS media
      FROM external_operations e JOIN publication_jobs j ON j.job_id=e.job_id
      JOIN media_submissions s ON s.submission_id=j.submission_id AND s.upload_state='sealed'
      JOIN publication_catalog_obligations c ON c.job_id=j.job_id
        AND json_extract(c.intent_json,'$.inputHash')=j.input_hash
      ${accountJoin}
      WHERE e.operation_id=? AND e.job_id=? AND e.request_hash=? AND e.step=? AND ${identityFence}`)
      .bind(reference.operationId, reference.jobId, reference.requestHash, reference.step, ...identity);
    const row = await statement(db.withSession("first-primary")).first<SelectedOperation>();
    insist(row && states.includes(row.status), "protected_posts_primary_original_unavailable", 409);
    if (lease) insist(row.leaseToken && hashText(row.leaseToken) === lease && row.phase === reference.step &&
      row.leaseUntil > row.dbNow, "protected_posts_primary_lease_changed", 409);

    const { intent, input, config } = await readCanonicalIntent(readPorts, reference.jobId);
    const expected = await driver.request(input.job, reference.step);
    insist(hashJson(config) === configurationSha256 && canonical(expected) === row.request_json &&
      hashJson(expected) === reference.requestHash && canonical(intent) === row.intent &&
      hashJson(intent) === row.intentHash && reservationId(intent) === row.reservationId &&
      input.job.input_hash === row.inputHash && input.job.authority_json === row.authority &&
      input.job.progress_json === row.progress && (!lease || (input.job.phase === row.phase &&
        input.job.lease_token === row.leaseToken && input.job.lease_until === row.leaseUntil)), "protected_posts_primary_original_changed", 409);
    let expiresAtMs = scope.expiresAtMs;
    if (lease) {
      requireOwnerGrantTime(ownerGrant);
      const { authorization, safeAnchorExpiresAtMs } = await requireAuthorizedOwnerWithFreshness(
        runtime.ownerAuthorization, configuration, ownerGrant.ownerWallet, undefined, runtime.ownerVerification,
      );
      insist(safeAnchorExpiresAtMs !== undefined, "protected_posts_owner_safe_view_unavailable", 503);
      expiresAtMs = Math.min(expiresAtMs, row.leaseUntil, ownerGrant.expiresAt * 1000,
        authorization.expiresAt * 1000, safeAnchorExpiresAtMs);
    }
    if (reference.step === "publication" && lease && row.status === "running") {
      const quote = preparedProtectedPostsFee({ db, ownerGrant, maximumTotalFee: scope.maximumTotalFee }, row);
      insist(quote.initiatingLeaseSha256 === lease, "protected_posts_primary_lease_changed", 409);
      expiresAtMs = Math.min(expiresAtMs, quote.expiresAtMs);
    }
    const snapshot = ({ dbNow: _clock, ...identity }: SelectedOperation) => identity;
    return {
      row, input, intent, expiresAtMs, statement,
      assertUnchanged(current: SelectedOperation | undefined, deadline: number) {
        insist(current && canonical(snapshot(current)) === canonical(snapshot(row)),
          "protected_posts_primary_original_changed", 409);
        insist(current.dbNow < deadline, "protected_posts_primary_proof_expired", 403);
      },
    };
  }

  type Operation = Awaited<ReturnType<typeof operation>>;

  function assertDeadline(signal: AbortSignal, deadline: number) {
    signal.throwIfAborted();
    insist(Number.isSafeInteger(deadline) && Date.now() < deadline, "protected_posts_primary_proof_expired", 403);
  }

  async function recheck(operations: readonly Operation[], signal: AbortSignal, deadline: number) {
    const session = db.withSession("first-primary");
    const batch = await session.batch<SelectedOperation>(operations.map(item => item.statement(session)));
    for (const [i, item] of operations.entries()) item.assertUnchanged(batch[i]?.results[0], deadline);
    assertDeadline(signal, deadline);
  }

  const common = (expiresAtMs: number, lease?: LeaseDigest) => ({
    applicationOriginalSha256: scope.applicationOriginalSha256, configurationSha256,
    grantSha256: bytes32(ownerGrant.sha256), expiresAtMs,
    ...(lease ? { initiatingLeaseSha256: lease } : {}),
  });

  function recordingFor(intent: Operation["intent"], input: Operation["input"]) {
    const recording = object(input.progress.catalog_reserve);
    insist(recording.intentSha256 === hashJson(intent) && recording.reservationId === reservationId(intent) &&
      recording.state === "ready" && recording.publicationSha256 === null, "protected_posts_primary_recording_changed", 409);
    return bytes32(recording.recordingId);
  }

  function publicationOriginal(row: ExternalOperation) {
    const post = object(object(JSON.parse(row.request_json)).publication);
    exact(post, ["communityId", "postId", "authorId", "configurationRevision", "manifestSha256", "manifestURI"]);
    insist(post.communityId === communityId && post.configurationRevision === configurationRevision,
      "protected_posts_primary_publication_changed", 409);
    return { communityId, postId: bytes32(post.postId), authorId: bytes32(post.authorId),
      configurationRevision: 1 as const, manifestSha256: bytes32(post.manifestSha256), manifestURI: ipfsUri(post.manifestURI) };
  }

  function confirmedPublication(row: ExternalOperation) {
    const publication = publicationOriginal(row);
    insist(row.status === "confirmed" && row.result_json && row.prepared_json, "protected_posts_primary_publication_changed", 409);
    const value = object(JSON.parse(row.result_json));
    exact(value, ["transactionHash", "blockHash", "blockNumber", "actualFeeWei", "postId", "revision"]);
    const receipt = { transactionHash: bytes32(value.transactionHash), blockHash: bytes32(value.blockHash),
      blockNumber: decimal(value.blockNumber), actualFeeWei: decimal(value.actualFeeWei), postId: publication.postId, revision: 1 as const };
    const quote = preparedProtectedPostsFee({ db, ownerGrant, maximumTotalFee: scope.maximumTotalFee }, row);
    insist(canonical(receipt) === row.result_json && receipt.transactionHash === row.provider_id &&
      BigInt(receipt.actualFeeWei) > 0n && BigInt(receipt.actualFeeWei) <= BigInt(quote.maximumFeeWei),
    "protected_posts_primary_publication_changed", 409);
    return { publication, receipt };
  }

  async function referenceFor(jobId: string, step: Reference["step"]): Promise<Reference> {
    const operationId = hashJson({ job: jobId, step });
    const row = await db.withSession("first-primary").prepare(
      "SELECT request_hash FROM external_operations WHERE operation_id=? AND job_id=? AND step=?",
    ).bind(operationId, jobId, step).first<{ request_hash: string }>();
    insist(row, "protected_posts_primary_original_unavailable", 409);
    return { installationId, releaseSha256: scope.releaseSha256, jobId, operationId, requestHash: bytes32(row.request_hash), step };
  }

  return {
    async auxiliary({ purpose, reference, initiatingLeaseSha256: lease }: AuxiliaryRequest, signal: AbortSignal) {
      const states = purpose === "ready" ? ["planned", "running"] as const :
        lease ? ["running"] as const : ["running", "uncertain", "confirmed"] as const;
      const selected = await operation(reference, lease, states);
      const { intent, input, expiresAtMs } = selected;
      const pin = purpose === "pin" || purpose === "pin_status";
      const profile = configuration.policies.recognition;
      insist(profile, "protected_posts_primary_catalog_unavailable", 503);
      const subject = pin ? { action: purpose === "pin" ? "release_pin" : "release_pin_status",
        context: input.context, role: protectedPostsPinRoles[reference.step as keyof typeof protectedPostsPinRoles] } :
        { action: purpose === "reserve" ? "intent_reserve" : "intent_status", intent, profile };
      const recordingId = purpose === "ready" ? recordingFor(intent, input) : undefined;
      if (recordingId) insist(["reserved", "posting"].includes(selected.row.catalogState),
        "protected_posts_primary_recording_changed", 409);
      const result = { ...common(expiresAtMs, lease), subject,
        ...(pin ? { callbackIntent: intent } : {}), ...(recordingId ? { recordingId } : {}) };
      await recheck([selected], signal, expiresAtMs);
      return result;
    },
    async terminal({ reference, publication, initiatingLeaseSha256: lease }: TerminalRequest, signal: AbortSignal) {
      const selected = await operation(reference, lease, lease ? ["running"] : ["running", "uncertain", "confirmed"]);
      const post = await operation({ ...publication, step: "publication" }, undefined, ["confirmed"]);
      const { intent, expiresAtMs } = selected;
      const profile = configuration.policies.recognition;
      const confirmed = confirmedPublication(post.row);
      insist(profile && selected.row.catalogState !== "pending" &&
        intent.postId === confirmed.publication.postId && canonical(post.intent) === canonical(intent),
        "protected_posts_primary_publication_changed", 409);
      await recheck([post, selected], signal, expiresAtMs);
      return { ...common(expiresAtMs, lease), intent, profile, ...confirmed };
    },
    async canonical({ wire, parent }: CanonicalRequest, signal: AbortSignal, ifMatch: string | null) {
      const authorized = await authorizeCanonicalRequest(wire, configuration);
      const { body, payload: { action, signer, expiresAt } } = authorized;
      const recognition = configuration.policies.recognition;
      insist(recognition && (action === "read" || action === "source" || action === "audio" ||
        action === "authorize" || action === "ready" || action === "protected_selection"),
      "protected_posts_primary_canonical_unavailable", 503);
      insist(ifMatch === null || action === "audio", "protected_posts_primary_audio_purpose_changed", 409);
      let expiresAtMs = Math.min(scope.expiresAtMs, expiresAt * 1000);
      if (parent) {
        const step = parent.reference.step;
        const isRecognition = signer === recognition.signer;
        const isModeration = signer === configuration.policies.moderationSigner;
        const allowed = Object.hasOwn(protectedPostsPinRoles, step)
          ? action === "read" || (isModeration && (action === "audio" || action === "ready"))
          : isRecognition && (action === "read" || (action === "protected_selection" && step !== "catalog_reserve"));
        insist(allowed, "protected_posts_primary_canonical_parent_changed", 409);
      }
      const parentRead = parent && await operation(parent.reference, parent.initiatingLeaseSha256,
        parent.initiatingLeaseSha256 ? ["planned", "running"] : ["running", "uncertain", "confirmed"]);
      if (parentRead) expiresAtMs = Math.min(expiresAtMs, parentRead.expiresAtMs);
      let selectedSource;
      let jobId: string;
      if (action === "read") {
        exact(body, ["jobId"]);
        jobId = readNativePostsJobId(body.jobId);
      } else if (action === "ready") {
        exact(body, ["intent"]);
        selectedSource = acceptedIntent(body.intent);
        jobId = readNativePostsJobId(selectedSource.jobId);
      } else if (action === "protected_selection") {
        jobId = readProtectedSelectionRequest(body).jobId;
      } else {
        exact(body, action === "authorize" ? ["source", "operationId"] : ["source"]);
        insist(action === "audio" || signer === recognition.signer, "protected_posts_primary_canonical_role_changed", 403);
        const value = object(body.source);
        selectedSource = Object.hasOwn(value, "schema") ? acceptedIntent(value) : verifiedPublication(value);
        jobId = readNativePostsJobId((await readCanonicalSource(readPorts, selectedSource)).jobId);
      }
      const { intent, input, config } = await readCanonicalIntent(readPorts, jobId);
      insist(hashJson(config) === configurationSha256 &&
        (!parentRead || canonical(parentRead.intent) === canonical(intent)),
      "protected_posts_primary_canonical_parent_changed", 409);
      if (selectedSource) requireSameCanonicalSource(intent, selectedSource);
      const ownerAuthorization = await readPorts.ownerAuthorization();
      const owner = await requireOwnerIdentity(ownerAuthorization, configuration, ownerGrant.ownerWallet, readPorts.ownerVerification);
      insist(hashJson(owner) === intent.ownerAuthorizationSha256, "protected_posts_primary_original_changed", 409);
      const snapshot = { intent, config, context: input.context, title: input.metadata.title,
        lyrics: input.metadata.lyrics.sourceText, ownerAuthorization };
      let details = {};
      let audioBody;
      let actionRead: Operation | undefined;
      let budget: ((session: PrimarySession) => D1PreparedStatement) | undefined;
      if (action === "audio") {
        const audio = { sha256: intent.audioSha256, byteLength: intent.audioBytes, etag: intent.audioEtag };
        details = { intentSha256: hashJson(intent), audio };
        if (ifMatch !== null) {
          insist(ifMatch === '"' + audio.etag + '"', "protected_posts_primary_audio_changed", 409);
          const retained = await readPorts.media.get(intent.audioObjectKey, { onlyIf: { etagMatches: audio.etag } });
          insist(retained && "body" in retained && retained.etag === audio.etag &&
            retained.size === audio.byteLength && retained.customMetadata?.sha256 === audio.sha256,
          "protected_posts_primary_audio_changed", 409);
          const bytes = await readCanonicalBytes(retained, Math.min(audio.byteLength, 25 * 1024 * 1024), signal);
          insist(bytes.byteLength === audio.byteLength && sha256(bytes) === audio.sha256, "protected_posts_primary_audio_changed", 409);
          audioBody = { bytes, ...audio };
        }
      } else if (action === "authorize") {
        const key = ownerBudgetKey(ownerGrant, "recognition_requests");
        const operationId = bytes32(body.operationId);
        const requestHash = hashJson(selectedSource);
        requireOwnerGrantTime(ownerGrant);
        insist(operationId === hashJson({ purpose: "original-identification/1", reservationId: reservationId(intent) }),
          "protected_posts_primary_budget_unavailable", 409);
        const { authorization, safeAnchorExpiresAtMs } = await requireAuthorizedOwnerWithFreshness(
          ownerAuthorization, configuration, ownerGrant.ownerWallet, undefined, readPorts.ownerVerification,
        );
        insist(safeAnchorExpiresAtMs !== undefined, "protected_posts_owner_safe_view_unavailable", 503);
        expiresAtMs = Math.min(expiresAtMs, ownerGrant.expiresAt * 1000, authorization.expiresAt * 1000, safeAnchorExpiresAtMs);
        budget = (session) => session.prepare(
          `SELECT reservation_id,request_hash,scope,period,asset,amount,status FROM spending_reservations
            WHERE reservation_id=? AND request_hash=? AND scope=? AND period=? AND asset=?
              AND amount='1' AND status='reserved'`,
        ).bind(operationId, requestHash, key.scope, key.period, key.asset);
        details = { intentSha256: hashJson(intent), effect: { kind: "identify" } };
      } else if (action === "ready") {
        const step = input.job.phase as keyof typeof protectedPostsPinRoles;
        const leaseToken = input.job.lease_token;
        insist(canonical(intent) === canonical(selectedSource) && Object.hasOwn(protectedPostsPinRoles, step) && leaseToken &&
          (!parent || (parent.reference.step === step && parent.initiatingLeaseSha256 === hashText(leaseToken))),
        "protected_posts_primary_ready_changed", 409);
        const reference = await referenceFor(jobId, step);
        if (parent) insist(canonical(reference) === canonical(parent.reference), "protected_posts_primary_ready_changed", 409);
        const initiatingLeaseSha256 = hashText(leaseToken);
        actionRead = await operation(reference, initiatingLeaseSha256, ["running"]);
        expiresAtMs = Math.min(expiresAtMs, actionRead.expiresAtMs);
        details = { intentSha256: hashJson(intent), reservationId: reservationId(intent),
          recordingId: recordingFor(intent, input), reference, initiatingLeaseSha256 };
      } else if (action === "protected_selection") {
        const pins = readProtectedSelectionRequest(body);
        insist(pins.intentSha256 === hashJson(intent) && pins.reservationId === reservationId(intent),
          "protected_posts_primary_catalog_selection_changed", 409);
        const reference = await referenceFor(jobId, "publication");
        actionRead = await operation(reference, undefined, ["running", "uncertain", "confirmed"]);
        const quote = preparedProtectedPostsFee({ db, ownerGrant, maximumTotalFee: scope.maximumTotalFee }, actionRead.row);
        details = { intentSha256: pins.intentSha256, reservationId: pins.reservationId, reference,
          recordingId: recordingFor(intent, input), quote, publication: publicationOriginal(actionRead.row) };
      }
      const session = db.withSession("first-primary");
      const live = session.prepare(
        `SELECT ${protectedPostsDbClock} AS dbNow FROM publication_jobs j
          JOIN media_submissions s ON s.submission_id=j.submission_id AND s.upload_state='sealed'
          JOIN publication_catalog_obligations c ON c.job_id=j.job_id
          ${accountJoin}
          WHERE j.job_id=? AND j.input_hash=? AND j.authority_json=? AND j.progress_json=?
            AND c.intent_json=? AND c.intent_sha256=? AND c.reservation_id=?
            AND s.submission_id=? AND s.account_id=? AND s.author_id=? AND s.captured_wallet=?
            AND s.metadata_json=? AND s.object_key=? AND s.object_etag=? AND s.audio_sha256=? AND s.audio_bytes=?
            AND ${identityFence}`,
      ).bind(jobId, input.job.input_hash, input.job.authority_json, input.job.progress_json,
        canonical(intent), hashJson(intent), reservationId(intent), input.row.submission_id, input.row.account_id,
        input.row.author_id, input.row.captured_wallet, input.row.metadata_json, intent.audioObjectKey,
        intent.audioEtag, intent.audioSha256, intent.audioBytes, ...identity);
      const operations = [parentRead, actionRead].filter((item): item is Operation => Boolean(item));
      const batch = await session.batch<SelectedOperation | { dbNow: number } | PrimaryBudgetRow>([live, ...operations.map(item => item.statement(session)),
        ...(budget ? [budget(session)] : [])]);
      const frame = batch[0]?.results[0];
      insist(frame && "dbNow" in frame && frame.dbNow < expiresAtMs, "protected_posts_primary_canonical_unavailable", 409);
      for (const [i, item] of operations.entries()) {
        const current = batch[i + 1]?.results[0];
        item.assertUnchanged(current && "operation_id" in current ? current : undefined, expiresAtMs);
      }
      const reservation = budget ? batch.at(-1)?.results[0] : undefined;
      insist(!budget || (reservation && "reservation_id" in reservation), "protected_posts_primary_budget_unavailable", 409);
      assertDeadline(signal, expiresAtMs);
      return { result: { ...common(expiresAtMs), action, snapshot, ...details, ...(reservation ? { reservation } : {}) }, audioBody };
    },
  };
}
