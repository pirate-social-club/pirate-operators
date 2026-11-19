import { bytes32, canonical, exact, hashJson, object } from "../../packages/community/common.ts";

const compactReservation = "/publication/v1/posts-catalog-reservation";
const canonicalResponse = "/publication/v1/posts-catalog-respond";
const canonicalReads = new Set(["read", "source", "audio", "protected_selection"]);

export type ProtectedPostsReadLane = "ready" | "canonical";
export type ProtectedPostsMixedRoute = "reservation" | "response";

export function protectedPostsMixedRoute(path?: string): ProtectedPostsMixedRoute | undefined {
  if (path === compactReservation) return "reservation";
  if (path === canonicalResponse) return "response";
}

export function protectedPostsMixedLimit(route: ProtectedPostsMixedRoute) {
  return route === "reservation" ? 4096 : 64 * 1024;
}

// Scheduling uses the same immutable bytes the private holder authenticates.
// Only the holder can authorize a read or select its original.
export function protectedPostsReadLane(route: ProtectedPostsMixedRoute, bytes: Uint8Array): ProtectedPostsReadLane | undefined {
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = object(JSON.parse(raw));
  if (raw !== canonical(value)) throw Error("protected_posts_request_not_canonical");
  if (route === "reservation") {
    if (value.purpose === "reserve" || value.purpose === "status") return;
    exact(value, ["version", "purpose", "reference", "initiatingLeaseSha256"]);
    const ref = object(value.reference);
    exact(ref, ["installationId", "releaseSha256", "jobId", "operationId", "requestHash", "step"]);
    if (value.version !== "pirate.native-posts-catalog-reservation-request/1" || value.purpose !== "ready" ||
      ref.step !== "publication" || typeof ref.jobId !== "string" ||
      !/^publication:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(ref.jobId) ||
      bytes32(ref.operationId) !== hashJson({ job: ref.jobId, step: ref.step })) {
      throw Error("protected_posts_ready_scope_changed");
    }
    for (const digest of [ref.installationId, ref.releaseSha256, ref.requestHash, value.initiatingLeaseSha256]) {
      bytes32(digest);
    }
    return "ready";
  }

  exact(value, ["payload", "body", "signature"]);
  const scope = object(value.payload), body = object(value.body);
  if (scope.schema !== "pirate.canonical-community-request/1" || typeof scope.action !== "string" ||
    scope.bodySha256 !== hashJson(body) || typeof value.signature !== "string") {
    throw Error("protected_posts_canonical_scope_changed");
  }
  if (scope.action === "ready") return "ready";
  if (canonicalReads.has(scope.action)) return "canonical";
  if (scope.action !== "authorize") throw Error("protected_posts_canonical_purpose_changed");
}
