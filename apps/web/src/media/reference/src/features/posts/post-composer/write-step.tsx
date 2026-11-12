import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, Show } from "solid-js";

import {
  CardContent,
  FormNote,
  IconUploadSimple,
  Input,
  Modal,
  ModalContent,
  ModalHeader,
  ModalTitle,
  Textarea,
  Type,
} from "../../../design-system.ts";
import { cn } from "../../../design-system.ts";
import { PostComposerGenericAssetFields } from "./generic-asset-fields.tsx";
import {
  PostComposerDesktopAttachmentToolbar,
  PostComposerMobileAttachmentBar,
} from "./attachment-bar.tsx";
import { PostComposerAttachmentCard } from "./attachment-card.tsx";
import {
  attachmentActions,
  overflowMobileAttachmentActions,
  primaryMobileAttachmentActions,
} from "./defaults.ts";
import { PostComposerEventSection } from "./event-section.tsx";
import { LiveTabContent } from "./live-tab.tsx";
import {
  extractEmbeddedAudioArtworkFile,
  extractEmbeddedAudioTitle,
} from "./audio-artwork.ts";
import {
  createKeyboardBottomOffset,
  createObjectUrl,
  createVideoSourceAspectRatio,
} from "./media-hooks.ts";
import type {
  AttachmentKind,
  AttachmentState,
  ComposerToolbarAction,
} from "./types.ts";
import type { PostComposerController } from "./controller.ts";

const imageExtensions = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
  "heic",
  "heif",
  "avif",
]);
const videoExtensions = new Set(["mp4", "mov"]);
const audioExtensions = new Set([
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "m4a",
  "wma",
  "aiff",
  "opus",
]);
const downloadExtensions = new Set(["csv", "tsv", "txt", "json"]);
const mp3OnlyCopy = "Public-song v1 currently accepts MP3 only.";
const unsupportedFileCopy = "That file type cannot be attached to a post.";
const hostedVideoDropCopy =
  "Start a video with the Video action; a dropped video cannot be carried into it.";

const attachmentKindNouns = {
  link: "Links",
  image: "Images",
  video: "Videos",
  song: "Songs",
  live: "Live rooms",
  file: "Downloadable files",
} satisfies Record<AttachmentKind, string>;

function unsupportedKindCopy(kind: AttachmentKind): string {
  return `${attachmentKindNouns[kind]} cannot be posted here.`;
}

function fileExtension(name: string): string | null {
  const index = name.lastIndexOf(".");
  return index > -1 && index < name.length - 1
    ? name.slice(index + 1).toLowerCase()
    : null;
}

function fileKind(file: File): AttachmentKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "video/mp4" || file.type === "video/quicktime")
    return "video";
  if (file.type.startsWith("video/")) return null;
  if (file.type.startsWith("audio/")) return "song";
  const extension = fileExtension(file.name);
  if (!extension) return null;
  if (imageExtensions.has(extension)) return "image";
  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "song";
  if (downloadExtensions.has(extension)) return "file";
  return null;
}

export function isPublicSongMp3(file: File): boolean {
  return file.type === "audio/mpeg" && fileExtension(file.name) === "mp3";
}

export function titleFromFilename(name: string): string {
  const index = name.lastIndexOf(".");
  return (index > 0 ? name.slice(0, index) : name).trim();
}

function bodyValue(controller: PostComposerController): string {
  return controller.tabs.activeTab === "image" ||
    controller.tabs.activeTab === "video"
    ? controller.fields.captionValue
    : controller.fields.textBodyValue;
}

function updateBody(controller: PostComposerController, value: string) {
  if (
    controller.tabs.activeTab === "image" ||
    controller.tabs.activeTab === "video"
  ) {
    controller.fields.onCaptionValueChange?.(value);
  } else {
    controller.fields.onTextBodyValueChange?.(value);
  }
}

function attachmentFor(
  controller: PostComposerController,
  imagePreview: string | undefined,
  videoPreview: string | undefined,
  videoAspectRatio: number | undefined,
  songArtwork: string | undefined,
): AttachmentState {
  const { fields, media, song, tabs } = controller;
  if (tabs.activeTab === "link")
    return { kind: "link", url: fields.linkUrlValue };
  if (tabs.activeTab === "image")
    return {
      kind: "image",
      label: media.activeImageUpload?.name ?? media.imageUploadLabel ?? "Image",
      previewUrl: imagePreview,
    };
  if (tabs.activeTab === "video")
    return {
      kind: "video",
      label:
        media.videoState.primaryVideoUpload?.name ??
        media.videoState.primaryVideoLabel ??
        "Video",
      aspectRatio: videoAspectRatio,
      previewUrl: videoPreview,
    };
  if (tabs.activeTab === "live") return { kind: "live" };
  if (tabs.activeTab === "file")
    return {
      kind: "file",
      label:
        controller.generic.file.upload?.name ??
        controller.generic.file.label ??
        "Downloadable file",
    };
  return null;
}

