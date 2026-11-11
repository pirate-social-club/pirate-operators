// Song steps: Royalties and Review. Every new song is published as "Remix and
// sell"; the Royalties step sets the author's share of remix earnings and the
// split between collaborators, and Review confirms the submission.

import type { JSX } from "@solidjs/web";
import { For, Show, type ParentProps } from "solid-js";

import { Button, CardContent, FormNote, Type } from "../../../design-system.ts";
import { cn } from "../../../design-system.ts";
import { basisPointsToPercentText } from "../media-submission/contracts.ts";
import type { ComposerSteps } from "./composer-steps.ts";
import type { PostComposerController } from "./controller.ts";
import { EarningsSplit, royaltySplitIssue } from "./earnings-split.tsx";
import { FieldLabel } from "./fields.tsx";
import { createObjectUrl } from "./media-hooks.ts";
import type {
  AssetRoyaltyAllocation,
  ComposerRecipientProfile,
  SongFlowRuntime,
} from "./types.ts";

function allocationBps(allocation: AssetRoyaltyAllocation): number {
  return allocation.shareBps ?? Math.round(allocation.sharePct * 100);
}

/** The exact validation the publish path runs, surfaced where it is edited. */
export function songTermsIssue(
  controller: PostComposerController,
  runtime?: SongFlowRuntime,
): string {
  const personaId =
    runtime?.personaId ??
    controller.royaltySplit.state.allocations.find(
      (row) => row.recipientKind === "creator",
    )?.recipientId;
  return royaltySplitIssue(
    controller.royaltySplit.state,
    personaId,
    controller.copy,
  );
}

function StepCard(
  props: ParentProps<{
    controller: PostComposerController;
    title: string;
  }>,
) {
  return (
    <CardContent
      class={cn(
        "space-y-6 p-8",
        props.controller.isMobile() && "px-0 pb-4 pt-1",
      )}
    >
      {/* The step's name sits in the composer header (Paper ruling 11). */}
      {props.children}
    </CardContent>
  );
}

