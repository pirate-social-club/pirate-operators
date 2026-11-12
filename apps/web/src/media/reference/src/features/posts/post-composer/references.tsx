// Reference rows and pickers (remix sources, live setlist), ported from the
// React post-composer-references.tsx. Differences:
// - `SearchReferencePicker` uses the DS Combobox, which filters internally
//   over the provided options; the React version's external query callback is
//   dropped (the picker now receives already-filtered options).
// - Story explorer links default to the mainnet explorer; React read the
//   network from app config.

import { createSignal, For, Show } from "solid-js";

import {
  Button,
  Combobox,
  FormNote,
  IconArrowSquareOut,
  IconTrash,
  Input,
  Type,
} from "../../../design-system.ts";
import type { ComposerCopy } from "./copy.ts";
import { FieldLabel } from "./fields.tsx";
import {
  buildPublicProfilePath,
  buildStoryExplorerIpAssetUrl,
  dedupeReferences,
  isPublicHandle,
  referenceLicenseLabel,
} from "./reference-model.ts";
import type { ComposerReference, LiveSetlistItemInput } from "./types.ts";

function ReferenceMeta(props: {
  item: ComposerReference;
  linkSubtitle?: boolean;
  showStoryLink?: boolean;
  showStoryStatus?: boolean;
}) {
  const royaltyLabel = () => referenceLicenseLabel(props.item);
  const explorerHref = () =>
    buildStoryExplorerIpAssetUrl(props.item.parentIpId, "story-mainnet");
  const storyLinkHref = () =>
    props.showStoryLink !== false ? explorerHref() : null;
  const storyStatusLabel = () =>
    explorerHref() && props.showStoryStatus ? "Story registered" : null;

  return (
    <Show
      when={
        props.item.subtitle ||
        royaltyLabel() ||
        storyLinkHref() ||
        storyStatusLabel()
      }
    >
      <Type
        as="p"
        class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground"
        variant="caption"
      >
        <Show
          when={
            props.linkSubtitle !== false && isPublicHandle(props.item.subtitle)
              ? props.item.subtitle
              : null
          }
        >
          {(subtitle) => (
            <a
              class="max-w-full truncate hover:text-foreground hover:underline"
              href={buildPublicProfilePath(subtitle())}
              onClick={(event) => event.stopPropagation()}
              rel="noreferrer"
              target="_blank"
            >
              {subtitle()}
            </a>
          )}
        </Show>
        <Show
          when={
            !(
              props.linkSubtitle !== false &&
              isPublicHandle(props.item.subtitle)
            ) && props.item.subtitle
          }
        >
          <span class="max-w-full truncate">{props.item.subtitle}</span>
        </Show>
        <Show when={props.item.subtitle && royaltyLabel()}>
          <span aria-hidden="true">·</span>
        </Show>
        <Show when={royaltyLabel()}>{(label) => <span>{label()}</span>}</Show>
        <Show
          when={
            (props.item.subtitle || royaltyLabel()) &&
            (storyStatusLabel() || storyLinkHref())
          }
        >
          <span aria-hidden="true">·</span>
        </Show>
        <Show when={storyStatusLabel()}>
          {(label) => <span>{label()}</span>}
        </Show>
        <Show when={storyLinkHref()}>
          {(href) => (
            <a
              class="inline-flex max-w-full items-center gap-1 font-medium text-foreground hover:underline"
              href={href()}
              onClick={(event) => event.stopPropagation()}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span class="truncate">View on Story</span>
              <IconArrowSquareOut
                aria-hidden="true"
                class="size-3.5 shrink-0"
              />
            </a>
          )}
        </Show>
      </Type>
    </Show>
  );
}

export { dedupeReferences };

