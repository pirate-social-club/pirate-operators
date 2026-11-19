import type { ProtectedCatalogPosting } from "./protected-catalog.ts";
import { sha256 } from "viem";
import { canonical, hashJson, insist } from "../community/common.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import type { ReleaseContext } from "../release/authority.ts";
import {
  canonicalPosting,
  canonicalPublication,
  readCanonicalIntent,
  type CanonicalIntentPorts,
  type CanonicalIntentReadPorts,
} from "./canonical-intent.ts";
import type { AcceptedIntent, PostingBinding } from "./intent.ts";
import type { VerifiedPublication } from "./model.ts";

export interface CanonicalSnapshot {
  intent: AcceptedIntent;
  config: CommunityConfig;
  context: ReleaseContext;
  title: string;
  lyrics: string;
  ownerAuthorization: unknown;
}
export type CanonicalSource = AcceptedIntent | VerifiedPublication;
export async function readCanonicalSource(
  ports: CanonicalIntentReadPorts,
  source: CanonicalSource,
) {
  let jobId: string;
  if ("schema" in source) jobId = source.jobId;
  else {
    const row = await ports.db.withSession("first-primary").prepare(
      `SELECT j.job_id FROM publication_jobs j
        JOIN media_submissions s ON s.submission_id=j.submission_id WHERE s.post_id=?`,
    ).bind(source.postId).first<{ job_id: string }>();
    insist(row, "recognition_publication_unverified", 403);
    jobId = row.job_id;
  }
  const { intent } = await readCanonicalIntent(ports, jobId);
  return requireSameCanonicalSource(intent, source);
}
export function requireSameCanonicalSource(
  current: AcceptedIntent,
  p: CanonicalSource,
) {
  insist(
    current.communityId === p.communityId &&
      current.namespace === p.namespace &&
      current.postId === p.postId &&
      current.publicationRevision === p.publicationRevision &&
      current.configurationRevision === p.configurationRevision &&
      current.audioSha256 === p.audioSha256 &&
      current.audioBytes === p.audioBytes &&
      current.audioObjectKey === p.audioObjectKey &&
      current.creatorKey === p.creatorKey &&
      current.audioRevision === p.audioRevision &&
      current.termsRevision === p.termsRevision &&
      current.termsSha256 === p.termsSha256 &&
      current.allowsDerivatives === p.allowsDerivatives,
    "recognition_private_source_changed",
    403,
  );
  if ("schema" in p)
    insist(
      canonical(current) === canonical(p),
      "recognition_intent_changed",
      403,
    );
  return current;
}
/** Explicit community operations. No SQL, bucket handles, paths or signing
 * callbacks cross this boundary. The private registry selects each community. */
export interface CanonicalCommunity {
  currentConfiguration(): Promise<CommunityConfig>;
  read(jobId: string): Promise<CanonicalSnapshot>;
  source(publication: CanonicalSource): Promise<AcceptedIntent>;
  posting(intent: AcceptedIntent, claimed: unknown): Promise<PostingBinding>;
  publication(
    intent: AcceptedIntent,
    posting: PostingBinding | ProtectedCatalogPosting,
  ): Promise<VerifiedPublication>;
  findPublication(
    postId: string,
    revision: number,
  ): Promise<VerifiedPublication | null>;
  audio(
    publication: CanonicalSource,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>>;
  authorize(source: CanonicalSource, operationId: string): Promise<void>;
}
export function localCanonicalCommunity(
  ports: CanonicalIntentPorts,
): CanonicalCommunity {
  const read = async (jobId: string): Promise<CanonicalSnapshot> => {
    const { intent, config, input } = await readCanonicalIntent(ports, jobId);
    return {
      intent,
      config,
      context: input.context,
      title: input.metadata.title,
      lyrics: input.metadata.lyrics.sourceText,
      ownerAuthorization: await ports.ownerAuthorization(),
    };
  };
  const source = (p: CanonicalSource) => readCanonicalSource(ports, p);
  return {
    currentConfiguration: () => ports.currentConfiguration(),
    read,
    source,
    posting: (p, posting) => canonicalPosting(ports, p, posting),
    publication: (p, posting) => canonicalPublication(ports, p, posting),
    async findPublication(postId, revision) {
      const row = await ports.db
        .withSession("first-primary")
        .prepare(
          `SELECT o.intent_json,o.posting_json
        FROM publication_catalog_obligations o JOIN media_submissions s ON s.submission_id=json_extract(o.intent_json,'$.submissionId')
        WHERE s.post_id=? AND json_extract(o.intent_json,'$.publicationRevision')=?`,
        )
        .bind(postId, revision)
        .first<{ intent_json: string; posting_json: string | null }>();
      return row?.posting_json
        ? canonicalPublication(
            ports,
            JSON.parse(row.intent_json),
            JSON.parse(row.posting_json),
          )
        : null;
    },
    async audio(p, signal = new AbortController().signal) {
      const current = await source(p);
      signal.throwIfAborted();
      const object = await ports.media.get(current.audioObjectKey);
      insist(object, "recognition_private_media_missing", 503);
      const bytes = new Uint8Array(await object.arrayBuffer());
      signal.throwIfAborted();
      insist(
        bytes.byteLength === current.audioBytes &&
          sha256(bytes) === current.audioSha256,
        "recognition_audio_changed",
        409,
      );
      await source(p);
      signal.throwIfAborted();
      return bytes;
    },
    async authorize(p, id) {
      await source(p);
      await ports.authorizeRecognition(id, hashJson(p));
      await source(p);
    },
  };
}
export function canonicalCommunity(
  input: CanonicalIntentPorts | CanonicalCommunity,
): CanonicalCommunity {
  return "db" in input ? localCanonicalCommunity(input) : input;
}
