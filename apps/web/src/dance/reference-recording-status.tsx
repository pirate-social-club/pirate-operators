// Pure pending/result branch of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db,
// src/features/dance/dance-review-page.tsx. Source/Storybook comparison is in
// docs/v1-dance-owner-ui-comparison.json. No centralized runtime is retained.
import { createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "@/components/actions/button/button";
import { Type } from "@/components/data-display/type/type";
import { ActionFooterShell } from "@/patterns/layout/action-footer-shell/action-footer-shell";
import { MobilePageHeader } from "@/patterns/navigation/mobile-page-header/mobile-page-header";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalTitle,
} from "@/patterns/overlays/modal/modal";
import type { DanceReview } from "../../../../packages/dance/contracts.ts";
import { danceStatus } from "./presentation.ts";

/** The recording-management surface stays in place after explicit submission. */
export function DanceRecordingStatusSurface(props: {
  review?: DanceReview;
  unavailable?: boolean;
  busy: boolean;
  error?: string;
  notice?: string;
  privatePreview?: JSX.Element;
  previewReady?: boolean;
  onPreview?: () => void;
  onRetry: () => void;
  onDone: () => void;
  onWithdraw?: () => void;
}) {
  const [confirmCancel, setConfirmCancel] = createSignal(false);
  const canWithdraw = () =>
    !!props.onWithdraw &&
    !props.unavailable &&
    !props.error &&
    !!props.review &&
    !props.review.localDenied &&
    (props.review.state === "awaiting_review" ||
      props.review.state === "decision_pending");
  return (
    <main
      class="h-dvh bg-background"
      data-dance-review={props.unavailable ? "unavailable" : "ready"}
    >
      <h1 class="sr-only">Your recording</h1>
      <ActionFooterShell
        fullViewport
        header={
          <MobilePageHeader
            title="Your recording"
            density="compact"
            onBackClick={props.onDone}
          />
        }
        bodyClass="relative flex flex-col gap-4 px-4 pt-[calc(4rem+env(safe-area-inset-top))]"
        footer={
          <div class="mx-auto grid w-full max-w-md gap-3">
            <Show when={props.review}>
              <Button variant="secondary" onClick={props.onDone}>
                Done
              </Button>
            </Show>
          </div>
        }
      >
        <Show when={props.unavailable}>
          <p role="alert">This recording is not available.</p>
        </Show>
        <Show when={props.review}>
          {(review) => (
            <>
              <section class="space-y-3" aria-live="polite">
                <Type as="h2" variant="h2">
                  {danceStatus(review()).title}
                </Type>
                <p>{danceStatus(review()).detail}</p>
              </section>
              <Show
                when={
                  review().state === "awaiting_review" ||
                  review().state === "decision_pending"
                }
              >
                <p class="text-sm text-muted-foreground">
                  Review deadline:{" "}
                  <time
                    datetime={new Date(
                      review().receipt.reviewDeadlineMs,
                    ).toISOString()}
                  >
                    {new Date(review().receipt.reviewDeadlineMs).toLocaleString(
                      undefined,
                      {
                        dateStyle: "medium",
                        timeStyle: "short",
                      },
                    )}
                  </time>
                </p>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.error && !props.unavailable}>
          <p role="status">{props.error}</p>
          <Button
            variant="secondary"
            disabled={props.busy}
            onClick={props.onRetry}
          >
            Check again
          </Button>
        </Show>
        <Show when={canWithdraw()}>
          <Show
            when={props.previewReady}
            fallback={
              <Button
                variant="secondary"
                disabled={props.busy}
                onClick={props.onPreview}
              >
                {props.busy ? "Loading recording…" : "Preview recording"}
              </Button>
            }
          >
            {props.privatePreview}
          </Show>
        </Show>
        <Show when={props.notice && !props.unavailable}>
          <p role="status">{props.notice}</p>
        </Show>
        <Show when={canWithdraw()}>
          <details class="text-sm">
            <summary class="cursor-pointer text-muted-foreground">
              Recording options
            </summary>
            <Button
              variant="ghost"
              disabled={props.busy}
              onClick={() => setConfirmCancel(true)}
            >
              Cancel review
            </Button>
          </details>
        </Show>
      </ActionFooterShell>
      <Modal
        open={confirmCancel() && canWithdraw()}
        onOpenChange={setConfirmCancel}
      >
        <ModalContent>
          <ModalHeader>
            <ModalTitle>Cancel review of this recording?</ModalTitle>
          </ModalHeader>
          <p>
            Private playback and new review dispatch will stop. A decision
            already sent on chain may still be accepted.
          </p>
          <Button
            disabled={props.busy}
            onClick={() => {
              setConfirmCancel(false);
              props.onWithdraw?.();
            }}
          >
            Cancel review
          </Button>
          <Button variant="secondary" onClick={() => setConfirmCancel(false)}>
            Keep waiting
          </Button>
        </ModalContent>
      </Modal>
    </main>
  );
}
