// Live tab content of the write step, ported from the React
// post-composer-live-tab.tsx.

import { For, Show } from "solid-js";

import {
  Checkbox,
  CheckboxLabel,
  Chip,
  FormNote,
  FormSectionHeading,
  IconPlus,
  Input,
  Switch,
  Type,
} from "../../../design-system.ts";
import type { ComposerCopy } from "./copy.ts";
import { FieldLabel, UploadField } from "./fields.tsx";
import { isLiveVisibilityAllowedForAccess } from "./invariants.ts";
import { createObjectUrl } from "./media-hooks.ts";
import {
  deriveLiveGateAssetOptions,
  deriveLiveTrackOptions,
  scheduleInputValue,
} from "./reference-model.ts";
import { SetlistItemRow } from "./references.tsx";
import type { ComposerReference, LiveComposerState } from "./types.ts";

export function LiveTabContent(props: {
  copy: ComposerCopy;
  live: LiveComposerState;
  onLiveChange: (state: LiveComposerState) => void;
}) {
  const coverPreviewUrl = createObjectUrl(() => props.live.coverUpload);
  const scheduleForLater = () =>
    props.live.scheduleForLater ?? Boolean(props.live.scheduleAt?.trim());
  const live = () => props.live;
  const onLiveChange = (next: LiveComposerState) => props.onLiveChange(next);

  const trackOptions = () => deriveLiveTrackOptions(live());
  const gateAssetOptions = () => deriveLiveGateAssetOptions(trackOptions());
  const selectedGateTargets = () =>
    new Set(live().audienceGateTargetRefs ?? []);

  const handleSetlistItemUpdate = (
    index: number,
    field: "titleText" | "artistText",
    value: string,
  ) => {
    const updated = [...live().setlistItems];
    updated[index] = { ...updated[index]!, [field]: value };
    onLiveChange({ ...live(), setlistItems: updated });
  };

  const handleSetlistReferenceSelect = (
    index: number,
    reference: ComposerReference,
  ) => {
    const updated = [...live().setlistItems];
    updated[index] = {
      ...updated[index]!,
      declaredTrackId: reference.id,
      titleText: reference.title,
      artistText: reference.subtitle,
    };
    onLiveChange({ ...live(), setlistItems: updated });
  };

  const handleClearSetlistReference = (index: number) => {
    const updated = [...live().setlistItems];
    updated[index] = {
      ...updated[index]!,
      declaredTrackId: undefined,
    };
    onLiveChange({ ...live(), setlistItems: updated });
  };

  const handleAddSetlistItem = () => {
    onLiveChange({
      ...live(),
      setlistItems: [
        ...live().setlistItems,
        { titleText: "", performanceKind: "unknown" },
      ],
    });
  };

  const handleRemoveSetlistItem = (index: number) => {
    onLiveChange({
      ...live(),
      setlistItems: live().setlistItems.filter((_, i) => i !== index),
    });
  };

  return (
    <div class="space-y-5">
      <UploadField
        accept="image/*"
        artworkHelp={props.copy.live.eventCoverHelp}
        artworkPlaceholderLabel={props.copy.live.eventCoverUpload}
        artworkPreviewAspect="video"
        chooseFileLabel={props.copy.buttons.chooseFile}
        coverLabel={props.copy.upload.cover}
        label={props.copy.live.eventCover}
        noFileSelectedLabel={props.copy.upload.noFileSelected}
        onChange={(files) =>
          onLiveChange({
            ...live(),
            coverUpload: files?.[0] ?? null,
            coverLabel: files?.[0]?.name ?? live().coverLabel,
          })
        }
        previewUrl={coverPreviewUrl()}
        replaceLabel={props.copy.buttons.replace}
        selectedLabel={live().coverUpload?.name ?? live().coverLabel}
        squareArtworkLabel={props.copy.upload.squareArtwork}
        uploadArtworkHelp={props.copy.upload.artworkHelp}
        variant="artwork"
      />

      <div class="space-y-3">
        <div class="flex items-center gap-3">
          <Checkbox
            checked={scheduleForLater()}
            id="live-schedule-for-later"
            onChange={(checked) =>
              onLiveChange({
                ...live(),
                scheduleAt: checked === true ? live().scheduleAt : undefined,
                scheduleForLater: checked === true,
              })
            }
          >
            <CheckboxLabel>{props.copy.live.scheduleForLater}</CheckboxLabel>
          </Checkbox>
        </div>

        <Show when={scheduleForLater()}>
          <div>
            <FieldLabel
              htmlFor="post-composer-live-start-time"
              label={props.copy.live.startTime}
            />
            <Input
              class="h-10"
              id="post-composer-live-start-time"
              onChange={(event) =>
                onLiveChange({
                  ...live(),
                  scheduleAt: event.currentTarget.value,
                  scheduleForLater: true,
                })
              }
              type="datetime-local"
              value={scheduleInputValue(live().scheduleAt)}
            />
            <FormNote class="mt-1">{props.copy.live.startTimeNote}</FormNote>
          </div>
        </Show>
      </div>

      <div class="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          <FieldLabel label={props.copy.live.storeUrl} />
          <Input
            class="h-10"
            onChange={(event) =>
              onLiveChange({ ...live(), storeUrl: event.currentTarget.value })
            }
            placeholder={props.copy.live.storeUrlPlaceholder}
            type="url"
            value={live().storeUrl ?? ""}
          />
        </div>
        <div>
          <FieldLabel label={props.copy.live.storeLabel} />
          <Input
            class="h-10"
            maxlength={80}
            onChange={(event) =>
              onLiveChange({ ...live(), storeLabel: event.currentTarget.value })
            }
            placeholder={props.copy.live.storeLabelPlaceholder}
            value={live().storeLabel ?? ""}
          />
        </div>
      </div>

      <div class="grid gap-3 md:grid-cols-3">
        <div>
          <FieldLabel label={props.copy.live.roomKind} />
          <div class="flex flex-wrap gap-2">
            <For
              each={[
                { value: "solo" as const, label: props.copy.live.roomKindSolo },
                { value: "duet" as const, label: props.copy.live.roomKindDuet },
              ]}
            >
              {(opt) => (
                <Chip
                  onClick={() =>
                    onLiveChange({ ...live(), roomKind: opt.value })
                  }
                  variant={
                    live().roomKind === opt.value ? "selected" : "default"
                  }
                >
                  {opt.label}
                </Chip>
              )}
            </For>
          </div>
        </div>
        <div>
          <FieldLabel label={props.copy.live.access} />
          <div class="flex flex-wrap gap-2">
            <For
              each={[
                { value: "free" as const, label: props.copy.live.accessFree },
                { value: "gated" as const, label: props.copy.live.accessGated },
                { value: "paid" as const, label: props.copy.live.accessPaid },
              ]}
            >
              {(opt) => (
                <Chip
                  onClick={() =>
                    onLiveChange({
                      ...live(),
                      accessMode: opt.value,
                      audienceGateMode:
                        opt.value === "gated"
                          ? (live().audienceGateMode ?? "community_members")
                          : live().audienceGateMode,
                    })
                  }
                  variant={
                    live().accessMode === opt.value ? "selected" : "default"
                  }
                >
                  {opt.label}
                </Chip>
              )}
            </For>
          </div>
        </div>
        <div>
          <FieldLabel label={props.copy.live.visibility} />
          <div class="flex flex-wrap gap-2">
            <For
              each={[
                {
                  value: "public" as const,
                  label: props.copy.live.visibilityPublic,
                },
                {
                  value: "unlisted" as const,
                  label: props.copy.live.visibilityUnlisted,
                },
              ]}
            >
              {(opt) => (
                <Chip
                  disabled={
                    live().accessMode === "paid" && opt.value === "unlisted"
                  }
                  onClick={() =>
                    onLiveChange({ ...live(), visibility: opt.value })
                  }
                  variant={
                    live().visibility === opt.value ? "selected" : "default"
                  }
                >
                  {opt.label}
                </Chip>
              )}
            </For>
          </div>
          <Show
            when={
              live().accessMode === "paid" &&
              !isLiveVisibilityAllowedForAccess(live())
            }
          >
            <FormNote class="mt-2">
              {props.copy.live.paidVisibilityNote ??
                "Paid livestreams must be public. Select Public to continue."}
            </FormNote>
          </Show>
        </div>
      </div>

      <Show when={live().accessMode === "gated"}>
        <div class="space-y-3">
          <FieldLabel label={props.copy.live.audienceGate ?? "Audience gate"} />
          <div class="flex flex-wrap gap-2">
            <For
              each={[
                {
                  value: "community_members" as const,
                  label:
                    props.copy.live.audienceGateCommunityMembers ??
                    "Community members",
                },
                {
                  value: "purchase_entitlement" as const,
                  label:
                    props.copy.live.audienceGatePurchaseEntitlement ??
                    "Buyers of selected songs",
                },
              ]}
            >
              {(opt) => (
                <Chip
                  onClick={() =>
                    onLiveChange({ ...live(), audienceGateMode: opt.value })
                  }
                  variant={
                    (live().audienceGateMode ?? "community_members") ===
                    opt.value
                      ? "selected"
                      : "default"
                  }
                >
                  {opt.label}
                </Chip>
              )}
            </For>
          </div>
          <Show
            when={
              (live().audienceGateMode ?? "community_members") ===
              "purchase_entitlement"
            }
          >
            <div class="space-y-2">
              <Show
                when={gateAssetOptions().length > 0}
                fallback={
                  <FormNote>
                    {props.copy.live.audienceGatePurchaseEntitlementEmpty ??
                      "Select catalog songs in the setlist before using buyer access."}
                  </FormNote>
                }
              >
                <For each={gateAssetOptions()}>
                  {(option) => (
                    <Checkbox
                      checked={selectedGateTargets().has(option.id)}
                      class="flex w-full items-start gap-2 rounded-md border border-border px-3 py-2"
                      onChange={(checked) => {
                        const current = new Set(
                          live().audienceGateTargetRefs ?? [],
                        );
                        if (checked === true) {
                          current.add(option.id);
                        } else {
                          current.delete(option.id);
                        }
                        onLiveChange({
                          ...live(),
                          audienceGateTargetRefs: [...current],
                        });
                      }}
                    >
                      <CheckboxLabel class="min-w-0">
                        <Type as="span" variant="body" class="block truncate">
                          {option.label}
                        </Type>
                        <Show when={option.subtitle}>
                          <Type
                            as="span"
                            variant="caption"
                            class="block truncate text-muted-foreground"
                          >
                            {option.subtitle}
                          </Type>
                        </Show>
                      </CheckboxLabel>
                    </Checkbox>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <div class="flex items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-border-soft bg-card p-4">
        <div class="space-y-1">
          <Type as="div" variant="body-strong">
            {props.copy.live.recordThisLivestream}
          </Type>
          <Type as="p" variant="caption">
            {props.copy.live.recordThisLivestreamNote}
          </Type>
        </div>
        <Switch
          aria-label={props.copy.live.recordThisLivestream}
          checked={live().recordingEnabled === true}
          onChange={(checked) =>
            onLiveChange({ ...live(), recordingEnabled: checked })
          }
        />
      </div>

      <Show when={live().roomKind === "duet"}>
        <div>
          <FieldLabel label={props.copy.live.guestPerformer} />
          <Input
            class="h-10"
            onChange={(event) => {
              const guestUserId = event.currentTarget.value;
              onLiveChange({
                ...live(),
                guestUserId,
                performerAllocations: live().performerAllocations.map(
                  (allocation) =>
                    allocation.role === "guest"
                      ? { ...allocation, userId: guestUserId }
                      : allocation,
                ),
              });
            }}
            placeholder={props.copy.live.collaboratorPlaceholder}
            value={live().guestUserId ?? ""}
          />
          <FormNote class="mt-1">{props.copy.live.collaboratorNote}</FormNote>
        </div>
      </Show>

      <Show when={live().accessMode === "paid"}>
        <div class="space-y-3 rounded-[var(--radius-lg)] border border-border-soft bg-card p-4">
          <FormSectionHeading
            description={
              live().roomKind === "solo"
                ? props.copy.live.soloProceedsDescription
                : props.copy.live.duetProceedsDescription
            }
            title={props.copy.live.performerAllocations}
          />
          <div class="space-y-2">
            <For each={live().performerAllocations}>
              {(alloc) => (
                <div class="flex items-center justify-between rounded-[var(--radius-lg)] border border-border-soft bg-background px-4 py-3">
                  <div class="flex items-center gap-3">
                    <span class="text-base font-medium text-foreground">
                      {alloc.role === "host"
                        ? props.copy.live.hostLabel
                        : props.copy.live.guestLabel}
                    </span>
                    <span class="text-base text-foreground">
                      {alloc.role === "host"
                        ? props.copy.live.youLabel
                        : live().guestUserId ||
                          props.copy.live.collaboratorLabel}
                    </span>
                  </div>
                  <div class="flex items-center gap-2">
                    <Input
                      aria-label={`${alloc.role === "host" ? props.copy.live.hostLabel : props.copy.live.guestLabel} percentage`}
                      class="h-10 w-20 text-center"
                      max={100}
                      min={0}
                      onChange={(event) => {
                        const val = Number.parseInt(
                          event.currentTarget.value,
                          10,
                        );
                        if (Number.isNaN(val)) return;
                        const updated = live().performerAllocations.map((a) =>
                          a.role === alloc.role ? { ...a, sharePct: val } : a,
                        );
                        onLiveChange({
                          ...live(),
                          performerAllocations: updated,
                        });
                      }}
                      type="number"
                      value={String(alloc.sharePct)}
                    />
                    <span class="text-base text-muted-foreground">%</span>
                  </div>
                </div>
              )}
            </For>
          </div>
          <Show
            when={
              live().performerAllocations.reduce(
                (sum, a) => sum + a.sharePct,
                0,
              ) !== 100
            }
          >
            <FormNote tone="destructive">
              {props.copy.live.allocationsError}
            </FormNote>
          </Show>
        </div>
      </Show>

      <div>
        <div class="mb-2 flex items-center justify-between gap-3">
          <FormSectionHeading title={props.copy.live.setlistTitle} />
          <Chip
            leadingIcon={<IconPlus class="size-4" />}
            onClick={handleAddSetlistItem}
          >
            {props.copy.live.addSong}
          </Chip>
        </div>
        <Show
          when={live().setlistItems.length > 0}
          fallback={
            <div class="rounded-[var(--radius-lg)] border border-dashed border-border-soft px-4 py-6 text-center text-base text-muted-foreground">
              {props.copy.live.emptySetlist}
            </div>
          }
        >
          <div class="space-y-2">
            <For each={live().setlistItems}>
              {(item, index) => (
                <SetlistItemRow
                  copy={props.copy}
                  index={index()}
                  item={item}
                  onClearReference={handleClearSetlistReference}
                  onReferenceSelect={handleSetlistReferenceSelect}
                  onRemove={handleRemoveSetlistItem}
                  onUpdateManual={handleSetlistItemUpdate}
                  options={trackOptions()}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
