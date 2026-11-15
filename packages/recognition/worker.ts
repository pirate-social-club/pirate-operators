import type { AcceptedIntent } from "./intent.ts";
import { sha256 } from "viem";
import { canonical, insist } from "../community/common.ts";
import {
  exactCatalogFile,
  type CatalogFile,
  type RecognitionCatalog,
  type Recording,
  type VerifiedPublication,
} from "./model.ts";
import { RecognitionStore } from "./store.ts";

export type RecognitionEffect = "lookup" | "upload" | "verify" | "delete";
export type Verification =
  | { outcome: "match"; matchId: string; evidenceSha256: string }
  | { outcome: "waiting" | "rejected" };
export interface EnrollmentDependencies {
  catalog: RecognitionCatalog;
  /** Required for accepted-intent sources; fresh owner/private-media authority. */
  authorizeSource?(source:VerifiedPublication | AcceptedIntent):Promise<void>;
  /** Bounded server-owned object capability; no caller-selected URL. */
  readAudio(
    publication: VerifiedPublication | AcceptedIntent,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  /** Implementations call beforeSend immediately before each actual provider request. */
  verify(
    recording: Recording,
    publication: VerifiedPublication | AcceptedIntent,
    signal: AbortSignal,
    beforeSend: () => Promise<void>,
  ): Promise<Verification>;
  recoverVerification(recording: Recording): Promise<Verification | null>;
  /** Reserve/check service and community quotas without resetting prior allowances. */
  authorizeEffect(
    effect: RecognitionEffect,
    recording: Recording,
  ): Promise<void>;
}
export type EnrollmentResult =
  | "idle"
  | "waiting"
  | "progress"
  | "ready"
  | "deleted"
  | "failed";

/** One leased durable advance. Queues only wake this function, never authorize sends. */
export async function advanceEnrollment(
  store: RecognitionStore,
  id: string,
  deps: EnrollmentDependencies,
  signal = new AbortController().signal,
): Promise<EnrollmentResult> {
  let r = await store.claim(id);
  if (!r) return "idle";
  const beforeSend = (effect: RecognitionEffect) => async () => {
    signal.throwIfAborted();
    await deps.authorizeEffect(effect, r!);
    signal.throwIfAborted();
    await store.requireClaim(r!);
    // A final withdrawal after an asynchronous quota/media read cannot authorize upload.
    if (effect === "upload" || effect === "verify") {
      const source=await store.source(id);
      insist(source,"recognition_association_withdrawn",409);
      if('schema' in source) insist(deps.authorizeSource,"recognition_intent_verifier_unconfigured",503);
      await deps.authorizeSource?.(source);
      insist(canonical(await store.source(id))===canonical(source),"recognition_source_changed",409);
    }
    await store.requireClaim(r!);
  };
  const accept = async (file: CatalogFile) => {
    insist(
      exactCatalogFile(r!, file),
      "recognition_catalog_identity_changed",
      409,
    );
    r = await store.transition(
      r!,
      file.state === "error" ? "failed" : "processing",
      { file },
      file,
    );
  };
  try {
    signal.throwIfAborted();
    const publication = await store.source(id);
    if (!publication) {
      if (r.state === "pending") {
        r = await store.transition(r, "deleted", {
          reason: "withdrawn_before_upload",
        });
        return "deleted";
      }
      if (!r.provider_file_id) {
        const found = await deps.catalog.find(r, signal, beforeSend("lookup"));
        if (found.outcome === "exact") {
          await accept(found.file);
          return "progress";
        }
        // Absence after an unknown send is not proof that no provider object exists.
        return "waiting";
      }
      if (r.state !== "deleting")
        r = await store.transition(r, "deleting", {
          fileId: r.provider_file_id,
        });
      const removed = await deps.catalog.remove(
        r,
        signal,
        beforeSend("delete"),
      );
      if (removed !== "deleted") return "waiting";
      r = await store.transition(r, "deleted", { fileId: r.provider_file_id });
      return "deleted";
    }
    if (r.state === "pending" || r.state === "upload_unknown") {
      const found = await deps.catalog.find(r, signal, beforeSend("lookup"));
      if (found.outcome === "exact") {
        await accept(found.file);
        return "progress";
      }
      if (found.outcome === "ambiguous") {
        r = await store.transition(r, "failed", {
          reason: "ambiguous_catalog_record",
        });
        return "failed";
      }
      if (found.outcome === "retryable" || r.state === "upload_unknown")
        return "waiting";
      const audio = await deps.readAudio(publication, signal);
      insist(
        audio.byteLength === r.audio_bytes && sha256(audio) === r.audio_sha256,
        "recognition_audio_changed",
        409,
      );
      // Persist intent BEFORE the request. Death before the send can leave a
      // conservative unknown, but death after a send cannot authorize a duplicate.
      r = await store.transition(r, "upload_unknown", {
        reason: "upload_intent",
      });
      const result = await deps.catalog.upload(
        r,
        audio,
        signal,
        beforeSend("upload"),
      );
      if (result.outcome === "unknown") return "waiting";
      if (result.outcome === "rejected") {
        r = await store.transition(r, "failed", {
          reason: "catalog_upload_rejected",
        });
        return "failed";
      }
      await accept(result.file);
      return "progress";
    }
    const finishVerification = async (verified: Verification) => {
      if (verified.outcome === "waiting") {
        r = await store.transition(r!, "processing", {
          reason: "known_inconclusive_verification",
        });
        return "waiting" as const;
      }
      if (verified.outcome !== "match") {
        r = await store.transition(r!, "failed", {
          reason: "catalog_verification_rejected",
        });
        return "failed" as const;
      }
      insist(
        verified.matchId === r!.provider_match_id &&
          /^0x[0-9a-f]{64}$/.test(verified.evidenceSha256),
        "recognition_verification_mismatch",
        409,
      );
      r = await store.transition(r!, "ready", verified);
      return "ready" as const;
    };
    if (r.state === "verification_unknown") {
      const retained = await deps.recoverVerification(r);
      if (retained) return await finishVerification(retained);
      return "waiting";
    }
    if (r.state !== "processing") return "waiting";
    const found = await deps.catalog.find(r, signal, beforeSend("lookup"));
    if (found.outcome !== "exact") return "waiting";
    insist(
      found.file.fileId === r.provider_file_id &&
        found.file.matchId === r.provider_match_id &&
        exactCatalogFile(r, found.file),
      "recognition_catalog_identity_changed",
      409,
    );
    if (found.file.state === "processing") return "waiting";
    if (found.file.state === "error") {
      r = await store.transition(r, "failed", {
        reason: "catalog_processing_failed",
      });
      return "failed";
    }
    r = await store.transition(r, "verification_unknown", {
      reason: "verification_intent",
    });
    return await finishVerification(
      await deps.verify(r, publication, signal, beforeSend("verify")),
    );
  } finally {
    await store.release(r);
  }
}
