// Shared composer field primitives, ported from the React
// post-composer-fields.tsx (FieldLabel, UploadField, LabeledTextarea).

import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";

import {
  FormFieldLabel,
  IconImage,
  IconX,
  Textarea,
} from "../../../design-system.ts";
import { cn } from "../../../design-system.ts";

export function FieldLabel(props: {
  label: string;
  counter?: JSX.Element;
  class?: string;
  labelClass?: string;
  htmlFor?: string;
  required?: boolean;
  tone?: "default" | "muted";
}) {
  return (
    <FormFieldLabel
      class={cn("mb-2", props.class)}
      counter={props.counter}
      htmlFor={props.htmlFor}
      label={props.label}
      labelClass={props.labelClass}
      required={props.required}
      tone={props.tone}
    />
  );
}

export function PostComposerField(props: {
  children: JSX.Element;
  class?: string;
  counter?: JSX.Element;
  htmlFor?: string;
  label: string;
  required?: boolean;
  tone?: "default" | "muted";
}) {
  return (
    <div class={cn("grid gap-1.5", props.class)}>
      <FieldLabel
        class="mb-0"
        counter={props.counter}
        htmlFor={props.htmlFor}
        label={props.label}
        required={props.required}
        tone={props.tone}
      />
      {props.children}
    </div>
  );
}

export function UploadField(props: {
  label: string;
  accept: string;
  artworkHelp?: string;
  artworkPlaceholderLabel?: string;
  artworkPreviewAspect?: "square" | "video";
  chooseFileLabel?: string;
  replaceLabel?: string;
  coverLabel?: string;
  noFileSelectedLabel?: string;
  squareArtworkLabel?: string;
  uploadArtworkHelp?: string;
  multiple?: boolean;
  onChange?: (files: FileList | null) => void;
  onClear?: () => void;
  placeholderLabel?: string;
  previewUrl?: string;
  required?: boolean;
  selectedLabel?: string;
  variant?: "default" | "artwork";
}) {
  const inputId = `upload-${props.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  let inputRef: HTMLInputElement | undefined;
  const isArtwork = () => props.variant === "artwork";
  const showClear = () => Boolean(props.selectedLabel && props.onClear);

  return (
    <div class="block">
      <FieldLabel
        htmlFor={inputId}
        label={props.label}
        required={props.required}
      />
      <div class="flex items-stretch gap-2">
        <input
          accept={props.accept}
          class="sr-only"
          id={inputId}
          multiple={props.multiple ?? false}
          onChange={(event) => {
            props.onChange?.(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
          ref={inputRef}
          required={props.required}
          type="file"
        />
        <label
          class={cn(
            "flex min-w-0 flex-1 cursor-pointer rounded-[var(--radius-lg)] border border-border-soft bg-background transition-colors hover:border-primary/40",
            isArtwork()
              ? "items-center gap-4 p-4"
              : "items-center justify-between gap-4 px-4 py-3.5",
          )}
          for={inputId}
        >
          <Show
            when={isArtwork()}
            fallback={
              <div class="min-w-0">
                <p class="truncate text-base font-semibold text-foreground">
                  {props.selectedLabel ||
                    props.placeholderLabel ||
                    props.noFileSelectedLabel ||
                    "No file selected"}
                </p>
              </div>
            }
          >
            <div
              class={cn(
                "grid shrink-0 place-items-center overflow-hidden rounded-[var(--radius-lg)] border border-border-soft bg-muted",
                props.artworkPreviewAspect === "video"
                  ? "aspect-video w-32"
                  : "size-24",
              )}
            >
              <Show
                when={props.previewUrl}
                fallback={
                  <Show
                    when={props.selectedLabel}
                    fallback={
                      <IconImage class="size-8 text-muted-foreground" />
                    }
                  >
                    <span class="px-3 text-center text-base font-semibold text-foreground">
                      {props.coverLabel ?? "Cover"}
                    </span>
                  </Show>
                }
              >
                {(url) => (
                  <img
                    alt=""
                    class="size-full rounded-[var(--radius-lg)] object-cover"
                    src={url()}
                  />
                )}
              </Show>
            </div>
            <div class="min-w-0 flex-1 space-y-1">
              <p class="truncate text-base font-semibold text-foreground">
                {props.selectedLabel ||
                  props.artworkPlaceholderLabel ||
                  props.squareArtworkLabel ||
                  "Upload square artwork"}
              </p>
              <p class="text-base text-muted-foreground">
                {props.artworkHelp ||
                  props.uploadArtworkHelp ||
                  "Shows in feed, release, and player surfaces."}
              </p>
            </div>
          </Show>
          <span class="inline-flex shrink-0 items-center rounded-full bg-muted px-3.5 py-2 text-base font-semibold text-foreground">
            {props.selectedLabel
              ? (props.replaceLabel ?? "Replace")
              : (props.chooseFileLabel ?? "Choose file")}
          </span>
        </label>
        <Show when={showClear()}>
          <button
            aria-label={`Remove ${props.label.toLowerCase()}`}
            class="grid w-12 shrink-0 place-items-center rounded-full border border-border-soft bg-background text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            onClick={() => {
              if (inputRef) inputRef.value = "";
              props.onClear?.();
            }}
            type="button"
          >
            <IconX class="size-5" />
          </button>
        </Show>
      </div>
    </div>
  );
}

export function LabeledTextarea(props: {
  label: string;
  placeholder: string;
  value?: string;
  onChange?: (value: string) => void;
  class?: string;
  labelClass?: string;
  labelTextClass?: string;
  variant?: "default" | "flat";
  required?: boolean;
  htmlFor?: string;
}) {
  return (
    <div>
      <FieldLabel
        class={props.labelClass}
        htmlFor={props.htmlFor}
        label={props.label}
        labelClass={props.labelTextClass}
        required={props.required}
      />
      <Textarea
        class={props.class}
        id={props.htmlFor}
        onChange={(event) => props.onChange?.(event.currentTarget.value)}
        placeholder={props.placeholder}
        required={props.required}
        variant={props.variant}
        value={props.value}
      />
    </div>
  );
}