export function SearchReferencePicker(props: {
  ariaLabel: string;
  emptyLabel: string;
  items: ComposerReference[];
  loading?: boolean;
  onSelect: (item: ComposerReference) => void;
  placeholder: string;
  value?: ComposerReference;
  loadingLabel?: string;
}) {
  return (
    <div class="space-y-1">
      <Combobox<ComposerReference>
        aria-label={props.ariaLabel}
        onChange={(value) => {
          const item = props.items.find((candidate) => candidate.id === value);
          if (item) {
            props.onSelect(item);
          }
        }}
        optionLabel={(item) => item.title}
        options={props.items}
        optionValue={(item) => item.id}
        placeholder={props.placeholder}
        value={props.value?.id ?? null}
      />
      <Show when={props.loading}>
        <FormNote>{props.loadingLabel ?? "Loading..."}</FormNote>
      </Show>
      <Show when={!props.loading && props.items.length === 0}>
        <FormNote>{props.emptyLabel}</FormNote>
      </Show>
    </div>
  );
}

export function SelectedReferenceCard(props: {
  clearLabel: string;
  item: ComposerReference;
  onClear: () => void;
}) {
  return (
    <div class="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-border-soft bg-card px-4 py-3">
      <div class="min-w-0">
        <Type as="p" variant="body-strong" class="truncate">
          {props.item.title}
        </Type>
        <ReferenceMeta item={props.item} />
      </div>
      <Button
        aria-label={`${props.clearLabel} ${props.item.title}`}
        onClick={props.onClear}
        size="icon"
        variant="secondary"
      >
        <IconTrash class="size-5" />
      </Button>
    </div>
  );
}

export function SetlistItemRow(props: {
  copy: ComposerCopy;
  item: LiveSetlistItemInput;
  index: number;
  options: ComposerReference[];
  onRemove: (index: number) => void;
  onClearReference: (index: number) => void;
  onReferenceSelect: (index: number, item: ComposerReference) => void;
  onUpdateManual: (
    index: number,
    field: "titleText" | "artistText",
    value: string,
  ) => void;
}) {
  const selectedReference = () =>
    props.options.find((option) => option.id === props.item.declaredTrackId);
  const [showManualFields, setShowManualFields] = createSignal(
    !props.item.declaredTrackId &&
      Boolean(props.item.titleText || props.item.artistText),
  );

  return (
    <div class="space-y-3 rounded-[var(--radius-lg)] border border-border-soft bg-background px-4 py-3">
      <div class="flex items-center justify-between gap-3">
        <Type as="span" variant="caption" class="font-semibold">
          {props.index + 1}
        </Type>
        <button
          class="text-muted-foreground hover:text-foreground"
          onClick={() => props.onRemove(props.index)}
          type="button"
        >
          <IconTrash class="size-5" />
        </button>
      </div>
      <div class="space-y-2">
        <FieldLabel label={props.copy.fields.song} />
        <SearchReferencePicker
          ariaLabel={`${props.copy.setlist.searchSongs} ${props.index + 1}`}
          emptyLabel={props.copy.empty.noSongs}
          items={props.options}
          onSelect={(reference) => {
            setShowManualFields(false);
            props.onReferenceSelect(props.index, reference);
          }}
          placeholder={props.copy.placeholders.songSearch}
          value={props.item.declaredTrackId ? selectedReference() : undefined}
        />
      </div>

      <Show when={selectedReference()}>
        {(reference) => (
          <SelectedReferenceCard
            clearLabel={props.copy.buttons.clear}
            item={reference()}
            onClear={() => props.onClearReference(props.index)}
          />
        )}
      </Show>

      <button
        class="text-base font-medium text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setShowManualFields((current) => !current)}
        type="button"
      >
        {showManualFields()
          ? props.copy.setlist.hideManualDetails
          : props.copy.setlist.cannotFindTrack}
      </button>

      <Show when={showManualFields()}>
        <div class="grid gap-3 md:grid-cols-2">
          <Input
            class="h-10"
            onChange={(event) =>
              props.onUpdateManual(
                props.index,
                "titleText",
                event.currentTarget.value,
              )
            }
            placeholder={props.copy.placeholders.songTitle}
            value={props.item.titleText}
          />
          <Input
            class="h-10"
            onChange={(event) =>
              props.onUpdateManual(
                props.index,
                "artistText",
                event.currentTarget.value,
              )
            }
            placeholder={props.copy.placeholders.artist}
            value={props.item.artistText ?? ""}
          />
        </div>
      </Show>
    </div>
  );
}
