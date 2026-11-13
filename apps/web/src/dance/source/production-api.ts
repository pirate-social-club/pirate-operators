import type { DanceCapture, DanceReview } from "../../../../../packages/dance/contracts.ts";
import { sameDanceTarget, validDanceTarget, type DanceCataloguePage,
  type DanceProductionTarget, type DanceReferenceGrant, type DanceGuideGrant } from "../../../../../packages/dance/production.ts";
import { DanceClientError } from "../client.ts";
import { assertDanceReview } from "./dance-review-api.ts";
import { assertCapture, captureTarget, type DanceCatalogue } from "./ports.ts";
import type { createProductionDanceAccount } from "./production-account.ts";

export function createProductionDanceApi(input: {
  owner: ReturnType<typeof createProductionDanceAccount>;
  fetcher?: typeof fetch;
}) {
  const lifetime = new AbortController();
  const unsubscribe = input.owner.account.subscribe(() => lifetime.abort());
  async function get<T>(path: string, signal: AbortSignal): Promise<T> {
    const owner = input.owner.currentOwner();
    if (!owner || lifetime.signal.aborted) throw new DanceClientError("dance_account_changed");
    const check = () => {
      signal.throwIfAborted();
      const fresh = input.owner.currentOwner();
      if (lifetime.signal.aborted || !fresh || fresh.communityId !== owner.communityId ||
        fresh.accountId !== owner.accountId || fresh.sessionKey !== owner.sessionKey || fresh.csrf !== owner.csrf)
        throw new DanceClientError("dance_account_changed");
    };
    check();
    const response = await (input.fetcher ?? fetch)("/api/dance/" + path, {
      credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.any([signal, lifetime.signal]),
      headers: { "x-dance-account": owner.accountId },
    });
    check();
    // Headers are authoritative. Do not await a proxy's stalled denial body.
    if (response.status === 401 || response.status === 403) {
      input.owner.deny();
      throw new DanceClientError("dance_request_denied", false, response.status);
    }
    let value: unknown;
    try { value = await response.json(); }
    catch { check(); throw new DanceClientError("dance_response_unavailable", false, response.status); }
    check();
    if (!response.ok) throw new DanceClientError(
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error : "dance_request_refused", false, response.status,
    );
    return value as T;
  }
  const targetQuery = (target: DanceProductionTarget) => {
    if (!validDanceTarget(target)) throw Error("dance_preparation_target_changed");
    return "target=" + encodeURIComponent(JSON.stringify({ communityId: target.communityId,
      songKey: target.songKey, songRevision: target.songRevision, audioSha256: target.audioSha256,
      reference: target.reference ? { id: target.reference.id, revision: target.reference.revision } : null,
      offerId: target.offerId }));
  };
  const catalogue: DanceCatalogue = {
    async options(query, signal) {
      const owner = input.owner.currentOwner();
      if (!owner || owner.communityId !== query.communityId || owner.accountId !== query.accountId)
        throw new DanceClientError("dance_account_changed");
      const p = new URLSearchParams({ songKey: query.songKey });
      if (query.cursor) p.set("cursor", query.cursor);
      const page = await get<DanceCataloguePage>("catalogue?" + p, signal);
      if (page.version !== "pirate.dance-catalogue/1" || page.communityId !== query.communityId ||
        page.accountId !== query.accountId || !Array.isArray(page.choices) ||
        page.choices.length > 100 || typeof page.owner !== "boolean" ||
        !(page.cursor === null || typeof page.cursor === "string") ||
        !page.consent || typeof page.consent.version !== "string" || !page.consent.version ||
        typeof page.consent.text !== "string" ||
        !/^0x[0-9a-f]{64}$/.test(page.consent.termsHash) ||
        !/^0x[0-9a-f]{64}$/.test(page.consent.publicityPolicyHash) ||
        !["admitted", "review_pending"].includes(page.consent.admission) ||
        page.choices.some(c => !validDanceTarget(c) || c.communityId !== query.communityId ||
          c.songKey !== query.songKey || typeof c.title !== "string" || !c.title ||
          !Number.isSafeInteger(c.durationMs) || c.durationMs < 6000 || c.durationMs > 30000 ||
          !["ready", "pending", "unavailable"].includes(c.playback) || typeof c.recordingAllowed !== "boolean"))
        throw Error("dance_catalogue_binding_mismatch");
      return page;
    },
    async latest(scope, signal) {
      const r = await get<DanceReview | null>("latest?" + targetQuery(scope), signal);
      if (r !== null) assertDanceReview(r, scope);
      return r;
    },
  };
  return {
    catalogue,
    async songKeyForPost(postId: string, signal: AbortSignal) {
      if (!/^0x[0-9a-f]{64}$/.test(postId)) throw Error("dance_song_target_changed");
      const owner = input.owner.currentOwner();
      const r = await get<{ version: string; communityId: string; accountId: string;
        postId: string; songKey: string; bindingOnly: boolean }>("songs/" + postId, signal);
      if (!owner || r.version !== "pirate.dance-song-key/1" || r.communityId !== owner.communityId ||
        r.accountId !== owner.accountId || r.postId !== postId || r.bindingOnly !== true ||
        !/^0x[0-9a-f]{64}$/.test(r.songKey) || /^0x0+$/.test(r.songKey)) throw Error("dance_song_target_changed");
      return r.songKey;
    },
    async review(id: string, signal: AbortSignal) {
      if (!/^[a-zA-Z0-9_:-]{1,128}$/.test(id)) throw Error("dance_review_target_mismatch");
      const r = await get<DanceReview>("reviews/" + encodeURIComponent(id), signal);
      const owner = input.owner.currentOwner();
      if (!owner || r.reviewId !== id || r.capture.learner.accountId !== owner.accountId ||
        r.capture.communityId !== owner.communityId) throw Error("dance_review_target_mismatch");
      assertDanceReview(r, { ...captureTarget(r.capture), ...owner });
      return r;
    },
    async captureAccess(c: DanceCapture, signal: AbortSignal) {
      const result = await get<{ version: string; capture: DanceCapture }>(
        "captures/" + encodeURIComponent(c.captureId) + "/access", signal,
      );
      if (result.version !== "pirate.dance-capture-access/1" ||
        result.capture.captureId !== c.captureId || result.capture.captureHash !== c.captureHash ||
        JSON.stringify(result.capture) !== JSON.stringify(c)) throw Error("dance_preparation_target_changed");
      assertCapture(result.capture, captureTarget(c));
    },
    guide: (c: DanceCapture, signal: AbortSignal) =>
      get<DanceGuideGrant>("captures/" + encodeURIComponent(c.captureId) + "/guide", signal),
    async reference(target: DanceProductionTarget, signal: AbortSignal) {
      if (!target.reference) throw Error("dance_reference_unavailable");
      const r = await get<DanceReferenceGrant>("reference?" + targetQuery(target), signal);
      if (!validDanceTarget(r.target) || !sameDanceTarget(r.target, target) ||
        typeof r.url !== "string" || !Number.isSafeInteger(r.expiresAt) ||
        !Number.isSafeInteger(r.renewAt) || r.renewAt <= Date.now() ||
        r.expiresAt <= r.renewAt) throw Error("dance_reference_unavailable");
      return { url: r.url, expiresAt: r.expiresAt, renewAt: r.renewAt };
    },
    dispose() { unsubscribe(); lifetime.abort(); },
  };
}
