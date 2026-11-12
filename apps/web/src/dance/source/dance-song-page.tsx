// c7 dance-song-page composition: original grid, selected-reference player,
// account-private latest attempt and recorder. Authenticated owner producer
// replaces central session/persona services; shared routing stays host-owned.
import { isServer } from "@solidjs/web";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { Button, IconArrowLeft, IconButton, Type } from "../design-system.ts";
import { privateAccessLost } from "../client.ts";
import type {
  DanceConsentPolicy,
  DanceReview,
} from "../../../../../packages/dance/contracts.ts";
import { DanceRecorderPanel } from "./dance-recorder-panel.tsx";
import type { createDanceRecorder } from "./dance-recorder.ts";
import { VideoPlayer } from "./platform/video-player.tsx";
import {
  assertDanceReview,
  danceResultPresentation,
  danceReviewPending,
  danceReviewPath,
  type DanceResult,
} from "./dance-review-api.ts";
import {
  danceScopeKey,
  type DanceAccount,
  type DanceAccountPort,
  type DanceCatalogue,
  type DancePlaybackPort,
  type DanceReferenceChoice,
  type DanceScope,
  type DanceSourcePorts,
} from "./ports.ts";

export interface DanceSongPageProps {
  readonly communityId: string;
  readonly songKey: string;
  readonly account: DanceAccountPort;
  readonly catalogue: DanceCatalogue;
  readonly playback: DancePlaybackPort;
  readonly source: (
    scope: DanceScope,
    consent: DanceConsentPolicy,
    current: () => DanceScope | null,
  ) => DanceSourcePorts;
  readonly recorder?: typeof createDanceRecorder;
  readonly onBack: () => void;
  readonly onSignIn: () => void;
  readonly onReview?: (review: DanceReview) => void;
}
type Ready = {
  account: DanceAccount;
  choices: readonly DanceReferenceChoice[];
  consent: DanceConsentPolicy;
  owner: boolean;
  cursor: string | null;
};
export function DanceSongPage(props: DanceSongPageProps) {
  const [phase, setPhase] = createSignal<
    "loading" | "anonymous" | "error" | "ready"
  >("loading");
  const [value, setValue] = createSignal<Ready | null>(null);
  const [selected, setSelected] = createSignal<DanceReferenceChoice | null>(
    null,
  );
  const [detail, setDetail] = createSignal<{
    latest: DanceReview | null;
  } | null>(null);
  const [recording, setRecording] = createSignal<DanceSourcePorts | null>(null);
  const [busy, setBusy] = createSignal(false),
    [message, setMessage] = createSignal("");
  let alive = true,
    generation = 0,
    selection = 0,
    request: AbortController | undefined,
    detailRequest: AbortController | undefined;
  let unsubscribeAccount: (() => void) | undefined;
  const clear = () => {
    generation++;
    selection++;
    request?.abort();
    detailRequest?.abort();
    recording()?.dispose?.();
    setValue(null);
    setSelected(null);
    setDetail(null);
    setRecording(null);
    setBusy(false);
    setMessage("");
    setPhase("loading");
  };
  const scope = (
    target: DanceReferenceChoice,
    account: DanceAccount,
  ): DanceScope => ({ ...target, ...account });
  const current = () => {
    const target = selected(),
      account = props.account.current(),
      shown = value();
    return alive &&
      target &&
      account &&
      shown &&
      account.accountId === shown.account.accountId &&
      account.sessionKey === shown.account.sessionKey
      ? scope(target, account)
      : null;
  };
  async function load() {
    clear();
    const attempt = generation,
      community = props.communityId,
      song = props.songKey,
      pending = new AbortController();
    request = pending;
    const owns = () =>
      alive &&
      !pending.signal.aborted &&
      generation === attempt &&
      props.communityId === community &&
      props.songKey === song;
    try {
      const account = await props.account.load(pending.signal);
      if (!owns()) return;
      if (!account) {
        setPhase("anonymous");
        return;
      }
      if (!account.accountId || !account.sessionKey || !account.profileLabel)
        throw Error("dance_owner_account_required");
      const options = await props.catalogue.options(
        { communityId: community, songKey: song, accountId: account.accountId },
        pending.signal,
      );
      if (!owns()) return;
      const fresh = props.account.current();
      if (
        !fresh ||
        fresh.accountId !== account.accountId ||
        fresh.sessionKey !== account.sessionKey
      )
        return;
      if (
        options.choices.some(
          (c) =>
            c.communityId !== community ||
            c.songKey !== song ||
            !Number.isSafeInteger(c.songRevision) ||
            !Number.isSafeInteger(c.durationMs) ||
            c.durationMs < 6000 ||
            c.durationMs > 30000,
        )
      )
        throw Error("dance_preparation_target_changed");
      setValue({
        account,
        choices: options.choices,
        consent: options.consent,
        owner: options.owner,
        cursor: options.cursor,
      });
      setPhase("ready");
    } catch (error) {
      if (owns()) {
        setValue(null);
        setPhase(privateAccessLost(error) ? "anonymous" : "error");
      }
    }
  }
  async function choose(target: DanceReferenceChoice) {
    const shown = value();
    if (!shown) return;
    const attempt = generation,
      chosen = ++selection,
      pending = new AbortController();
    detailRequest?.abort();
    detailRequest = pending;
    setSelected(target);
    setDetail(null);
    setRecording(null);
    setMessage("");
    setBusy(true);
    try {
      const latest = await props.catalogue.latest(
        scope(target, shown.account),
        pending.signal,
      );
      if (
        !alive ||
        pending.signal.aborted ||
        generation !== attempt ||
        selection !== chosen
      )
        return;
      const actual = current();
      if (
        !actual ||
        danceScopeKey(actual) !== danceScopeKey(scope(target, shown.account))
      )
        return;
      if (latest) assertDanceReview(latest, actual);
      if (
        latest &&
        (latest.capture.learner.accountId !== shown.account.accountId ||
          latest.capture.communityId !== target.communityId ||
          latest.capture.songKey !== target.songKey ||
          latest.capture.songRevision !== target.songRevision ||
          latest.capture.audioSha256 !== target.audioSha256 ||
          (latest.capture.reference?.id ?? null) !==
            (target.reference?.id ?? null) ||
          (latest.capture.reference?.revision ?? null) !==
            (target.reference?.revision ?? null))
      )
        throw Error("dance_preparation_target_changed");
      setDetail({ latest });
    } catch (error) {
      if (
        alive &&
        generation === attempt &&
        selection === chosen &&
        !pending.signal.aborted
      ) {
        if (privateAccessLost(error)) {
          clear();
          setPhase("anonymous");
        } else setMessage("This dance couldn’t be loaded. Try again.");
      }
    } finally {
      if (
        alive &&
        generation === attempt &&
        selection === chosen &&
        !pending.signal.aborted
      )
        setBusy(false);
    }
  }
  const back = () => {
    selection++;
    detailRequest?.abort();
    recording()?.dispose?.();
    setRecording(null);
    setSelected(null);
    setDetail(null);
    setBusy(false);
    setMessage("");
  };
  const begin = () => {
    const shown = value(),
      target = selected(),
      chosen = detail(),
      actual = current();
    if (
      !shown ||
      !target ||
      !chosen ||
      !actual ||
      busy() ||
      shown.owner ||
      !target.recordingAllowed ||
      shown.consent.admission !== "admitted" ||
      (chosen.latest &&
        danceReviewPending({
          kind: "review",
          state: chosen.latest.state,
          review: chosen.latest,
        }))
    )
      return;
    try {
      const source = props.source(actual, shown.consent, current);
      if (danceScopeKey(source.scope) !== danceScopeKey(actual)) {
        source.dispose?.();
        throw Error("dance_source_target_changed");
      }
      setRecording(source);
    } catch {
      setMessage("Recording isn’t available for this dance right now.");
    }
  };
  async function more() {
    const shown = value(),
      pending = request;
    if (!shown?.cursor || !pending || busy()) return;
    const attempt = generation;
    setBusy(true);
    try {
      const next = await props.catalogue.options(
        {
          communityId: props.communityId,
          songKey: props.songKey,
          accountId: shown.account.accountId,
          cursor: shown.cursor,
        },
        pending.signal,
      );
      if (!alive || attempt !== generation || pending.signal.aborted) return;
      const actual = props.account.current();
      if (
        !actual ||
        actual.accountId !== shown.account.accountId ||
        actual.sessionKey !== shown.account.sessionKey
      )
        return;
      if (
        next.consent.termsHash !== shown.consent.termsHash ||
        next.choices.some(
          (c) =>
            c.communityId !== props.communityId || c.songKey !== props.songKey,
        )
      )
        throw Error("dance_options_changed");
      const choices = [...shown.choices];
      for (const item of next.choices)
        if (
          !choices.some(
            (c) =>
              c.reference?.id === item.reference?.id &&
              c.reference?.revision === item.reference?.revision &&
              c.songRevision === item.songRevision,
          )
        )
          choices.push(item);
      setValue({ ...shown, choices, cursor: next.cursor });
    } catch (error) {
      if (alive && attempt === generation && !pending.signal.aborted) {
        if (privateAccessLost(error)) {
          clear();
          setPhase("anonymous");
        } else setMessage("More dances couldn’t be loaded. Try again.");
      }
    } finally {
      if (alive && attempt === generation && !pending.signal.aborted)
        setBusy(false);
    }
  }
  const latest = (): DanceResult | null => {
    const review = detail()?.latest;
    return review ? { kind: "review", state: review.state, review } : null;
  };
  createEffect(
    () => [props.communityId, props.songKey] as const,
    () => {
      clear();
      const attempt = generation;
      if (!isServer)
        queueMicrotask(() => {
          if (alive && generation === attempt) void load();
        });
    },
  );
  onSettled(() => {
    if (!alive) return;
    unsubscribeAccount = props.account.subscribe(() => {
      clear();
      void load();
    });
  });
  onCleanup(() => {
    alive = false;
    unsubscribeAccount?.();
    clear();
  });
  return (
    <div
      role={recording() ? undefined : "main"}
      class="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-5 p-5"
      data-dance-song={phase()}
    >
      <Show when={!recording()}>
        <div class="flex items-center gap-3">
          <button
            class="text-sm underline"
            type="button"
            onClick={props.onBack}
          >
            Back to song
          </button>
          <Type as="h1" variant="body-strong">
            Dances
          </Type>
        </div>
      </Show>
      <Show when={phase() === "loading"}>
        <p aria-busy="true">Loading dances…</p>
      </Show>
      <Show when={phase() === "anonymous"}>
        <p>Sign in to do this dance.</p>
        <Button variant="secondary" onClick={props.onSignIn}>
          Sign in
        </Button>
      </Show>
      <Show when={phase() === "error"}>
        <p role="alert">Dances couldn’t be loaded.</p>
        <Button variant="secondary" onClick={() => void load()}>
          Check again
        </Button>
      </Show>
      <Show when={value()} keyed>
        {(shown) => (
          <>
            <Show when={!recording()}>
              <Show
                when={shown.choices.length > 0}
                fallback={<p>No dances are available for this song yet.</p>}
              >
                <div
                  class="grid grid-cols-3 gap-2"
                  aria-label="Dances for this song"
                >
                  <For each={shown.choices}>
                    {(target, index) => (
                      <button
                        type="button"
                        class="relative aspect-[9/16] overflow-hidden rounded-xl bg-card text-foreground"
                        onClick={() => void choose(target)}
                        aria-label={`Open dance ${index() + 1}`}
                      >
                        <Show when={target.posterUrl}>
                          <img
                            class="h-full w-full object-cover"
                            src={target.posterUrl}
                            alt=""
                            loading="lazy"
                          />
                        </Show>
                        <span class="absolute inset-x-0 bottom-0 bg-black/70 p-2 text-sm text-white">
                          Dance {index() + 1} · {target.durationMs / 1000} s
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={shown.cursor}>
                <Button
                  variant="secondary"
                  disabled={busy()}
                  onClick={() => void more()}
                >
                  More dances
                </Button>
              </Show>
              <Show when={selected()} keyed>
                {(target) => (
                  <section
                    class="fixed inset-0 z-30 flex flex-col overflow-y-auto bg-black text-white"
                    aria-label="Selected dance"
                  >
                    <div class="absolute inset-0">
                      <VideoPlayer
                        postId={target.reference?.id ?? target.songKey}
                        state={{
                          playback: target.playback,
                          thumbnail: target.posterUrl ? "ready" : "unavailable",
                        }}
                        activation="manual"
                        layout="card"
                        posterPath={() => target.posterUrl ?? ""}
                        mint={(_id, signal) =>
                          props.playback.reference(target, signal)
                        }
                        onAccessLost={() => {
                          clear();
                          setPhase("anonymous");
                        }}
                      />
                    </div>
                    <div class="pointer-events-none relative z-10 flex min-h-dvh flex-col justify-between p-4">
                      <IconButton
                        class="pointer-events-auto size-11 bg-black/70"
                        aria-label="Back to dances"
                        variant="secondary"
                        onClick={back}
                      >
                        <IconArrowLeft />
                      </IconButton>
                      <div class="pointer-events-auto mx-auto flex w-full max-w-md flex-col gap-3 rounded-xl bg-black/80 p-4">
                        <Type as="h2" variant="h3" class="text-white">
                          Dance
                        </Type>
                        <p>{target.durationMs / 1000} seconds</p>
                        <Show when={busy()}>
                          <p aria-busy="true">Checking your recording…</p>
                        </Show>
                        <Show when={detail()} keyed>
                          {(_entry) => (
                            <>
                              <Show when={latest()} keyed>
                                {(result) => (
                                  <a
                                    class="rounded-lg border border-white/30 p-3 underline"
                                    href={danceReviewPath(
                                      props.communityId,
                                      detail()!.latest!.reviewId,
                                    )}
                                    onClick={(e) => {
                                      if (props.onReview) {
                                        e.preventDefault();
                                        props.onReview(detail()!.latest!);
                                      }
                                    }}
                                  >
                                    {danceResultPresentation(result).title}
                                  </a>
                                )}
                              </Show>
                              <Show
                                when={shown.owner}
                                fallback={
                                  <>
                                    <p class="text-sm">
                                      {shown.account.profileLabel}
                                    </p>
                                    <Show
                                      when={
                                        !target.recordingAllowed ||
                                        shown.consent.admission !== "admitted"
                                      }
                                    >
                                      <p>
                                        Recording isn’t available for this dance
                                        right now.
                                      </p>
                                    </Show>
                                    <Show
                                      when={
                                        !latest() ||
                                        !danceReviewPending(latest()!)
                                      }
                                    >
                                      <Button
                                        disabled={
                                          busy() ||
                                          !target.recordingAllowed ||
                                          shown.consent.admission !== "admitted"
                                        }
                                        onClick={begin}
                                      >
                                        Do this dance
                                      </Button>
                                    </Show>
                                  </>
                                }
                              >
                                <p>You review recordings for this community.</p>
                                <a class="underline" href="/operator">
                                  Review recordings
                                </a>
                              </Show>
                            </>
                          )}
                        </Show>
                        <Show when={message()}>
                          <p role="alert">{message()}</p>
                          <Button
                            variant="secondary"
                            disabled={busy()}
                            onClick={() => void choose(target)}
                          >
                            Check dance
                          </Button>
                        </Show>
                      </div>
                    </div>
                  </section>
                )}
              </Show>
              <Show when={!selected() && message()}>
                <p role="alert">{message()}</p>
              </Show>
            </Show>
            <Show when={recording()} keyed>
              {(source) => (
                <DanceRecorderPanel
                  source={source}
                  recorder={props.recorder}
                  onSignIn={props.onSignIn}
                  onAccessLost={() => {
                    clear();
                    setPhase("anonymous");
                  }}
                  onBack={() => {
                    source.dispose?.();
                    setRecording(null);
                    const target = selected();
                    if (target) void choose(target);
                  }}
                />
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
