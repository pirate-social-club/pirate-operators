// Attachment card shown above the composer body (link URL input, image,
// video with inline playback, song row, file row). Ported from the React
// post-composer-attachment-card.tsx.

import { createEffect, createSignal, Show } from "solid-js";

import {
  IconFileText,
  IconImage,
  IconMusicNote,
  IconPause,
  IconPlay,
  IconVideoCamera,
  IconX,
  Input,
  Type,
} from "../../../design-system.ts";
import { cn } from "../../../design-system.ts";
import {
  getMediaAspectRatioStyle,
  getVideoPreviewFrameClassName,
  getVideoPreviewObjectFitClassName,
} from "./media-hooks.ts";
import { isValidHttpUrl } from "./utils.ts";
import type { AttachmentKind, AttachmentState } from "./types.ts";

type VideoAttachment = Extract<NonNullable<AttachmentState>, { kind: "video" }>;
type ComposerAttachment = NonNullable<AttachmentState>;

function attachmentOfKind<Kind extends ComposerAttachment["kind"]>(
  attachment: ComposerAttachment,
  kind: Kind,
): Extract<ComposerAttachment, { kind: Kind }> | null {
  if (attachment.kind !== kind) return null;
  // SAFETY: the discriminant comparison above establishes the requested
  // attachment variant before this value reaches the matching view.
  return attachment as Extract<ComposerAttachment, { kind: Kind }>;
}

function VideoAttachmentPreview(props: {
  attachment: VideoAttachment;
  onRemove: () => void;
}) {
  let videoRef: HTMLVideoElement | undefined;
  const [isPlaying, setIsPlaying] = createSignal(false);
  const [posterVisible, setPosterVisible] = createSignal(
    Boolean(props.attachment.posterUrl),
  );
  const aspectRatioStyle = () =>
    getMediaAspectRatioStyle(props.attachment.aspectRatio);
  const frameClassName = () =>
    getVideoPreviewFrameClassName(props.attachment.aspectRatio);
  const objectFitClassName = () =>
    getVideoPreviewObjectFitClassName(props.attachment.aspectRatio);

  createEffect(
    () => [props.attachment.posterUrl, props.attachment.previewUrl] as const,
    ([posterUrl]) => {
      setIsPlaying(false);
      setPosterVisible(Boolean(posterUrl));
    },
  );

  async function togglePlayback() {
    const video = videoRef;
    if (!video) return;

    if (video.paused) {
      setPosterVisible(false);
      await video.play().catch(() => {
        setIsPlaying(false);
      });
      return;
    }

    video.pause();
  }

  return (
    <div
      class={cn(
        "group relative cursor-pointer overflow-hidden rounded-[var(--radius-xl)] border border-border-soft bg-black",
        aspectRatioStyle() ? frameClassName() : "aspect-video w-full",
      )}
      style={aspectRatioStyle()}
    >
      <Show
        when={props.attachment.previewUrl}
        fallback={
          <Show
            when={props.attachment.posterUrl}
            fallback={
              <div class="grid size-full place-items-center bg-muted text-muted-foreground">
                <IconVideoCamera class="size-12" />
              </div>
            }
          >
            {(posterUrl) => (
              <img
                alt=""
                class={cn("size-full", objectFitClassName())}
                src={posterUrl()}
              />
            )}
          </Show>
        }
      >
        {(previewUrl) => (
          <video
            ref={videoRef}
            class={cn("size-full", objectFitClassName())}
            onEnded={() => setIsPlaying(false)}
            onPause={() => setIsPlaying(false)}
            onPlay={() => setIsPlaying(true)}
            playsinline
            preload="metadata"
            src={previewUrl()}
          />
        )}
      </Show>

      <Show when={props.attachment.posterUrl && posterVisible()}>
        <img
          alt=""
          class={cn("absolute inset-0 size-full", objectFitClassName())}
          src={props.attachment.posterUrl}
        />
      </Show>

      <button
        aria-label={isPlaying() ? "Pause video" : "Play video"}
        class={cn(
          "absolute inset-0 grid cursor-pointer place-items-center border-0 bg-black/10 p-0 transition-[background-color,opacity] group-hover:bg-black/20 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isPlaying() ? "opacity-0" : "opacity-100",
        )}
        onClick={() => void togglePlayback()}
        type="button"
      >
        <span class="grid size-14 place-items-center rounded-full bg-background/85 text-foreground shadow-sm backdrop-blur">
          <Show
            when={isPlaying()}
            fallback={<IconPlay class="ms-1 size-7" filled />}
          >
            <IconPause class="size-7" />
          </Show>
        </span>
      </button>
      <button
        aria-label="Remove video"
        class="absolute right-3 top-3 grid size-10 cursor-pointer place-items-center rounded-full bg-background/85 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          event.stopPropagation();
          props.onRemove();
        }}
        type="button"
      >
        <IconX class="size-5" />
      </button>
    </div>
  );
}

