// Independently owned source copy from src/features/posts/post-composer/video-original-audio-surface.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db; local design-system import extension only.
import type { JSX } from "@solidjs/web";
import { Match, Show, Switch } from "solid-js";

import {
  ActionFooterShell,
  Button,
  FormNote,
  IconArrowsClockwise,
  IconButton,
  IconImage,
  IconMusicNote,
  IconPlay,
  IconUploadSimple,
  IconWarningCircle,
  MobilePageHeader,
  IconX,
  Type,
  cn,
} from "../../../design-system.ts";

export type OriginalVideoCaptureStatus =
  | "idle"
  | "recording"
  | "camera_denied"
  | "capability_unavailable"
  /** A recording that started and then ended without a usable file. */
  | "recording_failed"
  | "orientation_lost"
  | "guide_interrupted";

export interface OriginalVideoCaptureSurfaceProps {
  readonly preview?: JSX.Element;
  readonly channel?: "camera" | "upload";
  readonly status?: OriginalVideoCaptureStatus;
  readonly elapsedLabel?: string;
  readonly durationLabel?: string;
  readonly title?: string;
  readonly recordDisabled?: boolean;
  readonly recordActionLabel?: string;
  readonly allowUpload?: boolean;
  readonly timerClass?: string;
  readonly onClose?: () => void;
  readonly onBack?: () => void;
  readonly onRecordToggle?: () => void;
  readonly onUpload?: () => void;
  readonly onRetake?: () => void;
  readonly onFlipCamera?: () => void;
  /** The song this take is recorded to, shown in place of the title. */
  readonly songLabel?: string;
  /** Opens the song's excerpt controls. */
  readonly onSongTap?: () => void;
  /** A state the author must know before recording: a pending check, a
   * refusal, a retryable failure. Rendered over the viewfinder. */
  readonly notice?: JSX.Element;
}

/**
 * Presentational phase-one capture surface. A host owns capability probing,
 * camera and microphone streams, orientation locking, recording and files.
 */