export function SongRightsStep(props: {
  controller: PostComposerController;
  recipients?: readonly ComposerRecipientProfile[];
  runtime?: SongFlowRuntime;
}) {
  const controller = props.controller;
  const locked = () => props.runtime?.locked === true;
  const license = () => controller.license.state.presetId;
  const issue = () => songTermsIssue(controller, props.runtime);

  // The author's cut of remix sales: one line, a few preset shares.
  const shareOptions = () => {
    const current = controller.license.state.commercialRevShareBps ?? 1_000;
    const presets = [500, 1_000, 2_000, 3_000];
    return presets.includes(current)
      ? presets
      : [...presets, current].sort((a, b) => a - b);
  };
  const selectShare = (shareBps: number) =>
    controller.license.update((current) => ({
      ...current,
      commercialRevShareBps: shareBps,
      commercialRevSharePct: shareBps / 100,
    }));
  const remixShare = () => (
    <div class="grid gap-3">
      <Type as="span" id="remix-share-label" variant="body-strong">
        {controller.copy.rights.revShare}
      </Type>
      <div
        aria-labelledby="remix-share-label"
        class="flex flex-wrap gap-2"
        role="radiogroup"
      >
        <For each={shareOptions()}>
          {(shareBps) => {
            const selected = () =>
              (controller.license.state.commercialRevShareBps ?? 1_000) ===
              shareBps;
            return (
              <button
                aria-checked={selected() ? "true" : "false"}
                class={cn(
                  "h-10 min-w-16 rounded-full border px-4 text-base font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected()
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border-soft bg-card text-foreground hover:bg-muted",
                )}
                onClick={() => selectShare(shareBps)}
                role="radio"
                type="button"
              >
                {basisPointsToPercentText(shareBps)}%
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );

  // Every new song is "Remix and sell"; the author only chooses their share.
  // A recovered submission bound to another preset keeps it, read-only.
  return (
    <StepCard controller={controller} title={controller.copy.steps.rights}>
      <fieldset class="space-y-8" disabled={locked()}>
        <Show
          when={license() === "commercial-remix"}
          fallback={
            <Type as="p" class="text-muted-foreground">
              {controller.copy.assetLicense.song[license()]}
            </Type>
          }
        >
          {remixShare()}
        </Show>

        <EarningsSplit
          authorPersonaId={props.runtime?.personaId}
          copy={controller.copy}
          disabled={locked()}
          onChange={(value) => controller.royaltySplit.update(() => value)}
          recipients={props.recipients ?? []}
          split={controller.royaltySplit.state}
        />
      </fieldset>
      <Show when={issue()}>
        <FormNote tone="warning">{issue()}</FormNote>
      </Show>
    </StepCard>
  );
}

function ReviewRow(props: {
  action?: { label: string; onClick: () => void };
  label: string;
  value: JSX.Element;
}) {
  return (
    <div class="flex items-start justify-between gap-3 border-b border-border-soft py-3 last:border-b-0">
      <div class="min-w-0">
        <Type as="p" variant="caption" class="text-muted-foreground">
          {props.label}
        </Type>
        <div class="mt-0.5 min-w-0 text-base text-foreground">
          {props.value}
        </div>
      </div>
      <Show when={props.action}>
        <Button onClick={props.action!.onClick} size="sm" variant="ghost">
          {props.action!.label}
        </Button>
      </Show>
    </div>
  );
}

function recipientLabel(
  allocation: AssetRoyaltyAllocation,
  recipients: readonly ComposerRecipientProfile[],
  youLabel: string,
): string {
  if (allocation.recipientKind === "creator") return youLabel;
  const profile = recipients.find(
    (candidate) => candidate.personaId === allocation.recipientId,
  );
  const handle = profile?.handle?.trim();
  if (handle) return handle.startsWith("@") ? handle : `@${handle}`;
  return profile?.displayName?.trim() || "Collaborator";
}

export function SongReviewStep(props: {
  controller: PostComposerController;
  recipients?: readonly ComposerRecipientProfile[];
  runtime?: SongFlowRuntime;
  steps: ComposerSteps;
}) {
  const controller = props.controller;
  const song = () => controller.song.state;
  const cover = createObjectUrl(() => controller.song.state.coverUpload);
  const issue = () => songTermsIssue(controller, props.runtime);
  const licenseLabel = () =>
    controller.license.state.presetId === "commercial-remix"
      ? `${basisPointsToPercentText(controller.license.state.commercialRevShareBps ?? 1_000)}%`
      : controller.copy.assetLicense.song[controller.license.state.presetId];
  const references = () => controller.primary.derivativeState?.references ?? [];
  const earningsSummary = () =>
    controller.royaltySplit.state.allocations
      .map(
        (allocation) =>
          `${recipientLabel(allocation, props.recipients ?? [], controller.copy.review.you)} ${basisPointsToPercentText(allocationBps(allocation))}%`,
      )
      .join(" · ");

  return (
    <StepCard controller={controller} title={controller.copy.steps.review}>
      <Show when={issue()}>
        <FormNote tone="warning">{issue()}</FormNote>
      </Show>
      <div class="rounded-[var(--radius-lg)] px-1">
        <ReviewRow
          action={
            props.runtime?.locked
              ? undefined
              : {
                  label: controller.copy.review.change,
                  onClick: () => props.steps.set("song"),
                }
          }
          label={controller.copy.review.song}
          value={
            <span class="flex min-w-0 items-center gap-3">
              <Show when={cover()}>
                {(url) => (
                  <img
                    alt=""
                    class="size-12 shrink-0 rounded-[var(--radius-md)] border border-border-soft object-cover"
                    src={url()}
                  />
                )}
              </Show>
              <span class="min-w-0 truncate">
                {song().title?.trim() || "—"}
              </span>
            </span>
          }
        />
        <ReviewRow
          action={
            props.runtime?.locked
              ? undefined
              : {
                  label: controller.copy.review.change,
                  onClick: () => props.steps.set("song"),
                }
          }
          label={controller.copy.review.lyrics}
          value={
            controller.fields.lyricsValue.trim() === "" ? (
              controller.copy.review.noLyrics
            ) : (
              <span class="line-clamp-2">{controller.fields.lyricsValue}</span>
            )
          }
        />
        <Show when={controller.primary.activeSongMode === "remix"}>
          <ReviewRow
            action={
              props.runtime?.locked
                ? undefined
                : {
                    label: controller.copy.review.change,
                    onClick: () => props.steps.set("song"),
                  }
            }
            label={controller.copy.review.sources}
            value={
              references().length === 0
                ? controller.copy.derivative.chooseSource
                : references()
                    .map((reference) => reference.title)
                    .join(" · ")
            }
          />
        </Show>
        <ReviewRow
          action={
            props.runtime?.locked
              ? undefined
              : {
                  label: controller.copy.review.change,
                  onClick: () => props.steps.set("rights"),
                }
          }
          label={controller.copy.review.permissions}
          value={licenseLabel()}
        />
        <ReviewRow
          action={
            props.runtime?.locked
              ? undefined
              : {
                  label: controller.copy.review.change,
                  onClick: () => props.steps.set("rights"),
                }
          }
          label={controller.copy.review.earnings}
          value={earningsSummary()}
        />
      </div>
    </StepCard>
  );
}