export function PostComposerWriteStep(props: {
  attachmentBarPlacement?: "fixed" | "inline";
  controller: PostComposerController;
  onVideoEntry?: () => void;
  children?: JSX.Element;
}) {
  const controller = props.controller;
  const barPlacement = () => props.attachmentBarPlacement ?? "fixed";
  const imagePreview = createObjectUrl(
    () => controller.media.activeImageUpload,
  );
  const videoPreview = createObjectUrl(
    () => controller.media.videoState.primaryVideoUpload,
  );
  const detectedVideoAspectRatio = createVideoSourceAspectRatio(videoPreview);
  const videoAspectRatio = () =>
    detectedVideoAspectRatio() ??
    controller.media.videoState.primaryVideoAspectRatio;
  const songArtwork = createObjectUrl(() => controller.song.state.coverUpload);
  const attachment = () =>
    attachmentFor(
      controller,
      imagePreview(),
      videoPreview(),
      videoAspectRatio(),
      songArtwork(),
    );
  const keyboardOffset = createKeyboardBottomOffset();
  const [activeTool, setActiveTool] =
    createSignal<ComposerToolbarAction | null>(null);
  const [moreOpen, setMoreOpen] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [attachmentError, setAttachmentError] = createSignal<string | null>(
    null,
  );
  let dragCounter = 0;
  let imageInput: HTMLInputElement | undefined;
  let videoInput: HTMLInputElement | undefined;
  let songInput: HTMLInputElement | undefined;
  let fileInput: HTMLInputElement | undefined;

  createEffect(
    () => detectedVideoAspectRatio(),
    (detected) => {
      if (typeof detected !== "number") return;
      if (controller.media.videoState.primaryVideoAspectRatio === detected)
        return;
      controller.media.updateVideoState((current) =>
        current.primaryVideoAspectRatio === detected
          ? current
          : { ...current, primaryVideoAspectRatio: detected },
      );
    },
  );

  const selectAttachment = (kind: ComposerToolbarAction) => {
    // Fail closed. The toolbars are already filtered, so reaching this is
    // either a programmatic caller or a stale action; neither may open a
    // picker or change the tab.
    if (!controller.tabs.allows(kind)) return;
    setAttachmentError(null);
    setActiveTool(kind);
    if (kind === "event") {
      controller.event.update({ ...controller.event.state, enabled: true });
      return;
    }
    if (kind === "image") return imageInput?.click();
    if (kind === "video") {
      if (props.onVideoEntry) return props.onVideoEntry();
      return videoInput?.click();
    }
    if (kind === "song") return songInput?.click();
    if (kind === "file") return fileInput?.click();
    controller.tabs.onTabChange(kind);
  };

  const removeAttachment = () => {
    const current = attachment();
    if (current?.kind === "image") controller.media.setImageUpload(null);
    if (current?.kind === "video") {
      controller.media.updateVideoState((state) => ({
        ...state,
        primaryVideoUpload: null,
        primaryVideoLabel: undefined,
        primaryVideoAspectRatio: undefined,
      }));
    }
    if (current?.kind === "link") controller.fields.onLinkUrlValueChange?.("");
    if (current?.kind === "file")
      controller.generic.setFile({ upload: null, label: undefined });
    controller.tabs.onTabChange("text");
    setActiveTool(null);
  };

  const handleFile = async (file: File) => {
    const kind = fileKind(file);
    if (!kind) {
      setAttachmentError(unsupportedFileCopy);
      return;
    }
    if (!controller.tabs.allows(kind)) {
      // Refuse visibly. Dropping a file this surface cannot post used to be
      // indistinguishable from the drop not registering at all.
      setAttachmentError(unsupportedKindCopy(kind));
      return;
    }
    if (kind === "video" && props.onVideoEntry) {
      // The host owns video entry and replaces this composer with its own
      // runtime, which has no transport for a file staged here. Taking the
      // drop would set video state and a mode the host acts on, and the file
      // would be gone by the time the runtime mounted. Refuse instead.
      setAttachmentError(hostedVideoDropCopy);
      return;
    }
    setAttachmentError(null);
    if (kind === "image") {
      controller.media.setImageUpload(file);
    } else if (kind === "video") {
      controller.media.updateVideoState((state) => ({
        ...state,
        primaryVideoUpload: file,
        primaryVideoLabel: file.name,
        posterFrameSeconds: "0",
      }));
    } else if (kind === "song") {
      if (!isPublicSongMp3(file)) {
        setAttachmentError(mp3OnlyCopy);
        return;
      }
      const [embeddedTitle, embeddedArtwork] = await Promise.all([
        extractEmbeddedAudioTitle(file),
        extractEmbeddedAudioArtworkFile(file),
      ]);
      const title = embeddedTitle ?? titleFromFilename(file.name);
      const selectedTitle = controller.song.state.title?.trim()
        ? controller.song.state.title
        : title;
      controller.song.update((state) => ({
        ...state,
        primaryAudioUpload: file,
        primaryAudioLabel: file.name,
        title: selectedTitle,
        coverUpload: embeddedArtwork,
        coverLabel: embeddedArtwork?.name,
        coverSource: embeddedArtwork ? "embedded" : undefined,
        lyricsEditorState: "hidden",
      }));
    } else {
      controller.generic.setFile({ upload: file, label: file.name });
    }
    controller.tabs.onTabChange(kind);
  };

  const input = (kind: AttachmentKind, files: FileList | null) => {
    const file = files?.[0];
    if (file) {
      if (kind === "song" && !isPublicSongMp3(file)) {
        setAttachmentError(mp3OnlyCopy);
      } else void handleFile(file);
    }
    if (kind === "image" && imageInput) imageInput.value = "";
    if (kind === "song" && songInput) songInput.value = "";
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    dragCounter = 0;
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  };

  // Only declared kinds get an input. An undeclared picker must not exist to
  // be clicked, by the toolbar or by anything else holding the ref.
  const Inputs = () => (
    <>
      <Show when={controller.tabs.allows("image")}>
        <input
          accept="image/*"
          aria-label="Upload image"
          class="sr-only"
          ref={imageInput}
          type="file"
          onChange={(event) => input("image", event.currentTarget.files)}
        />
      </Show>
      <Show when={controller.tabs.allows("video")}>
        <input
          accept="video/mp4,video/quicktime,.mp4,.mov"
          aria-label="Upload video"
          class="sr-only"
          ref={videoInput}
          type="file"
          onChange={(event) => input("video", event.currentTarget.files)}
        />
      </Show>
      <Show when={controller.tabs.allows("song")}>
        <input
          accept=".mp3,audio/mpeg"
          aria-label="Upload audio"
          class="sr-only"
          ref={songInput}
          type="file"
          onChange={(event) => input("song", event.currentTarget.files)}
        />
      </Show>
      <Show when={controller.tabs.allows("file")}>
        <input
          accept=".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values,text/plain,application/json"
          aria-label="Upload downloadable file"
          class="sr-only"
          ref={fileInput}
          type="file"
          onChange={(event) => input("file", event.currentTarget.files)}
        />
      </Show>
    </>
  );

  const body = (mobile: boolean) => (
    <>
      <Input
        aria-label="Title"
        class={cn(
          "h-auto min-w-0 flex-1 px-0 py-0 font-semibold leading-tight shadow-none focus-visible:border-transparent focus-visible:ring-0",
          mobile ? "text-2xl" : "text-3xl tracking-tight",
        )}
        maxlength={300}
        onInput={(event) =>
          controller.fields.onTitleValueChange?.(event.currentTarget.value)
        }
        placeholder={controller.copy.placeholders.title}
        variant="flat"
        value={controller.fields.titleValue}
      />
      <PostComposerAttachmentCard
        attachment={attachment()}
        onChange={(next) => {
          if (next?.kind === "link" && controller.tabs.allows("link")) {
            controller.fields.onLinkUrlValueChange?.(next.url);
            controller.tabs.onTabChange("link");
          }
        }}
        onRemove={removeAttachment}
        onReplace={selectAttachment}
      />
      <Show when={attachmentError()}>
        <FormNote tone="warning">{attachmentError()}</FormNote>
      </Show>
      <Show when={controller.tabs.activeTab === "file"}>
        <PostComposerGenericAssetFields
          file={controller.generic.file}
          onFileChange={controller.generic.setFile}
        />
      </Show>
      <Textarea
        aria-label="Post"
        id="create-post-body"
        class={cn(
          "resize-none text-xl leading-relaxed",
          mobile
            ? "min-h-[38dvh] rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
            : "min-h-48 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0",
        )}
        onInput={(event) => updateBody(controller, event.currentTarget.value)}
        placeholder={
          attachment()
            ? controller.copy.placeholders.optional
            : controller.copy.placeholders.body
        }
        value={bodyValue(controller)}
      />
      <Show
        when={controller.tabs.activeTab === "live"}
        fallback={
          <Show
            when={
              controller.tabs.allows("event") && controller.event.state.enabled
            }
          >
            <PostComposerEventSection
              event={controller.event.state}
              onChange={controller.event.update}
              onSearchPlaces={controller.event.searchPlaces}
            />
          </Show>
        }
      >
        <LiveTabContent
          copy={controller.copy}
          live={controller.primary.liveState}
          onLiveChange={controller.primary.setLiveState}
        />
      </Show>
    </>
  );

  return (
    <>
      <Show
        when={controller.isMobile()}
        fallback={
          <>
            <CardContent
              data-composer-drop-zone
              class={cn(
                "relative space-y-4 p-8",
                dragging() && "overflow-hidden",
              )}
              onDragEnter={(event) => {
                event.preventDefault();
                dragCounter += 1;
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                event.preventDefault();
                dragCounter -= 1;
                if (dragCounter <= 0) setDragging(false);
              }}
              onDrop={drop}
            >
              <Show when={dragging()}>
                <div class="absolute inset-0 z-10 grid place-items-center rounded-[var(--radius-lg)] border-2 border-dashed border-primary bg-primary-subtle/80">
                  <div class="flex flex-col items-center gap-3">
                    <IconUploadSimple class="size-10 text-primary" />
                    <Type as="p" variant="body-strong" class="text-primary">
                      Drop a file to attach it
                    </Type>
                  </div>
                </div>
              </Show>
              {body(false)}
              <Inputs />
            </CardContent>
            <div class="flex items-center gap-3 border-t border-border-soft px-8 py-4">
              <PostComposerDesktopAttachmentToolbar
                actions={controller.tabs.permitted(attachmentActions)}
                activeKind={activeTool() ?? attachment()?.kind ?? null}
                onSelect={selectAttachment}
              />
              <Show when={props.children}>
                <div class="ms-auto min-w-0">{props.children}</div>
              </Show>
            </div>
          </>
        }
      >
        <div
          class="space-y-2 px-0 pt-1"
          style={{
            "padding-bottom": `${barPlacement() === "inline" ? 0 : 96 + keyboardOffset()}px`,
          }}
        >
          {body(true)}
        </div>
        <Show
          when={
            controller.event.state.enabled &&
            controller.tabs.activeTab !== "live"
          }
        >
          <div
            class="flex flex-wrap gap-2 px-1"
            aria-label="Selected post options"
          >
            <Type as="span" variant="caption" class="text-muted-foreground">
              {controller.event.state.isOnline
                ? "Online event"
                : "Date and place"}
            </Type>
          </div>
        </Show>
        <PostComposerMobileAttachmentBar
          actions={controller.tabs.permitted(primaryMobileAttachmentActions)}
          activeKind={activeTool() ?? attachment()?.kind ?? null}
          bottomOffset={keyboardOffset()}
          position={barPlacement()}
          onMore={
            controller.tabs.permitted(overflowMobileAttachmentActions).length >
            0
              ? () => setMoreOpen(true)
              : undefined
          }
          onSelect={selectAttachment}
        />
        <Inputs />
        <Modal open={moreOpen()} onOpenChange={setMoreOpen}>
          <ModalContent
            class="rounded-t-[var(--radius-3xl)] px-0 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-4 sm:rounded-[var(--radius-xl)] sm:p-0"
            mobileSide="bottom"
          >
            <div
              aria-hidden="true"
              class="mx-auto mb-4 h-1 w-12 rounded-full bg-muted sm:hidden"
            />
            <ModalHeader class="px-4 pe-12 text-start">
              <ModalTitle>More post attachments</ModalTitle>
            </ModalHeader>
            <div class="space-y-2 px-4 pt-5">
              <PostComposerDesktopAttachmentToolbar
                actions={controller.tabs.permitted(
                  overflowMobileAttachmentActions,
                )}
                activeKind={activeTool() ?? attachment()?.kind ?? null}
                onSelect={(kind) => {
                  setMoreOpen(false);
                  selectAttachment(kind);
                }}
              />
            </div>
          </ModalContent>
        </Modal>
      </Show>
    </>
  );
}