export function OriginalVideoCaptureSurface(
  props: OriginalVideoCaptureSurfaceProps,
) {
  const channel = () => props.channel ?? "camera";
  const status = () => props.status ?? "idle";
  const recording = () => status() === "recording";
  const cameraControls = () =>
    channel() === "camera" && (status() === "idle" || status() === "recording");

  return (
    <Show
      when={channel() === "upload"}
      fallback={
        <section class="relative h-dvh overflow-hidden bg-black text-white">
          <div class="absolute inset-0 flex items-center justify-center">
            <div
              class="relative aspect-[9/16] w-full max-w-[56.25dvh] overflow-hidden bg-gradient-to-b from-[#262a30] to-[#0d0f12]"
              data-video-viewfinder
            >
              {props.preview}
              <Switch>
                <Match when={status() === "camera_denied"}>
                  <CaptureMessage
                    action="Try again"
                    body="Camera or microphone access is off. Allow it in your browser settings, then try again, or upload a video instead."
                    icon={<IconWarningCircle class="size-7" />}
                    title="Camera unavailable"
                    onAction={props.onRetake}
                    onSecondaryAction={props.onUpload}
                    secondaryAction="Choose a video instead"
                  />
                </Match>
                <Match when={status() === "capability_unavailable"}>
                  <CaptureMessage
                    action="Upload a video"
                    body="This browser can’t record video. You can upload a video from your device instead."
                    icon={<IconWarningCircle class="size-7" />}
                    title="Recording isn’t available here"
                    onAction={props.onUpload}
                  />
                </Match>
                <Match when={status() === "recording_failed"}>
                  <CaptureMessage
                    action="Try again"
                    body="The recording ended before it finished, so nothing was saved. Try again, or upload a video instead."
                    icon={<IconWarningCircle class="size-7" />}
                    title="Recording stopped"
                    onAction={props.onRetake}
                    onSecondaryAction={props.onUpload}
                    secondaryAction="Upload a video"
                  />
                </Match>
                <Match when={status() === "orientation_lost"}>
                  <CaptureMessage
                    action="Retake video"
                    body="The phone rotated. Keep it upright and record again."
                    icon={<IconArrowsClockwise class="size-7" />}
                    title="Retake in one orientation"
                    onAction={props.onRetake}
                  />
                </Match>
                <Match when={status() === "guide_interrupted"}>
                  <CaptureMessage
                    action="Record again"
                    body="The recording stopped. Record a new video."
                    icon={<IconArrowsClockwise class="size-7" />}
                    title="Recording interrupted"
                    onAction={props.onRetake}
                  />
                </Match>
              </Switch>
            </div>
          </div>

          <header class="absolute inset-x-0 top-0 z-10 flex items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <IconButton
              aria-label="Close video capture"
              class="size-10 bg-black/45 backdrop-blur-sm"
              onClick={() => props.onClose?.()}
              variant="secondary"
            >
              <IconX class="size-5" />
            </IconButton>
            <div class="flex min-w-0 flex-1 justify-center">
              <Show
                when={props.songLabel}
                fallback={
                  <Show
                    when={props.onSongTap}
                    fallback={
                      <Type
                        as="h1"
                        variant="body-strong"
                        class="text-center text-white"
                      >
                        {props.title ?? "New video"}
                      </Type>
                    }
                  >
                    <button
                      aria-label="Add song"
                      class="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-full bg-black/45 px-3 py-2 text-sm font-medium text-white backdrop-blur-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => props.onSongTap?.()}
                      type="button"
                    >
                      <IconMusicNote
                        aria-hidden="true"
                        class="size-4 shrink-0"
                      />
                      <span>Add song</span>
                    </button>
                  </Show>
                }
              >
                {(label) => (
                  <button
                    aria-label={`Song: ${label()}. Adjust the part of the song`}
                    class="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-full bg-black/45 px-3 py-2 text-sm font-medium text-white backdrop-blur-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                    disabled={!props.onSongTap || recording()}
                    onClick={() => props.onSongTap?.()}
                    type="button"
                  >
                    <IconMusicNote aria-hidden="true" class="size-4 shrink-0" />
                    <span class="truncate">{label()}</span>
                  </button>
                )}
              </Show>
            </div>
            <span aria-hidden="true" class="size-10" />
          </header>

          <Show when={props.notice}>
            <div class="absolute inset-x-0 top-[calc(3.75rem+env(safe-area-inset-top))] z-10 px-4">
              {props.notice}
            </div>
          </Show>

          <Show when={cameraControls()}>
            <div class="absolute inset-x-0 bottom-0 z-10 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <Show when={props.elapsedLabel && props.durationLabel}>
                <div class="mb-5 flex justify-center">
                  <span
                    class={cn(
                      "inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-sm font-medium tabular-nums backdrop-blur-sm",
                      props.timerClass,
                    )}
                    role="timer"
                  >
                    <span
                      aria-hidden="true"
                      class={cn(
                        "size-2 rounded-full",
                        recording() ? "bg-destructive" : "bg-white/45",
                      )}
                    />
                    {`${props.elapsedLabel} / ${props.durationLabel}`}
                  </span>
                </div>
              </Show>
              <div class="grid grid-cols-3 items-center justify-items-center">
                <Show
                  when={props.allowUpload !== false}
                  fallback={<span aria-hidden="true" />}
                >
                  <CaptureSideAction
                    disabled={recording()}
                    icon={<IconImage class="size-5" />}
                    label="Upload"
                    onClick={() => props.onUpload?.()}
                  />
                </Show>
                <button
                  aria-label={
                    props.recordActionLabel ??
                    (recording() ? "Stop recording" : "Start recording")
                  }
                  aria-pressed={recording() ? "true" : "false"}
                  disabled={props.recordDisabled}
                  class="grid size-[74px] cursor-pointer place-items-center rounded-full border-4 border-white outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-black"
                  onClick={() => props.onRecordToggle?.()}
                  type="button"
                >
                  <span
                    class={cn(
                      "bg-[#f0453a] transition-[border-radius,width,height] duration-200 motion-reduce:transition-none",
                      recording()
                        ? "size-6 rounded-[6px]"
                        : "size-[58px] rounded-full",
                    )}
                  />
                </button>
                <Show when={props.onFlipCamera && !recording()}>
                  <CaptureSideAction
                    icon={<IconArrowsClockwise class="size-5" />}
                    label="Flip"
                    onClick={() => props.onFlipCamera?.()}
                  />
                </Show>
              </div>
            </div>
          </Show>
        </section>
      }
    >
      <OriginalVideoUploadSurface {...props} />
    </Show>
  );
}

function OriginalVideoUploadSurface(props: OriginalVideoCaptureSurfaceProps) {
  return (
    <ActionFooterShell
      fullViewport
      class="bg-background text-foreground"
      header={
        <MobilePageHeader
          class="relative z-10"
          title="Upload video"
          backAriaLabel="Back to song"
          onBackClick={() => (props.onBack ?? props.onClose)?.()}
        />
      }
      bodyClass="grid place-items-center px-4 py-8"
      footer={
        <Button
          class="mx-auto flex w-full max-w-md"
          size="lg"
          onClick={() => props.onUpload?.()}
        >
          Choose a video
        </Button>
      }
    >
      <div class="mx-auto grid w-full max-w-md gap-6 text-center">
        <IconUploadSimple
          aria-hidden="true"
          class="mx-auto size-12 text-muted-foreground"
        />
        <Type as="p" variant="body" class="text-muted-foreground">
          MP4 or MOV, 3 to 15 seconds long.
        </Type>
        <Show when={props.songLabel}>
          <Button
            onClick={() => props.onSongTap?.()}
            type="button"
            variant="secondary"
          >
            <IconMusicNote aria-hidden="true" class="size-4" />
            {props.songLabel}
          </Button>
        </Show>
        {props.notice}
      </div>
    </ActionFooterShell>
  );
}

