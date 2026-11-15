import {
  canonicalPath,
  signCanonicalRequest,
  readCanonicalBytes,
  verifyCanonicalResponse,
  canonicalAuthority,
  type CanonicalAction,
} from "./canonical-protocol.ts";
import { sha256 } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  bytes32,
  canonical,
  exact,
  hashJson,
  insist,
  object,
  text,
} from "../community/common.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { address } from "../community/manifest-core.ts";
import { validateLyrics } from "../community/lyric-manifest.ts";
import { requireAuthorizedOwner } from "../community/owner-authorization.ts";
import { recognitionRequestTypes } from "./authorization.ts";
import type { ReleaseContext } from "../release/authority.ts";
import { acceptedIntent, reservationId } from "./intent.ts";
import {
  verifyReservation,
  type ReservationReceipt,
} from "./reservation-receipt.ts";
import {
  canonicalPostingBinding,
  canonicalPostingInput,
  independentCanonicalPublication,
  requireFirstSongRevision,
  type CanonicalChainInputs,
} from "./canonical-chain.ts";
import type {
  CanonicalCommunity,
  CanonicalSnapshot,
  CanonicalSource,
} from "./canonical-community.ts";
import { requireSameCanonicalSource } from "./canonical-community.ts";

async function snapshot(
  input: unknown,
  config: CommunityConfig,
): Promise<CanonicalSnapshot> {
  const v = object(input);
  exact(v, [
    "intent",
    "config",
    "context",
    "title",
    "lyrics",
    "ownerAuthorization",
  ]);
  const intent = acceptedIntent(v.intent),
    c = object(v.context);
  requireFirstSongRevision(intent.publicationRevision);
  const owner = await requireAuthorizedOwner(
    v.ownerAuthorization,
    config,
    intent.creatorKey.slice("eip155:6343:".length),
  );
  insist(
    hashJson(owner) === intent.ownerAuthorizationSha256,
    "recognition_owner_authority_changed",
    403,
  );
  exact(c, [
    "jobId",
    "admissionId",
    "postId",
    "authorId",
    "recipient",
    "lineage",
    "lyrics",
    "rating",
  ]);
  insist(
    c.lineage === "root" && (c.rating === "general" || c.rating === "adult"),
    "canonical_release_context_changed",
    409,
  );
  const context: ReleaseContext = {
    jobId: text(c.jobId, 128),
    admissionId: bytes32(c.admissionId),
    postId: bytes32(c.postId),
    authorId: bytes32(c.authorId),
    recipient: address(c.recipient),
    lineage: "root" as const,
    lyrics: validateLyrics(c.lyrics),
    rating: c.rating,
  };
  insist(
    canonical(v.config) === canonical(config) &&
      intent.communityId === config.communityId &&
      intent.configurationRevision === config.configurationRevision &&
      intent.communityOrigin === config.app.origin &&
      intent.namespace === config.policies.recognition?.namespace &&
      intent.profileSha256 === config.policies.recognition?.sha256 &&
      context.jobId === intent.jobId &&
      context.postId === intent.postId &&
      context.lyrics.communityId === intent.communityId &&
      context.lyrics.postId === intent.postId &&
      context.lyrics.postsContract === config.postsContract &&
      context.lyrics.sourceText === v.lyrics,
    "canonical_snapshot_changed",
    409,
  );
  return {
    intent,
    config,
    context,
    title: text(v.title, 200),
    lyrics: text(v.lyrics, 256 * 1024),
    ownerAuthorization: v.ownerAuthorization,
  };
}
export interface CanonicalClientInputs {
  signer: PrivateKeyAccount;
  chain: CanonicalChainInputs;
  /** Independently selected registry/chain reader, never learned from a response. */
  currentConfiguration(): Promise<CommunityConfig>;
  transport?: (request: Request) => Promise<Response>;
}
export function canonicalCommunityClient(
  inputs: CanonicalClientInputs,
): CanonicalCommunity & {
  ready(
    intent: import("./intent.ts").AcceptedIntent,
  ): Promise<ReservationReceipt>;
} {
  const call = async (
    action: CanonicalAction,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const config = await inputs.currentConfiguration(),
      wire = await signCanonicalRequest(inputs.signer, config, action, body),
      deadline = AbortSignal.any([
        AbortSignal.timeout(30000),
        ...(signal ? [signal] : []),
      ]);
    const response = await (inputs.transport ?? fetch)(
      new Request(config.app.origin + canonicalPath, {
        method: "POST",
        redirect: "error",
        signal: deadline,
        headers: { "content-type": "application/json" },
        body: canonical(wire),
      }),
    );
    insist(response.ok, "canonical_community_unavailable", 503);
    insist(
      response.headers.get("content-type") ===
        (action === "audio" ? "application/octet-stream" : "application/json"),
      "canonical_response_invalid",
      503,
    );
    const bytes = await readCanonicalBytes(
      response,
      action === "audio" ? 25 * 1024 * 1024 : 1024 * 1024,
      deadline,
    );
    await verifyCanonicalResponse(
      JSON.parse(response.headers.get("x-pirate-canonical-receipt") ?? "null"),
      wire,
      config,
      bytes,
    );
    insist(
      canonical(await inputs.currentConfiguration()) === canonical(config),
      "canonical_authority_changed",
      403,
    );
    deadline.throwIfAborted();
    return {
      config,
      wire,
      data:
        action === "audio"
          ? bytes
          : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  };
  const sourceBody = (p: CanonicalSource) => {
    requireFirstSongRevision(p.publicationRevision);
    return { source: p };
  };
  return {
    currentConfiguration: () => inputs.currentConfiguration(),
    async read(jobId) {
      const r = await call("read", { jobId }),
        value = await snapshot(r.data, r.config);
      insist(value.intent.jobId === jobId, "canonical_snapshot_changed", 409);
      return value;
    },
    async source(p) {
      const response = await call("source", sourceBody(p)),
        value = await snapshot(response.data, response.config);
      return requireSameCanonicalSource(value.intent, p);
    },
    async posting(p, claimed) {
      requireFirstSongRevision(p.publicationRevision);
      const response = await call("posting", { intent: p, posting: claimed }),
        value = canonicalPostingBinding(response.data);
      insist(
        canonical(value) === canonical(claimed),
        "canonical_posting_invalid",
        409,
      );
      await canonicalPostingInput(p, value, response.config);
      return value;
    },
    async publication(p, claimed) {
      requireFirstSongRevision(p.publicationRevision);
      const response = await call("publication", {
          intent: p,
          posting: claimed,
        }),
        witness = await independentCanonicalPublication(
          response.data,
          response.config,
          inputs.chain,
        );
      insist(
        canonical(witness.intent) === canonical(p) &&
          canonical(witness.posting) === canonical(claimed),
        "recognition_intent_changed",
        409,
      );
      insist(
        canonical(await inputs.currentConfiguration()) ===
          canonical(response.config),
        "canonical_authority_changed",
        403,
      );
      return witness.publication;
    },
    async findPublication(postId, revision) {
      requireFirstSongRevision(revision);
      const r = await call("find_publication", { postId, revision });
      if (r.data === null) return null;
      const value = (
        await independentCanonicalPublication(r.data, r.config, inputs.chain)
      ).publication;
      insist(
        value.communityId === r.config.communityId &&
          value.postId === postId &&
          value.publicationRevision === revision,
        "canonical_publication_changed",
        409,
      );
      insist(
        canonical(await inputs.currentConfiguration()) === canonical(r.config),
        "canonical_authority_changed",
        403,
      );
      return value;
    },
    async audio(p, signal) {
      const bytes = (await call("audio", sourceBody(p), signal))
        .data as Uint8Array<ArrayBuffer>;
      insist(
        bytes.byteLength === p.audioBytes && sha256(bytes) === p.audioSha256,
        "recognition_audio_changed",
        409,
      );
      return bytes;
    },
    async authorize(p, operationId) {
      await call("authorize", { source: p, operationId });
    },
    async ready(p) {
      requireFirstSongRevision(p.publicationRevision);
      const response = await call("ready", { intent: p }),
        data = object(response.data);
      exact(data, ["request", "receipt"]);
      const request = object(data.request),
        a = object(request.authorization),
        body = object(request.body),
        profile = canonicalAuthority(response.config);
      exact(request, ["authorization", "body", "signature"]);
      exact(body, ["jobId"]);
      exact(
        a,
        recognitionRequestTypes.RecognitionRequest.map((f) => f.name),
      );
      insist(
        a.action === "intent_status" &&
          a.nonce === response.wire.payload.nonce &&
          a.namespace === profile.namespace &&
          a.profileSha256 === profile.sha256 &&
          a.communityId === p.communityId &&
          a.communityOrigin === p.communityOrigin &&
          a.serviceOrigin === profile.origin &&
          a.configurationRevision === p.configurationRevision &&
          a.publisher === response.config.publisher &&
          a.bodySha256 === hashJson(body) &&
          body.jobId === p.jobId,
        "recognition_reservation_scope_mismatch",
        403,
      );
      const r = await verifyReservation(
        data.receipt,
        profile,
        {
          purpose: "accepted_intent",
          namespace: profile.namespace,
          profileSha256: profile.sha256,
          communityId: p.communityId,
          configurationRevision: p.configurationRevision,
          intentSha256: hashJson(p),
          reservationId: reservationId(p),
          requestSha256: hashJson(request),
        },
        Math.floor(Date.now() / 1000),
      );
      insist(
        r.intentSha256 === hashJson(p) &&
          r.reservationId === reservationId(p) &&
          r.communityId === p.communityId &&
          r.configurationRevision === p.configurationRevision &&
          r.profileSha256 === p.profileSha256 &&
          r.namespace === p.namespace &&
          ["ready", "committing", "committed"].includes(r.state) &&
          r.recordingState === "ready" &&
          r.recordingId &&
          r.expiresAt > Math.floor(Date.now() / 1000),
        "catalog_pending",
        503,
      );
      insist(
        canonical(await inputs.currentConfiguration()) ===
          canonical(response.config),
        "canonical_authority_changed",
        403,
      );
      return r;
    },
  };
}
