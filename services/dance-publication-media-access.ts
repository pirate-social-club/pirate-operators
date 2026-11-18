import { bytes32, canonical, insist } from "../packages/community/common.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import type { MediaActor } from "../packages/community-media/contracts.ts";
import {
  parseDanceCaptureV2,
  type PublicationCaptureV2,
} from "../packages/dance/capture-v2.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";
import type { PublicReadPorts } from "./community-public.ts";
import { createDanceSongResources } from "./dance-song-resources.ts";
import type { Web2PublicDanceInputs } from "./web2-public-dance-start.ts";

/** Selected public verdict metadata does not change the media audience.
 * This authorizes owned access to the original private-media capture. */
export function dancePublicationMediaAccess(
  selection: Web2PublicDanceInputs | {
    db: D1Database;
    open(): Promise<Web2PublicDanceInputs>;
  },
  config: Web2CommunityConfig,
  reads: PublicReadPorts,
  assertMounted: () => void | Promise<void>,
) {
  const db = "publication" in selection ? selection.publication.db : selection.db;
  const configJson = canonical(config), scope = config.communityId;
  const resources = createDanceSongResources({ db, config, reads });
  async function selectedCapture(
    actor: MediaActor,
    capture: PublicationCaptureV2,
  ) {
    await assertMounted();
    const resolved = "publication" in selection ? selection : await selection.open();
    const { catalog, installation } = resolved.publication;
    const source = structuredClone(resolved.source);
    await assertMounted();
    insist(
      resolved.publication.db === db && installation &&
        installation.db === db &&
        installation.catalog === catalog &&
        installation.expected.communityId === scope &&
        installation.expected.origin === config.app.origin &&
        canonical(catalog.fresh().configuration) === configJson &&
        source.domain.communityId === scope &&
        source.pin.posts === config.postsContract,
      "dance_publication_source_changed",
      503,
    );
    insist(
      capture.communityId === scope &&
        capture.learner.accountId === actor.accountId &&
        capture.canonical.sourceHash === source.sourceHash &&
        capture.reference === null &&
        capture.expected.configurationRevision ===
          String(config.configurationRevision) &&
        capture.publication.binding.source.releaseSelectionSha256 ===
          catalog.active,
      "dance_publication_capture_context_changed",
      409,
    );
    const selected = await resources.selected(
      capture.songKey,
      null,
      capture.offer?.offerId ?? null,
    );
    const song = selected.song;
    insist(
      song.songRevision === capture.songRevision &&
        song.manifestSha256 === capture.manifestSha256 &&
        song.audioSha256 === capture.audioSha256 &&
        song.songDurationSamples === capture.songDurationSamples &&
        song.startSample === capture.startSample &&
        song.durationSamples === capture.durationSamples &&
        canonical(song.offer) === canonical(capture.offer),
      "dance_captured_inputs_changed",
      409,
    );
    const published = await resources.publication(capture.songKey, song);
    const fences: DanceFence[] = [
      installation.mountFence(),
      selected.fence,
      published.fence,
      {
        sql: `EXISTS(SELECT 1 FROM dance_publication_bindings b JOIN publication_v1_commands o ON o.command_id=b.command_id
        JOIN community_accounts a ON a.account_id=b.account_id
        JOIN credential_bindings x ON x.account_id=a.account_id
        WHERE b.community_id=? AND b.capture_id=? AND b.capture_hash=? AND b.account_id=?
        AND b.purpose='dance-verdict' AND o.command_id=? AND o.purpose=b.purpose AND o.action='grant'
        AND json_extract(b.value_json,'$.binding')=? AND o.digest=? AND o.phase='accepted'
        AND a.author_id=json_extract(o.request_json,'$.capture.authorId')
        AND x.binding_id=json_extract(o.request_json,'$.capture.bindingId')
        AND x.namespace='moss' AND x.network=6343 AND x.subject=?)
        AND EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision=? AND manifest_json=?)
        AND NOT EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision>?)`,
        values: [
          scope,
          capture.captureId,
          capture.captureHash,
          actor.accountId,
          capture.publication.publicationCommandId,
          canonical(capture.publication.binding),
          capture.publication.binding.grantId,
          capture.learner.wallet,
          scope,
          config.configurationRevision,
          configJson,
          scope,
          config.configurationRevision,
        ],
      },
    ];
    await assertMounted();
    return { postId: song.postId, fences };
  }
  return {
    async current(actor: MediaActor, capture: PublicationCaptureV2) {
      return (await selectedCapture(actor, capture)).fences;
    },
    async owned(actor: MediaActor, captureId: string) {
      const row = await db
        .prepare(
          `SELECT c.capture_json,s.consent_json FROM dance_captures c
        JOIN dance_consents s ON s.capture_id=c.capture_id WHERE c.community_id=? AND c.account_id=?
        AND c.capture_id=? AND json_extract(c.capture_json,'$.publication.kind')='publication-bound'`,
        )
        .bind(scope, actor.accountId, bytes32(captureId))
        .first<{ capture_json: string; consent_json: string }>();
      if (!row) return null;
      const stored = parseDanceCaptureV2({
        ...JSON.parse(row.capture_json),
        consent: JSON.parse(row.consent_json),
      });
      insist(
        stored.publication.kind === "publication-bound",
        "dance_capture_binding_mismatch",
        409,
      );
      const capture = stored as PublicationCaptureV2;
      const selected = await selectedCapture(actor, capture);
      return {
        capture,
        guide: {
          communityId: scope,
          songKey: capture.songKey,
          songRevision: capture.songRevision,
          audioSha256: capture.audioSha256,
          access: "public" as const,
          playback_url:
            config.app.origin +
            "/api/public/posts/" +
            selected.postId +
            "/audio",
        },
        fences: [
          ...selected.fences,
          {
            sql: `EXISTS(SELECT 1 FROM dance_captures c JOIN dance_consents s ON s.capture_id=c.capture_id
            WHERE c.capture_id=? AND c.community_id=? AND c.account_id=? AND c.capture_json=? AND s.consent_json=?)
            AND ${DANCE_DB_NOW}<?`,
            values: [
              capture.captureId,
              scope,
              actor.accountId,
              row.capture_json,
              row.consent_json,
              capture.expiresAtMs,
            ],
          },
        ] satisfies DanceFence[],
      };
    },
  };
}

export type DancePublicationMediaAccess = ReturnType<
  typeof dancePublicationMediaAccess
>;
