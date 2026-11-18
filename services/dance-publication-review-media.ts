import { bytesToHex, decodeAbiParameters, hexToBytes, type Hex } from "viem";
import type { AuthContext } from "../packages/community/accounts.ts";
import {
  bytes32,
  canonical,
  CommunityError,
  hashJson,
  insist,
} from "../packages/community/common.ts";
import { parseWeb2ProfileDocument } from "../packages/community/web2-directory.ts";
import { mediaPlayback } from "../packages/community-media/playback.ts";
import { MediaError } from "../packages/community-media/validation.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import { danceShapes } from "../packages/dance-chain/v2/wire-shapes.ts";
import {
  parseDanceCaptureV2,
  type PublicationCaptureV2,
} from "../packages/dance/capture-v2.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";
import { validateFence } from "../packages/dance/validation.ts";
import type { CommunityPrivateDance } from "./community-private-dance.ts";
import { readDanceV2PrivateRegistration } from "./dance-publication-actions.ts";
import { createDancePublicationJournal } from "./dance-publication-journal.ts";
import { DanceV2ActionStore } from "./dance-v2-action-store.ts";
import { readDanceV2ParticipantBindings } from "./dance-v2-participant-bindings.ts";
import {
  publicationActivationHead,
  publicationOriginalFingerprint,
} from "./publication-app-activation.ts";
import { PublicationRequestSession } from "./publication-app-request.ts";
import { publicationSelectionSource } from "./publication-app-selection.ts";
import { publicationCurrentState } from "./publication-app-state.ts";
import { parseCommand } from "./publication-command-contract.ts";
import { ownedCommand } from "./publication-command-store.ts";
import type { Web2PublicDanceInputs } from "./web2-public-dance-start.ts";

const playback = /^\/api\/media\/([a-f0-9-]{36})\/playback$/;
const queue = "/api/dance/queue";
const grantHeader = "x-dance-review-grant";
const pageLimit = 10;
const scanLimit = 40;
const cursorBytes = 36;

export function dancePublicationReviewerRoute(request: Request) {
  const path = new URL(request.url).pathname;
  return (
    request.headers.has(grantHeader) &&
    ((request.method === "GET" && path === queue) ||
      ((request.method === "GET" || request.method === "HEAD") &&
        playback.test(path)))
  );
}

/** The position refers only to an immutable original-action row. Its value
 * and any skipped capture are absent from the response and protected by a
 * key scoped to the current private credential binding, session and grant. */
async function reviewerCursor(keyHash: Hex, value: string | null) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(hexToBytes(keyHash)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  let after = 0;
  if (value !== null) {
    insist(/^0x[0-9a-f]{72}$/.test(value), "dance_invalid_cursor");
    const bytes = Uint8Array.from(hexToBytes(value as Hex));
    let clear: ArrayBuffer;
    try {
      clear = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, 12) },
        key,
        bytes.subarray(12),
      );
    } catch {
      throw new CommunityError("dance_invalid_cursor");
    }
    after = Number(new DataView(clear).getBigUint64(0));
    insist(Number.isSafeInteger(after) && after > 0, "dance_invalid_cursor");
  }
  return {
    after,
    async next(position: number) {
      insist(
        Number.isSafeInteger(position) && position > after,
        "dance_invalid_cursor",
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const clear = new DataView(new ArrayBuffer(8));
      clear.setBigUint64(0, BigInt(position));
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, clear),
      );
      const token = new Uint8Array(cursorBytes);
      token.set(iv);
      token.set(sealed, 12);
      return bytesToHex(token);
    },
  };
}

function staleQueueItem(error: unknown) {
  if (error instanceof MediaError)
    return error.code === "media_unavailable" && error.status === 410;
  return (
    error instanceof CommunityError &&
    [
      "dance_review_unavailable",
      "dance_publication_submission_missing",
      "dance_publication_submission_changed",
      "dance_publication_registration_unconfirmed",
      "dance_fence_changed",
    ].includes(error.code)
  );
}

