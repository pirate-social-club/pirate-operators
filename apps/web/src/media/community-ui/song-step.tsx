// Song step: the audio first (its card shows the embedded artwork), then the
// title and optional lyrics, one full-width field per row. Release policy
// consent and any backend-required rating declaration belong to the next step.
// Primary audio, Instrumental and Vocals are required; the title is prefilled
// from ID3 or the filename and stays editable.

import { createSignal, onCleanup, Show } from "solid-js";

import {
  Button,
  CardContent,
  IconButton,
  IconMusicNote,
  IconPlus,
  IconUploadSimple,
  IconX,
  Input,
  Textarea,
  Type,
} from "../reference/src/design-system.ts";
import { cn } from "../reference/src/design-system.ts";
import {
  COMMUNITY_LYRICS_LIMIT as PUBLIC_SONG_LYRICS_MAX_CHARACTERS,
  mp3Issue as publicSongAudioIssue,
} from "../community-song-validation.ts";
import {
  extractEmbeddedAudioArtworkFile,
  extractEmbeddedAudioTitle,
} from "../reference/src/features/posts/post-composer/audio-artwork.ts";
import { PostComposerAttachmentCard } from "../reference/src/features/posts/post-composer/attachment-card.tsx";
import { FieldLabel } from "../reference/src/features/posts/post-composer/fields.tsx";
import { createObjectUrl } from "../reference/src/features/posts/post-composer/media-hooks.ts";
import type { PostComposerController } from "../reference/src/features/posts/post-composer/controller.ts";
import type { SongFlowRuntime } from "../reference/src/features/posts/post-composer/types.ts";

function titleFromFilename(name: string): string {
  const index = name.lastIndexOf(".");
  return (index > 0 ? name.slice(0, index) : name).trim();
}

export function SongStep(props: {
  controller: PostComposerController;
  runtime?: SongFlowRuntime;
  release?: import("./release-steps.tsx").CommunityReleaseUI;
}) {
  const controller = props.controller;
  const song = () => controller.song.state;
  const coverPreview = createObjectUrl(() => song().coverUpload);
  const [dragging, setDragging] = createSignal(false);
  const [readingFile, setReadingFile] = createSignal(false);
  const [fileError, setFileError] = createSignal<string | null>(null);
  const audioLocked = () => props.runtime?.retained === true;
  let dragCounter = 0;
  let audioInput: HTMLInputElement | undefined;

  const attachment = () => {
    const upload = song().primaryAudioUpload;
    const label = upload?.name ?? song().primaryAudioLabel;
    return label?.trim()
      ? ({ kind: "song", label, artworkUrl: coverPreview() } as const)
      : null;
  };

  let fileSelection = 0;
  let live = true;
  onCleanup(() => { live = false; fileSelection++; });
  async function selectFile(file: File | undefined) {
    if (!live || !file || audioLocked()) return;
    const selection = ++fileSelection;
    const issue = publicSongAudioIssue(file);
    if (issue !== null) {
      setFileError(issue);
      return;
    }
    setFileError(null);
    setReadingFile(true);
    try {
      const [embeddedTitle, artwork] = await Promise.all([
        extractEmbeddedAudioTitle(file),
        extractEmbeddedAudioArtworkFile(file),
      ]);
      if (selection !== fileSelection || audioLocked()) return;
      controller.song.update((current) => ({
        ...current,
        primaryAudioUpload: file,
        primaryAudioLabel: file.name,
        title:
          current.title?.trim() ||
          embeddedTitle ||
          titleFromFilename(file.name),
        coverUpload: artwork,
        coverLabel: artwork?.name,
        coverSource: artwork ? "embedded" : undefined,
        lyricsEditorState: "hidden",
      }));
    } catch {
      if (live && selection === fileSelection) setFileError("The audio file could not be read. Choose it again.");
    } finally {
      if (selection === fileSelection) setReadingFile(false);
    }
  }

  const drop = (event: DragEvent) => {
    event.preventDefault();
    dragCounter = 0;
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void selectFile(file);
  };

  const removeAudio = () => {
    controller.song.update((state) => ({
      ...state,
      primaryAudioUpload: null,
      primaryAudioLabel: undefined,
    }));
    // Removing the audio returns to the text composer, matching the entry
    // that selected it: with no song attached there is nothing to review.
    controller.tabs.onTabChange("text");
  };

  return (
    <CardContent
      class={cn(
        "relative space-y-6 p-8",
        controller.isMobile() && "px-0 pb-4 pt-1",
        dragging() && "overflow-hidden",
      )}
      onDragEnter={(event) => {
        event.preventDefault();
        dragCounter += 1;
        setDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragCounter -= 1;
        if (dragCounter <= 0) setDragging(false);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
    >
      <Show when={dragging()}>
        <div class="absolute inset-0 z-10 grid place-items-center rounded-[var(--radius-lg)] border-2 border-dashed border-primary bg-primary-subtle/80">
          <div class="flex flex-col items-center gap-3">
            <IconUploadSimple class="size-10 text-primary" />
            <Type as="p" variant="body-strong" class="text-primary">
              Drop a song to attach it
            </Type>
          </div>
        </div>
      </Show>

      <section class="space-y-3">
        <FieldLabel label="Audio" required />
        <Show
          when={attachment()}
          fallback={
            <Show
              when={audioLocked()}
              fallback={
                <button
                  class="grid w-full cursor-pointer place-items-center gap-3 rounded-[var(--radius-lg)] border-2 border-dashed border-border-soft bg-muted/20 px-4 py-10 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => audioInput?.click()}
                  type="button"
                >
                  <IconMusicNote class="size-8" />
                  <Type as="span" variant="body-strong">
                    Add audio
                  </Type>
                </button>
              }
            >
              <Type as="p" variant="caption" class="text-muted-foreground">
                {props.runtime?.audioPrepared
                  ? "Audio is retained by the server; the browser file is unavailable."
                  : "The browser audio file is unavailable. Cancel this submission to start again."}
              </Type>
            </Show>
          }
        >
          <PostComposerAttachmentCard
            attachment={attachment()!}
            onChange={() => undefined}
            onRemove={removeAudio}
            onReplace={() => audioInput?.click()}
          />
        </Show>
        <Show when={fileError()}>
          <Type as="p" variant="caption" class="text-destructive-text">
            {fileError()}
          </Type>
        </Show>
      </section>

      <section aria-labelledby="song-stems-label" class="space-y-2">
        <FieldLabel
          htmlFor="song-stem-instrumental"
          label="Instrumental and vocals"
          required
        />
        <Type
          as="p"
          id="song-stems-label"
          variant="caption"
          class="-mt-1 text-muted-foreground"
        >
          Both are required to continue and unlock Karaoke and Study.
        </Type>
        <div class="divide-y divide-border-soft overflow-hidden rounded-[var(--radius-lg)] border border-border-soft">
          <StemRow
            file={song().instrumentalAudioUpload ?? null}
            id="song-stem-instrumental"
            label="Instrumental"
            attached={props.runtime?.stems?.instrumental === true}
            locked={
              props.runtime?.locked === true ||
              props.runtime?.stems?.instrumental === true ||
              props.runtime?.pendingStems?.instrumental === true
            }
            onChange={(file) =>
              controller.song.update((current) => ({
                ...current,
                instrumentalAudioUpload: file,
                instrumentalAudioLabel: file?.name,
              }))
            }
            onReject={setFileError}
          />
          <StemRow
            file={song().vocalAudioUpload ?? null}
            id="song-stem-vocals"
            label="Vocals"
            attached={props.runtime?.stems?.vocals === true}
            locked={
              props.runtime?.locked === true ||
              props.runtime?.stems?.vocals === true ||
              props.runtime?.pendingStems?.vocals === true
            }
            onChange={(file) =>
              controller.song.update((current) => ({
                ...current,
                vocalAudioUpload: file,
                vocalAudioLabel: file?.name,
              }))
            }
            onReject={setFileError}
          />
        </div>
      </section>

      <section>
        <FieldLabel htmlFor="song-track-title" label="Song title" required />
        <Input
          id="song-track-title"
          disabled={audioLocked() || readingFile()}
          maxlength={200}
          onChange={(event) =>
            controller.song.update((current) => ({
              ...current,
              title: event.currentTarget.value,
            }))
          }
          placeholder="Song title"
          value={song().title ?? ""}
        />
      </section>

      <section>
        <FieldLabel htmlFor="song-lyrics" label="Lyrics" />
        <Textarea
          id="song-lyrics"
          class="min-h-32 resize-y"
          disabled={audioLocked()}
          maxlength={PUBLIC_SONG_LYRICS_MAX_CHARACTERS}
          onChange={(event) =>
            controller.fields.onLyricsValueChange?.(event.currentTarget.value)
          }
          value={controller.fields.lyricsValue}
        />
      </section>

      <input
        accept=".mp3,audio/mpeg"
        aria-label="Upload audio"
        class="sr-only"
        disabled={audioLocked() || readingFile()}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void selectFile(file);
          event.currentTarget.value = "";
        }}
        ref={audioInput}
        type="file"
      />
    </CardContent>
  );
}

