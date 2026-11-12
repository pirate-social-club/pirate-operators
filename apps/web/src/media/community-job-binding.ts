import {
  CommunitySongController,
  type CommunitySongDraft,
} from "./community-song-controller.ts";
import type { ScopedStorage } from "./community-browser-storage.ts";
import type { CommunityOwner } from "./community-contracts.ts";
import type { CommunityHttp } from "./community-http.ts";
import type { SongObservationSource } from "./reference/src/features/posts/song-submission/song-observation-machine.ts";

/** Capture accepted native identity, not a mutable controller/source pointer. */
export function bindCommunitySongJob(options: {
  draft: CommunitySongDraft;
  storage: ScopedStorage<CommunitySongDraft>;
  owner: CommunityOwner;
  http: CommunityHttp;
  onChange(draft: CommunitySongDraft | null): void;
}) {
  const draft = options.draft;
  if (!draft.submissionId || !draft.postId || !draft.jobId)
    throw new Error("Canonical accepted job is unavailable.");
  const binding = Object.freeze({
    accountId: draft.accountId,
    communityId: draft.communityId,
    authorId: draft.authorId,
    requestId: draft.requestId,
    bodyDigest: draft.bodyDigest,
    submissionId: draft.submissionId,
    postId: draft.postId,
    jobId: draft.jobId,
  });
  const assert = (value: CommunitySongDraft | null): CommunitySongDraft => {
    if (
      !value ||
      Object.entries(binding).some(
        ([key, expected]) =>
          value[key as keyof CommunitySongDraft] !== expected,
      )
    )
      throw new Error("The accepted job no longer owns this saved release.");
    return value;
  };
  const storage: ScopedStorage<CommunitySongDraft> = {
    exclusive: (work) => options.storage.exclusive(work),
    load: async () => assert(await options.storage.load()),
    save: (value) => options.storage.save(assert(value)),
    remove: async () => {
      throw new Error("Observation cannot erase a saved release.");
    },
  };
  const controller = new CommunitySongController({
    owner: options.owner,
    store: storage,
    http: options.http,
    onChange: options.onChange,
  });
  // An explicit native resume can overlap a polling read whose abort was
  // ignored. Serialize this one immutable job, then recheck authority/signal
  // before each operation; never redirect the source to the upload controller.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>, signal?: AbortSignal) => {
    const next = tail
      .catch(() => {})
      .then(() => {
        options.owner.assert();
        signal?.throwIfAborted();
        return work();
      });
    tail = next.catch(() => {});
    return next;
  };
  const source: SongObservationSource = {
    refresh: (signal) => serial(() => controller.observe(signal), signal),
    retry: (signal) => serial(() => controller.resume(signal), signal),
  };
  return { binding, source, controller };
}
