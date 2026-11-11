// Step navigation for multi-step tracks (song), per Paper rulings 11 and 12
// (2026-10-09). The header is the way out: close on the first step, a back
// arrow on later ones, beside the step's name. The footer moves forward: a
// labelled button, full width on a phone. There is no separate Back button.
// The final step publishes exactly once through the host's submit runtime.

import { Portal } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import {
  Button,
  CardFooter,
  FormNote,
  IconArrowLeft,
  IconButton,
  IconX,
  Type,
} from "../reference/src/design-system.ts";
import { cn } from "../reference/src/design-system.ts";
import type { ComposerSteps } from "../reference/src/features/posts/post-composer/composer-steps.ts";
import { animateComposerBarEnter } from "../reference/src/features/posts/post-composer/composer-motion.ts";
import type { PostComposerController } from "../reference/src/features/posts/post-composer/controller.ts";
import type { CommunityReleaseUI } from "./release-steps.tsx";
import { PublishButton } from "../reference/src/features/posts/post-composer/submit-actions.tsx";
import {
  getNextComposerStep,
  getPreviousComposerStep,
} from "../reference/src/features/posts/post-composer/utils.ts";
import type { SongFlowRuntime } from "../reference/src/features/posts/post-composer/types.ts";

export function PostComposerStepFooter(props: {
  /** `header`: close or back on the left beside the step's name, centred on
   * a phone. `footer`: the forward or publish button. */
  layout?: "footer" | "header";
  onClose?: () => void;
  controller: PostComposerController;
  /** Where the mobile footer belongs. Same rule as the attachment bar: a host
   * that already owns the viewport gets `inline`, because a portalled footer
   * leaves that host's stacking context and lands behind its overlay, taking
   * Back, Next and Publish out of reach. */
  placement?: "fixed" | "inline";
  steps: ComposerSteps;
  runtime?: SongFlowRuntime;
  release: CommunityReleaseUI;
}) {
  const controller = props.controller;
  const placement = () => props.placement ?? "fixed";
  const [preparing, setPreparing] = createSignal(false);
  let advancing = false;
  let live = true;
  onCleanup(() => { live = false; });
  let mobileBar: HTMLDivElement | undefined;
  let entered = false;
  createEffect(
    () => mobileBar,
    (nextBar) => {
      // The entrance slide belongs to a bar that floats in from the bottom
      // edge. An inline footer is already in the flow, so it just appears.
      if (!entered && nextBar && placement() === "fixed") {
        animateComposerBarEnter(nextBar);
        entered = true;
      }
    },
  );
  const locked = () => props.runtime?.locked === true;
  const termsIssue = () => props.release.issue();

  const canAdvance = () => {
    if (preparing() || locked() || controller.submit.loading) return false;
    switch (props.steps.current()) {
      case "song":
        return (
          (!controller.requirements.songAudioMissing ||
            props.runtime?.audioPrepared === true ||
            props.runtime?.prepared === true) &&
          (props.runtime?.prepared === true ||
            ((Boolean(controller.song.state.instrumentalAudioUpload) ||
              props.runtime?.stems?.instrumental === true) &&
              (Boolean(controller.song.state.vocalAudioUpload) ||
                props.runtime?.stems?.vocals === true))) &&
          Boolean(controller.song.state.title?.trim()) &&
          props.release.authorized()
        );
      case "rights":
        return termsIssue() === "";
      default:
        return true;
    }
  };

  const goBack = () => {
    props.steps.set(
      getPreviousComposerStep(props.steps.current(), controller.tabs.activeTab),
    );
  };
  const goNext = async () => {
    // Signal writes are not visible to a second handler in the same tick.
    // This synchronous owner prevents a double click from starting a second
    // advance while the audio preparation is still awaiting its response.
    if (!live || advancing || !canAdvance()) return;
    advancing = true;
    const target = getNextComposerStep(
      props.steps.current(),
      controller.tabs.activeTab,
    );
    try {
      if (
        props.steps.current() === "rights" &&
        props.runtime &&
        !props.runtime.prepared
      ) {
        // Advancing past policy consent uploads the audio first; a failed or uncertain
        // upload stays on this step with the host's error surfaced. The target
        // is computed before the await because a successful upload re-seeds the
        // step state, which would otherwise advance a second time.
        setPreparing(true);
        if (!(await props.runtime.prepare()) || !live) return;
      }
    } catch {
      return;
    } finally {
      advancing = false;
      if (live) setPreparing(false);
    }
    // Release the operation before exposing the next step. An author can
    // legitimately continue as soon as that UI becomes visible.
    if (live) props.steps.set(target);
  };

  const forward = () => (
    <Show
      when={props.steps.isLast()}
      fallback={
        <Button
          class={controller.isMobile() ? "w-full" : undefined}
          data-composer-forward
          disabled={!canAdvance()}
          loading={preparing()}
          onClick={() => void goNext()}
          size="lg"
        >
          {controller.copy.actions.continue}
        </Button>
      }
    >
      <PublishButton
        class={controller.isMobile() ? "h-12 w-full" : undefined}
        controller={controller}
        label={controller.submit.label}
        onClick={controller.submit.onSubmit}
        size="lg"
      />
    </Show>
  );

  // The final step's PublishButton renders the submit error beside itself.
  // Earlier steps have no such button, so an audio upload that fails on
  // Continue would otherwise leave the author on policy consent with no explanation.
  const stepError = (className?: string) => (
    <Show when={!props.steps.isLast() && controller.submit.error}>
      {(message) => (
        <div aria-live="polite" class={className} role="alert">
          <FormNote tone="warning">{message()}</FormNote>
        </div>
      )}
    </Show>
  );

  const desktop = (
    <CardFooter class="justify-end gap-3 border-t border-border-soft px-8 py-5">
      <div class="flex min-w-0 flex-1 items-center justify-end gap-3">
        {stepError()}
        {forward()}
      </div>
    </CardFooter>
  );

  const mobile = (
    <div
      class={cn(
        "border-t border-border-soft bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3",
        // Inline, the footer stays at the bottom of the screen while the steps scroll.
        placement() === "inline"
          ? "sticky bottom-0 z-20 -mx-4 mt-auto"
          : "fixed inset-x-0 bottom-0 z-20",
      )}
      data-composer-footer
      ref={mobileBar}
    >
      {stepError("mb-3")}
      {forward()}
    </div>
  );

  if (props.layout === "header") {
    const mobile = controller.isMobile();
    const wayOut = () => (
      <Show
        when={!props.steps.isFirst() && !locked()}
        fallback={
          <IconButton
            aria-label="Close composer"
            onClick={() => props.onClose?.()}
            variant="ghost"
          >
            <IconX class="size-5" />
          </IconButton>
        }
      >
        <IconButton
          aria-label={controller.copy.actions.back}
          disabled={preparing() || controller.submit.loading}
          onClick={goBack}
          variant="ghost"
        >
          <IconArrowLeft class="size-5" />
        </IconButton>
      </Show>
    );
    return (
      <header
        class={
          mobile
            ? "grid min-h-14 grid-cols-[2.75rem_1fr_2.75rem] items-center px-1"
            : "-ms-2 flex items-center gap-2 px-8 pt-6"
        }
      >
        {wayOut()}
        <Type
          as="h2"
          class={mobile ? "text-center" : undefined}
          variant={mobile ? "h3" : "h2"}
        >
          {controller.copy.steps[props.steps.current()]}
        </Type>
      </header>
    );
  }
  if (controller.isMobile()) {
    if (placement() === "inline" || typeof document === "undefined")
      return mobile;
    return <Portal>{mobile}</Portal>;
  }

  return desktop;
}
