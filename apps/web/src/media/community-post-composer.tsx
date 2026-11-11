import { createEffect, createSignal, Show } from "solid-js";
import type {
  MediaCapability,
  ReadyMedia,
} from "../../../../packages/community-media/contracts.ts";
import type { MediaClient } from "./client.ts";
import {
  useCommunityVideoFlow,
  type VideoComposerPorts,
} from "./video-flow.ts";
import { VideoComposerSurface } from "./reference/src/features/posts/video-submission/video-composer-surface.tsx";
import {
  TextPostPanel,
  emptyTextPostDraft,
  type TextPostDraft,
} from "./reference/src/features/posts/text-submission/text-post-panel.tsx";
import type { TextSubmissionStore } from "./reference/src/features/posts/text-submission/text-submission-store.tsx";
import { PostComposer } from "./reference/src/features/posts/post-composer/post-composer.tsx";
import type {
  PostComposerProps,
  SongFlowRuntime,
} from "./reference/src/features/posts/post-composer/types.ts";
import { PostedSong } from "./reference/src/features/posts/song-submission/posted-song.tsx";
import type {
  SongSubmissionHandover,
  SongSubmissionStore,
} from "./reference/src/features/posts/song-submission/song-submission-store.tsx";

export interface TextComposerPort {
  /** Application-owned: keeps delivering after this composer unmounts. */
  readonly owner: TextSubmissionStore;
  readonly capability: MediaCapability;
}
export interface SongComposerPort {
  readonly owner: SongSubmissionStore;
  readonly capability: MediaCapability;
  readonly composer: PostComposerProps & {
    readonly songFlowRuntime: SongFlowRuntime;
  };
  /** Actual coordinator submit/reconciliation; never an optimistic receipt. */
  readonly publish: () => Promise<SongSubmissionHandover>;
  readonly chooseFile: (file: File) => void;
  readonly unresolved: () => boolean;
}
export interface CommunityPostComposerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly community: { readonly id: string; readonly name: string };
  readonly accountId: string;
  readonly client: MediaClient;
  readonly video?: VideoComposerPorts;
  readonly text?: TextComposerPort;
  readonly song?: SongComposerPort;
  readonly onMediaReady?: (media: ReadyMedia) => void;
  readonly onTextPublished?: (href: string) => void;
  readonly onCloseRefused?: () => void;
}

/** Mount inside the shell-owned CommunityPageShell main column. The actual
 * pinned text panel is the entry; its Song and Video actions enter the actual
 * reusable compositions. Shell owns the adjacent Post action and chrome. */
export function CommunityPostComposer(props: CommunityPostComposerProps) {
  const announced = new Set<string>();
  createEffect(
    () => props.text?.owner.items(),
    (items) => {
      for (const item of items ?? []) {
        if (
          item.accountId === props.accountId &&
          item.communityId === props.community.id &&
          item.status === "published" &&
          item.postHref &&
          !announced.has(item.id)
        ) {
          announced.add(item.id);
          props.onTextPublished?.(item.postHref);
        }
      }
    },
  );
  return (
    <Show
      when={
        props.open &&
        props.accountId &&
        JSON.stringify([props.accountId, props.community.id])
      }
      keyed
    >
      {(_identity: string) => <ComposerSession {...props} />}
    </Show>
  );
}

