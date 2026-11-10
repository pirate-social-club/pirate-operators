// Independently adopted PURE render branches from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db,
// src/features/dance/dance-owner-page.tsx. Runtime auth/router/API/journal removed.
// Exact blob/line and adapter map: docs/v1-dance-ui-provenance.json.
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Button } from "@/components/actions/button/button";
import { Type } from "@/components/data-display/type/type";
import type {
  DanceReview,
  DanceQueue,
  DanceVerdict,
} from "../../../../packages/dance/contracts.ts";
const formatTime = (n: number) =>
  new Date(n).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
export function DanceOwnerReviewSurface(props: {
  loading: boolean;
  error?: string;
  page: DanceQueue | null;
  detail: DanceReview | null;
  privatePreview: JSX.Element;
  referencePreview: JSX.Element;
  canDecide: boolean;
  status: string;
  previewReady: boolean;
  reviewDisclosure: string;
  onPreview: () => void;
  onSelect: (r: DanceReview) => void;
  onMore: () => void;
  onLoad: () => void;
  onDecide: (v: DanceVerdict) => void;
}) {
  return (
    <main
      class="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-8"
      data-dance-owner={
        props.loading ? "loading" : props.detail ? "detail" : "queue"
      }
    >
      <Type as="h1" variant="h1">
        Dance reviews
      </Type>
      <Show when={props.loading}>
        <p aria-busy="true">Checking review access…</p>
      </Show>
      <Show when={props.error}>
        <p role="alert">{props.error}</p>
        <Button onClick={props.onLoad}>Check again</Button>
      </Show>
      <Show when={!props.detail ? props.page : null}>
        {(selected) => {
          const page = selected();
          return (
            <>
              <Show when={page.items.length === 0}>
                <p>
                  {page.cursor
                    ? "No recordings are available on this page."
                    : "No recordings are waiting for review."}
                </p>
              </Show>
              <ol class="flex flex-col gap-3">
                <For each={page.items}>
                  {(item) => (
                    <li class="rounded-xl border border-border p-4">
                      <Button
                        variant="secondary"
                        onClick={() => props.onSelect(item)}
                      >
                        Review recording
                      </Button>
                      <p class="text-sm text-muted-foreground">
                        Review before{" "}
                        <time
                          datetime={new Date(
                            item.receipt.reviewDeadlineMs,
                          ).toISOString()}
                        >
                          {formatTime(item.receipt.reviewDeadlineMs)}
                        </time>
                      </p>
                    </li>
                  )}
                </For>
              </ol>
              <Show when={page.skipped.count}>
                <p role="status">
                  Some recordings are no longer available for your review.
                </p>
              </Show>
              <Show when={page.cursor}>
                <Button
                  variant="secondary"
                  disabled={props.loading}
                  onClick={props.onMore}
                >
                  {props.loading ? "Loading…" : "More recordings"}
                </Button>
              </Show>
            </>
          );
        }}
      </Show>
      <Show when={props.detail}>
        {(r) => (
          <>
            <Type as="h2" variant="h2">
              Review recording
            </Type>
            <p>
              Review before{" "}
              <time
                datetime={new Date(r().receipt.reviewDeadlineMs).toISOString()}
              >
                {formatTime(r().receipt.reviewDeadlineMs)}
              </time>
            </p>
            <p role="status">{props.status}</p>
            <Show when={props.canDecide}>
              <section class="space-y-3" aria-label="Private recording">
                <Show
                  when={props.previewReady}
                  fallback={
                    <Button
                      variant="secondary"
                      disabled={props.loading}
                      onClick={props.onPreview}
                    >
                      Preview recording
                    </Button>
                  }
                >
                  {props.privatePreview}
                </Show>
              </section>
              <Show when={r().capture.reference}>
                <section class="space-y-3" aria-label="Reference dance">
                  <Type as="h3" variant="h3">
                    Reference dance
                  </Type>
                  <div class="mx-auto aspect-[9/16] max-h-[45dvh] overflow-hidden rounded-xl">
                    {props.referencePreview}
                  </div>
                </section>
              </Show>
              <section class="space-y-3" aria-label="Captured review rubric">
                <Type as="h3" variant="h3">
                  What to review
                </Type>
                <p class="whitespace-pre-wrap">{r().capture.rubricText}</p>
                <p>
                  Dance interval: 0–{r().capture.durationSamples / 48000}{" "}
                  seconds. No opening cue is required.
                </p>
                <p>
                  By choosing Pass, you confirm you inspected this recording and
                  accept the performance of the selected dance.
                </p>
                <p>{props.reviewDisclosure}</p>
                <div class="flex flex-wrap gap-3">
                  <Button
                    disabled={props.loading}
                    onClick={() => props.onDecide("pass")}
                  >
                    Pass
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={props.loading}
                    onClick={() => props.onDecide("not_passed")}
                  >
                    Not passed
                  </Button>
                </div>
              </section>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.detail && !props.loading}>
        <Button variant="secondary" onClick={props.onLoad}>
          Back to reviews
        </Button>
      </Show>
    </main>
  );
}