export async function dancePublicationReviewerFetch(input: {
  request: Request;
  context: AuthContext;
  config: Web2CommunityConfig;
  selection: Web2PublicDanceInputs;
  runtime: CommunityPrivateDance;
  assertMounted(): void;
}) {
  const { request, context, config, selection, runtime, assertMounted } = input;
  const {
    publication: ports,
    owner,
    publisher,
    source,
    participants,
  } = selection;
  const { db, installation, client, catalog } = ports;
  const url = new URL(request.url);
  const requestedMedia = playback.exec(url.pathname)?.[1] ?? null;
  insist(
    dancePublicationReviewerRoute(request) &&
      installation &&
      runtime.db === db &&
      runtime.source3 &&
      runtime.publicationV2 &&
      participants,
    "dance_publication_review_unavailable",
    503,
  );
  // The existing session reader allows GET. Authorize HEAD with the same
  // path and headers, while the media handler still receives actual HEAD.
  const sessionRequest =
    request.method === "HEAD"
      ? new Request(request.url, { headers: request.headers, method: "GET" })
      : request;
  const session = await PublicationRequestSession.open(
    sessionRequest,
    db,
    context,
    installation,
  );
  const reviewer = { accountId: session.original.account_id };
  const pair = structuredClone(participants.pair);
  insist(
    request.headers.get("x-dance-account") === reviewer.accountId &&
      pair[1].accountId === reviewer.accountId &&
      pair[1].wallet === session.original.wallet.toLowerCase(),
    "dance_review_unavailable",
    404,
  );
  const scope = { communityId: context.communityId, ...reviewer };
  const grantId = bytes32(request.headers.get(grantHeader));
  const release = catalog.fresh(),
    releaseSource = publicationSelectionSource(release);
  const profile = parseWeb2ProfileDocument(release.profile);
  const store = new DanceV2ActionStore(db);
  const journal = createDancePublicationJournal(ports, session);

  async function authorize() {
    assertMounted();
    await runtime.current?.();
    const row = await ownedCommand(db, grantId, scope);
    insist(
      row.phase === "accepted" && row.typed_json,
      "dance_review_unavailable",
      404,
    );
    const grant = parseCommand(JSON.parse(row.typed_json));
    insist(
      grant.action === "grant" &&
        grant.message.purpose === "dance-review-attribution" &&
        canonical(grant.source) === canonical(releaseSource) &&
        grant.message.learner === pair[1].wallet &&
        grant.digest === pair[1].grantId &&
        grant.message.publicationTarget === source.domain.verifier &&
        grant.message.publicationTargetRuntimeHash ===
          source.pin.runtimeCodeHash &&
        grant.message.policyHash === source.pin.reviewerConsentPolicyHash,
      "dance_review_unavailable",
      404,
    );
    const current = await publicationCurrentState(ports, row, session);
    insist(
      current.state === "allowed" &&
        current.grantId === grant.digest &&
        current.purpose === "dance-review-attribution" &&
        canonical(current.source) === canonical(releaseSource),
      "dance_review_unavailable",
      404,
    );
    const accepted = await ownedCommand(db, grantId, scope);
    insist(
      publicationOriginalFingerprint(accepted) ===
        publicationOriginalFingerprint({
          ...row,
          observation_hash: accepted.observation_hash,
          result_state: accepted.result_state,
        }) &&
        accepted.result_state === "recorded" &&
        accepted.observation_hash &&
        accepted.fence_generation !== null,
      "dance_review_unavailable",
      404,
    );
    const activation = await publicationActivationHead(db, accepted);
    const firstMs = Number(grant.message.validAfter) * 1000;
    const finalMs = Number(grant.message.expiresAt) * 1000;
    insist(
      Number.isSafeInteger(firstMs) &&
        Number.isSafeInteger(finalMs) &&
        firstMs > 0 &&
        finalMs > firstMs,
      "dance_review_unavailable",
      404,
    );
    insist(
      activation.generation === accepted.fence_generation &&
        activation.stopped === 0 &&
        activation.pending === 0,
      "dance_review_unavailable",
      404,
    );
    const privateFences = (
      await participants!.privateOriginalFences(structuredClone(pair))
    ).map(validateFence);
    insist(privateFences.length > 0, "dance_publication_fences_missing", 503);
    const active: DanceFence[] = [
      ...privateFences,
      session.observationFence({
        db,
        ...scope,
        source: releaseSource,
        active: true,
      }),
      {
        sql: `EXISTS(SELECT 1 FROM publication_v1_commands o JOIN publication_v1_heads h
          ON h.community_id=o.community_id AND h.account_id=o.account_id
          AND h.source_id=o.source_id AND h.purpose=o.purpose
          WHERE o.command_id=? AND o.community_id=? AND o.account_id=? AND o.typed_json=?
          AND o.accepted_json=? AND o.signature=? AND o.phase='accepted' AND o.result_state='recorded'
          AND o.observation_hash=? AND o.fence_generation=h.generation AND h.generation=?
          AND h.stopped=0 AND h.stop_command_id IS ?
          AND NOT EXISTS(SELECT 1 FROM publication_v1_commands w WHERE w.community_id=h.community_id
            AND w.account_id=h.account_id AND w.source_id=h.source_id AND w.purpose=h.purpose
            AND w.action='withdraw' AND (w.fence_generation IS NULL OR w.fence_ack_json IS NULL OR
            COALESCE(w.result_state,'') NOT IN ('recorded','reverted','withheld'))))
          AND ${DANCE_DB_NOW}>=? AND ${DANCE_DB_NOW}<?`,
        values: [
          grantId,
          context.communityId,
          reviewer.accountId,
          accepted.typed_json,
          accepted.accepted_json,
          accepted.signature,
          accepted.observation_hash,
          activation.generation,
          activation.stop_command_id,
          firstMs,
          finalMs,
        ],
      },
    ];
    const afterAwait = async () => {
      assertMounted();
      await store.assert(active);
      await session.check();
      assertMounted();
    };
    const roles = await readDanceV2ParticipantBindings({
      client,
      config,
      selected: source,
      profile,
      owner,
      caller: publisher,
      clock: ports.clock,
      participants: pair,
      afterAwait,
      async verifyPrivateOriginals(expected) {
        insist(
          canonical(expected) === canonical(pair),
          "dance_review_unavailable",
          404,
        );
        await afterAwait();
      },
    });
    const observedBlock = await client.getBlock({
      blockNumber: BigInt(current.observed.blockNumber),
    });
    await afterAwait();
    insist(
      observedBlock.hash === current.observed.blockHash &&
        observedBlock.timestamp === BigInt(current.observed.timestampS) &&
        roles.anchor.number >= BigInt(current.observed.blockNumber),
      "dance_publication_observation_pending",
      503,
    );
    return { roles, afterAwait, active };
  }

  async function inspect(
    captureId: Hex,
    auth: Awaited<ReturnType<typeof authorize>>,
    mediaId: string | null,
  ) {
    const retained = await store
      .stmt(
        `SELECT c.capture_json,s.consent_json FROM dance_captures c JOIN dance_consents s ON s.capture_id=c.capture_id
       WHERE c.community_id=? AND c.capture_id=? AND c.account_id=?
       AND json_extract(c.capture_json,'$.publication.kind')='publication-bound'
       AND NOT EXISTS(SELECT 1 FROM dance_v2_action_originals v
         WHERE v.community_id=c.community_id AND v.capture_id=c.capture_id AND v.kind='verdict')`,
        context.communityId,
        captureId,
        pair[0].accountId,
      )
      .first<{ capture_json: string; consent_json: string }>();
    insist(retained, "dance_review_unavailable", 404);
    const found = parseDanceCaptureV2({
      ...JSON.parse(retained.capture_json),
      consent: JSON.parse(retained.consent_json),
    }) as PublicationCaptureV2;
    const [wire] = decodeAbiParameters(
      [danceShapes.capture],
      found.canonical.captureAbi,
    );
    const learner = auth.roles.participants[0];
    insist(
      found.communityId === context.communityId &&
        found.captureId === captureId &&
        found.learner.accountId === learner.accountId &&
        learner.accountId !== reviewer.accountId &&
        found.canonical.sourceHash === source.sourceHash &&
        canonical(found.publication.binding.source) ===
          canonical(releaseSource) &&
        found.expected.ownerEpoch === String(owner.epoch) &&
        found.expected.configurationRevision ===
          String(config.configurationRevision) &&
        wire.accountCommitment === learner.accountCommitment &&
        wire.groupId === learner.groupId &&
        wire.identityEpoch === learner.identityEpoch &&
        wire.groupEpoch === learner.groupEpoch &&
        wire.publicationGrantId === learner.grantId,
      "dance_review_unavailable",
      404,
    );
    const registration = await readDanceV2PrivateRegistration(
      selection,
      runtime,
      found,
      store,
    );
    insist(
      !mediaId || registration.record.id === mediaId,
      "dance_review_unavailable",
      404,
    );
    const fences = [
      ...registration.readFences,
      {
        sql: `EXISTS(SELECT 1 FROM dance_source3_requests WHERE community_id=? AND account_id=? AND request_id=? AND capture_id=? AND capture_hash=?)`,
        values: [
          context.communityId,
          learner.accountId,
          registration.record.requestId,
          captureId,
          found.captureHash,
        ],
      },
      ...(await runtime.publicationV2!.current(
        { accountId: learner.accountId },
        found,
      )),
      ...(await journal.acceptanceFences({
        captureHash: found.captureHash,
        grants: [
          { accountId: learner.accountId, binding: found.publication.binding },
        ],
        configurationRevision: found.expected.configurationRevision,
        ownerEpoch: found.expected.ownerEpoch,
      })),
      {
        sql: `EXISTS(SELECT 1 FROM dance_captures c JOIN dance_consents s ON s.capture_id=c.capture_id
          WHERE c.community_id=? AND c.capture_id=? AND c.account_id=? AND c.capture_json=? AND s.consent_json=?)
          AND NOT EXISTS(SELECT 1 FROM dance_v2_action_originals WHERE community_id=? AND capture_id=? AND kind='verdict')`,
        values: [
          context.communityId,
          captureId,
          learner.accountId,
          retained.capture_json,
          retained.consent_json,
          context.communityId,
          captureId,
        ],
      },
    ];
    const afterAwait = async () => {
      await auth.afterAwait();
      await store.assert(fences);
      assertMounted();
    };
    await registration.verifyRegistration(auth.roles.anchor, afterAwait);
    const canonicalBlock = await client.getBlock({
      blockNumber: auth.roles.anchor.number,
    });
    insist(
      canonicalBlock.hash === auth.roles.anchor.hash &&
        canonicalBlock.timestamp === auth.roles.anchor.timestamp &&
        canonicalBlock.timestamp * 1000n <
          BigInt(registration.retainedMedia.reviewDeadlineMs),
      "dance_review_unavailable",
      404,
    );
    await afterAwait();
    return { registration, fences };
  }

  if (requestedMedia) {
    insist(!url.search, "dance_review_unavailable", 404);
    return mediaPlayback(
      request,
      {
        ports: runtime.media.ports,
        async playbackRecord(id) {
          const auth = await authorize();
          const matching = await store
            .stmt(
              `SELECT submission_id FROM community_media_submissions WHERE community_id=? AND account_id=? AND media_id=?`,
              context.communityId,
              pair[0].accountId,
              id,
            )
            .first<{ submission_id: string }>();
          insist(matching, "dance_review_unavailable", 404);
          try {
            return (await inspect(bytes32(matching.submission_id), auth, id))
              .registration.record;
          } catch (error) {
            if (!staleQueueItem(error)) throw error;
            await auth.afterAwait();
            throw new CommunityError("dance_review_unavailable", 404);
          }
        },
      },
      requestedMedia,
      reviewer,
    );
  }

  const auth = await authorize();
  insist(
    url.searchParams.size === 0 ||
      (url.searchParams.size === 1 && url.searchParams.has("cursor")),
    "dance_invalid_cursor",
  );
  const page = await reviewerCursor(
    hashJson({
      schema: "pirate.dance-reviewer-cursor/2",
      communityId: context.communityId,
      sourceHash: source.sourceHash,
      grantId,
      bindingId: session.original.binding_id,
      sessionHash: session.original.session_hash,
      learner: pair[0].accountId,
    }),
    url.searchParams.get("cursor"),
  );
  const candidates = await store
    .stmt(
      `SELECT a.rowid AS position,a.capture_id FROM dance_v2_action_originals a JOIN dance_v2_ready_commands r ON r.command_id=a.command_id
      JOIN community_media_submissions s ON s.community_id=a.community_id AND s.submission_id=a.capture_id AND s.account_id=a.account_id
      JOIN community_media m ON m.community_id=s.community_id AND m.id=s.media_id
      WHERE a.community_id=? AND a.account_id=? AND a.kind='register' AND r.source_hash=? AND a.rowid>?
      AND s.deadline_ms>${DANCE_DB_NOW} AND m.state='ready' AND m.purpose='private-review' AND m.revision=s.media_revision
      AND NOT EXISTS(SELECT 1 FROM dance_v2_action_originals v WHERE v.community_id=a.community_id AND v.capture_id=a.capture_id AND v.kind='verdict')
      ORDER BY a.rowid LIMIT ?`,
      context.communityId,
      pair[0].accountId,
      source.sourceHash,
      page.after,
      scanLimit + 1,
    )
    .all<{ capture_id: Hex; position: number }>();
  const visible = [];
  let scanned = 0,
    lastPosition = page.after;
  for (const candidate of candidates.results.slice(0, scanLimit)) {
    scanned++;
    lastPosition = candidate.position;
    try {
      const checked = await inspect(candidate.capture_id, auth, null);
      const { record, retainedMedia } = checked.registration;
      visible.push({
        item: {
          captureId: candidate.capture_id,
          mediaId: record.id,
          reviewDeadlineMs: retainedMedia.reviewDeadlineMs,
          playbackUrl: "/api/media/" + record.id + "/playback",
        },
        fences: checked.fences,
      });
    } catch (error) {
      if (!staleQueueItem(error)) throw error;
      // A role/session/selection fence cannot be treated as a stale clip.
      await auth.afterAwait();
    }
    if (visible.length === pageLimit) break;
  }
  const cursor =
    scanned < candidates.results.length ? await page.next(lastPosition) : null;
  const stillCanonical = await client.getBlock({
    blockNumber: auth.roles.anchor.number,
  });
  insist(
    stillCanonical.hash === auth.roles.anchor.hash,
    "dance_review_unavailable",
    404,
  );
  await session.check();
  await store.assert([
    ...auth.active,
    ...visible.flatMap(({ fences }) => fences),
  ]);
  assertMounted();
  return Response.json(
    {
      version: "pirate.dance-review-queue/2",
      items: visible.map(({ item }) => item),
      cursor,
    },
    {
      headers: {
        "cache-control": "no-store, private",
        vary: "Cookie, X-Dance-Review-Grant",
      },
    },
  );
}
