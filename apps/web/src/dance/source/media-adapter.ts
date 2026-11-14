/** Adapter to the existing source3 media client/producer. This adds no upload,
 * rendering, storage, quota, billing or publication pipeline. The root must
 * mount expected-account and private Dance permission checks on the real API. */
import type { DanceCapture } from "../../../../../packages/dance/contracts.ts";
import { mediaClient } from "../../media/client.ts";
import { DanceClientError } from "../client.ts";
import {
  assertCapture,
  danceScopeKey,
  type DanceScope,
  type DancePrivateMediaPort,
} from "./ports.ts";
import { danceSession } from "./dance-preparation-api.ts";
import { validateDanceMedia } from "./dance-upload-controller.ts";
import { producerDigest } from "./digests.ts";
export function createDancePrivateMediaPort(input: {
  readonly scope: DanceScope;
  readonly currentScope: () => DanceScope | null;
  readonly csrf: () => string;
  readonly maximumBytes: number;
  readonly fetcher?: typeof fetch;
}): DancePrivateMediaPort {
  const original = structuredClone(input.scope),
    key = danceScopeKey(original);
  const currentScope = input.currentScope, csrf = input.csrf,
    fetcher = input.fetcher ?? fetch, maximumBytes = input.maximumBytes;
  // Exclusion guards only; the existing durable journey and server journal
  // remain authoritative across reload. Failed/canceled ACKs retain the same
  // original association rather than relinking a request to a newer capture.
  const requests = new Map<string, { captureId: string; captureHash: string; body: string }>();
  const mediaOwners = new Map<string, { captureId: string; captureHash: string }>();
  const current = () => {
    const s = currentScope();
    if (!s || danceScopeKey(s) !== key)
      throw new DanceClientError("dance_account_changed");
  };
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0)
    throw Error("dance_media_capability_unavailable");
  const clientFor = (signal: AbortSignal, capture: DanceCapture) => {
    const captureId = capture.captureId, captureHash = capture.captureHash;
    return mediaClient(csrf, async (url, init = {}) => {
      signal.throwIfAborted();
      current();
      const headers = new Headers(init.headers);
      headers.set("x-dance-account", original.accountId);
      if (String(url) === "/api/media" && init.method === "POST") {
        headers.set("x-dance-capture-id", captureId);
        headers.set("x-dance-capture-hash", captureHash);
      }
      const response = await fetcher(url, {
        ...init,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
      signal.throwIfAborted();
      current();
      // Preserve authoritative HTTP denial even if the source3 body parser could
      // not decode a proxy/plain-text response. No private payload is returned.
      if (response.status === 401 || response.status === 403)
        throw new DanceClientError(
          "dance_request_denied",
          false,
          response.status,
        );
      return response;
    });
  };
  const check = (capture: DanceCapture, signal: AbortSignal) => {
    signal.throwIfAborted();
    current();
    assertCapture(capture, original);
  };
  const mediaId = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id))
      throw Error("dance_upload_target_changed");
    return id;
  };
  const ownedMedia = (capture: DanceCapture, id: string) => {
    const known = mediaOwners.get(id);
    if (known && (known.captureId !== capture.captureId || known.captureHash !== capture.captureHash))
      throw Error("dance_upload_target_changed");
    return mediaId(id);
  };
  const bound = async <T>(
    capture: DanceCapture,
    signal: AbortSignal,
    work: (originalCapture: DanceCapture) => Promise<T>,
  ): Promise<T> => {
    capture = structuredClone(capture);
    check(capture, signal);
    const result = await work(capture);
    check(capture, signal);
    return result;
  };
  return {
    version: "pirate.dance-private-media-ui/1",
    maximumBytes,
    reserve: (c, intent, signal) => {
      intent = structuredClone(intent);
      return bound(c, signal, async (capture) => {
        if (
          intent.purpose !== "private-review" ||
          intent.publicConsent !== false ||
          intent.songKey !== capture.songKey ||
          intent.songRevision !== capture.songRevision ||
          intent.startSample !== capture.startSample ||
          intent.durationSamples !== capture.durationSamples ||
          !intent.requestId ||
          !/^[a-f0-9]{64}$/.test(intent.recordingSha256) ||
          !Number.isSafeInteger(intent.bytes) ||
          intent.bytes <= 0 ||
          intent.bytes > maximumBytes
        )
          throw Error("dance_upload_target_changed");
        const body = JSON.stringify(intent), prior = requests.get(intent.requestId);
        if (prior && (prior.captureId !== capture.captureId || prior.captureHash !== capture.captureHash || prior.body !== body))
          throw Error("dance_upload_target_changed");
        requests.set(intent.requestId, { captureId: capture.captureId, captureHash: capture.captureHash, body });
        const status = await clientFor(signal, capture).reserve(intent);
        check(capture, signal);
        ownedMedia(capture, status.id);
        mediaOwners.set(status.id, { captureId: capture.captureId, captureHash: capture.captureHash });
        return status;
      });
    },
    upload: (c, id, file, signal) =>
      bound(c, signal, (capture) =>
        clientFor(signal, capture).upload(ownedMedia(capture, id), file, signal),
      ),
    status: (c, id, signal) =>
      bound(c, signal, (capture) => clientFor(signal, capture).status(ownedMedia(capture, id))),
    retry: (c, id, signal) =>
      bound(c, signal, (capture) => clientFor(signal, capture).retry(ownedMedia(capture, id))),
    playback: async (review, signal) => {
      review = structuredClone(review);
      const status = await bound(review.capture, signal, (capture) =>
        clientFor(signal, capture).status(ownedMedia(capture, review.receipt.mediaId)),
      );
      validateDanceMedia(
        status,
        danceSession(review.capture, maximumBytes),
        producerDigest(review.media.recordingSha256),
        review.receipt.mediaId,
      );
      const url = `/api/media/${encodeURIComponent(review.receipt.mediaId)}/playback`;
      if (!status.ready || status.playbackUrl !== url)
        throw Error("dance_review_media_unavailable");
      const expiresAtMs = Math.min(status.ready.expiresAt, review.receipt.reviewDeadlineMs);
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now())
        throw new DanceClientError("dance_review_media_unavailable", false, 410);
      return {
        url,
        expiresAtMs,
      };
    },
  };
}