export function PostComposerAttachmentCard(props: {
  attachment: AttachmentState;
  onChange: (next: AttachmentState) => void;
  onRemove: () => void;
  onReplace?: (kind: AttachmentKind) => void;
}) {
  let linkInputRef: HTMLInputElement | undefined;

  createEffect(
    () => props.attachment?.kind,
    (kind) => {
      if (kind === "link") {
        linkInputRef?.focus();
      }
    },
  );

  return (
    <Show when={props.attachment}>
      {(attachment) => (
        <>
          <Show when={attachmentOfKind(attachment(), "link")}>
            {(link) => {
              const hasValue = () => Boolean(link().url.trim());
              const isInvalid = () => hasValue() && !isValidHttpUrl(link().url);
              return (
                <div class="space-y-2">
                  <div class="grid grid-cols-[1fr_auto] items-center gap-3">
                    <Input
                      aria-invalid={isInvalid() ? "true" : undefined}
                      class={cn(
                        "h-auto rounded-none border-0 bg-transparent p-0 text-2xl shadow-none placeholder:text-muted-foreground focus-visible:ring-0",
                        isInvalid() && "text-destructive-text",
                      )}
                      inputmode="url"
                      onChange={(event) =>
                        props.onChange({
                          ...link(),
                          url: event.currentTarget.value,
                        })
                      }
                      placeholder="https://"
                      ref={linkInputRef}
                      value={link().url}
                    />
                    <button
                      aria-label="Remove link"
                      class="grid size-11 cursor-pointer place-items-center rounded-full bg-muted text-foreground transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={props.onRemove}
                      type="button"
                    >
                      <IconX class="size-6" />
                    </button>
                  </div>
                  <Show when={isInvalid()}>
                    <Type
                      as="p"
                      variant="caption"
                      class="text-destructive-text"
                    >
                      Enter a valid http or https link.
                    </Type>
                  </Show>
                </div>
              );
            }}
          </Show>

          <Show when={attachmentOfKind(attachment(), "image")}>
            {(image) => (
              <div class="relative w-full max-w-xl overflow-hidden rounded-[var(--radius-xl)] border border-border-soft bg-card">
                <Show
                  when={image().previewUrl}
                  fallback={
                    <div class="grid aspect-video w-full place-items-center bg-muted text-muted-foreground">
                      <IconImage class="size-12" />
                    </div>
                  }
                >
                  {(previewUrl) => (
                    <img
                      alt=""
                      class="max-h-96 w-full object-contain"
                      src={previewUrl()}
                    />
                  )}
                </Show>
                <button
                  aria-label="Remove image"
                  class="absolute right-3 top-3 grid size-10 cursor-pointer place-items-center rounded-full bg-background/85 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={props.onRemove}
                  type="button"
                >
                  <IconX class="size-5" />
                </button>
              </div>
            )}
          </Show>

          <Show when={attachmentOfKind(attachment(), "video")}>
            {(video) => (
              <VideoAttachmentPreview
                attachment={video()}
                onRemove={props.onRemove}
              />
            )}
          </Show>

          <Show when={attachmentOfKind(attachment(), "song")}>
            {(song) => (
              <div class="grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--radius-lg)] border border-border-soft bg-card px-4 py-3">
                <button
                  class="flex min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-start text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => props.onReplace?.("song")}
                  type="button"
                >
                  <span class="grid size-12 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-md)] bg-background text-muted-foreground">
                    <Show
                      when={song().artworkUrl}
                      fallback={<IconMusicNote class="size-6" />}
                    >
                      {(artworkUrl) => (
                        <img
                          alt=""
                          class="size-full object-cover"
                          data-song-artwork
                          src={artworkUrl()}
                        />
                      )}
                    </Show>
                  </span>
                  <span class="min-w-0">
                    <Type
                      as="span"
                      variant="body-strong"
                      class="block truncate"
                    >
                      {song().label === "No audio selected"
                        ? "Audio file"
                        : song().label}
                    </Type>
                    <Type
                      as="span"
                      variant="body"
                      class="block truncate text-muted-foreground"
                    >
                      Replace
                    </Type>
                  </span>
                </button>
                <button
                  aria-label="Remove audio"
                  class="grid size-10 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={props.onRemove}
                  type="button"
                >
                  <IconX class="size-5" />
                </button>
              </div>
            )}
          </Show>

          <Show when={attachmentOfKind(attachment(), "file")}>
            {(file) => (
              <div class="flex min-h-16 w-full items-center gap-3 rounded-[var(--radius-lg)] border border-border-soft bg-card px-4 py-3">
                <span class="grid size-12 place-items-center rounded-[var(--radius-md)] bg-muted text-muted-foreground">
                  <IconFileText class="size-6" />
                </span>
                <Type
                  as="span"
                  variant="body-strong"
                  class="min-w-0 flex-1 truncate"
                >
                  {file().label}
                </Type>
                <button
                  aria-label="Remove asset"
                  class="grid size-10 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={props.onRemove}
                  type="button"
                >
                  <IconX class="size-5" />
                </button>
              </div>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
