/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { Show, onSettled } from "solid-js";

import {
  Button,
  Card,
  FormNote,
  IconButton,
  IconMusicNote,
  IconVideoCamera,
  IconX,
  Input,
  Textarea,
  Type,
} from "../../../design-system.ts";
import { PostComposerField } from "../post-composer/fields.tsx";
import { createPhoneLayout } from "../../shell/composing-surface.tsx";

export interface TextPostDraft {
  readonly title: string;
  readonly body: string;
  readonly ageGatePolicy: "none" | "18_plus";
}

export const emptyTextPostDraft: TextPostDraft = {
  title: "",
  body: "",
  ageGatePolicy: "none",
};

export interface TextPostPanelProps {
  readonly draft: TextPostDraft;
  readonly onDraftChange: (draft: TextPostDraft) => void;
  readonly onPost: () => void;
  readonly onClose: () => void;
  /** Absent when the surface cannot start that kind of post. */
  readonly onSong?: (file: File) => void;
  readonly onVideo?: () => void;
  /** Why posting is unavailable, such as no profile for this community. */
  readonly unavailable?: string;
}

/**
 * The post form occupies the community page's main content column. Posting
 * hands the text to the application owner and returns to the feed immediately;
 * delivery and recovery stay with that owner.
 *
 * Paper rulings 10-12 (2026-10-09): the title is required and marked with an
 * asterisk; the way out is a close at the top left beside "New post", with no
 * Cancel; on a phone the form is a flat surface whose labelled Post button
 * sits full width in a footer kept on screen while the page scrolls. Song and
 * Video sit in a plain row under the text field.
 */
export function TextPostPanel(props: TextPostPanelProps): JSX.Element {
  let bodyInput: HTMLTextAreaElement | undefined;
  let songInput: HTMLInputElement | undefined;
  onSettled(() => {
    bodyInput?.focus();
  });
  const canPost = () =>
    props.unavailable === undefined &&
    props.draft.title.trim() !== "" &&
    props.draft.body.trim() !== "";
  const post = () => {
    if (canPost()) props.onPost();
  };

  const isMobile = createPhoneLayout();

  const songEntry = () => (
    <Show when={props.onSong}>
      <Button
        class="min-w-0 px-3"
        aria-label="Post a song"
        leadingIcon={<IconMusicNote class="size-5" />}
        onClick={() => songInput?.click()}
        type="button"
        variant="outline"
      >
        Song
      </Button>
      <input
        accept=".mp3,audio/mpeg"
        aria-label="Choose a song file"
        class="sr-only"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) props.onSong?.(file);
        }}
        ref={songInput}
        tabindex={-1}
        type="file"
      />
    </Show>
  );
  const videoEntry = () => (
    <Show when={props.onVideo}>
      <Button
        class="min-w-0 px-3"
        aria-label="Post a video"
        leadingIcon={<IconVideoCamera class="size-5" />}
        onClick={() => props.onVideo?.()}
        type="button"
        variant="outline"
      >
        Video
      </Button>
    </Show>
  );
  const fields = (mobile: boolean) => (
    <>
      <PostComposerField htmlFor="text-post-title" label="Title" required>
        <Input
          aria-label="Title"
          aria-required="true"
          class="w-full"
          id="text-post-title"
          maxlength={300}
          onInput={(event) =>
            props.onDraftChange({
              ...props.draft,
              title: event.currentTarget.value,
            })
          }
          placeholder="Give your post a title"
          value={props.draft.title}
        />
      </PostComposerField>
      <PostComposerField htmlFor="text-post-body" label="Post">
        <Textarea
          aria-label="Post"
          id="text-post-body"
          class={
            mobile
              ? "min-h-40 w-full resize-y text-base leading-relaxed"
              : "min-h-48 w-full resize-y text-base leading-relaxed md:min-h-64"
          }
          onInput={(event) =>
            props.onDraftChange({
              ...props.draft,
              body: event.currentTarget.value,
            })
          }
          placeholder="Write your post"
          ref={bodyInput}
          value={props.draft.body}
        />
      </PostComposerField>
      <Show when={props.unavailable}>
        {(reason) => <FormNote tone="warning">{reason()}</FormNote>}
      </Show>
    </>
  );

  const close = (size: string) => (
    <IconButton
      aria-label="Close composer"
      onClick={() => props.onClose()}
      type="button"
      variant="ghost"
    >
      <IconX class={size} />
    </IconButton>
  );

  return (
    <div
      class="w-full min-w-0"
      data-text-post-panel
      data-presentation={isMobile() ? "flat" : "card"}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) post();
      }}
    >
      <Show
        when={isMobile()}
        fallback={
          <Card class="w-full">
            <form
              aria-label="Create a post"
              class="flex flex-col gap-5 p-5 md:p-6"
              onSubmit={(event) => {
                event.preventDefault();
                post();
              }}
            >
              <div class="-ms-2 flex items-center gap-2">
                {close("size-5")}
                <Type as="h2" variant="h2">
                  New post
                </Type>
              </div>
              {fields(false)}
              <div class="flex flex-wrap items-center gap-2 border-t border-border-soft pt-4">
                {songEntry()}
                {videoEntry()}
                <Button
                  class="ms-auto min-w-24"
                  disabled={!canPost()}
                  type="submit"
                >
                  Post
                </Button>
              </div>
            </form>
          </Card>
        }
      >
        <form
          aria-label="Create a post"
          class="flex min-h-dvh flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            post();
          }}
        >
          <header
            class="sticky top-0 z-20 -mx-4 grid min-h-14 grid-cols-[2.75rem_1fr_2.75rem] items-center bg-background px-3 pt-[env(safe-area-inset-top)]"
            data-composer-sticky-header
          >
            {close("size-5")}
            <Type as="h2" class="text-center" variant="h3">
              New post
            </Type>
          </header>
          {fields(true)}
          <div
            aria-label="Add to your post"
            class="flex flex-wrap items-center gap-2"
            role="group"
          >
            {songEntry()}
            {videoEntry()}
          </div>
          <footer
            class="sticky bottom-0 z-20 -mx-4 mt-auto border-t border-border-soft bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3"
            data-composer-footer
          >
            <Button
              class="h-12 w-full"
              disabled={!canPost()}
              size="lg"
              type="submit"
            >
              Post
            </Button>
          </footer>
        </form>
      </Show>
    </div>
  );
}