/** Keep an uncertain stem's original file until its attachment is reconciled. */
function StemRow(props: {
  file: File | null;
  id: string;
  label: string;
  locked: boolean;
  attached: boolean;
  onChange: (file: File | null) => void;
  onReject: (message: string | null) => void;
}) {
  let input: HTMLInputElement | undefined;
  const choose = (file: File | undefined) => {
    if (!file || props.locked) return;
    const issue = publicSongAudioIssue(file);
    if (issue !== null) {
      props.onReject(issue);
      return;
    }
    props.onReject(null);
    props.onChange(file);
  };
  return (
    <div class="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2">
      <div class="min-w-0">
        <Type as="p" variant="body-strong">
          {props.label}
        </Type>
        <Show when={props.file}>
          {(file) => (
            <Type
              as="p"
              class="truncate text-muted-foreground"
              variant="caption"
            >
              {file().name}
            </Type>
          )}
        </Show>
        <Show when={props.attached}>
          <Type as="p" class="text-muted-foreground" variant="caption">
            Attached
          </Type>
        </Show>
      </div>
      <Show
        when={props.file || props.attached}
        fallback={
          <Button
            aria-label={`Add ${props.label.toLowerCase()}`}
            disabled={props.locked}
            leadingIcon={<IconPlus class="size-4" />}
            onClick={() => input?.click()}
            size="sm"
            variant="ghost"
          >
            Add
          </Button>
        }
      >
        <IconButton
          aria-label={`Remove ${props.label.toLowerCase()}`}
          disabled={props.locked}
          onClick={() => {
            if (!props.locked) props.onChange(null);
          }}
          variant="ghost"
        >
          <IconX class="size-5" />
        </IconButton>
      </Show>
      <input
        accept=".mp3,audio/mpeg"
        aria-label={`Upload ${props.label.toLowerCase()}`}
        class="sr-only"
        disabled={props.locked}
        id={props.id}
        onChange={(event) => {
          choose(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
        ref={input}
        type="file"
      />
    </div>
  );
}