function CaptureMessage(props: {
  readonly action: string;
  readonly body: string;
  readonly icon: JSX.Element;
  readonly title: string;
  readonly onAction?: () => void;
  /** A second way forward, offered beside the first. */
  readonly secondaryAction?: string;
  readonly onSecondaryAction?: () => void;
}) {
  return (
    <div class="flex h-full flex-col items-center justify-center gap-4 bg-black px-8 text-center">
      <span class="grid size-16 place-items-center rounded-full bg-white/10">
        {props.icon}
      </span>
      <div class="space-y-2">
        <Type as="h2" variant="h3" class="text-white">
          {props.title}
        </Type>
        <Type as="p" variant="body" class="max-w-sm text-white/70">
          {props.body}
        </Type>
      </div>
      <div class="flex flex-col items-center gap-2">
        <Button onClick={() => props.onAction?.()} size="lg">
          {props.action}
        </Button>
        <Show when={props.secondaryAction}>
          {(label) => (
            <Button
              class="text-white hover:bg-white/10 hover:text-white"
              onClick={() => props.onSecondaryAction?.()}
              size="lg"
              variant="ghost"
            >
              {label()}
            </Button>
          )}
        </Show>
      </div>
    </div>
  );
}

function CaptureSideAction(props: {
  readonly disabled?: boolean;
  readonly icon: JSX.Element;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      class="flex cursor-pointer flex-col items-center gap-1.5 rounded-[var(--radius-lg)] p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
      disabled={props.disabled}
      onClick={props.onClick}
      type="button"
    >
      <span class="grid size-11 place-items-center rounded-[var(--radius-lg)] bg-white/10 backdrop-blur-sm">
        {props.icon}
      </span>
      <span class="text-xs text-white">{props.label}</span>
    </button>
  );
}

export interface OriginalVideoReviewSurfaceProps {
  readonly preview?: JSX.Element;
  readonly submitting?: boolean;
  readonly submitLabel?: string;
  readonly publishDisabled?: boolean;
  readonly notice?: string;
  /** The song this video is posted to, when it has one. */
  readonly songLabel?: string;
  /** Opens the song's controls, where the author can change the sound. */
  readonly onSongTap?: () => void;
  /** Anything the author must see before publishing, such as the audience
   *  setting or a problem with the take. */
  readonly details?: JSX.Element;
  readonly onBack?: () => void;
  readonly onPublish?: () => void;
}

/** Review step: the video, its song and one publication action. */
export function OriginalVideoReviewSurface(
  props: OriginalVideoReviewSurfaceProps,
) {
  return (
    <ActionFooterShell
      class="bg-background text-foreground"
      footer={
        <Button
          class="mx-auto flex w-full max-w-4xl"
          disabled={props.submitting || props.publishDisabled}
          loading={props.submitting}
          onClick={() => props.onPublish?.()}
          size="lg"
        >
          {props.submitLabel ?? "Post"}
        </Button>
      }
      fullViewport
      header={
        <MobilePageHeader
          class="relative z-10"
          title="Review video"
          backAriaLabel="Back to capture"
          onBackClick={() => props.onBack?.()}
        />
      }
    >
      <Show when={props.details}>
        {(details) => (
          <div class="mx-auto w-full max-w-4xl px-4 pt-4 md:px-6">
            {details()}
          </div>
        )}
      </Show>
      <Show when={props.notice}>
        {(message) => (
          <FormNote tone="warning" class="mx-auto w-full max-w-4xl px-4 pt-4">
            {message()}
          </FormNote>
        )}
      </Show>
      <div class="mx-auto grid w-full max-w-4xl gap-5 p-4 md:p-6">
        <div class="grid gap-3">
          <div
            data-video-review-frame
            class="relative mx-auto aspect-[9/16] w-[min(100%,32.625dvh)] overflow-hidden rounded-[var(--radius-2xl)] bg-gradient-to-b from-[#262a30] to-[#0d0f12]"
          >
            <Show
              when={props.preview}
              fallback={
                <IconButton
                  aria-label="Play video preview"
                  class="absolute left-1/2 top-1/2 size-16 -translate-x-1/2 -translate-y-1/2 bg-black/60"
                  variant="secondary"
                >
                  <IconPlay class="size-7" />
                </IconButton>
              }
            >
              {props.preview}
            </Show>
          </div>
          <Show when={props.songLabel}>
            {(label) => (
              <button
                aria-label={`Song: ${label()}. Change the sound`}
                class="mx-auto inline-flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                disabled={!props.onSongTap || props.submitting}
                onClick={() => props.onSongTap?.()}
                type="button"
              >
                <IconMusicNote aria-hidden="true" class="size-4 shrink-0" />
                <span class="truncate">{label()}</span>
              </button>
            )}
          </Show>
        </div>
      </div>
    </ActionFooterShell>
  );
}
