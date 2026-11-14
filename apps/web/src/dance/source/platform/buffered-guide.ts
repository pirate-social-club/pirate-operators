export type ReadSongGuideGrant = (
  postId: string,
  signal: AbortSignal,
) => Promise<import("../../../../../../packages/dance/production.ts").DanceGuideAccess>;

/** Full compressed song bound; refused files never start a camera take. */
export const GUIDE_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
export const GUIDE_DOWNLOAD_TIMEOUT_MS = 30_000;
export interface BufferedGuideSource {
  readonly url: string;
  /** The same complete, bounded download behind url; decoders need no Blob fetch. */
  readonly blob: Blob;
  readonly expiresAtSeconds?: number;
  release(): void;
}
export type GuideSourcePreparation = (
  postId: string,
  signal: AbortSignal,
) => Promise<BufferedGuideSource>;

/** A fresh grant and a complete local copy for this take, never a cached URL. */
export async function prepareBufferedGuide(
  postId: string,
  signal: AbortSignal,
  dependencies: {
    readonly readGrant: ReadSongGuideGrant;
    readonly fetch?: typeof fetch;
    readonly createObjectURL?: (blob: Blob) => string;
    readonly revokeObjectURL?: (url: string) => void;
    readonly maxBytes?: number;
  },
): Promise<BufferedGuideSource> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, GUIDE_DOWNLOAD_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    controller.signal.throwIfAborted();
    const grant = await dependencies.readGrant(postId, controller.signal);
    controller.signal.throwIfAborted();
    const url = new URL(grant.playback_url);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Guide grant refused");
    const send = dependencies.fetch ?? fetch;
    const response = await send(url, {
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    const maxBytes = dependencies.maxBytes ?? GUIDE_AUDIO_MAX_BYTES;
    const length = response.headers.get("content-length");
    const expected = length === null ? null : Number(length);
    if (
      !response.ok ||
      !response.body ||
      (expected !== null &&
        (!Number.isSafeInteger(expected) ||
          expected <= 0 ||
          expected > maxBytes))
    ) {
      await response.body?.cancel();
      throw new Error("Guide download refused");
    }
    reader = response.body.getReader();
    const cancel = () => {
      void reader?.cancel().catch(() => {});
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let bytes = 0;
      while (true) {
        controller.signal.throwIfAborted();
        const next = await reader.read();
        controller.signal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes || (expected !== null && bytes > expected))
          throw new Error("Guide size refused");
        chunks.push(new Uint8Array(next.value));
      }
      if (bytes === 0 || (expected !== null && bytes !== expected))
        throw new Error("Guide incomplete");
      const blob = new Blob(chunks, {
        type:
          response.headers.get("content-type") ?? "application/octet-stream",
      });
      controller.signal.throwIfAborted();
      const objectUrl = (
        dependencies.createObjectURL ?? ((value) => URL.createObjectURL(value))
      )(blob);
      let released = false;
      return {
        url: objectUrl,
        blob,
        expiresAtSeconds: grant.expires_at,
        release() {
          if (released) return;
          released = true;
          (
            dependencies.revokeObjectURL ??
            ((value) => URL.revokeObjectURL(value))
          )(objectUrl);
        },
      };
    } finally {
      controller.signal.removeEventListener("abort", cancel);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
