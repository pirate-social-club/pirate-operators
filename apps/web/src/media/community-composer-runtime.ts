import {
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
} from "solid-js";
import {
  createSongSubmissionStore,
  type SongSubmissionItem,
  type SongSubmissionHandover,
} from "./reference/src/features/posts/song-submission/song-submission-store.tsx";
import type { SongComposerState } from "./reference/src/features/posts/post-composer/types.ts";
import type { SongSubmissionView } from "./reference/src/features/posts/media-submission/projection.ts";
import {
  captureCommunityOwner,
  requireHost,
  type CommunityHostContext,
} from "./community-contracts.ts";
import {
  browserStoragePlatform,
  type BrowserStoragePlatform,
} from "./community-browser-storage.ts";
import {
  createBrowserSongStorage,
  CommunitySongController,
  type CommunitySongDraft,
  type SongReleaseInput,
} from "./community-song-controller.ts";
import { communityHttp } from "./community-http.ts";
import { bindCommunitySongJob } from "./community-job-binding.ts";

export interface CommunityRuntimeOptions {
  current(): CommunityHostContext | null;
  refreshFeed(): Promise<void>;
  /** Explicit native-browser harness seams; defaults are actual platform/HTTP. */
  platform?: () => BrowserStoragePlatform;
  transport?: typeof fetch;
  observeIntervalMs?: number;
  requestTimeoutMs?: number;
}
export function communityAuthorityKey(context: CommunityHostContext | null) {
  try {
    const value = requireHost(context);
    return JSON.stringify([
      value.community.id,
      value.community.origin,
      value.owner.accountId,
      value.session.authorId,
      value.session.mossAddress,
      value.owner.generation,
      value.session.csrf,
    ]);
  } catch {
    return null;
  }
}

/** Construct once per authenticated application authority, under a Solid owner.
 * Route views borrow it; neither their cleanup nor draft pause stops job reads. */
