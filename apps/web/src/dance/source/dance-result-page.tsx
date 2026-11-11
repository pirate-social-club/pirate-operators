// c7 dance-result-page actual section/typography/actions, on a private verified
// review read. No centralized publication, numeric grade or reward projection.
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { Button, Type } from "../design-system.ts";
import { privateAccessLost } from "../client.ts";
import {
  assertCurrent,
  danceScopeKey,
  type DanceSourcePorts,
} from "./ports.ts";
import { createDanceReviewController } from "./dance-review-controller.ts";
import {
  danceResultPresentation,
  danceReviewEditable,
  danceReviewPending,
  type DanceResult,
} from "./dance-review-api.ts";

export function DanceResultPage(props: {
  readonly source: DanceSourcePorts;
  readonly reviewId: string;
  readonly onBack: () => void;
  readonly onManage: () => void;
  readonly onSignIn: () => void;
  readonly onAccessLost: () => void;
  readonly participation?: JSX.Element;
}) {
  const [phase, setPhase] = createSignal<
    "loading" | "ready" | "anonymous" | "error"
  >("loading");
  const [result, setResult] = createSignal<DanceResult | null>(null);
  let active = true,
    accessDenied = false,
    generation = 0,
    request: AbortController | undefined;
  const initialReviewId = props.reviewId;
  const controller = createDanceReviewController({
    ...props.source,
    reviewId: props.reviewId,
  });
  const clear = () => {
    generation++;
    request?.abort();
    setResult(null);
    setPhase("loading");
  };
  const unsubscribeDenial = props.source.client.onAccessLost?.(() => {
    if (!active) return;
    accessDenied = true;
    clear();
    controller.dispose();
    setPhase("anonymous");
    props.onAccessLost();
  });
  async function load() {
    if (accessDenied || !active) return;
    clear();
    const attempt = generation,
      id = props.reviewId,
      pending = new AbortController();
    request = pending;
    try {
      const view = await controller.observe(pending.signal);
      assertCurrent(props.source, pending.signal);
      if (!active || attempt !== generation || props.reviewId !== id) return;
      if (view.result.kind !== "review" || view.result.review.reviewId !== id)
        throw Error("dance_result_target_mismatch");
      setResult(view.result);
      setPhase("ready");
    } catch (error) {
      if (!active || attempt !== generation || pending.signal.aborted) return;
      setResult(null);
      if (privateAccessLost(error)) {
        accessDenied = true;
        controller.dispose();
        setPhase("anonymous");
        props.onAccessLost();
      } else setPhase("error");
    }
  }
  createEffect(
    () => [props.source.currentScope(), props.reviewId] as const,
    ([scope]) => {
      clear();
      if (
        accessDenied ||
        !scope ||
        props.reviewId !== initialReviewId ||
        danceScopeKey(scope) !== danceScopeKey(props.source.scope)
      ) {
        controller.dispose();
        setPhase("anonymous");
        return;
      }
    },
  );
  onSettled(() => {
    void load();
  });
  onCleanup(() => {
    active = false;
    unsubscribeDenial?.();
    clear();
    controller.dispose();
  });
  const review = () => {
    const r = result();
    return r?.kind === "review" ? r.review : null;
  };
  return (
    <main
      class="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-8"
      data-dance-result={phase()}
    >
      <Type as="h1" variant="h1">
        Your dance result
      </Type>
      <Show when={phase() === "loading"}>
        <p aria-busy="true">Loading your dance result…</p>
      </Show>
      <Show when={phase() === "anonymous"}>
        <p>Sign in to view your dance result.</p>
        <Button variant="secondary" onClick={props.onSignIn}>
          Sign in
        </Button>
      </Show>
      <Show when={phase() === "error"}>
        <p role="alert">Your dance result could not be loaded.</p>
        <Button variant="secondary" onClick={() => void load()}>
          Retry dance result
        </Button>
      </Show>
      <Show when={phase() === "ready" ? result() : null} keyed>
        {(value) => (
          <>
            <section
              class="space-y-3 rounded-xl border border-border-soft p-5"
              aria-label="Dance review result"
              aria-live="polite"
            >
              <Type as="h2" variant="h2">
                {danceResultPresentation(value).title}
              </Type>
              <p>{danceResultPresentation(value).detail}</p>
              <Show when={review()} keyed>
                {(r) => (
                  <>
                    <p class="text-sm text-muted-foreground">
                      Submitted{" "}
                      <time
                        datetime={new Date(
                          r.receipt.trustedSubmittedAtMs,
                        ).toISOString()}
                      >
                        {new Date(
                          r.receipt.trustedSubmittedAtMs,
                        ).toLocaleString()}
                      </time>
                    </p>
                    <Show when={danceReviewPending(value)}>
                      <p class="text-sm text-muted-foreground">
                        Review deadline:{" "}
                        <time
                          datetime={new Date(
                            r.receipt.reviewDeadlineMs,
                          ).toISOString()}
                        >
                          {new Date(
                            r.receipt.reviewDeadlineMs,
                          ).toLocaleString()}
                        </time>
                      </p>
                    </Show>
                  </>
                )}
              </Show>
            </section>
            <Show when={danceReviewEditable(value)}>
              <Button variant="secondary" onClick={props.onManage}>
                Manage recording
              </Button>
            </Show>
            {props.participation}
            <Button variant="secondary" onClick={props.onBack}>
              Back to song
            </Button>
          </>
        )}
      </Show>
    </main>
  );
}
