import type { PrivateKeyAccount } from "viem/accounts";
import {
  bytes32,
  canonical,
  exact,
  hashJson,
  insist,
  jsonBody,
  publicId,
} from "../community/common.ts";
import {
  associationId,
  verifiedPublication,
  type VerifiedPublication,
} from "./model.ts";
import {
  recognitionAuthority,
  signRecognitionRequest,
  type RecognitionAction,
  type RecognitionAuthority,
} from "./authorization.ts";
import {
  recognitionConnection,
  verifyCatalogStatus,
  type RecognitionConnection,
} from "./status-receipt.ts";

export interface RecognitionClientPorts {
  /** Server-owned deployment/configuration input, never learned from a response. */
  connection: RecognitionConnection;
  publisher: PrivateKeyAccount;
  currentAuthority(): Promise<RecognitionAuthority | null>;
  /** Existing publication/outbox lease and durable request journal gate. */
  beforeSend(input: {
    action: RecognitionAction;
    requestSha256: string;
    requestJson: string;
  }): Promise<void>;
  transport?: (request: Request) => Promise<Response>;
  now?: () => number;
}
/** Community server client. It possesses no ACRCloud credential or bucket input.
 * Each poll creates a new signed nonce, preventing a previous ready response
 * from being substituted after withdrawal, profile rotation or another request. */
export function recognitionClient(ports: RecognitionClientPorts) {
  const connection = Object.freeze(recognitionConnection(ports.connection)),
    now = ports.now ?? Date.now;
  const send = async (
    action: Extract<RecognitionAction,"catalog_enroll"|"catalog_status"|"catalog_withdraw">,
    publication: VerifiedPublication,
    expectedRecordingId?: string,
    signal = new AbortController().signal,
  ) => {
    const p = Object.freeze(verifiedPublication(publication));
    signal.throwIfAborted();
    const loaded = await ports.currentAuthority();
    insist(loaded, "recognition_pairing_unavailable", 503);
    const authority = recognitionAuthority(loaded),
      authorityJson = canonical(authority);
    insist(
      authority.enabled &&
        authority.namespace === connection.namespace &&
        p.namespace === connection.namespace &&
        authority.profileSha256 === connection.profileSha256 &&
        authority.communityId === p.communityId &&
        authority.configurationRevision === p.configurationRevision &&
        authority.publisher === ports.publisher.address.toLowerCase(),
      "recognition_pairing_changed",
      403,
    );
    const stillAuthorized = async () => {
      const current = await ports.currentAuthority();
      insist(
        current && canonical(recognitionAuthority(current)) === authorityJson,
        "recognition_pairing_changed",
        403,
      );
      signal.throwIfAborted();
    };
    const issuedAt = Math.floor(now() / 1000),
      expiresAt = issuedAt + 300,
      body =
        action === "catalog_enroll"
          ? { postId: p.postId, publicationRevision: p.publicationRevision }
          : { associationId: associationId(p) };
    const signed = await signRecognitionRequest(
      ports.publisher,
      {
        namespace: bytes32(connection.namespace),
        profileSha256: bytes32(connection.profileSha256),
        action,
        communityId: bytes32(p.communityId),
        communityOrigin: authority.communityOrigin,
        serviceOrigin: connection.origin,
        configurationRevision: authority.configurationRevision,
        nonce: publicId(),
        issuedAt,
        expiresAt,
      },
      body,
    );
    const requestSha256 = hashJson(signed),
      requestJson = JSON.stringify(signed),
      path = {
        catalog_enroll: "enroll",
        catalog_status: "status",
        catalog_withdraw: "withdraw",
      }[action];
    const request = new Request(
      `${connection.origin}/v1/catalog/publications/${path}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        headers: { "content-type": "application/json" },
        body: requestJson,
      },
    );
    await stillAuthorized();
    await ports.beforeSend({ action, requestSha256, requestJson });
    insist(
      expiresAt > Math.floor(now() / 1000),
      "recognition_request_expired",
      409,
    );
    request.signal.throwIfAborted();
    const response = await (ports.transport ?? fetch)(request);
    insist(
      response.status >= 200 && response.status < 300,
      "recognition_catalog_request_failed",
      503,
    );
    const result = await jsonBody(response, 16 * 1024);
    exact(result, [
      "schema",
      "namespace",
      "associationId",
      "recordingId",
      "state",
      "receipt",
    ]);
    const receipt = await verifyCatalogStatus(
      result.receipt,
      {
        connection,
        publication: p,
        communityOrigin: authority.communityOrigin,
        requestSha256,
        recordingId: expectedRecordingId,
      },
      () => Math.floor(now() / 1000),
    );
    insist(
      result.schema === "pirate.recognition-catalog-status/1" &&
        result.namespace === receipt.payload.namespace &&
        result.associationId === receipt.payload.associationId &&
        result.recordingId === receipt.payload.recordingId &&
        result.state === receipt.payload.state,
      "recognition_status_envelope_mismatch",
      503,
    );
    await stillAuthorized();
    insist(
      receipt.payload.expiresAt > Math.floor(now() / 1000),
      "recognition_status_expired",
      409,
    );
    return receipt;
  };
  return {
    enroll: (p: VerifiedPublication, signal?: AbortSignal) =>
      send("catalog_enroll", p, undefined, signal),
    status: (
      p: VerifiedPublication,
      recordingId?: string,
      signal?: AbortSignal,
    ) => send("catalog_status", p, recordingId, signal),
    ready: async (
      p: VerifiedPublication,
      recordingId?: string,
      signal?: AbortSignal,
    ) => {
      const receipt = await send("catalog_status", p, recordingId, signal);
      insist(
        receipt.payload.state === "ready",
        "recognition_catalog_pending",
        409,
      );
      return receipt;
    },
    withdraw: (
      p: VerifiedPublication,
      recordingId?: string,
      signal?: AbortSignal,
    ) => send("catalog_withdraw", p, recordingId, signal),
  };
}