export function createCommunityComposerRuntime(
  options: CommunityRuntimeOptions,
) {
  if (!getOwner())
    throw new Error(
      "The composer runtime requires an application Solid owner.",
    );
  return createRoot((disposeRoot) => {
    const initial = requireHost(options.current()),
      authority = communityAuthorityKey(initial);
    let disposed = false,
      revoked = false,
      viewEpoch = 0,
      views = 0;
    const [fault, setFault] = createSignal<string | null>(null, {
      ownedWrite: true,
    });
    const [record, setRecord] = createSignal<CommunitySongDraft | null>(null, {
      ownedWrite: true,
    });
    const [song, setSong] = createSignal<SongComposerState>(
      {},
      { ownedWrite: true },
    );
    const [lyrics, setLyrics] = createSignal("", { ownedWrite: true });
    const [consent, setConsent] = createSignal(false, { ownedWrite: true });
    const [rating, setRating] = createSignal<"general" | "adult" | null>(null, {
      ownedWrite: true,
    });
    const [busy, setBusy] = createSignal(false, { ownedWrite: true });
    const [error, setError] = createSignal<string | null>(null, {
      ownedWrite: true,
    });
    const [selectedId, setSelectedId] = createSignal<string>();
    const [draftVersion, setDraftVersion] = createSignal(0);
    const active = () =>
      !disposed &&
      !revoked &&
      communityAuthorityKey(options.current()) === authority;
    const owner = captureCommunityOwner(() =>
      active() ? options.current() : null,
    );
    const observer = createSongSubmissionStore({
      observeIntervalMs: options.observeIntervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    let controller: CommunitySongController | undefined;
    let storage: ReturnType<typeof createBrowserSongStorage> | undefined;
    const jobs = new Map<string, ReturnType<typeof bindCommunitySongJob>>();
    let latest: CommunitySongDraft | null = null;
    const refreshed = new Set<string>();
    const invalidate = (
      reason = "Reconnect your private community profile before continuing.",
    ) => {
      if (revoked || disposed) return;
      revoked = true;
      viewEpoch++;
      controller?.pause();
      owner.dispose();
      observer.dispose();
      observer.clear();
      setFault(reason);
    };
    const send: typeof fetch = async (input, init) => {
      owner.assert();
      const response = await (options.transport ?? fetch)(input, init);
      // Revoke at the headers, before a delayed/unreadable body can keep any
      // old-authority observer or UI alive. The protocol still saves late replies.
      if (response.status === 401 || response.status === 403) invalidate();
      return response;
    };
    const http = communityHttp(owner, send);
    const receive = (next: CommunitySongDraft | null) => {
      if (!active()) return;
      latest = next;
      setRecord(next);
      if (next) {
        setSong({
          title: next.body.title,
          primaryAudioUpload: next.files.audio,
          primaryAudioLabel: next.files.audio.name,
          instrumentalAudioUpload: next.files.instrumental,
          vocalAudioUpload: next.files.vocals,
        });
        setLyrics(next.body.lyrics);
        setConsent(true);
        setRating(next.body.rating ?? null);
      }
    };
    try {
      storage = createBrowserSongStorage(
        owner,
        (options.platform ?? browserStoragePlatform)(),
      );
      controller = new CommunitySongController({
        owner,
        store: storage,
        http,
        onChange: receive,
      });
    } catch {
      setFault(
        "This browser needs IndexedDB File storage and Web Locks before a release can be saved safely.",
      );
    }
    const requireController = () => {
      owner.assert();
      if (!controller)
        throw new Error(fault() ?? "Safe release storage is unavailable.");
      return controller;
    };
    const items = (): readonly SongSubmissionItem[] =>
      active()
        ? observer
            .items()
            .filter(
              (item) =>
                item.accountId === owner.accountId &&
                item.communityId === owner.communityId,
            )
        : [];
    createEffect(
      () => items(),
      (list) => {
        for (const item of list)
          if (
            item.view.status === "published" &&
            !refreshed.has(item.submissionId)
          ) {
            refreshed.add(item.submissionId);
            queueMicrotask(() => {
              if (!active()) return;
              void options.refreshFeed().catch(() => {
                if (active())
                  setError("Published feed refresh is unavailable.");
              });
            });
          }
      },
    );
    const bind = (draft: CommunitySongDraft) => {
      const id = draft.submissionId!;
      let job = jobs.get(id);
      if (!job) {
        if (!storage) throw new Error("Safe release storage is unavailable.");
        job = bindCommunitySongJob({
          draft,
          storage,
          owner,
          http,
          onChange: (next) => {
            if (active() && next?.requestId === latest?.requestId)
              receive(next);
          },
        });
        jobs.set(id, job);
      }
      if (
        job.binding.requestId !== draft.requestId ||
        job.binding.jobId !== draft.jobId ||
        job.binding.bodyDigest !== draft.bodyDigest
      )
        throw new Error("Accepted job binding changed.");
      return job;
    };
    const adopt = (
      draft: CommunitySongDraft,
      view: SongSubmissionView,
    ): SongSubmissionHandover => {
      owner.assert();
      if (
        !draft.submissionId ||
        !("submissionId" in view) ||
        view.submissionId !== draft.submissionId
      )
        throw new Error("Canonical song handover is unavailable.");
      const job = bind(draft),
        handover = {
          submissionId: draft.submissionId,
          accountId: owner.accountId,
          communityId: owner.communityId,
          title: draft.body.title,
          view,
          source: job.source,
        };
      observer.adopt(handover);
      setSelectedId(draft.submissionId);
      return handover;
    };
    let main: Promise<unknown> | null = null;
    const run = async <T>(work: () => Promise<T>) => {
      owner.assert();
      if (main) throw new Error("A release step is already in progress.");
      setBusy(true);
      setError(null);
      const result = (async () => await work())();
      main = result;
      try {
        return await result;
      } catch (failure) {
        if (active())
          setError(
            failure instanceof Error
              ? failure.message
              : "The saved release could not be confirmed.",
          );
        throw failure;
      } finally {
        if (main === result) main = null;
        if (active()) setBusy(false);
      }
    };
    const reconcile = async () => {
      if (!active() || !controller || main) return;
      await run(async () => {
        const draft = await controller!.restore();
        owner.assert();
        if (draft?.jobId) {
          const job = bind(draft),
            view = await job.source.refresh();
          if (view) adopt(draft, view);
        }
      });
    };
    const viewClosed = () => {
      viewEpoch++;
      views = 0;
      if (!controller?.working) return;
      controller.pause();
      // A seal/PUT can ignore abort and still commit. After it leaves its lock,
      // recover only via reads and attach the canonical accepted job if present.
      void (main ?? Promise.resolve())
        .catch(() => {})
        .then(() => reconcile())
        .catch(() => {});
    };
    const acquireView = () => {
      owner.assert();
      const epoch = ++viewEpoch;
      views++;
      void reconcile().catch(() => {});
      let closed = false;
      return {
        active: () => !closed && active() && epoch === viewEpoch,
        close() {
          if (closed) return;
          closed = true;
          if (epoch === viewEpoch) viewClosed();
        },
      };
    };
    const check = (id: string) => {
      owner.assert();
      if (!items().some((item) => item.submissionId === id)) return;
      observer.check(id);
    };
    const retry = (id: string) => {
      owner.assert();
      if (!items().some((item) => item.submissionId === id)) return;
      observer.retry(id);
    };
    const dismiss = (id: string) => {
      owner.assert();
      observer.dismiss(id); /* memory observation only, never storage.remove */
    };
    const openStatus = (id: string) => {
      if (!active() || !items().some((item) => item.submissionId === id))
        return false;
      setSelectedId(id);
      return true;
    };
    const dispose = () => {
      if (disposed) return;
      invalidate();
      disposed = true;
      disposeRoot();
    };
    onCleanup(() => {
      revoked = true;
      controller?.pause();
      owner.dispose();
      observer.dispose();
    });
    return {
      owner,
      authority,
      active,
      fault,
      record,
      song,
      lyrics,
      consent,
      rating,
      busy,
      error,
      selectedId,
      draftVersion,
      observer,
      items,
      setSong: (next: SongComposerState) => {
        owner.assert();
        if (!latest) setSong(next);
      },
      setLyrics: (next: string) => {
        owner.assert();
        if (!latest) setLyrics(next);
      },
      setConsent: (next: boolean) => {
        owner.assert();
        if (!latest) setConsent(next);
      },
      setRating: (next: "general" | "adult") => {
        owner.assert();
        if (!latest) setRating(next);
      },
      setError: (next: string) => {
        if (active()) setError(next);
      },
      prepare: (input: SongReleaseInput) =>
        run(() => requireController().prepare(input)),
      publish: () =>
        run(async () => {
          const c = requireController(),
            view = await c.publish();
          owner.assert();
          return adopt(c.current!, view);
        }),
      resume: (id: string) =>
        run(async () => {
          const job = jobs.get(id);
          if (!job || !items().some((item) => item.submissionId === id))
            throw new Error("The owned job is unavailable.");
          observer.pause();
          try {
            const view = await job.source.retry();
            owner.assert();
            observer.dismiss(id);
            adopt(job.controller.current!, view);
          } finally {
            if (active()) observer.resume(owner.accountId);
          }
        }),
      closeSaved: () =>
        run(async () => {
          const c = requireController(),
            id = latest?.submissionId;
          await c.close();
          owner.assert();
          if (id) {
            observer.dismiss(id);
            jobs.delete(id);
          }
          setSelectedId(undefined);
          setSong({});
          setLyrics("");
          setConsent(false);
          setRating(null);
          setDraftVersion((value) => value + 1);
        }),
      stopUpload: () => {
        owner.assert();
        controller?.pause();
      },
      reconcile,
      acquireView,
      viewClosed,
      check,
      retry,
      dismiss,
      openStatus,
      invalidate,
      dispose,
      get viewOpen() {
        return views > 0;
      },
    };
  });
}
export type CommunityComposerRuntime = ReturnType<
  typeof createCommunityComposerRuntime
>;
