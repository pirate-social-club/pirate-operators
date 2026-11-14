import { sharedReservationService, type SharedReservationPorts } from "./shared-recognition-reservations.ts";
import {
  bytes32,
  canonical,
  CommunityError,
  exact,
  hashJson,
  insist,
  jsonBody,
} from "../packages/community/common.ts";
import { httpsOrigin } from "../packages/community/manifest-core.ts";
import {
  authorizeRecognitionRequest,
  recognitionAuthority,
  type RecognitionAuthority,
} from "../packages/recognition/authorization.ts";
import {
  associationId,
  verifiedPublication,
  type VerifiedPublication,
  type CatalogStatusSnapshot,
} from "../packages/recognition/model.ts";
import { RecognitionStore } from "../packages/recognition/store.ts";
import {
  advanceEnrollment,
  type EnrollmentDependencies,
} from "../packages/recognition/worker.ts";
import type { PrivateKeyAccount } from "viem/accounts";
import { signCatalogStatus } from "../packages/recognition/status-receipt.ts";

/** Required production ports have no fixture/default success implementation. */
export interface SharedRecognitionPorts {
  db: D1Database;
  namespace: string;
  profileSha256: string;
  origin: string;
  statusSigner: PrivateKeyAccount;
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
  reservations?: SharedReservationPorts;
}
/** Independently owned service entrypoints. Deployment/migrations are explicit integration inputs. */
export function sharedRecognitionService(ports: SharedRecognitionPorts) {
  insist(
    ports.statusSigner &&
      typeof ports.statusSigner.signTypedData === "function",
    "recognition_status_signer_unconfigured",
    503,
  );
  const namespace = bytes32(ports.namespace),
    profileSha256 = bytes32(ports.profileSha256),
    origin = httpsOrigin(ports.origin),
    now = ports.now ?? Date.now,
    store = () => new RecognitionStore(ports.db, namespace, now);
  const reservations=ports.reservations ? sharedReservationService(ports.reservations) : null;
  if (ports.reservations) insist(ports.reservations.db===ports.db && ports.reservations.profile.namespace===namespace && ports.reservations.profile.sha256===profileSha256 && ports.reservations.profile.origin===origin && ports.reservations.signer.address.toLowerCase()===ports.statusSigner.address.toLowerCase(),"recognition_profile_composition_changed",503);
  const response = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: { "cache-control": "no-store" },
    });
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/v1/reservations")) {
          insist(reservations,"recognition_reservations_unconfigured",503);
          return reservations.fetch(request);
        }
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
        const input = await jsonBody(request, 16 * 1024),
          requestSha256 = hashJson(input),
          s = store(),
          {
            authorization: a,
            body,
            authority,
          } = await authorizeRecognitionRequest(
            s.db,
            input,
            action,
            namespace,
            profileSha256,
            origin,
            (id) => ports.loadAuthority(id),
            () => Math.floor(now() / 1000),
          );
        const stillAuthorized = async () => {
          const loaded = await ports.loadAuthority(a.communityId),
            current = loaded ? recognitionAuthority(loaded) : null;
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
        const signedStatus = async (id: string, httpStatus = 200) => {
          const snapshot = await s.status(id, a.communityId);
          insist(snapshot, "recognition_publication_not_found", 404);
          const p = verifiedPublication(JSON.parse(snapshot.publication_json));
          const binding = (v: CatalogStatusSnapshot) =>
            canonical({
              associationId: v.association_id,
              recordingId: v.recording_id,
              publication: v.publication_json,
              associationState: v.association_state,
              recordingState: v.recording_state,
              canonicalAudioSha256: v.canonical_audio_sha256,
            });
          const issuedAt = Math.floor(now() / 1000),
            state =
              snapshot.association_state === "withdrawn"
                ? "withdrawn"
                : snapshot.recording_state;
          const receipt = await signCatalogStatus(ports.statusSigner, {
            schema: "pirate.recognition-catalog-receipt/1",
            namespace,
            profileSha256,
            serviceOrigin: origin,
            communityId: a.communityId,
            communityOrigin: a.communityOrigin,
            configurationRevision: a.configurationRevision,
            requestSha256,
            associationId: bytes32(snapshot.association_id),
            postId: bytes32(p.postId),
            publicationRevision: p.publicationRevision,
            publicationSha256: hashJson(p),
            recordingId: bytes32(snapshot.recording_id),
            canonicalAudioSha256: bytes32(snapshot.canonical_audio_sha256),
            state,
            catalogRevision: snapshot.catalog_revision,
            issuedAt,
            expiresAt: Math.min(issuedAt + 60, a.expiresAt),
          });
          if (snapshot.association_state === "active") {
            const current = await ports.verifyPublication(
              authority,
              p.postId,
              p.publicationRevision,
            );
            insist(
              current &&
                canonical(verifiedPublication(current)) === canonical(p),
              "recognition_publication_unverified",
              403,
            );
          }
          await stillAuthorized();
          const after = await s.status(id, a.communityId);
          insist(
            after && binding(after) === binding(snapshot),
            "recognition_status_changed",
            409,
          );
          insist(
            receipt.payload.expiresAt > Math.floor(now() / 1000),
            "recognition_status_expired",
            409,
          );
          return response(
            {
              schema: "pirate.recognition-catalog-status/1",
              namespace,
              associationId: snapshot.association_id,
              recordingId: snapshot.recording_id,
              state,
              receipt,
            },
            httpStatus,
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
            return await signedStatus(existing.association_id, 202);
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
          return await signedStatus(result.association.association_id, 202);
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
          return await signedStatus(association.association_id);
        }
        return await signedStatus(association.association_id);
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
    async runReservation(id:string,communityId?:string) {
      insist(reservations,"recognition_reservations_unconfigured",503);return reservations.run(id,communityId);
    },
    async recover() {
      await reservations?.recover();
      for (const id of await store().due()) await ports.wake(id);
    },
  };
}
