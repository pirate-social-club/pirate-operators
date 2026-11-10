// Pure presentation independently adopted from pirate-web-solid c7cb8783,
// src/features/dance/dance-review-page.tsx, ActionFooterShell review branch.
// No centralized session, persona, API, review journal or routing runtime.
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { ActionFooterShell, Button, MobilePageHeader } from "./reference-ui.ts";

export function DanceRecordingReviewSurface(props: {
  preview: JSX.Element;
  busy: boolean;
  canSubmit: boolean;
  submitLabel: "Submit for review" | "Resume submission";
  error?: string;
  onSubmit?: () => void;
  onBack: () => void;
}) {
  return (
    <main class="h-dvh bg-background" data-dance-review="ready">
      <h1 class="sr-only">Your recording</h1>
      <ActionFooterShell
        fullViewport
        header={
          <MobilePageHeader
            title="Your recording"
            density="compact"
            onBackClick={props.onBack}
          />
        }
        bodyClass="relative flex flex-col gap-4 px-4 pt-[calc(4rem+env(safe-area-inset-top))]"
        footer={
          <div class="mx-auto grid w-full max-w-md gap-3">
            <Show when={props.onSubmit}>
              <Button
                disabled={props.busy || !props.canSubmit}
                onClick={props.onSubmit}
              >
                {props.busy ? "Submitting…" : props.submitLabel}
              </Button>
            </Show>
          </div>
        }
      >
        {props.preview}
        <Show when={props.error}>
          <p role="alert">{props.error}</p>
        </Show>
      </ActionFooterShell>
    </main>
  );
}
