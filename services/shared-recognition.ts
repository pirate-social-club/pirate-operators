import {
  bytes32,
  canonical,
  CommunityError,
  exact,
  insist,
  jsonBody,
} from "../packages/community/common.ts";
import { httpsOrigin } from "../packages/community/manifest-core.ts";
import {
  authorizeRecognitionRequest,
  type RecognitionAuthority,
} from "../packages/recognition/authorization.ts";
import {
  associationId,
  verifiedPublication,
  type VerifiedPublication,
} from "../packages/recognition/model.ts";
import { RecognitionStore } from "../packages/recognition/store.ts";
import {
  advanceEnrollment,
  type EnrollmentDependencies,
} from "../packages/recognition/worker.ts";

/** Required production ports have no fixture/default success implementation. */
export interface SharedRecognitionPorts {
  db: D1Database;
  namespace: string;
  origin: string;
  loadAuthority(communityId: string): Promise<RecognitionAuthority | null>;
  verifyPublication(
    authority: RecognitionAuthority,
    postId: string,
    revision: number,
  ): Promise<VerifiedPublication | null>;
  verifyWithdrawal(
    authority: RecognitionAuthority,
    publication: VerifiedPublication,
  ): Promise<string>;
  /** Null means a verified new recording, never an unavailable recognition check. */
  resolveEnrollment(
    authority: RecognitionAuthority,
    publication: VerifiedPublication,
  ): Promise<{ recordingId: string; evidenceSha256: string } | null>;
  enrollment: EnrollmentDependencies;
  wake(recordingId: string): Promise<void>;
  now?: () => number;
}
/** Independently owned service entrypoints. Deployment/migrations are explicit integration inputs. */
export function sharedRecognitionService(ports: SharedRecognitionPorts) {
  const namespace = bytes32(ports.namespace),
    origin = httpsOrigin(ports.origin),
    now = ports.now ?? Date.now,
    store = () => new RecognitionStore(ports.db, namespace, now);
  const response = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: { "cache-control": "no-store" },
    });
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        insist(
          url.origin === origin && !url.search && request.method === "POST",
          "not_found",
          404,
        );
        const action =
          url.pathname === "/v1/catalog/publications/enroll"
            ? "catalog_enroll"
            : url.pathname === "/v1/catalog/publications/status"
              ? "catalog_status"
              : url.pathname === "/v1/catalog/publications/withdraw"
                ? "catalog_withdraw"
                : null;
        insist(action, "not_found", 404);
        const s = store(),
          {
            authorization: a,
            body,
            authority,
          } = await authorizeRecognitionRequest(
            s.db,
            await jsonBody(request, 16 * 1024),
            action,
            namespace,
            origin,
            (id) => ports.loadAuthority(id),
            () => Math.floor(now() / 1000),
          );
        const stillAuthorized = async () => {
          const current = await ports.loadAuthority(a.communityId);
          insist(
            canonical(current) === canonical(authority),
            "recognition_pairing_changed",
            403,
          );
          insist(
            a.expiresAt > Math.floor(now() / 1000),
            "recognition_request_expired",
            403,
          );
        };
        if (action === "catalog_enroll") {
          exact(body, ["postId", "publicationRevision"]);
          const postId = bytes32(body.postId),
            revision = body.publicationRevision;
          insist(
            typeof revision === "number" &&
              Number.isSafeInteger(revision) &&
              revision > 0,
            "invalid_publication_revision",
          );
          const facts = await ports.verifyPublication(
            authority,
            postId,
            revision,
          );
          insist(facts, "recognition_publication_unverified", 403);
          const p = verifiedPublication(facts);
          insist(
            p.namespace === namespace &&
              p.communityId === a.communityId &&
              p.postId === postId &&
              p.publicationRevision === revision &&
              p.configurationRevision === a.configurationRevision,
            "recognition_publication_scope_mismatch",
            403,
          );
          const existing = await s.association(associationId(p), a.communityId);
          if (existing) {
            insist(
              existing.publication_json === canonical(p),
              "recognition_publication_conflict",
              409,
            );
            await stillAuthorized();
            const r = await s.get(existing.recording_id);
            insist(r, "recognition_recording_unavailable", 503);
            if (existing.state === "active" && r.state !== "ready")
              await ports.wake(r.recording_id);
            return response(
              {
                schema: "pirate.recognition-catalog-status/1",
                namespace,
                associationId: existing.association_id,
                recordingId: r.recording_id,
                state: existing.state === "withdrawn" ? "withdrawn" : r.state,
              },
              202,
            );
          }
          const catalogRevision = await s.catalogRevision();
          const matched = await ports.resolveEnrollment(authority, p);
          await stillAuthorized();
          const result = matched
            ? await s.associateMatched(
                p,
                matched.recordingId,
                matched.evidenceSha256,
              )
            : await s.enroll(p, catalogRevision);
          if (
            result.association.state === "active" &&
            result.recording.state !== "ready"
          )
            await ports.wake(result.recording.recording_id);
          return response(
            {
              schema: "pirate.recognition-catalog-status/1",
              namespace,
              associationId: result.association.association_id,
              recordingId: result.recording.recording_id,
              state:
                result.association.state === "withdrawn"
                  ? "withdrawn"
                  : result.recording.state,
            },
            202,
          );
        }
        exact(body, ["associationId"]);
        const id = bytes32(body.associationId),
          association = await s.association(id, a.communityId);
        insist(association, "recognition_publication_not_found", 404);
        if (action === "catalog_withdraw") {
          const p = verifiedPublication(
            JSON.parse(association.publication_json),
          );
          const proof = bytes32(await ports.verifyWithdrawal(authority, p));
          await stillAuthorized();
          const id = await s.withdraw(p, proof);
          await ports.wake(id);
          return response({
            schema: "pirate.recognition-catalog-status/1",
            namespace,
            associationId: association.association_id,
            recordingId: id,
            state: "withdrawn",
          });
        }
        const recording = await s.get(association.recording_id);
        insist(recording, "recognition_recording_unavailable", 503);
        await stillAuthorized();
        return response({
          schema: "pirate.recognition-catalog-status/1",
          namespace,
          associationId: association.association_id,
          recordingId: recording.recording_id,
          state:
            association.state === "withdrawn" ? "withdrawn" : recording.state,
        });
      } catch (error) {
        return response(
          {
            error:
              error instanceof CommunityError
                ? error.code
                : "recognition_service_unavailable",
          },
          error instanceof CommunityError ? error.status : 503,
        );
      }
    },
    async run(recordingId: string, signal?: AbortSignal) {
      return advanceEnrollment(
        store(),
        bytes32(recordingId),
        ports.enrollment,
        signal,
      );
    },
    async recover() {
      for (const id of await store().due()) await ports.wake(id);
    },
  };
}