function ComposerSession(props: CommunityPostComposerProps) {
  const [mode, setMode] = createSignal<"text" | "song" | "video">("text");
  const [draft, setDraft] = createSignal<TextPostDraft>(emptyTextPostDraft);
  const [submittedSongId, setSubmittedSongId] = createSignal<string>();
  const [songBusy, setSongBusy] = createSignal(false);
  const [songError, setSongError] = createSignal<string | null>(null);
  const close = () => {
    if (props.song?.unresolved() || songBusy()) {
      props.onCloseRefused?.();
      return;
    }
    props.onOpenChange(false);
  };
  const postText = () => {
    if (
      !props.text?.capability.allowed ||
      !props.accountId ||
      !props.community.id
    )
      return;
    props.text.owner.submit({
      accountId: props.accountId,
      communityId: props.community.id,
      title: draft().title,
      body: draft().body,
      ageGatePolicy: draft().ageGatePolicy,
    });
    // Source flow: delivery belongs to the shell owner; return to the feed now.
    props.onOpenChange(false);
  };
  const postSong = async () => {
    if (songBusy() || !props.song?.capability.allowed) return;
    setSongBusy(true);
    setSongError(null);
    try {
      const receipt = await props.song.publish();
      if (
        receipt.accountId !== props.accountId ||
        receipt.communityId !== props.community.id ||
        !("submissionId" in receipt.view) ||
        receipt.view.submissionId !== receipt.submissionId
      )
        throw new Error("Song receipt changed authority");
      props.song.owner.adopt(receipt);
      setSubmittedSongId(receipt.submissionId);
    } catch {
      setSongError("The song could not be submitted safely.");
    } finally {
      setSongBusy(false);
    }
  };
  const postedSong = () =>
    props.song?.owner
      .items()
      .find(
        (item) =>
          item.submissionId === submittedSongId() &&
          item.accountId === props.accountId &&
          item.communityId === props.community.id,
      );
  return (
    <Show
      when={postedSong()}
      fallback={
        <Show
          when={mode() === "video" && props.video}
          fallback={
            <Show
              when={mode() === "song" && props.song}
              fallback={
                <TextPostPanel
                  draft={draft()}
                  onDraftChange={setDraft}
                  onClose={close}
                  onPost={postText}
                  unavailable={
                    !props.accountId
                      ? "Choose your active community profile before posting."
                      : !props.text?.capability.allowed
                        ? "Posting isn’t available right now."
                        : undefined
                  }
                  onSong={
                    props.song?.capability.allowed
                      ? (file) => {
                          props.song!.chooseFile(file);
                          setMode("song");
                        }
                      : undefined
                  }
                  onVideo={props.video ? () => setMode("video") : undefined}
                />
              }
            >
              {(port) => (
                <PostComposer
                  {...port().composer}
                  presentation="inline"
                  attachmentBarPlacement="inline"
                  availableCapabilities={["song"]}
                  canCreateSongPost={port().capability.allowed}
                  onClose={close}
                  validateDraftBeforeSubmit
                  submit={{
                    ...port().composer.submit,
                    label: "Post",
                    disabled:
                      songBusy() ||
                      !port().capability.allowed ||
                      port().composer.submit?.disabled,
                    loading: songBusy() || port().composer.submit?.loading,
                    error: songError() ?? port().composer.submit?.error,
                    onSubmit: () => {
                      void postSong();
                    },
                  }}
                />
              )}
            </Show>
          }
        >
          {(ports) => (
            <CommunityVideoSession {...props} video={ports()} onExit={close} />
          )}
        </Show>
      }
    >
      {(item) => (
        <PostedSong
          item={item()}
          onClose={close}
          onCheck={props.song!.owner.check}
          onRetry={props.song!.owner.retry}
          onBindOriginal={props.song!.owner.bindOriginal}
          onRetryOriginal={props.song!.owner.retryOriginal}
          onDismiss={(id) => {
            props.song!.owner.dismiss(id);
            close();
          }}
        />
      )}
    </Show>
  );
}

function CommunityVideoSession(
  props: CommunityPostComposerProps & {
    video: VideoComposerPorts;
    onExit: () => void;
  },
) {
  const flow = useCommunityVideoFlow({
    accountId: props.accountId,
    communityId: props.community.id,
    client: props.client,
    ports: props.video,
    onExit: props.onExit,
    onMediaReady: props.onMediaReady,
  });
  return (
    <VideoComposerSurface
      flow={flow}
      communityId={props.community.id}
      onExit={props.onExit}
      songReader={props.video.songReader}
      songPicker={props.video.songPicker}
      createGuideAudio={props.video.device?.createGuideAudio}
    />
  );
}

export { createTextSubmissionStore } from "./reference/src/features/posts/text-submission/text-submission-store.tsx";
export { createSongSubmissionStore } from "./reference/src/features/posts/song-submission/song-submission-store.tsx";
export { PendingSongs } from "./reference/src/features/posts/song-submission/pending-songs.tsx";
export { PostedSong } from "./reference/src/features/posts/song-submission/posted-song.tsx";
