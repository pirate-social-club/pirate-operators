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
  const current = () => {
    const s = input.currentScope();
    if (!s || danceScopeKey(s) !== key)
      throw new DanceClientError("dance_account_changed");
  };
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0)
    throw Error("dance_media_capability_unavailable");
  const clientFor = (signal: AbortSignal) =>
    mediaClient(input.csrf, async (url, init = {}) => {
      current();
      const headers = new Headers(init.headers);
      headers.set("x-dance-account", original.accountId);
      const response = await (input.fetcher ?? fetch)(url, {
        ...init,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
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
  const bound = async <T>(
    capture: DanceCapture,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> => {
    check(capture, signal);
    const result = await work();
    check(capture, signal);
    return result;
  };
  return {
    version: "pirate.dance-private-media-ui/1",
    maximumBytes: input.maximumBytes,
    reserve: (c, intent, signal) =>
      bound(c, signal, () => {
        if (
          intent.purpose !== "private-review" ||
          intent.publicConsent !== false ||
          intent.songKey !== c.songKey ||
          intent.songRevision !== c.songRevision ||
          intent.startSample !== c.startSample ||
          intent.durationSamples !== c.durationSamples ||
          !intent.requestId ||
          !/^[a-f0-9]{64}$/.test(intent.recordingSha256) ||
          !Number.isSafeInteger(intent.bytes) ||
          intent.bytes <= 0 ||
          intent.bytes > input.maximumBytes
        )
          throw Error("dance_upload_target_changed");
        return clientFor(signal).reserve(intent);
      }),
    upload: (c, id, file, signal) =>
      bound(c, signal, () =>
        clientFor(signal).upload(mediaId(id), file, signal),
      ),
    status: (c, id, signal) =>
      bound(c, signal, () => clientFor(signal).status(mediaId(id))),
    retry: (c, id, signal) =>
      bound(c, signal, () => clientFor(signal).retry(mediaId(id))),
    playback: async (review, signal) => {
      const status = await bound(review.capture, signal, () =>
        clientFor(signal).status(mediaId(review.receipt.mediaId)),
      );
      validateDanceMedia(
        status,
        danceSession(review.capture, input.maximumBytes),
        producerDigest(review.media.recordingSha256),
        review.receipt.mediaId,
      );
      const url = `/api/media/${encodeURIComponent(review.receipt.mediaId)}/playback`;
      if (!status.ready || status.playbackUrl !== url)
        throw Error("dance_review_media_unavailable");
      return {
        url,
        expiresAtMs: Math.min(
          status.ready.expiresAt,
          review.receipt.reviewDeadlineMs,
        ),
      };
    },
  };
}
