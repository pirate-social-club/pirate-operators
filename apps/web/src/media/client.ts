import type {
  MediaCapability,
  MediaFeedPage,
  MediaIntent,
  MediaStatus,
} from "../../../../packages/community-media/contracts.ts";
export type {
  MediaFeedItem,
  MediaStatus,
  ReadyMedia,
} from "../../../../packages/community-media/contracts.ts";
export interface MediaClient {
  feed(cursor?: string): Promise<MediaFeedPage>;
  capability(
    songKey: string,
    songRevision: number,
  ): Promise<{
    publicPosting: MediaCapability;
    privateReview: MediaCapability;
  }>;
  reserve(intent: MediaIntent): Promise<MediaStatus>;
  upload(id: string, file: File, signal?: AbortSignal): Promise<MediaStatus>;
  status(id: string): Promise<MediaStatus>;
  retry(id: string): Promise<MediaStatus>;
  withdraw(id: string): Promise<MediaStatus>;
}
/** A parsed HTTP refusal is distinct from a lost or malformed acknowledgement. */
export class MediaHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(mediaErrorText(code));
    this.name = "MediaHttpError";
    this.status = status;
    this.code = code;
  }
}
export function mediaErrorText(code: string) {
  const messages: Record<string, string> = {
    media_public_posting_not_permitted:
      "Public video posting is not enabled for this account.",
    media_processor_unavailable:
      "Video processing is unavailable. Your private upload is saved; retry when the community is ready.",
    media_processing_failed:
      "The video could not be processed. Try again or choose a different clip.",
    media_source_too_short:
      "The recording must cover the entire selected song segment.",
    media_video_too_short:
      "The picture must cover the entire selected song segment. A longer audio track does not extend the video.",
    media_commit_outcome_unknown:
      "Your request could not be confirmed. Resume it without making a new submission.",
    media_private_policy_unconfigured:
      "Recording isn’t available for this dance right now.",
    media_video_invalid:
      "Choose an MP4, MOV or WebM video with a valid picture.",
    media_recording_mismatch:
      "The uploaded file did not match. Please choose it again.",
    media_song_revision_changed:
      "This song has changed. Reopen the song and choose its current version.",
    media_account_inactive:
      "Reconnect your community account before continuing.",
    media_upload_expired:
      "This upload expired. Start again with the same recording.",
    media_too_large: "Choose a video smaller than 32 MiB.",
    media_retry_unavailable:
      "This video cannot be retried. Start a new upload.",
    media_capacity_full:
      "The community's video storage allowance is full. Withdraw an unused recording or try later.",
  };
  return (
    messages[code] ??
    "The community could not complete this video request. Please try again."
  );
}
/** Same-origin session/CSRF transport, supplied a fresh session CSRF getter. */
export function mediaClient(
  csrf: () => string,
  transport: typeof fetch = fetch,
): MediaClient {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.method && !["GET", "HEAD"].includes(init.method))
      headers.set("x-csrf-token", csrf());
    const response = await transport(path, {
      ...init,
      headers,
      credentials: "same-origin",
    });
    // Retain the HTTP authentication status independently of body decoding.
    // Structured policy refusals keep their original code. Intermediary HTML,
    // empty bodies and rejected/malformed JSON must still produce an auth hold.
    const authenticationStatus =
      response.status === 401 || response.status === 403;
    if (
      authenticationStatus &&
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json")
    )
      throw new MediaHttpError(
        response.status,
        "media_authentication_required",
      );
    let body: { error?: unknown } | null;
    try {
      body = await response.json();
    } catch (error) {
      if (authenticationStatus)
        throw new MediaHttpError(
          response.status,
          "media_authentication_required",
        );
      throw error;
    }
    if (!response.ok)
      throw new MediaHttpError(
        response.status,
        typeof body?.error === "string"
          ? body.error
          : authenticationStatus
            ? "media_authentication_required"
            : "media_service_unavailable",
      );
    return body as T;
  }
  return {
    feed: (cursor) =>
      call(
        `/api/media/feed${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    capability: (songKey, songRevision) =>
      call(
        `/api/media/capability?songKey=${encodeURIComponent(songKey)}&songRevision=${songRevision}`,
      ),
    reserve: (intent) =>
      call("/api/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intent),
      }),
    upload: (id, file, signal) =>
      call(`/api/media/${id}/upload`, { method: "PUT", body: file, signal }),
    status: (id) => call(`/api/media/${id}`),
    retry: (id) => call(`/api/media/${id}/retry`, { method: "POST" }),
    withdraw: (id) => call(`/api/media/${id}`, { method: "DELETE" }),
  };
}
