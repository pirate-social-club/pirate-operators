import {
  digestBytes,
  MEDIA_ATTEMPT_VERSION,
  type MediaAttempt,
  type MediaAttemptStorage,
} from "../src/media/media-attempt.ts";
import type {
  MediaStatus,
  ReadyMedia,
} from "../../../packages/community-media/contracts.ts";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const status = (
  state: MediaStatus["state"],
  extra: Partial<MediaStatus> = {},
): MediaStatus => ({
  id: "media-fixture",
  state,
  purpose: "public-feed",
  canRetry: false,
  expiresAt: 2000000000000,
  ...extra,
});
export async function retained(): Promise<MediaAttempt> {
  const file = new File(["retained recording fixture"], "fixture.mp4", {
    type: "video/mp4",
  });
  const intent = {
    requestId: "request-fixture",
    songKey: "song-fixture",
    songRevision: 7,
    recordingSha256: await digestBytes(await file.arrayBuffer()),
    bytes: file.size,
    startSample: 48000,
    durationSamples: 480000,
    purpose: "public-feed" as const,
    publicConsent: true,
  };
  return {
    version: MEDIA_ATTEMPT_VERSION,
    accountId: "account-fixture",
    communityId: "community-fixture",
    file,
    rating: "general",
    song: {
      communityId: "community-fixture",
      songKey: intent.songKey,
      songRevision: 7,
      audioSha256: "a".repeat(64),
      durationSamples: 960000,
      title: "Fixture",
    },
    intent,
    intentDigest: await digestBytes(
      new TextEncoder().encode(JSON.stringify(intent)),
    ),
    status: status("uploading"),
    pending: "upload",
    commandDispatched: true,
  };
}
export function memory(initial: MediaAttempt) {
  let value: MediaAttempt | null = initial,
    lock: Promise<unknown> = Promise.resolve();
  const history: MediaAttempt[] = [];
  const storage: MediaAttemptStorage = {
    exclusive<T>(work: () => Promise<T>) {
      const next = lock.then(work);
      lock = next.catch(() => {});
      return next;
    },
    load: async () => value,
    save: async (record) => {
      value = record;
      history.push(record);
    },
    remove: async () => {
      value = null;
    },
  };
  return { storage, history, value: () => value };
}
export function ready(record: MediaAttempt): ReadyMedia {
  return {
    version: "pirate.community-media/1",
    id: "media-fixture",
    revision: 9,
    accountId: record.accountId,
    communityId: record.communityId,
    songKey: record.intent.songKey,
    songRevision: record.intent.songRevision,
    audioSha256: record.song.audioSha256,
    recordingSha256: record.intent.recordingSha256,
    startSample: record.intent.startSample,
    durationSamples: record.intent.durationSamples,
    mediaPolicyVersion: "fixture-policy/1",
    purpose: "public-feed",
    readyAt: 1900000000000,
    expiresAt: 2000000000000,
    rendition: {
      sha256: "b".repeat(64),
      bytes: 120,
      durationMs: 10000,
      width: 720,
      height: 1280,
      videoCodec: "h264",
      audioCodec: "aac",
    },
  };
}
