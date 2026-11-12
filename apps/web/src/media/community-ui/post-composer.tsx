import { createSignal, Show } from "solid-js";

import {
  Card,
  IconButton,
  IconX,
  Type,
  cn,
} from "../reference/src/design-system.ts";
import { createComposerSteps } from "../reference/src/features/posts/post-composer/composer-steps.ts";
import { PostComposerRequiredSheet } from "../reference/src/features/posts/post-composer/required-post-sheet.tsx";
import { PublishButton } from "../reference/src/features/posts/post-composer/submit-actions.tsx";
import { createPostComposerController } from "../reference/src/features/posts/post-composer/controller.ts";
import { SongStep } from "./song-step.tsx";
import { SongReviewStep, SongRightsStep } from "./release-steps.tsx";
import { PostComposerStepFooter } from "./step-footer.tsx";
import type { CommunitySongComposerProps } from "./release-steps.tsx";
import { defaultComposerCopy } from "../reference/src/features/posts/post-composer/copy.ts";
import { PostComposerWriteStep } from "../reference/src/features/posts/post-composer/write-step.tsx";
import { createPhoneLayout } from "../reference/src/features/shell/composing-surface.tsx";

export function CommunitySongComposer(props: CommunitySongComposerProps) {
  // Knows the phone layout from the first frame (see createPhoneLayout), so
  // the step controls, which choose their form once when they mount, are the
  // phone's from the start.
  const phoneLayout = createPhoneLayout();
  const controller = createPostComposerController(props, {
    isMobile: phoneLayout,
    copy: {
      ...defaultComposerCopy,
      steps: { ...defaultComposerCopy.steps, rights: "Release policy" },
    },
  });
  const steps = createComposerSteps(
    () => controller.tabs.activeTab,
    () => props.initialSongStep,
  );
  const [requiredSheetOpen, setRequiredSheetOpen] = createSignal(false);
  const isMultiStep = () => steps.list().length > 1;

  const requestPost = () => {
    if (controller.requirements.requiresPostSheet) {
      setRequiredSheetOpen(true);
      return;
    }
    controller.submit.onSubmit?.();
  };

  const stepContent = () => {
    if (!isMultiStep()) {
      return (
        <>
          <PostComposerWriteStep
            attachmentBarPlacement={props.attachmentBarPlacement}
            onVideoEntry={props.onVideoEntry}
            controller={controller}
          >
            <PublishButton
              class="min-w-40"
              controller={controller}
              label={controller.submit.label}
              onClick={requestPost}
            />
          </PostComposerWriteStep>
        </>
      );
    }
    switch (steps.current()) {
      case "song":
        return (
          <SongStep
            controller={controller}
            runtime={props.songFlowRuntime}
            release={props.release}
          />
        );
      case "rights":
        return (
          <SongRightsStep
            controller={controller}
            recipients={props.recipientProfiles}
            runtime={props.songFlowRuntime}
            release={props.release}
          />
        );
      case "review":
        return (
          <SongReviewStep
            controller={controller}
            recipients={props.recipientProfiles}
            runtime={props.songFlowRuntime}
            release={props.release}
            steps={steps}
          />
        );
    }
  };

  // Paper rulings 11 and 12: the way out and the step's name at the top, the
  // labelled forward button at the bottom (full width on a phone).
  const stepHeader = () => (
    <PostComposerStepFooter
      controller={controller}
      layout="header"
      onClose={() => props.onClose?.()}
      runtime={props.songFlowRuntime}
      release={props.release}
      steps={steps}
    />
  );
  const stepFooter = (placement: "fixed" | "inline" | undefined) => (
    <PostComposerStepFooter
      controller={controller}
      placement={placement}
      runtime={props.songFlowRuntime}
      release={props.release}
      steps={steps}
    />
  );

  // Mobile header: close on the left; a single-step post publishes from an
  // icon button on the right, whose accessible name is the post label.
  const mobileHeader = () => (
    <header class="flex min-h-12 items-center justify-between gap-2 px-1">
      <IconButton
        aria-label="Close composer"
        onClick={() => props.onClose?.()}
        variant="ghost"
      >
        <IconX class="size-5" />
      </IconButton>
      <Show when={!isMultiStep()}>
        <PublishButton
          compact
          controller={controller}
          label={controller.submit.label}
          onClick={requestPost}
        />
      </Show>
    </header>
  );

  return (
    <>
      <Show
        when={props.presentation === "inline"}
        fallback={
          <div class={cn("w-full space-y-2", !controller.isMobile() && "pt-0")}>
            <Show when={controller.isMobile() && !isMultiStep()}>
              <div
                class="sticky -top-4 z-20 -mt-4 bg-background pt-4"
                data-composer-sticky-header
              >
                {mobileHeader()}
              </div>
            </Show>

            <Show
              when={controller.isMobile()}
              fallback={
                <Card class="relative mx-auto w-full max-w-3xl overflow-hidden bg-card shadow-none">
                  <Show
                    when={isMultiStep()}
                    fallback={
                      <IconButton
                        aria-label="Close composer"
                        class="absolute end-3 top-3 z-10"
                        onClick={() => props.onClose?.()}
                        variant="ghost"
                      >
                        <IconX class="size-6" />
                      </IconButton>
                    }
                  >
                    {stepHeader()}
                  </Show>
                  <Show when={props.mediaStatus}>{props.mediaStatus!()}</Show>
                  {stepContent()}
                  <Show when={isMultiStep()}>
                    {stepFooter(props.attachmentBarPlacement)}
                  </Show>
                </Card>
              }
            >
              <Show
                when={isMultiStep()}
                fallback={
                  <>
                    <Show when={props.mediaStatus}>{props.mediaStatus!()}</Show>
                    {stepContent()}
                  </>
                }
              >
                {/* Pinned at the scroll edge; its padding paints over the form's
                top padding so nothing is seen scrolling above the header. */}
                <div
                  class="sticky -top-4 z-20 -mt-4 bg-background pt-4"
                  data-composer-sticky-header
                >
                  {stepHeader()}
                </div>
                <Show when={props.mediaStatus}>{props.mediaStatus!()}</Show>
                {stepContent()}
                {stepFooter(props.attachmentBarPlacement)}
              </Show>
            </Show>
          </div>
        }
      >
        <Show
          when={phoneLayout()}
          fallback={
            <Card class="w-full overflow-hidden">
              <Show
                when={isMultiStep()}
                fallback={
                  <header class="flex items-center gap-2 px-5 pt-5 md:px-8 md:pt-6">
                    <IconButton
                      aria-label="Close composer"
                      class="-ms-2"
                      onClick={() => props.onClose?.()}
                      variant="ghost"
                    >
                      <IconX class="size-5" />
                    </IconButton>
                    <Type as="h2" variant="h2">
                      New post
                    </Type>
                  </header>
                }
              >
                {stepHeader()}
              </Show>
              <div class="max-md:px-5">
                <Show when={props.mediaStatus}>{props.mediaStatus!()}</Show>
                {stepContent()}
              </div>
              <Show when={isMultiStep()}>{stepFooter("inline")}</Show>
            </Card>
          }
        >
          {/* A phone gets a flat surface: close or back beside the step's name
              at the top, and the labelled forward button full width in a
              footer, both kept on screen while the steps scroll. */}
          <div class="flex min-h-dvh w-full flex-col" data-presentation="flat">
            <div
              class="sticky top-0 z-20 -mx-4 bg-background px-3 pt-[env(safe-area-inset-top)]"
              data-composer-sticky-header
            >
              <Show when={isMultiStep()} fallback={mobileHeader()}>
                {stepHeader()}
              </Show>
            </div>
            <Show when={props.mediaStatus}>{props.mediaStatus!()}</Show>
            {stepContent()}
            <Show when={isMultiStep()}>{stepFooter("inline")}</Show>
          </div>
        </Show>
      </Show>

      <PostComposerRequiredSheet
        controller={controller}
        onOpenChange={setRequiredSheetOpen}
        open={requiredSheetOpen()}
      />
    </>
  );
}
