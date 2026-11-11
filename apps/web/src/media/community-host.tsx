import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  CommunityPostComposer,
  createSongSubmissionStore,
  type SongComposerPort,
} from "./community-post-composer.tsx";
import { CommunitySongComposer } from "./community-ui/post-composer.tsx";
import { Button, FormNote } from "./reference/src/design-system.ts";
import type {
  SongComposerState,
  PostComposerProps,
} from "./reference/src/features/posts/post-composer/types.ts";
import type { SongSubmissionHandover } from "./reference/src/features/posts/song-submission/song-submission-store.tsx";
import {
  captureCommunityOwner,
  requireHost,
  songCapability,
  OWNER_RELEASE_POLICY,
  type CommunityHostContext,
} from "./community-contracts.ts";
import { communityHttp } from "./community-http.ts";
import {
  createBrowserSongStorage,
  CommunitySongController,
  type CommunitySongDraft,
} from "./community-song-controller.ts";
import { browserStoragePlatform } from "./community-browser-storage.ts";
import { mediaClient } from "./client.ts";
export type { CommunityHostContext } from "./community-contracts.ts";
export interface CommunityComposerHostProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  current(): CommunityHostContext | null;
  refreshFeed(): Promise<void>;
  onCloseRefused?: () => void;
}
export function CommunityComposerHost(props: CommunityComposerHostProps) {
  const admitted = () => {
    try {
      const context = requireHost(props.current());
      return JSON.stringify([
        context.community.id,
        context.owner.accountId,
        context.session.authorId,
        context.owner.generation,
      ]);
    } catch {
      return null;
    }
  };
  return (
    <Show
      when={admitted()}
      keyed
      fallback={
        <FormNote>
          Reconnect your private community profile before opening the composer.
        </FormNote>
      }
    >
      {() => <CommunityHostSession {...props} />}
    </Show>
  );
}
function CommunityHostSession(props: CommunityComposerHostProps) {
  const owner = captureCommunityOwner(props.current);
  let storage;
  try {
    storage = createBrowserSongStorage(owner, browserStoragePlatform());
  } catch {
    owner.dispose();
    return (
      <FormNote>
        This browser needs IndexedDB File storage and Web Locks before a release
        can be saved safely.
      </FormNote>
    );
  }
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
  const [restoredId, setRestoredId] = createSignal<string | undefined>();
  const [draftVersion, setDraftVersion] = createSignal(0);
  const observer = createSongSubmissionStore();
  const refreshed = new Set<string>();
  createEffect(
    () => observer.items(),
    (items) => {
      for (const item of items)
        if (
          owner.active() &&
          item.accountId === owner.accountId &&
          item.communityId === owner.communityId &&
          item.view.status === "published" &&
          !refreshed.has(item.submissionId)
        ) {
          refreshed.add(item.submissionId);
          void props.refreshFeed().catch(() => {
            if (owner.active())
              setError("Published feed refresh is unavailable.");
          });
        }
    },
  );
  const controller = new CommunitySongController({
    owner,
    store: storage,
    http: communityHttp(owner),
    onChange: (next) => {
      if (!owner.active()) return;
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
    },
  });
  const handover = (
    view: Awaited<ReturnType<typeof controller.observe>>,
  ): SongSubmissionHandover => {
    const saved = controller.current;
    if (
      !saved?.submissionId ||
      !("submissionId" in view) ||
      view.submissionId !== saved.submissionId
    )
      throw new Error("Canonical song handover is unavailable.");
    return {
      submissionId: saved.submissionId,
      accountId: owner.accountId,
      communityId: owner.communityId,
      title: saved.body.title,
      view,
      source: controller.source(),
    };
  };
  const run = async <T,>(work: () => Promise<T>): Promise<T> => {
    owner.assert();
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (failure) {
      if (owner.active())
        setError(
          failure instanceof Error
            ? failure.message
            : "The saved release could not be confirmed.",
        );
      throw failure;
    } finally {
      if (owner.active()) setBusy(false);
    }
  };
  const policy = () =>
    record()?.body.acceptedPolicy ?? owner.current.capabilities.policyVersion;
  const issue = () =>
    !songCapability(owner.current).allowed
      ? songCapability(owner.current).reason
      : !consent()
        ? "Accept the community release policy before uploading."
        : policy() === OWNER_RELEASE_POLICY && !rating()
          ? "Declare the release rating before uploading."
          : "";
  const runtime = {
    get prepared() {
      return (
        !!record()?.master &&
        !!record()?.stems.instrumental &&
        !!record()?.stems.vocals
      );
    },
    get retained() {
      return !!record();
    },
    get locked() {
      return busy() || !!record()?.jobId;
    },
    get audioPrepared() {
      return !!record()?.master;
    },
    get stems() {
      return {
        instrumental: !!record()?.stems.instrumental,
        vocals: !!record()?.stems.vocals,
      };
    },
    get pendingStems() {
      return {
        instrumental: !!record() && !record()?.stems.instrumental,
        vocals: !!record() && !record()?.stems.vocals,
      };
    },
    prepare: async () => {
      try {
        await run(() =>
          controller.prepare({
            title: song().title ?? "",
            lyrics: lyrics(),
            language: owner.current.language,
            file: song().primaryAudioUpload!,
            instrumental: song().instrumentalAudioUpload!,
            vocals: song().vocalAudioUpload!,
            originalConsent: consent(),
            rating: rating(),
          }),
        );
        return true;
      } catch {
        return false;
      }
    },
  };
  const composer: PostComposerProps & { songFlowRuntime: typeof runtime } = {
    mode: "song",
    presentation: "inline",
    attachmentBarPlacement: "inline",
    availableCapabilities: ["song"],
    get canCreateSongPost() {
      return songCapability(owner.current).allowed;
    },
    get song() {
      return song();
    },
    onSongChange: (next) => {
      if (!record()) setSong(next);
    },
    get titleValue() {
      return song().title ?? "";
    },
    get lyricsValue() {
      return lyrics();
    },
    onLyricsValueChange: (value) => {
      if (!record()) setLyrics(value);
    },
    songFlowRuntime: runtime,
    get initialSongStep() {
      return runtime.prepared ? 3 : record() ? 2 : 1;
    },
    get submit() {
      return {
        label: "Post",
        disabled: busy() || !runtime.prepared || !!issue(),
        loading: busy(),
        error: error(),
      };
    },
    mediaStatus: () => (
      <>
        <Show when={error()}>
          {(message) => <FormNote tone="warning">{message()}</FormNote>}
        </Show>
        <Show when={busy()}>
          <Button variant="outline" onClick={() => controller.pause()}>
            Stop upload
          </Button>
        </Show>
      </>
    ),
  };
  const port: SongComposerPort = {
    owner: observer,
    get capability() {
      return songCapability(owner.current);
    },
    composer,
    chooseFile: (file) => {
      if (record()) {
        setError(
          "Continue the saved release before choosing another recording.",
        );
        return;
      }
      setSong({
        primaryAudioUpload: file,
        primaryAudioLabel: file.name,
        title: file.name.replace(/\.mp3$/i, ""),
      });
    },
    unresolved: () => busy(),
    publish: async () => {
      const view = await run(() => controller.publish());
      owner.assert();
      const receipt = handover(view);
      return receipt;
    },
    render: (events) => (
      <CommunitySongComposer
        {...composer}
        onClose={events.close}
        release={{
          authorized: () => songCapability(owner.current).allowed,
          policy,
          consent,
          onConsent: setConsent,
          rating,
          onRating: setRating,
          language: () => record()?.body.language ?? owner.current.language,
          issue,
        }}
        submit={{
          get disabled() {
            return composer.submit?.disabled || events.busy();
          },
          get loading() {
            return busy() || events.busy();
          },
          get error() {
            return events.error() ?? error();
          },
          label: "Post",
          onSubmit: events.publish,
        }}
      />
    ),
  };
  onCleanup(() => {
    controller.pause();
    owner.dispose();
    observer.dispose();
  });
  void run(async () => {
    await controller.restore();
    if (controller.current?.jobId) {
      const receipt = handover(await controller.observe());
      owner.assert();
      observer.adopt(receipt);
      setRestoredId(receipt.submissionId);
    }
  }).catch(() => {});
  const closeSaved = async () => {
    await run(() => controller.close());
    owner.assert();
    observer.clear();
    setRestoredId(undefined);
    setSong({});
    setLyrics("");
    setConsent(false);
    setRating(null);
    setDraftVersion((value) => value + 1);
  };
  return (
    <>
      <CommunityPostComposer
        open={props.open}
        onOpenChange={props.onOpenChange}
        community={owner.current.community}
        accountId={owner.accountId}
        client={mediaClient(() => {
          owner.assert();
          return owner.current.session.csrf;
        })}
        song={port}
        initialMode="song"
        isCurrent={owner.active}
        initialSongSubmissionId={restoredId()}
        draftVersion={draftVersion()}
        onCloseRefused={props.onCloseRefused}
      />
      <FormNote>
        Text, image processing, collaborator splits and public video posting are
        unavailable here.
      </FormNote>
      <Show
        when={record()?.job?.phase === "uncertain" && record()?.job?.resumable}
      >
        <Button
          disabled={busy()}
          variant="outline"
          onClick={() => {
            void run(async () => {
              await controller.resume();
              observer.check(record()!.submissionId!);
            }).catch(() => {});
          }}
        >
          Check and resume
        </Button>
      </Show>
      <Show
        when={
          record()?.job &&
          ["held", "failed", "published"].includes(record()!.job!.phase) &&
          !record()?.pending &&
          songCapability(owner.current).allowed
        }
      >
        <Button
          disabled={busy()}
          variant="outline"
          onClick={() => {
            void closeSaved().catch(() => {});
          }}
        >
          Start another release
        </Button>
      </Show>
    </>
  );
}
